import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MachineAuth, type Config, type Storage } from './auth.ts';
import { MachineQueue, MAX_UPDATE_CHARS, MESSAGES, type Sql } from './queue.ts';
import { handleRunner, handleWebhook, MAX_WEBHOOK_BYTES, underBasePath } from './routes.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, any>;

const ORG = 'org-example';
const WEBHOOK_SECRET = 'webhook-secret-example';
const BEARER = 'b'.repeat(32);
const config: Config = {
  orgId: ORG,
  adminSecret: 'a'.repeat(32),
  machines: {
    'example-machine': { clientId: 'client-example', clientSecret: 'client-secret-example', webhookSecret: WEBHOOK_SECRET, bearerSecret: BEARER },
    'other-machine': { clientId: 'client-other', clientSecret: 'client-secret-other', webhookSecret: 'other', bearerSecret: 'o'.repeat(32) },
  },
};
const LEASE_MS = 10 * 60_000;

/** A machine installed as `app-user-example`, with node:sqlite standing in for the Durable Object's SQL. */
function setup(prepare?: (db: DatabaseSync, now: number) => void) {
  const db = new DatabaseSync(':memory:');
  prepare?.(db, 1_800_000_000_000);
  // Runs eagerly, like Cloudflare's exec().
  const sql: Sql = {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  };
  const data = new Map<string, unknown>();
  const storage: Storage = {
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async put(key: string, value: unknown) { data.set(key, structuredClone(value)); },
    async delete(key: string) { return data.delete(key); },
  };
  const clock = { now: 1_800_000_000_000 };
  data.set('token', {
    accessToken: 'access-example', refreshToken: 'refresh-example', expiresAt: clock.now + 365 * 86_400_000,
    appUserId: 'app-user-example', appName: 'Example Machine', orgId: ORG, clientId: 'client-example', scopes: ['read', 'write', 'app:assignable'],
  });
  // Fakes Linear. `posts` records each activity Linear accepted, in order. `failNext`
  // fails that many activity requests; `refreshFails` fails token refreshes; `hold()`
  // holds the next request, activity or token refresh, until released.
  const posts: { auth: string; sessionId: string; type: string; body: string }[] = [];
  // Every other request goes to `answer`, which reads and edits `world`, and is kept in `requests`.
  const world = fakeWorld();
  const requests: { query: string; variables: Record<string, any> }[] = [];
  const linear = { failNext: 0, refreshFails: false, attempts: 0, hold, world, requests, answer: (q: string, v: Record<string, any>) => answer(world, q, v) };
  let held: { reached: () => void; released: Promise<void> } | undefined;
  function hold() {
    let release!: () => void;
    let reached!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    held = { reached, released };
    return { waiting, release };
  }
  const fetchFn: typeof fetch = async (input, init) => {
    const pause = held;
    held = undefined;
    if (pause) {
      pause.reached();
      await pause.released;
    }
    if (String(input) === 'https://api.linear.app/oauth/token') {
      if (linear.refreshFails) return new Response(null, { status: 500 });
      return Response.json({ access_token: 'access-refreshed', refresh_token: 'refresh-2', expires_in: 86400, scope: 'read write app:assignable' });
    }
    assert.equal(String(input), 'https://api.linear.app/graphql');
    linear.attempts++;
    if (linear.failNext > 0) {
      linear.failNext--;
      return new Response(null, { status: 503 });
    }
    const { query, variables } = JSON.parse(String(init?.body));
    if (!query.includes('agentActivityCreate')) {
      linear.requests.push({ query, variables });
      return Response.json({ data: linear.answer(query, variables) });
    }
    const { input: activity } = variables;
    posts.push({
      auth: new Headers(init?.headers).get('Authorization')!,
      sessionId: activity.agentSessionId, type: activity.content.type, body: activity.content.body,
    });
    return Response.json({ data: { agentActivityCreate: { success: true } } });
  };
  const auth = new MachineAuth(storage, config.machines['example-machine']!, ORG, fetchFn, () => clock.now);
  // The Durable Object's alarm; tests fire it with `flush()`.
  const alarms: number[] = [];
  const build = () => new MachineQueue(sql, auth, 'example-machine', (at) => alarms.push(at), fetchFn, () => clock.now);
  let queue = build();
  /** Replaces the queue with a new one over the same storage, as after a restart. */
  const rebuild = () => { queue = build(); };
  const flush = () => queue.deliver();
  const rows = () => ({
    jobs: db.prepare('SELECT id, issue_id, state FROM jobs ORDER BY rowid').all().map((row) => ({ ...row })),
    seen: db.prepare('SELECT session_id FROM seen').all().map((row) => ({ ...row })),
    outbox: db.prepare('SELECT session_id, type FROM outbox ORDER BY id').all().map((row) => ({ ...row })),
    ended: db.prepare('SELECT session_id FROM ended ORDER BY session_id').all().map((row) => ({ ...row })),
  });

  /** Delivers a webhook without firing the alarm. */
  const send = (payload: Record<string, any>, sign: (body: string) => string = signed) => {
    // Fixtures carry webhookTimestamp 0, meaning "now".
    const body = JSON.stringify({ ...payload, webhookTimestamp: payload.webhookTimestamp || clock.now });
    const request = new Request('https://cloud-inbox.example/webhook', {
      method: 'POST', body, headers: { 'Linear-Signature': sign(body) },
    });
    return handleWebhook(request, config, () => queue, clock.now);
  };
  /** Delivers a webhook, then fires the alarm. */
  const deliver = async (payload: Record<string, any>, sign?: (body: string) => string) => {
    const res = await send(payload, sign);
    await flush();
    return res;
  };
  const createdPayload = (sessionId: string, issueId = 'issue-1') => {
    const payload = fixture('created');
    payload.agentSession.id = sessionId;
    payload.agentSession.issueId = payload.agentSession.issue.id = issueId;
    return payload;
  };
  const stoppedPayload = (sessionId: string) => {
    const payload = fixture('stopped');
    payload.agentSession.id = sessionId;
    return payload;
  };
  const created = (sessionId: string, issueId = 'issue-1') => deliver(createdPayload(sessionId, issueId));
  const runner = (method: string, path: string, bearer = BEARER, body?: unknown) =>
    handleRunner(new Request(`https://cloud-inbox.example${path}`, {
      method, headers: { Authorization: `Bearer ${bearer}` }, body: body === undefined ? undefined : JSON.stringify(body),
    }), config, () => queue);
  /** Claims a job, returning everything the runner receives. */
  const claimed = async () => {
    const res = await runner('POST', '/jobs/claim');
    await flush();
    return res.status === 204 ? undefined : await res.json() as { issueId: string; sessionId: string; claimId: string };
  };
  /** Claims a job, returning just its payload. */
  const claim = async () => {
    const { claimId: _, ...job } = await claimed() ?? {};
    return 'sessionId' in job ? job : undefined;
  };
  /** Reports the outcome of a claim. */
  const report = (sessionId: string, outcome: string, claimId: string | undefined) =>
    runner('POST', `/jobs/${sessionId}/${outcome}?claimId=${claimId}`);
  return {
    clock, posts, linear, alarms, rows, send, deliver, flush, rebuild, created, createdPayload, stoppedPayload,
    runner, claim, claimed, report, data, machines: () => queue,
  };
}

const signed = (body: string) => createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

/** The slice of a Linear workspace the Runner API reads and edits. */
function fakeWorld() {
  const issue = (identifier: string) => ({
    identifier, description: `Task for ${identifier}`, branchName: `abc-${identifier.split('-')[1]}`,
    stateId: 'state-todo', delegateId: 'app-user-example' as string | null, assigneeId: 'someone-else' as string | null,
    labelIds: ['label-claude', 'label-factory'], attachments: [] as string[], title: identifier,
  });
  return {
    issues: { 'issue-1': issue('ABC-1'), 'issue-2': issue('ABC-2') } as Record<string, ReturnType<typeof issue>>,
    sessions: {} as Record<string, { creatorId: string | null; status: string; links: string[] }>,
    states: [
      { id: 'state-todo', type: 'unstarted', position: 1 },
      { id: 'state-review', type: 'started', position: 3 },
      { id: 'state-progress', type: 'started', position: 2 },
      { id: 'state-done', type: 'completed', position: 4 },
    ],
    labels: [
      { id: 'label-orca', name: 'Orca', team: null, parent: { id: 'group-dispatch' } },
      { id: 'label-orca-other-team', name: 'Orca', team: { id: 'team-other' }, parent: null },
      { id: 'label-claude', name: 'Claude', team: null, parent: { id: 'group-dispatch' } },
      { id: 'label-factory', name: 'Factory', team: null, parent: null },
    ],
  };
}
type World = ReturnType<typeof fakeWorld>;

function answer(world: World, query: string, variables: Record<string, any>) {
  const issue = world.issues[variables.issue]!;
  const session = (world.sessions[variables.session] ??= { creatorId: 'user-creator', status: 'active', links: [] });
  const state = () => world.states.find((s) => s.id === issue.stateId)!;
  if (query.includes('issueUpdate')) {
    const { stateId, assigneeId, delegateId, addedLabelIds = [], removedLabelIds = [], ...other } = variables.input;
    assert.deepEqual(other, {}, 'an unexpected field was set');
    if (stateId !== undefined) issue.stateId = stateId;
    if (assigneeId !== undefined) issue.assigneeId = assigneeId;
    if (delegateId !== undefined) issue.delegateId = delegateId;
    issue.labelIds = [...issue.labelIds.filter((id) => !removedLabelIds.includes(id)), ...addedLabelIds];
    return { issueUpdate: { success: true } };
  }
  if (query.includes('agentSessionUpdate')) {
    session.links.push(variables.url);
    return { agentSessionUpdate: { success: true } };
  }
  const creator = session.creatorId && { id: session.creatorId };
  if (query.includes('issueLabels')) {
    return {
      issue: {
        delegate: issue.delegateId && { id: issue.delegateId },
        state: { type: state().type },
        team: { id: 'team-1', states: { nodes: world.states.filter((s) => s.type === 'started') } },
        labels: { nodes: issue.labelIds.map((id) => world.labels.find((l) => l.id === id)!) },
      },
      agentSession: { creator },
      issueLabels: { nodes: world.labels.filter((l) => l.name === 'Orca') },
    };
  }
  if (query.includes('branchName')) {
    const { identifier, description, branchName, delegateId } = issue;
    return {
      issue: { identifier, description, branchName, state: { type: state().type }, delegate: delegateId && { id: delegateId } },
      agentSession: { creator },
    };
  }
  if (query.includes('attachments')) {
    return { issue: { attachments: { nodes: issue.attachments.map((url) => ({ url })) } }, agentSession: { status: session.status } };
  }
  assert.match(query, /delegate/);
  return { issue: { delegate: issue.delegateId && { id: issue.delegateId } } };
}

test('a created webhook queues the job and posts the queued thought', async () => {
  const { created, posts, rows } = setup();
  assert.equal((await created('session-1')).status, 200);
  assert.deepEqual(rows().jobs, [{ id: 'session-1', issue_id: 'issue-1', state: 'queued' }]);
  assert.deepEqual(posts, [{
    auth: 'Bearer access-example', sessionId: 'session-1', type: 'thought',
    body: 'Queued on Example Machine. It starts when Example Machine picks it up, which can take a while if the machine is busy or asleep.',
  }]);
});

type Tamper = (payload: Record<string, any>, now: number) => [Record<string, any>, ((body: string) => string)?];
for (const [label, tamper, status] of [
  ['a bad signature', (p) => [p, () => '0'.repeat(64)], 401],
  ['a missing signature', (p) => [p, () => ''], 401],
  ['a stale timestamp', (p, now) => [{ ...p, webhookTimestamp: now - 60_001 }], 401],
  ['a future timestamp', (p, now) => [{ ...p, webhookTimestamp: now + 60_001 }], 401],
  ['an unknown client', (p) => [{ ...p, oauthClientId: 'client-unknown' }], 401],
  ["another machine's client", (p) => [{ ...p, oauthClientId: 'client-other' }], 401],
  ['a wrong org', (p) => [{ ...p, organizationId: 'org-other' }], 403],
  ['a wrong app user', (p) => [{ ...p, appUserId: 'app-user-other' }], 403],
] as [string, Tamper, number][]) {
  test(`a webhook with ${label} gets ${status} and writes nothing`, async () => {
    const { clock, deliver, posts, rows } = setup();
    const [payload, sign] = tamper(fixture('created'), clock.now);
    assert.equal((await deliver(payload, sign)).status, status);
    assert.deepEqual(rows(), { jobs: [], seen: [], outbox: [], ended: [] });
    assert.equal(posts.length, 0);
  });
}

test('a duplicate created webhook is deduped', async () => {
  const { created, posts, rows } = setup();
  await created('session-1');
  assert.equal((await created('session-1')).status, 200);
  assert.equal(rows().jobs.length, 1);
  assert.equal(posts.length, 1);
});

test('a second delegation of the same issue replaces the queued job', async () => {
  const { created, posts, rows, claim } = setup();
  await created('session-1');
  await created('session-2');
  await created('session-3', 'issue-2');
  assert.deepEqual(rows().jobs.map((j) => j.id), ['session-2', 'session-3']);
  assert.deepEqual(posts.slice(1, 3).map(({ sessionId, type, body }) => ({ sessionId, type, body })), [
    { sessionId: 'session-1', type: 'response', body: 'Replaced by a newer delegation.' },
    { sessionId: 'session-2', type: 'thought', body: MESSAGES.queued('Example Machine') },
  ]);
  assert.deepEqual(await claim(), { issueId: 'issue-1', sessionId: 'session-2' });
});

test('a stop signal posts the stopped response and drops a job not yet claimed', async () => {
  const { created, deliver, posts, rows } = setup();
  await created('session-1');
  assert.equal((await deliver(fixture('stopped'))).status, 200);
  assert.deepEqual(posts.at(-1)!.type, 'response');
  assert.equal(posts.at(-1)!.body, 'Stopped watching. The agent in Orca keeps running; stop it there if needed.');
  assert.deepEqual(rows().jobs, []);
});

test('any other prompt gets the replies thought and leaves the queue alone', async () => {
  const { created, deliver, posts, rows } = setup();
  await created('session-1');
  assert.equal((await deliver(fixture('prompted'))).status, 200);
  assert.deepEqual(posts.at(-1), {
    auth: 'Bearer access-example', sessionId: 'session-1', type: 'thought',
    body: "Delegator doesn't read replies; steer the agent in Orca.",
  });
  assert.equal(rows().jobs.length, 1);
});

test('the runner API rejects a wrong or missing bearer secret with 401', async () => {
  const { runner, created, rows } = setup();
  await created('session-1');
  for (const [method, path] of [['POST', '/jobs/claim'], ['POST', '/jobs/session-1/launched']]) {
    assert.equal((await runner(method!, path!, 'x'.repeat(32))).status, 401);
    assert.equal((await runner(method!, path!, '')).status, 401);
  }
  assert.equal(rows().jobs[0]!.state, 'queued');
});

test('claim hands out the oldest job once, then nothing', async () => {
  const { created, claim } = setup();
  await created('session-1', 'issue-1');
  await created('session-2', 'issue-2');
  assert.deepEqual(await claim(), { issueId: 'issue-1', sessionId: 'session-1' });
  assert.deepEqual(await claim(), { issueId: 'issue-2', sessionId: 'session-2' });
  assert.equal(await claim(), undefined);
});

test('an expired lease goes back on the queue', async () => {
  const { clock, created, claim, claimed, report } = setup();
  await created('session-1');
  await claim();
  clock.now += LEASE_MS - 1;
  assert.equal(await claim(), undefined);
  clock.now += 1;
  const again = await claimed();
  assert.equal(again?.sessionId, 'session-1');
  assert.equal((await report('session-1', 'launched', again?.claimId)).status, 204);
});

test('an expired lease is replaced by a newer delegation of its issue', async () => {
  const { clock, created, claim, posts } = setup();
  await created('session-1');
  await claim();
  await created('session-2');
  clock.now += LEASE_MS;
  assert.deepEqual(await claim(), { issueId: 'issue-1', sessionId: 'session-2' });
  assert.deepEqual(posts.at(-1), {
    auth: 'Bearer access-example', sessionId: 'session-1', type: 'response', body: 'Replaced by a newer delegation.',
  });
  assert.equal(await claim(), undefined);
});

test('launched and failed record the outcome of a claimed job only', async () => {
  const { created, claimed, report, rows } = setup();
  await created('session-1', 'issue-1');
  await created('session-2', 'issue-2');
  assert.equal((await report('session-1', 'launched', 'unclaimed')).status, 409);
  const first = await claimed();
  const second = await claimed();
  assert.notEqual(first?.claimId, second?.claimId);
  assert.equal((await report('session-1', 'launched', first?.claimId)).status, 204);
  assert.equal((await report('session-2', 'failed', second?.claimId)).status, 204);
  assert.equal((await report('session-1', 'failed', first?.claimId)).status, 409);
  assert.deepEqual(rows().jobs.map((j) => j.state), ['launched', 'failed']);
});

test('history and dedupe records are kept for 30 days', async () => {
  const { clock, created, claim, claimed, report, rows } = setup();
  await created('session-1');
  await report('session-1', 'launched', (await claimed())?.claimId);
  clock.now += 30 * 86_400_000 - 1;
  await claim();
  assert.equal(rows().jobs.length, 1);
  clock.now += 1;
  await claim();
  assert.deepEqual(rows(), { jobs: [], seen: [], outbox: [], ended: [] });
});

test('even an authenticated machine cannot retrieve a Linear token', async () => {
  const { runner } = setup();
  const res = await runner('GET', '/token');
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /access-example|refresh-example/);
});

test('unknown runner routes are 404 once authenticated', async () => {
  const { runner } = setup();
  assert.equal((await runner('GET', '/jobs/claim')).status, 404);
  assert.equal((await runner('POST', '/jobs/session-1/other')).status, 404);
});

const QUEUED = MESSAGES.queued('Example Machine');
const sent = (posts: { sessionId: string; type: string; body: string }[]) =>
  posts.map(({ sessionId, type, body }) => [sessionId, type, body]);

test('a verified webhook is answered once its writes are stored, without waiting on Linear', async () => {
  const { send, flush, linear, rows, alarms, clock, createdPayload, posts } = setup();
  assert.equal((await send(createdPayload('session-1'))).status, 200);
  assert.deepEqual(rows().outbox, [{ session_id: 'session-1', type: 'thought' }]);
  assert.deepEqual(alarms, [clock.now]);
  const { waiting, release } = linear.hold();
  const delivering = flush();
  await waiting;
  // Linear is holding the first post; the next webhook is answered regardless.
  assert.equal((await send(createdPayload('session-2', 'issue-2'))).status, 200);
  assert.deepEqual(rows().jobs.map((j) => j.id), ['session-1', 'session-2']);
  assert.equal(posts.length, 0);
  release();
  await delivering;
  assert.deepEqual(sent(posts), [['session-1', 'thought', QUEUED], ['session-2', 'thought', QUEUED]]);
  assert.deepEqual(rows().outbox, []);
});

test('a failed activity stays pending across a restart and is retried without queueing the job again', async () => {
  const { created, deliver, flush, rebuild, linear, posts, rows, clock, alarms, createdPayload } = setup();
  linear.failNext = 1;
  await created('session-1');
  assert.equal(posts.length, 0);
  assert.equal(alarms.at(-1), clock.now + 10_000);
  // Linear's redelivery is deduped, and the pending thought isn't due yet.
  assert.equal((await deliver(createdPayload('session-1'))).status, 200);
  assert.equal(linear.attempts, 1);
  rebuild();
  clock.now += 10_000;
  await flush();
  assert.deepEqual(sent(posts), [['session-1', 'thought', QUEUED]]);
  assert.deepEqual(rows(), {
    jobs: [{ id: 'session-1', issue_id: 'issue-1', state: 'queued' }], seen: [{ session_id: 'session-1' }], outbox: [],
    ended: [],
  });
});

test('an activity whose token refresh fails is retried once the refresh works', async () => {
  const { created, flush, linear, posts, rows, clock, data } = setup();
  const token = data.get('token') as { expiresAt: number };
  token.expiresAt = clock.now + 1000;
  linear.refreshFails = true;
  await created('session-1');
  assert.equal(posts.length, 0);
  assert.equal(linear.attempts, 0);
  assert.equal(rows().outbox.length, 1);
  linear.refreshFails = false;
  clock.now += 10_000;
  await flush();
  assert.deepEqual(posts.map((p) => [p.auth, p.sessionId]), [['Bearer access-refreshed', 'session-1']]);
  assert.deepEqual(rows().outbox, []);
});

test('a session replaced while an earlier post is in flight never gets its queued thought', async () => {
  const { created, send, flush, linear, posts, rows, createdPayload } = setup();
  await created('session-a');
  const { waiting, release } = linear.hold();
  await send(createdPayload('session-b'));
  const delivering = flush();
  await waiting; // Linear holds the response replacing A, so B's thought is still pending.
  await send(createdPayload('session-c'));
  release();
  await delivering;
  assert.deepEqual(sent(posts), [
    ['session-a', 'thought', QUEUED],
    ['session-a', 'response', MESSAGES.replaced],
    ['session-b', 'response', MESSAGES.replaced],
    ['session-c', 'thought', QUEUED],
  ]);
  assert.deepEqual(rows().jobs, [{ id: 'session-c', issue_id: 'issue-1', state: 'queued' }]);
  assert.deepEqual(rows().outbox, []);
});

test('a session stopped while an earlier post is in flight never gets its queued thought', async () => {
  const { created, send, flush, linear, posts, rows, createdPayload, stoppedPayload } = setup();
  await created('session-a');
  const { waiting, release } = linear.hold();
  await send(createdPayload('session-b'));
  const delivering = flush();
  await waiting;
  await send(stoppedPayload('session-b'));
  release();
  await delivering;
  assert.deepEqual(sent(posts), [
    ['session-a', 'thought', QUEUED],
    ['session-a', 'response', MESSAGES.replaced],
    ['session-b', 'response', MESSAGES.stopped],
  ]);
  assert.deepEqual(rows().jobs, []);
  assert.deepEqual(rows().outbox, []);
});

test("a session's later activity waits for its failed earlier one; other sessions don't", async () => {
  const { created, send, flush, linear, posts, clock, createdPayload } = setup();
  linear.failNext = 1;
  await created('session-1');
  await send(fixture('prompted'));
  await send(createdPayload('session-2', 'issue-2'));
  await flush();
  assert.deepEqual(sent(posts), [['session-2', 'thought', QUEUED]]);
  clock.now += 10_000;
  await flush();
  assert.deepEqual(sent(posts).slice(1), [['session-1', 'thought', QUEUED], ['session-1', 'thought', MESSAGES.replies]]);
});

test('a created webhook arriving after its stop never queues the session', async () => {
  const { deliver, created, claim, posts, rows, stoppedPayload } = setup();
  await deliver(stoppedPayload('session-a'));
  assert.equal((await created('session-a')).status, 200);
  assert.deepEqual(sent(posts), [['session-a', 'response', MESSAGES.stopped]]);
  assert.deepEqual(rows().jobs, []);
  assert.equal(await claim(), undefined);
});

test('a reply arriving after its session was replaced gets no thought', async () => {
  const { created, deliver, claim, posts, rows } = setup();
  await created('session-1');
  await created('session-2');
  assert.equal((await deliver(fixture('prompted'))).status, 200);
  assert.deepEqual(sent(posts), [
    ['session-1', 'thought', QUEUED],
    ['session-1', 'response', MESSAGES.replaced],
    ['session-2', 'thought', QUEUED],
  ]);
  assert.deepEqual(rows().ended, [{ session_id: 'session-1' }]);
  assert.deepEqual(await claim(), { issueId: 'issue-1', sessionId: 'session-2' });
  assert.equal(await claim(), undefined);
});

test('a session stopped after its claim is not requeued when the lease expires', async () => {
  const { clock, created, deliver, claim, claimed, report, rows } = setup();
  await created('session-1');
  const first = await claimed();
  await deliver(fixture('stopped'));
  clock.now += LEASE_MS;
  assert.equal(await claim(), undefined);
  assert.deepEqual(rows().jobs, []);
  assert.equal((await report('session-1', 'launched', first?.claimId)).status, 409);
});

for (const alarmFirst of [false, true]) {
  test(`a stopped claim stays stopped after 31 days offline (alarm first: ${alarmFirst})`, async () => {
    const { clock, created, deliver, claim, rows, flush } = setup();
    await created('session-1');
    assert.deepEqual(await claim(), { issueId: 'issue-1', sessionId: 'session-1' });
    await deliver(fixture('stopped'));
    clock.now += 31 * 86_400_000;
    if (alarmFirst) await flush();
    assert.equal(await claim(), undefined);
    assert.deepEqual(rows().jobs, []);
    assert.deepEqual(rows().ended, []);
  });
}

test('the ended marker expires with the rest of the history', async () => {
  const { clock, deliver, claim, rows } = setup();
  await deliver(fixture('stopped'));
  clock.now += 30 * 86_400_000;
  await claim();
  assert.deepEqual(rows().ended, []);
});

test('a failed queued thought is not retried once the runner claims and fails the job', async () => {
  const { created, claimed, report, flush, linear, posts, rows, clock } = setup();
  linear.failNext = 1;
  await created('session-1');
  const first = await claimed();
  posts.push({ auth: 'runner', sessionId: 'session-1', type: 'error', body: 'Launch failed.' });
  assert.equal((await report('session-1', 'failed', first?.claimId)).status, 204);
  clock.now += 10_000;
  await flush();
  assert.deepEqual(sent(posts), [['session-1', 'error', 'Launch failed.']]);
  assert.deepEqual(rows().outbox, []);
  // The failed thought, then the failure's delegate read and clear.
  assert.equal(linear.attempts, 3);
});

test('a claim during the token refresh cancels the queued thought before it is sent', async () => {
  const { send, runner, flush, linear, posts, rows, clock, data, createdPayload } = setup();
  (data.get('token') as { expiresAt: number }).expiresAt = clock.now + 1000;
  await send(createdPayload('session-1'));
  const { waiting, release } = linear.hold();
  const delivering = flush();
  await waiting; // Linear holds the token refresh.
  assert.equal((await runner('POST', '/jobs/claim')).status, 200);
  release();
  await delivering;
  assert.equal(linear.attempts, 0);
  assert.deepEqual(posts, []);
  assert.deepEqual(rows().outbox, []);
});

test('a queued thought in flight at claim is not retried when it fails', async () => {
  const { created, send, deliver, runner, flush, linear, posts, rows, clock, createdPayload } = setup();
  await send(createdPayload('session-1'));
  await send(fixture('prompted'));
  const { waiting, release } = linear.hold();
  linear.failNext = 1;
  const delivering = flush();
  await waiting; // Linear holds the queued thought.
  assert.equal((await runner('POST', '/jobs/claim')).status, 200);
  release();
  await delivering;
  clock.now += 10_000;
  await flush();
  await deliver(fixture('stopped'));
  // The reply and the final response still go out; the queued thought never does.
  assert.deepEqual(sent(posts), [['session-1', 'thought', MESSAGES.replies], ['session-1', 'response', MESSAGES.stopped]]);
  assert.deepEqual(rows().outbox, []);
  assert.equal(linear.attempts, 3);
});

test('only paths under the base path reach Cloud Inbox, with the prefix removed', async () => {
  const stripped = underBasePath(new Request('https://cloud-inbox.example/delegator/webhook?x=1', { method: 'POST', body: 'raw' }));
  assert.equal(stripped?.url, 'https://cloud-inbox.example/webhook?x=1');
  assert.equal(stripped?.method, 'POST');
  assert.equal(await stripped?.text(), 'raw');
  for (const path of ['/webhook', '/delegator', '/delegatorx/webhook', '/']) {
    assert.equal(underBasePath(new Request(`https://cloud-inbox.example${path}`)), null, path);
  }
});

const webhookRequest = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('https://cloud-inbox.example/webhook', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
const refuseQueue = () => { throw new Error('the queue must not see this request'); };

for (const [label, headers] of [
  ['no signature', {}],
  ['a signature that is too short', { 'Linear-Signature': 'a'.repeat(63) }],
  ['a signature that is too long', { 'Linear-Signature': 'a'.repeat(65) }],
  ['a signature that is not hex', { 'Linear-Signature': 'g'.repeat(64) }],
] as [string, Record<string, string>][]) {
  test(`a webhook with ${label} is refused without reading its body`, async () => {
    const request = webhookRequest('{}', headers);
    assert.equal((await handleWebhook(request, config, refuseQueue)).status, 401);
    assert.equal(request.bodyUsed, false);
  });
}

const WELL_FORMED = { 'Linear-Signature': '0'.repeat(64) };

test('a webhook declaring too large a body is refused without reading it', async () => {
  const request = webhookRequest('{}', { ...WELL_FORMED, 'Content-Length': String(MAX_WEBHOOK_BYTES + 1) });
  assert.equal((await handleWebhook(request, config, refuseQueue)).status, 413);
  assert.equal(request.bodyUsed, false);
});

for (const [label, headers] of [
  ['no Content-Length', WELL_FORMED],
  ['a false Content-Length', { ...WELL_FORMED, 'Content-Length': '2' }],
] as [string, Record<string, string>][]) {
  test(`an endless webhook body with ${label} is cut off at the limit`, async () => {
    const chunk = new Uint8Array(64 * 1024);
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += chunk.length; controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    assert.equal((await handleWebhook(webhookRequest(body, headers), config, refuseQueue)).status, 413);
    assert.equal(cancelled, true);
    assert.ok(pulled <= MAX_WEBHOOK_BYTES + chunk.length, `read ${pulled} bytes`);
  });
}

test('a chunked webhook is accepted at exactly the limit and refused one byte over', async () => {
  const { clock, createdPayload, machines, rows } = setup();
  const json = JSON.stringify({ ...createdPayload('session-1'), webhookTimestamp: clock.now });
  const sendSized = (size: number) => {
    const bytes = new TextEncoder().encode(json.padEnd(size));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1000));
        controller.enqueue(bytes.slice(1000));
        controller.close();
      },
    });
    return handleWebhook(webhookRequest(body, { 'Linear-Signature': signed(json.padEnd(size)) }), config, machines, clock.now);
  };
  assert.equal((await sendSized(MAX_WEBHOOK_BYTES + 1)).status, 413);
  assert.deepEqual(rows().jobs, []);
  assert.equal((await sendSized(MAX_WEBHOOK_BYTES)).status, 200);
  assert.equal(rows().jobs.length, 1);
});

test('a webhook with a well-formed signature and an empty body is a bad request', async () => {
  assert.equal((await handleWebhook(webhookRequest(null, WELL_FORMED), config, refuseQueue)).status, 400);
});

test('an expired claim cannot change the outcome of the claim that replaced it', async () => {
  const { clock, created, claimed, report, rows } = setup();
  await created('session-1');
  const a = await claimed();
  clock.now += LEASE_MS;
  const b = await claimed();
  assert.equal(b?.sessionId, 'session-1');
  assert.notEqual(a?.claimId, b?.claimId);
  assert.equal((await report('session-1', 'launched', a?.claimId)).status, 409);
  assert.equal(rows().jobs[0]!.state, 'claimed');
  assert.equal((await report('session-1', 'failed', b?.claimId)).status, 204);
  assert.equal((await report('session-1', 'launched', a?.claimId)).status, 409);
  assert.equal(rows().jobs[0]!.state, 'failed');
});

test('a claim past its lease is refused even before anyone reclaims the job', async () => {
  const { clock, created, claimed, report, rows } = setup();
  await created('session-1');
  const a = await claimed();
  clock.now += LEASE_MS;
  assert.equal((await report('session-1', 'launched', a?.claimId)).status, 409);
  assert.equal(rows().jobs[0]!.state, 'claimed');
  assert.equal((await claimed())?.sessionId, 'session-1');
});

test('an outcome without a claim id is a bad request', async () => {
  const { created, claim, runner, rows } = setup();
  await created('session-1');
  await claim();
  assert.equal((await runner('POST', '/jobs/session-1/launched')).status, 400);
  assert.equal((await runner('POST', '/jobs/session-1/failed?claimId=')).status, 400);
  assert.equal(rows().jobs[0]!.state, 'claimed');
});

test('an existing installation keeps its jobs, and a pre-change claim expires into a fresh one', async () => {
  const { clock, claimed, runner, report, rebuild, rows } = setup((db, now) => {
    db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL,
      state TEXT NOT NULL, lease_until INTEGER, updated_at INTEGER NOT NULL)`);
    db.prepare("INSERT INTO jobs VALUES ('old-claim', 'issue-1', 'claimed', ?, ?)").run(now + LEASE_MS, now);
    db.prepare("INSERT INTO jobs VALUES ('old-queued', 'issue-2', 'queued', NULL, ?)").run(now);
  });
  rebuild(); // The column is added only once.
  // The old runner has no id to send, and no guess matches the empty column.
  assert.equal((await runner('POST', '/jobs/old-claim/launched')).status, 400);
  assert.equal((await report('old-claim', 'launched', 'guess')).status, 409);
  const queued = await claimed();
  assert.equal(queued?.sessionId, 'old-queued');
  assert.equal((await report('old-queued', 'launched', queued?.claimId)).status, 204);
  assert.equal(await claimed(), undefined);
  clock.now += LEASE_MS;
  const reclaimed = await claimed();
  assert.equal(reclaimed?.sessionId, 'old-claim');
  assert.equal((await report('old-claim', 'failed', reclaimed?.claimId)).status, 204);
  assert.deepEqual(rows().jobs.map((j) => j.state), ['failed', 'launched']);
});

const prompt = (activityId: string | undefined, sessionId = 'session-1') => {
  const payload = fixture('prompted');
  payload.agentSession.id = sessionId;
  payload.agentActivity.id = activityId;
  return payload;
};

test('a redelivered prompt gets one thought; a distinct prompt in the session gets its own', async () => {
  const { send, deliver, flush, posts, rows } = setup();
  // The first copy is still pending when its redelivery lands.
  assert.equal((await send(prompt('activity-a'))).status, 200);
  assert.equal((await send(prompt('activity-a'))).status, 200);
  await flush();
  // And once it's delivered.
  assert.equal((await deliver(prompt('activity-a'))).status, 200);
  assert.equal((await deliver(prompt('activity-b'))).status, 200);
  assert.deepEqual(sent(posts), [['session-1', 'thought', MESSAGES.replies], ['session-1', 'thought', MESSAGES.replies]]);
  assert.deepEqual(rows().outbox, []);
});

test('a prompt without an activity id is a bad request', async () => {
  const { deliver, posts, rows } = setup();
  assert.equal((await deliver(prompt(undefined))).status, 400);
  assert.equal(posts.length, 0);
  assert.deepEqual(rows().outbox, []);
});

test('prompt dedupe records expire with the rest of the history', async () => {
  const { clock, deliver, flush, posts } = setup();
  await deliver(prompt('activity-a'));
  clock.now += 30 * 86_400_000;
  await flush();
  await deliver(prompt('activity-a'));
  assert.equal(posts.length, 2);
});

test('a duplicate stop writes no second final response', async () => {
  const { deliver, send, flush, stoppedPayload, posts, rows } = setup();
  // The first response is still pending when its redelivery lands.
  await send(stoppedPayload('session-1'));
  assert.equal((await send(stoppedPayload('session-1'))).status, 200);
  await flush();
  // And once it's delivered, including a second stop with its own activity id.
  assert.equal((await deliver(stoppedPayload('session-1'))).status, 200);
  const another = stoppedPayload('session-1');
  another.agentActivity.id = 'activity-other';
  assert.equal((await deliver(another)).status, 200);
  assert.deepEqual(sent(posts), [['session-1', 'response', MESSAGES.stopped]]);
  assert.deepEqual(rows().outbox, []);
});

test('a stop without an activity id still stops the session, once', async () => {
  const { created, deliver, stoppedPayload, posts, rows } = setup();
  await created('session-1');
  const stop = stoppedPayload('session-1');
  delete stop.agentActivity.id;
  assert.equal((await deliver(stop)).status, 200);
  assert.equal((await deliver(stop)).status, 200);
  assert.deepEqual(sent(posts), [['session-1', 'thought', QUEUED], ['session-1', 'response', MESSAGES.stopped]]);
  assert.deepEqual(rows().jobs, []);
});

test('the alarm alone expires an activity failing for 30 days, logs it, and frees what waited on it', async (t) => {
  const { created, send, flush, linear, posts, rows, clock } = setup();
  linear.failNext = 1;
  await created('session-1');
  assert.equal(linear.attempts, 1);
  // Written later, so still inside the window: it goes out once the head expires.
  clock.now += 24 * 3_600_000;
  await send(prompt('activity-a'));
  clock.now += 30 * 86_400_000 - 24 * 3_600_000;
  const logged = t.mock.method(console, 'log', () => {});
  await flush();
  const lines = logged.mock.calls.map((call) => JSON.parse(String(call.arguments[0])));
  assert.deepEqual(lines, [{ event: 'activity', machine: 'example-machine', session: 'session-1', type: 'thought', outcome: 'expired' }]);
  assert.deepEqual(sent(posts), [['session-1', 'thought', MESSAGES.replies]]);
  assert.equal(linear.attempts, 2);
  assert.deepEqual(rows().outbox, []);
  assert.deepEqual(rows().jobs, [{ id: 'session-1', issue_id: 'issue-1', state: 'queued' }]);
});

// The Runner API's named operations on a claimed job.

type Harness = ReturnType<typeof setup>;
const OPERATIONS: [method: string, op: string, body?: unknown][] = [
  ['GET', 'task'], ['GET', 'watch'], ['POST', 'updates', { type: 'thought', body: 'Working.' }],
  ['POST', 'pull-request'], ['POST', 'launched'], ['POST', 'failed'],
];
/** Calls an operation on a job with a claim id. */
const call = (h: Harness, method: string, op: string, claimId: string | undefined, body?: unknown, session = 'session-1', bearer = BEARER) =>
  h.runner(method, `/jobs/${session}/${op}?claimId=${claimId}`, bearer, body);
const update = (h: Harness, claimId: string | undefined, type: string, body: string, session = 'session-1') =>
  call(h, 'POST', 'updates', claimId, { type, body }, session);
/** A harness with session-1 (issue-1) claimed, its queued thought already sent. */
async function claimedJob() {
  const h = setup();
  await h.created('session-1');
  const claim = await h.claimed();
  h.posts.length = 0;
  h.linear.requests.length = 0;
  return { ...h, claimId: claim!.claimId };
}

for (const [method, op, body] of OPERATIONS) {
  test(`${method} ${op} needs the bearer secret, a claim id and a current claim by this machine`, async () => {
    const h = await claimedJob();
    assert.equal((await call(h, method, op, h.claimId, body, 'session-1', 'x'.repeat(32))).status, 401);
    assert.equal((await h.runner(method, `/jobs/session-1/${op}`, BEARER, body)).status, 400);
    assert.equal((await call(h, method, op, 'not-the-claim', body)).status, 409);
    // Another machine's bearer secret reaches only that machine's queue, where this job doesn't exist.
    const other = setup();
    const res = await handleRunner(new Request(`https://cloud-inbox.example/jobs/session-1/${op}?claimId=${h.claimId}`, {
      method, headers: { Authorization: `Bearer ${'o'.repeat(32)}` }, body: body === undefined ? undefined : JSON.stringify(body),
    }), config, (name) => (name === 'other-machine' ? other.machines() : h.machines()));
    assert.equal(res.status, 409);
    // An unclaimed job, and a claim past its lease, are refused too.
    await h.created('session-2', 'issue-2');
    assert.equal((await call(h, method, op, h.claimId, body, 'session-2')).status, 409);
    h.clock.now += LEASE_MS;
    assert.equal((await call(h, method, op, h.claimId, body)).status, 409);
    await h.flush();
    assert.deepEqual(sent(h.posts), [['session-2', 'thought', QUEUED]]); // From session-2's own delegation.
    assert.deepEqual(h.linear.requests, []);
  });
}

test('task returns what the Runner checks, read from the job and never from the request', async () => {
  const h = await claimedJob();
  const res = await h.runner('GET', `/jobs/session-1/task?claimId=${h.claimId}&issueId=issue-2&sessionId=session-2`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    delegated: true, creatorId: 'user-creator', identifier: 'ABC-1', description: 'Task for ABC-1',
    branchName: 'abc-1', statusType: 'unstarted',
  });
  assert.deepEqual(h.linear.requests.map((r) => r.variables), [{ issue: 'issue-1', session: 'session-1' }]);

  h.linear.world.issues['issue-1']!.delegateId = 'someone-else';
  h.linear.world.sessions['session-1']!.creatorId = null;
  const task = await (await call(h, 'GET', 'task', h.claimId)).json();
  assert.equal(task.delegated, false);
  assert.equal(task.creatorId, null);
});

test('task and watch answer 502 when Linear fails', async () => {
  const h = await claimedJob();
  h.linear.failNext = 2;
  assert.equal((await call(h, 'GET', 'task', h.claimId)).status, 502);
  assert.equal((await call(h, 'GET', 'watch', h.claimId)).status, 502);
});

test('a status update posts only its type and body, on the job session', async () => {
  const h = await claimedJob();
  const res = await call(h, 'POST', 'updates', h.claimId,
    { type: 'thought', body: 'Started.', agentSessionId: 'session-2', sessionId: 'session-2', content: { type: 'action' } });
  assert.equal(res.status, 202);
  await h.flush();
  assert.deepEqual(sent(h.posts), [['session-1', 'thought', 'Started.']]);
});

for (const [label, body, status] of [
  ['another activity type', { type: 'action', body: 'x' }, 400],
  ['an empty body', { type: 'thought', body: '  ' }, 400],
  ['a body over the limit', { type: 'thought', body: 'x'.repeat(MAX_UPDATE_CHARS + 1) }, 400],
  ['a non-string body', { type: 'thought', body: { text: 'x' } }, 400],
  ['a request over 16 KiB', { type: 'thought', body: 'x'.repeat(17 * 1024) }, 413],
] as const) {
  test(`a status update with ${label} gets ${status} and posts nothing`, async () => {
    const h = await claimedJob();
    assert.equal((await call(h, 'POST', 'updates', h.claimId, body)).status, status);
    await h.flush();
    assert.deepEqual(h.posts, []);
  });
}

test('a status update at the limit is accepted', async () => {
  const h = await claimedJob();
  assert.equal((await update(h, h.claimId, 'thought', 'x'.repeat(MAX_UPDATE_CHARS))).status, 202);
});

test('status updates retry through the outbox and keep per-session order', async () => {
  const h = await claimedJob();
  h.linear.failNext = 1;
  await update(h, h.claimId, 'thought', 'First.');
  await update(h, h.claimId, 'thought', 'Second.');
  await h.flush();
  assert.deepEqual(h.posts, []); // Second waits behind First.
  h.rebuild(); // And both survive a restart.
  h.clock.now += 10_000;
  await h.flush();
  assert.deepEqual(sent(h.posts), [['session-1', 'thought', 'First.'], ['session-1', 'thought', 'Second.']]);
});

test("a queued thought still pending at claim never lands after the Runner's update", async () => {
  const h = setup();
  h.linear.failNext = 1;
  await h.created('session-1');
  const { claimId } = (await h.claimed())!;
  await update(h, claimId, 'thought', 'Started.');
  h.clock.now += 10_000;
  await h.flush();
  assert.deepEqual(sent(h.posts), [['session-1', 'thought', 'Started.']]);
});

test("a queued thought in flight at claim lands before the Runner's update", async () => {
  const h = setup();
  await h.send(h.createdPayload('session-1'));
  const { waiting, release } = h.linear.hold();
  const delivering = h.flush();
  await waiting; // Linear holds the queued thought.
  const { claimId } = await (await h.runner('POST', '/jobs/claim')).json();
  await update(h, claimId, 'thought', 'Started.');
  release();
  await delivering;
  assert.deepEqual(sent(h.posts), [['session-1', 'thought', QUEUED], ['session-1', 'thought', 'Started.']]);
});

for (const type of ['response', 'error']) {
  test(`a ${type} ends the session, so later updates are refused`, async () => {
    const h = await claimedJob();
    assert.equal((await update(h, h.claimId, type, 'Done.')).status, 202);
    assert.equal((await update(h, h.claimId, 'thought', 'Late.')).status, 409);
    await h.flush();
    assert.deepEqual(sent(h.posts), [['session-1', type, 'Done.']]);
  });
}

test('a stopped session refuses status updates', async () => {
  const h = await claimedJob();
  await h.deliver(h.stoppedPayload('session-1'));
  assert.equal((await update(h, h.claimId, 'thought', 'Started.')).status, 409);
});

test('a launched job still takes updates and watch calls from the claim that launched it', async () => {
  const h = await claimedJob();
  assert.equal((await call(h, 'POST', 'launched', h.claimId)).status, 204);
  h.clock.now += 2 * LEASE_MS;
  assert.equal((await call(h, 'GET', 'watch', h.claimId)).status, 200);
  assert.equal((await update(h, h.claimId, 'response', 'Opened.')).status, 202);
  assert.equal((await update(h, 'another-claim', 'response', 'Opened.')).status, 409);
});

test('a failed job takes no more operations', async () => {
  const h = await claimedJob();
  assert.equal((await call(h, 'POST', 'failed', h.claimId)).status, 204);
  assert.equal((await update(h, h.claimId, 'error', 'Late.')).status, 409);
  assert.equal((await call(h, 'GET', 'task', h.claimId)).status, 409);
});

test('launched sets In Progress, the Orca label and the creator as assignee, and nothing else', async () => {
  const h = await claimedJob();
  const before = structuredClone(h.linear.world.issues['issue-1']!);
  await update(h, h.claimId, 'thought', 'Started.');
  await call(h, 'POST', 'launched', h.claimId);
  await h.flush();
  assert.deepEqual(h.linear.world.issues['issue-1'], {
    ...before, stateId: 'state-progress', assigneeId: 'user-creator', labelIds: ['label-factory', 'label-orca'],
  });
  assert.deepEqual(h.linear.world.issues['issue-2'], fakeWorld().issues['issue-2']);
  assert.deepEqual(sent(h.posts), [['session-1', 'thought', 'Started.']]);
  // The thought went before the write-back.
  assert.equal(h.linear.requests.filter((r) => r.query.includes('issueUpdate')).length, 1);
});

for (const [label, stateId] of [['already started', 'state-review'], ['done', 'state-done']]) {
  test(`launched keeps the status of an issue ${label}`, async () => {
    const h = await claimedJob();
    h.linear.world.issues['issue-1']!.stateId = stateId!;
    await call(h, 'POST', 'launched', h.claimId);
    await h.flush();
    assert.equal(h.linear.world.issues['issue-1']!.stateId, stateId);
    assert.equal(h.linear.world.issues['issue-1']!.assigneeId, 'user-creator');
  });
}

test("launched's write-back retries until Linear accepts it", async () => {
  const h = await claimedJob();
  h.linear.failNext = 1;
  await call(h, 'POST', 'launched', h.claimId);
  await h.flush();
  assert.equal(h.linear.world.issues['issue-1']!.stateId, 'state-todo');
  h.clock.now += 10_000;
  await h.flush();
  assert.equal(h.linear.world.issues['issue-1']!.stateId, 'state-progress');
  assert.deepEqual(h.rows().outbox, []);
});

test('failed clears the delegate and nothing else', async () => {
  const h = await claimedJob();
  const before = structuredClone(h.linear.world.issues['issue-1']!);
  await update(h, h.claimId, 'error', 'Repo not allowed. Fix it and delegate again to retry.');
  await call(h, 'POST', 'failed', h.claimId);
  await h.flush();
  assert.deepEqual(h.linear.world.issues['issue-1'], { ...before, delegateId: null });
  assert.deepEqual(sent(h.posts), [['session-1', 'error', 'Repo not allowed. Fix it and delegate again to retry.']]);
});

test("failed leaves a delegate that isn't this app", async () => {
  const h = await claimedJob();
  h.linear.world.issues['issue-1']!.delegateId = 'another-app';
  await call(h, 'POST', 'failed', h.claimId);
  await h.flush();
  assert.equal(h.linear.world.issues['issue-1']!.delegateId, 'another-app');
  assert.equal(h.linear.requests.filter((r) => r.query.includes('issueUpdate')).length, 0);
  assert.deepEqual(h.rows().outbox, []);
});

test("a failed job's delayed release leaves a newer delegation to this app alone", async () => {
  const h = await claimedJob();
  h.linear.failNext = 1;
  await call(h, 'POST', 'failed', h.claimId);
  await h.flush();
  // Delegated again while the release waits to retry; another issue's session is unaffected.
  await h.created('session-2');
  await h.created('session-3', 'issue-2');
  h.clock.now += 10_000;
  await h.flush();
  assert.equal(h.linear.world.issues['issue-1']!.delegateId, 'app-user-example');
  assert.equal(h.linear.requests.filter((r) => r.query.includes('issueUpdate')).length, 0);
  assert.deepEqual(sent(h.posts), [['session-2', 'thought', QUEUED], ['session-3', 'thought', QUEUED]]);
  assert.deepEqual(h.rows().outbox, []);
});

for (const [label, change] of [
  ['handed to another app', (h: Harness) => { h.linear.world.issues['issue-1']!.delegateId = 'another-app'; }],
  ['delegated again to this app', (h: Harness) => h.created('session-2')],
] as const) {
  test(`a delayed launch write-back changes nothing once the issue is ${label}`, async () => {
    const h = await claimedJob();
    h.linear.failNext = 1;
    await call(h, 'POST', 'launched', h.claimId);
    await h.flush();
    await change(h);
    const before = structuredClone(h.linear.world.issues['issue-1']!);
    h.clock.now += 10_000;
    await h.flush();
    assert.deepEqual(h.linear.world.issues['issue-1'], before);
    assert.equal(h.linear.requests.filter((r) => r.query.includes('issueUpdate')).length, 0);
    assert.deepEqual(h.rows().outbox, []);
  });
}

// A newer delegation whose job is then deleted, before its claim or after a stopped claim expires.
const forgotten: [label: string, wait: number, drop: (h: Harness) => Promise<unknown>][] = [
  ['stopped before its claim', 10_000, (h) => h.deliver(h.stoppedPayload('session-2'))],
  ['stopped after its claim and expired', LEASE_MS, async (h) => {
    assert.equal((await h.claimed())?.sessionId, 'session-2');
    await h.deliver(h.stoppedPayload('session-2'));
  }],
];
for (const outcome of ['launched', 'failed']) {
  for (const [label, wait, drop] of forgotten) {
    test(`a delayed ${outcome} write-back stays superseded after the newer job is ${label}, across a restart`, async () => {
      const h = await claimedJob();
      h.linear.failNext = 1;
      await call(h, 'POST', outcome, h.claimId);
      await h.flush();
      await h.created('session-2');
      await drop(h);
      const before = structuredClone(h.linear.world.issues['issue-1']!);
      h.rebuild();
      h.clock.now += wait;
      await h.flush();
      assert.ok(!h.rows().jobs.some((j) => j.id === 'session-2'));
      assert.deepEqual(h.linear.world.issues['issue-1'], before);
      assert.equal(h.linear.requests.filter((r) => r.query.includes('issueUpdate')).length, 0);
      assert.deepEqual(h.rows().outbox, []);
    });
  }
}

test('a row cancelled in flight neither deletes nor blocks newer activity', async () => {
  const h = setup();
  (h.data.get('token') as { expiresAt: number }).expiresAt = h.clock.now + 1000;
  await h.send(h.createdPayload('session-1'));
  const { waiting, release } = h.linear.hold();
  const delivering = h.flush();
  await waiting; // Linear holds the token refresh for the queued thought.
  const { claimId } = await (await h.runner('POST', '/jobs/claim')).json() as { claimId: string };
  assert.equal((await update(h, claimId, 'thought', 'Working.')).status, 202);
  await h.send(h.createdPayload('session-2', 'issue-2'));
  release();
  await delivering;
  assert.deepEqual(sent(h.posts), [['session-1', 'thought', 'Working.'], ['session-2', 'thought', QUEUED]]);
  assert.deepEqual(h.rows().outbox, []);
});

test('watch returns the session status and only GitHub pull request links', async () => {
  const h = await claimedJob();
  h.linear.world.issues['issue-1']!.attachments = [
    'https://example.com/doc', 'https://github.com/owner/repo/issues/3', 'https://github.com/owner/repo/pull/7',
    'https://github.com/owner/repo/pull/8/files', 'https://github.com.evil.example/owner/repo/pull/9',
  ];
  h.linear.world.sessions['session-1'] = { creatorId: 'user-creator', status: 'complete', links: [] };
  const res = await h.runner('GET', `/jobs/session-1/watch?claimId=${h.claimId}&issueId=issue-2`);
  assert.deepEqual(await res.json(), {
    sessionStatus: 'complete',
    pullRequests: ['https://github.com/owner/repo/pull/7', 'https://github.com/owner/repo/pull/8/files'],
  });
  assert.deepEqual(h.linear.requests.map((r) => r.variables), [{ issue: 'issue-1', session: 'session-1' }]);
});

test("pull-request links the issue's first pull request on the job session, and 409 without one", async () => {
  const h = await claimedJob();
  assert.equal((await call(h, 'POST', 'pull-request', h.claimId)).status, 409);
  h.linear.world.issues['issue-1']!.attachments = ['https://github.com/owner/repo/pull/7', 'https://github.com/owner/repo/pull/8'];
  const res = await call(h, 'POST', 'pull-request', h.claimId, { url: 'https://evil.example', session: 'session-2' });
  assert.deepEqual(await res.json(), { url: 'https://github.com/owner/repo/pull/7' });
  assert.deepEqual(h.linear.world.sessions['session-1']!.links, ['https://github.com/owner/repo/pull/7']);
  assert.deepEqual(h.linear.requests.at(-1)!.variables, { session: 'session-1', url: 'https://github.com/owner/repo/pull/7' });
});

test('Runner operations never log task content, activity bodies or tokens', async (t) => {
  const logged = t.mock.method(console, 'log', () => {});
  const h = await claimedJob();
  await call(h, 'GET', 'task', h.claimId);
  await update(h, h.claimId, 'thought', 'secret-body');
  h.linear.failNext = 1;
  await h.flush();
  const output = logged.mock.calls.map((c) => String(c.arguments[0])).join('\n');
  assert.doesNotMatch(output, /Task for|secret-body|access-example|bbbbbbbb/);
  assert.match(output, /"event":"task"/);
});
