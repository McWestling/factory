import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MachineAuth, type Config, type Storage } from './auth.ts';
import { MachineQueue, MESSAGES, type Sql } from './queue.ts';
import { handleDaemon, handleWebhook } from './routes.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, any>;

const ORG = 'org-example';
const WEBHOOK_SECRET = 'webhook-secret-example';
const BEARER = 'b'.repeat(32);
const config: Config = {
  orgId: ORG,
  adminSecret: 'a'.repeat(32),
  machines: {
    'example-machine': { clientId: 'client-example', clientSecret: 's', webhookSecret: WEBHOOK_SECRET, bearerSecret: BEARER },
    'other-machine': { clientId: 'client-other', clientSecret: 's', webhookSecret: 'other', bearerSecret: 'o'.repeat(32) },
  },
};
const LEASE_MS = 10 * 60_000;

/** A machine installed as `app-user-example`, with node:sqlite standing in for the Durable Object's SQL. */
function setup() {
  const db = new DatabaseSync(':memory:');
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
    appUserId: 'app-user-example', appName: 'Example Machine', orgId: ORG, clientId: 'client-example',
  });
  // Fakes Linear. `posts` records each activity Linear accepted, in order. `failNext`
  // fails that many activity requests; `refreshFails` fails token refreshes; `hold()`
  // holds the next activity request until released.
  const posts: { auth: string; sessionId: string; type: string; body: string }[] = [];
  const linear = { failNext: 0, refreshFails: false, attempts: 0, hold };
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
    if (String(input) === 'https://api.linear.app/oauth/token') {
      if (linear.refreshFails) return new Response(null, { status: 500 });
      return Response.json({ access_token: 'access-refreshed', refresh_token: 'refresh-2', expires_in: 86400 });
    }
    assert.equal(String(input), 'https://api.linear.app/graphql');
    linear.attempts++;
    const pause = held;
    held = undefined;
    if (pause) {
      pause.reached();
      await pause.released;
    }
    if (linear.failNext > 0) {
      linear.failNext--;
      return new Response(null, { status: 503 });
    }
    const { input: activity } = JSON.parse(String(init?.body)).variables;
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
  });

  /** Delivers a webhook without firing the alarm. */
  const send = (payload: Record<string, any>, sign: (body: string) => string = signed) => {
    // Fixtures carry webhookTimestamp 0, meaning "now".
    const body = JSON.stringify({ ...payload, webhookTimestamp: payload.webhookTimestamp || clock.now });
    const request = new Request('https://relay.example/webhook', {
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
  const daemon = (method: string, path: string, bearer = BEARER) =>
    handleDaemon(new Request(`https://relay.example${path}`, { method, headers: { Authorization: `Bearer ${bearer}` } }),
      config, () => queue);
  const claim = async () => {
    const res = await daemon('POST', '/jobs/claim');
    await flush();
    return res.status === 204 ? undefined : await res.json();
  };
  return {
    clock, posts, linear, alarms, rows, send, deliver, flush, rebuild, created, createdPayload, stoppedPayload,
    daemon, claim, data,
  };
}

const signed = (body: string) => createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

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
    assert.deepEqual(rows(), { jobs: [], seen: [], outbox: [] });
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
    { sessionId: 'session-1', type: 'response', body: 'Replaced by a newer dispatch.' },
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
    body: "Dispatch doesn't read replies; steer the agent in Orca.",
  });
  assert.equal(rows().jobs.length, 1);
});

test('the daemon API rejects a wrong or missing bearer secret with 401', async () => {
  const { daemon, created, rows } = setup();
  await created('session-1');
  for (const [method, path] of [['POST', '/jobs/claim'], ['POST', '/jobs/session-1/launched'], ['GET', '/token']]) {
    assert.equal((await daemon(method!, path!, 'x'.repeat(32))).status, 401);
    assert.equal((await daemon(method!, path!, '')).status, 401);
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
  const { clock, created, claim, daemon } = setup();
  await created('session-1');
  await claim();
  clock.now += LEASE_MS - 1;
  assert.equal(await claim(), undefined);
  clock.now += 1;
  assert.deepEqual(await claim(), { issueId: 'issue-1', sessionId: 'session-1' });
  assert.equal((await daemon('POST', '/jobs/session-1/launched')).status, 204);
});

test('an expired lease is replaced by a newer dispatch of its issue', async () => {
  const { clock, created, claim, posts } = setup();
  await created('session-1');
  await claim();
  await created('session-2');
  clock.now += LEASE_MS;
  assert.deepEqual(await claim(), { issueId: 'issue-1', sessionId: 'session-2' });
  assert.deepEqual(posts.at(-1), {
    auth: 'Bearer access-example', sessionId: 'session-1', type: 'response', body: 'Replaced by a newer dispatch.',
  });
  assert.equal(await claim(), undefined);
});

test('launched and failed record the outcome of a claimed job only', async () => {
  const { created, claim, daemon, rows } = setup();
  await created('session-1', 'issue-1');
  await created('session-2', 'issue-2');
  assert.equal((await daemon('POST', '/jobs/session-1/launched')).status, 409);
  await claim();
  await claim();
  assert.equal((await daemon('POST', '/jobs/session-1/launched')).status, 204);
  assert.equal((await daemon('POST', '/jobs/session-2/failed')).status, 204);
  assert.equal((await daemon('POST', '/jobs/session-1/failed')).status, 409);
  assert.deepEqual(rows().jobs.map((j) => j.state), ['launched', 'failed']);
});

test('history and dedupe records are kept for 30 days', async () => {
  const { clock, created, claim, daemon, rows } = setup();
  await created('session-1');
  await claim();
  await daemon('POST', '/jobs/session-1/launched');
  clock.now += 30 * 86_400_000 - 1;
  await claim();
  assert.equal(rows().jobs.length, 1);
  clock.now += 1;
  await claim();
  assert.deepEqual(rows(), { jobs: [], seen: [], outbox: [] });
});

test('the token endpoint lends the cached token, rate-limited per machine', async () => {
  const { clock, daemon } = setup();
  const res = await daemon('GET', '/token');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await res.json(), { accessToken: 'access-example' });
  const limited = await daemon('GET', '/token');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '10');
  clock.now += 10_000;
  assert.equal((await daemon('GET', '/token')).status, 200);
});

test('unknown daemon routes are 404 once authenticated', async () => {
  const { daemon } = setup();
  assert.equal((await daemon('GET', '/jobs/claim')).status, 404);
  assert.equal((await daemon('POST', '/jobs/session-1/other')).status, 404);
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
