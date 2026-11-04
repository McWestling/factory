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
  const posts: { auth: string; sessionId: string; type: string; body: string }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.linear.app/graphql');
    const { input: activity } = JSON.parse(String(init?.body)).variables;
    posts.push({
      auth: new Headers(init?.headers).get('Authorization')!,
      sessionId: activity.agentSessionId, type: activity.content.type, body: activity.content.body,
    });
    return Response.json({ data: { agentActivityCreate: { success: true } } });
  };
  const auth = new MachineAuth(storage, config.machines['example-machine']!, ORG, fetchFn, () => clock.now);
  const queue = new MachineQueue(sql, auth, 'example-machine', fetchFn, () => clock.now);
  const rows = () => ({
    jobs: db.prepare('SELECT id, issue_id, state FROM jobs ORDER BY rowid').all().map((row) => ({ ...row })),
    seen: db.prepare('SELECT session_id FROM seen').all().map((row) => ({ ...row })),
  });

  const deliver = (payload: Record<string, any>, sign: (body: string) => string = signed) => {
    // Fixtures carry webhookTimestamp 0, meaning "now".
    const body = JSON.stringify({ ...payload, webhookTimestamp: payload.webhookTimestamp || clock.now });
    const request = new Request('https://relay.example/webhook', {
      method: 'POST', body, headers: { 'Linear-Signature': sign(body) },
    });
    return handleWebhook(request, config, () => queue, clock.now);
  };
  const created = (sessionId: string, issueId = 'issue-1') => {
    const payload = fixture('created');
    payload.agentSession.id = sessionId;
    payload.agentSession.issueId = payload.agentSession.issue.id = issueId;
    return deliver(payload);
  };
  const daemon = (method: string, path: string, bearer = BEARER) =>
    handleDaemon(new Request(`https://relay.example${path}`, { method, headers: { Authorization: `Bearer ${bearer}` } }),
      config, () => queue);
  const claim = async () => {
    const res = await daemon('POST', '/jobs/claim');
    return res.status === 204 ? undefined : await res.json();
  };
  return { clock, posts, rows, deliver, created, daemon, claim };
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
    assert.deepEqual(rows(), { jobs: [], seen: [] });
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
  assert.deepEqual(rows(), { jobs: [], seen: [] });
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
