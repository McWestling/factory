import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAdmin, MachineAuth, readConfig, type Storage } from './auth.ts';

const ORG = 'org-example';
const REDIRECT = 'https://cloud-inbox.example/callback/example-machine';
const client = { clientId: 'client-example', clientSecret: 'client-secret-example' };
const secret = 'x'.repeat(32);

function memoryStorage(): Storage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async put(key: string, value: unknown) { data.set(key, structuredClone(value)); },
    async delete(key: string) { return data.delete(key); },
  };
}

/**
 * Fakes Linear: the token endpoint and a viewer in `org`. Records each call.
 * `pause()` holds the next token response: await `reached`, then call `release`.
 */
function fakeLinear(org = ORG) {
  const calls: { url: string; body: string }[] = [];
  let issued = 0;
  let hold: { reached: () => void; released: Promise<void> } | undefined;
  const pause = () => {
    let release!: () => void;
    let reached!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    hold = { reached, released };
    return { waiting, release };
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body) });
    if (url === 'https://api.linear.app/oauth/token') {
      const n = ++issued;
      const held = hold;
      hold = undefined;
      if (held) {
        held.reached();
        await held.released;
      }
      return Response.json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 86400, scope: 'read write app:assignable' });
    }
    if (url === 'https://api.linear.app/graphql') {
      return Response.json({ data: { viewer: { id: 'app-user-example', name: 'Example Machine', organization: { id: org } } } });
    }
    return new Response(null, { status: 404 });
  };
  return { fetchFn, calls, pause };
}

function setup(org = ORG) {
  const storage = memoryStorage();
  const linear = fakeLinear(org);
  const clock = { now: 1_000_000 };
  const auth = new MachineAuth(storage, client, ORG, linear.fetchFn, () => clock.now);
  return { storage, linear, clock, auth };
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

test('install redirects to Linear as the app with the Cloud Inbox scopes', async () => {
  const { auth } = setup();
  const url = new URL((await auth.startInstall(REDIRECT, true))!);
  assert.equal(url.origin + url.pathname, 'https://linear.app/oauth/authorize');
  assert.equal(url.searchParams.get('actor'), 'app');
  assert.equal(url.searchParams.get('scope'), 'read,write,app:assignable');
  assert.equal(url.searchParams.get('client_id'), client.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.match(url.searchParams.get('state')!, /^[0-9a-f]{64}$/);
});

test('a valid callback stores the tokens and the app user id', async () => {
  const { auth, storage } = setup();
  const state = stateOf((await auth.startInstall(REDIRECT, true))!);
  assert.deepEqual(await auth.completeInstall(state, 'code', REDIRECT), { ok: true, appUserId: 'app-user-example' });
  assert.deepEqual(storage.data.get('token'), {
    accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 1_000_000 + 86_400_000, appUserId: 'app-user-example',
    appName: 'Example Machine', orgId: ORG, clientId: client.clientId, scopes: ['read', 'write', 'app:assignable'],
  });
});

test('a wrong state is rejected before any call to Linear', async () => {
  const { auth, linear } = setup();
  await auth.startInstall(REDIRECT, true);
  assert.deepEqual(await auth.completeInstall('0'.repeat(64), 'code', REDIRECT), { ok: false, reason: 'state' });
  assert.equal(linear.calls.length, 0);
});

test('a reused state is rejected', async () => {
  const { auth } = setup();
  const state = stateOf((await auth.startInstall(REDIRECT, true))!);
  assert.equal((await auth.completeInstall(state, 'code', REDIRECT)).ok, true);
  assert.deepEqual(await auth.completeInstall(state, 'code', REDIRECT), { ok: false, reason: 'state' });
});

test('an expired state is rejected and consumed', async () => {
  const { auth, clock, linear, storage } = setup();
  const state = stateOf((await auth.startInstall(REDIRECT, true))!);
  clock.now += 10 * 60_000;
  assert.deepEqual(await auth.completeInstall(state, 'code', REDIRECT), { ok: false, reason: 'state' });
  assert.equal(storage.data.has('oauthState'), false);
  assert.equal(linear.calls.length, 0);
});

test('a newer install replaces the pending state', async () => {
  const { auth } = setup();
  const first = stateOf((await auth.startInstall(REDIRECT, true))!);
  await auth.startInstall(REDIRECT, true);
  assert.deepEqual(await auth.completeInstall(first, 'code', REDIRECT), { ok: false, reason: 'state' });
});

test('a token from another workspace is rejected and not stored', async () => {
  const { auth, storage } = setup('org-other');
  const state = stateOf((await auth.startInstall(REDIRECT, true))!);
  assert.deepEqual(await auth.completeInstall(state, 'code', REDIRECT), { ok: false, reason: 'org' });
  assert.equal(storage.data.has('token'), false);
});

test('a reinstall without the admin secret is rejected', async () => {
  const { auth } = setup();
  await auth.completeInstall(stateOf((await auth.startInstall(REDIRECT, true))!), 'code', REDIRECT);
  assert.equal(await auth.startInstall(REDIRECT, false), undefined);
});

test('a first-install state cannot replace an existing token', async () => {
  const { auth, storage } = setup();
  const before = stateOf((await auth.startInstall(REDIRECT, true))!);
  // Simulate a token landing after this state was issued.
  await storage.put('token', { accessToken: 'a', refreshToken: 'r', expiresAt: 0, appUserId: 'u' });
  assert.deepEqual(await auth.completeInstall(before, 'code', REDIRECT), { ok: false, reason: 'reinstall' });
});

test('a reinstall with the admin secret replaces the token', async () => {
  const { auth, storage } = setup();
  await auth.completeInstall(stateOf((await auth.startInstall(REDIRECT, true))!), 'code', REDIRECT);
  const state = stateOf((await auth.startInstall(REDIRECT, true))!);
  assert.equal((await auth.completeInstall(state, 'code', REDIRECT)).ok, true);
  assert.equal((storage.data.get('token') as { accessToken: string }).accessToken, 'access-2');
});

test('getAccessToken returns the cached token and refreshes once near expiry', async () => {
  const { auth, clock, linear } = setup();
  await auth.completeInstall(stateOf((await auth.startInstall(REDIRECT, true))!), 'code', REDIRECT);
  assert.equal(await auth.getAccessToken(), 'access-1');
  clock.now += 23 * 60 * 60_000 + 1;
  assert.deepEqual(await Promise.all([auth.getAccessToken(), auth.getAccessToken()]), ['access-2', 'access-2']);
  const refreshes = linear.calls.filter((c) => c.body.includes('grant_type=refresh_token'));
  assert.equal(refreshes.length, 1);
  assert.match(refreshes[0]!.body, /refresh_token=refresh-1/);
  assert.equal(await auth.getAccessToken(), 'access-2');
});

test('getAccessToken fails before install', async () => {
  await assert.rejects(setup().auth.getAccessToken(), /not installed/);
});

test('isAdmin accepts only Basic auth with the admin secret', () => {
  const basic = (v: string) => new Request('https://cloud-inbox.example', { headers: { Authorization: `Basic ${btoa(v)}` } });
  assert.equal(isAdmin(basic(`admin:${secret}`), secret), true);
  assert.equal(isAdmin(basic(`admin:${secret}x`), secret), false);
  assert.equal(isAdmin(basic('admin'), secret), false);
  assert.equal(isAdmin(new Request('https://cloud-inbox.example', { headers: { Authorization: 'Basic %%%' } }), secret), false);
  assert.equal(isAdmin(new Request('https://cloud-inbox.example'), secret), false);
});

const machine = { clientId: 'c', clientSecret: 'cs', webhookSecret: 'w', bearerSecret: secret };
const env = { LINEAR_ORG_ID: ORG, ADMIN_SECRET: secret, MACHINES: JSON.stringify({ 'example-machine': machine }) };

test('readConfig accepts a complete config', () => {
  assert.deepEqual(readConfig(env), { orgId: ORG, adminSecret: secret, machines: { 'example-machine': machine } });
});

const otherMachine = { ...machine, clientId: 'other-client', bearerSecret: 'z'.repeat(32) };

test('readConfig accepts machines with distinct routing credentials', () => {
  const machines = { first: machine, second: otherMachine };
  assert.deepEqual(readConfig({ ...env, MACHINES: JSON.stringify(machines) }), {
    orgId: ORG, adminSecret: secret, machines,
  });
});

for (const key of ['bearerSecret', 'clientId'] as const) {
  test(`readConfig rejects duplicate ${key} without exposing credentials`, () => {
    const machines = { first: machine, second: { ...otherMachine, [key]: machine[key] } };
    const problem = readConfig({ ...env, MACHINES: JSON.stringify(machines) });
    assert.equal(problem, `MACHINES has duplicate ${key} values`);
    for (const entry of Object.values(machines)) {
      assert.equal((problem as string).includes(entry.bearerSecret), false);
      assert.equal((problem as string).includes(entry.clientSecret), false);
    }
  });
}

for (const [label, bad] of Object.entries({
  'no org id': { ...env, LINEAR_ORG_ID: '' },
  'a short admin secret': { ...env, ADMIN_SECRET: 'short' },
  'no machines': { ...env, MACHINES: undefined },
  'empty machines': { ...env, MACHINES: '{}' },
  'a bad machine name': { ...env, MACHINES: JSON.stringify({ 'Bad/Name': machine }) },
  'a missing machine secret': { ...env, MACHINES: JSON.stringify({ m: { ...machine, webhookSecret: '' } }) },
  'a missing client secret': { ...env, MACHINES: JSON.stringify({ m: { ...machine, clientSecret: '' } }) },
  'a short bearer secret': { ...env, MACHINES: JSON.stringify({ m: { ...machine, bearerSecret: 'short' } }) },
})) {
  test(`readConfig fails closed on ${label}, without echoing values`, () => {
    const problem = readConfig(bad);
    assert.equal(typeof problem, 'string');
    assert.doesNotMatch(problem as string, new RegExp(secret));
  });
}

test('a failed or unparseable token exchange stores nothing', async () => {
  for (const response of [new Response('denied', { status: 400 }), new Response('<html>', { status: 200 })]) {
    const storage = memoryStorage();
    const auth = new MachineAuth(storage, client, ORG, async () => response.clone());
    const state = stateOf((await auth.startInstall(REDIRECT, true))!);
    assert.deepEqual(await auth.completeInstall(state, 'code', REDIRECT), { ok: false, reason: 'exchange' });
    assert.equal(storage.data.has('token'), false);
  }
});

const install = async (auth: MachineAuth, admin = true) =>
  auth.completeInstall(stateOf((await auth.startInstall(REDIRECT, admin))!), 'code', REDIRECT);
const storedAccess = (storage: { data: Map<string, unknown> }) =>
  (storage.data.get('token') as { accessToken: string }).accessToken;

test('an initial callback that finishes late cannot replace one that finished first', async () => {
  const { auth, linear, storage } = setup();
  const stateA = stateOf((await auth.startInstall(REDIRECT, true))!);
  const paused = linear.pause();
  const a = auth.completeInstall(stateA, 'code-a', REDIRECT);
  await paused.waiting;
  assert.equal((await install(auth)).ok, true);
  paused.release();
  assert.deepEqual(await a, { ok: false, reason: 'reinstall' });
  assert.equal(storedAccess(storage), 'access-2');
});

test('an admin callback that finishes late cannot replace a newer install', async () => {
  const { auth, linear, storage } = setup();
  await install(auth);
  const stateA = stateOf((await auth.startInstall(REDIRECT, true))!);
  const paused = linear.pause();
  const a = auth.completeInstall(stateA, 'code-a', REDIRECT);
  await paused.waiting;
  assert.equal((await install(auth, true)).ok, true);
  paused.release();
  assert.deepEqual(await a, { ok: false, reason: 'superseded' });
  assert.equal(storedAccess(storage), 'access-3');
});

test('a refresh that finishes after an admin reinstall neither stores nor returns its token', async () => {
  const { auth, clock, linear, storage } = setup();
  await install(auth);
  clock.now += 23 * 60 * 60_000 + 1;
  const paused = linear.pause();
  const refresh = auth.getAccessToken();
  await paused.waiting;
  assert.equal((await install(auth, true)).ok, true);
  paused.release();
  await assert.rejects(refresh, /replaced/);
  assert.equal(storedAccess(storage), 'access-3');
  assert.equal(await auth.getAccessToken(), 'access-3');
});

for (const [label, orgId, clientId, legacy] of [
  ['the org id changes', 'org-new', client.clientId, false],
  ['the client id changes', ORG, 'client-new', false],
  ['the record has no identity', ORG, client.clientId, true],
] as const) {
  test(`when ${label}, the token is neither used nor refreshed until an admin reinstall`, async () => {
    const { auth, clock, linear, storage } = setup();
    await install(auth);
    if (legacy) {
      const { orgId: _o, clientId: _c, ...old } = storage.data.get('token') as Record<string, unknown>;
      storage.data.set('token', old);
    }
    const moved = setup(orgId === ORG ? ORG : 'org-new').linear;
    const changed = new MachineAuth(storage, { ...client, clientId }, orgId, moved.fetchFn, () => clock.now);
    await assert.rejects(changed.getAccessToken(), /reinstalled/);
    clock.now += 23 * 60 * 60_000 + 1;
    await assert.rejects(changed.getAccessToken(), /reinstalled/);
    assert.equal(moved.calls.length, 0);

    assert.equal(await changed.startInstall(REDIRECT, false), undefined);
    assert.equal((await install(changed, true)).ok, true);
    assert.equal(await changed.getAccessToken(), 'access-1');
    assert.equal(linear.calls.length, 2);
  });
}

test('an unauthenticated first install cannot create or replace pending state', async () => {
  const { auth, storage, linear } = setup();
  assert.equal(await auth.startInstall(REDIRECT, false), undefined);
  assert.equal(storage.data.size, 0);
  await auth.startInstall(REDIRECT, true);
  const pending = structuredClone(storage.data.get('oauthState'));
  assert.equal(await auth.startInstall(REDIRECT, false), undefined);
  assert.deepEqual(storage.data.get('oauthState'), pending);
  assert.equal(linear.calls.length, 0);
});

test('the exchange is bound to its PKCE challenge, and exchange and refresh send the client secret', async () => {
  const { auth, linear, clock } = setup();
  const url = new URL((await auth.startInstall(REDIRECT, true))!);
  await auth.completeInstall(stateOf(url.toString()), 'code', REDIRECT);
  const exchange = new URLSearchParams(linear.calls[0]!.body);
  const verifier = exchange.get('code_verifier')!;
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  assert.equal(url.searchParams.get('code_challenge'), Buffer.from(digest).toString('base64url'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(exchange.get('client_secret'), client.clientSecret);
  clock.now += 24 * 60 * 60_000;
  await auth.getAccessToken();
  const refresh = new URLSearchParams(linear.calls.at(-1)!.body);
  assert.equal(refresh.get('grant_type'), 'refresh_token');
  assert.equal(refresh.get('client_secret'), client.clientSecret);
});

for (const scope of [undefined, 'read write admin app:assignable', 'read app:assignable', 'read issues:create app:assignable', 'read', ['read', 1]]) {
  test(`a grant with unapproved permissions is rejected: ${JSON.stringify(scope)}`, async () => {
    const storage = memoryStorage();
    const auth = new MachineAuth(storage, client, ORG, async () => Response.json({
      access_token: 'access', refresh_token: 'refresh', expires_in: 86400, scope,
    }));
    assert.deepEqual(await install(auth), { ok: false, reason: 'exchange' });
    assert.equal(storage.data.has('token'), false);
  });
}

for (const scopes of [undefined, ['read', 'app:assignable'], ['read', 'write', 'admin', 'app:assignable']]) {
  test(`other or unverified stored permissions require reinstall: ${JSON.stringify(scopes)}`, async () => {
    const { auth, storage, linear, clock } = setup();
    await install(auth);
    const token = storage.data.get('token') as Record<string, unknown>;
    storage.data.set('token', { ...token, scopes });
    await assert.rejects(auth.getAccessToken(), /reinstalled/);
    clock.now += 24 * 60 * 60_000;
    await assert.rejects(auth.getAccessToken(), /reinstalled/);
    assert.equal(linear.calls.length, 2);
  });
}

test('a legacy pending install without PKCE is rejected before exchange', async () => {
  const { auth, storage, linear } = setup();
  storage.data.set('oauthState', { value: 'old-state', expiresAt: Infinity, reinstall: true });
  assert.deepEqual(await auth.completeInstall('old-state', 'code', REDIRECT), { ok: false, reason: 'state' });
  assert.equal(linear.calls.length, 0);
});

test('a refresh cannot widen the stored permissions', async () => {
  const { auth, storage, linear, clock } = setup();
  await install(auth);
  const before = structuredClone(storage.data.get('token'));
  clock.now += 24 * 60 * 60_000;
  const changed = new MachineAuth(storage, client, ORG, async () => Response.json({
    access_token: 'broad-access', refresh_token: 'broad-refresh', expires_in: 86400,
    scope: 'read write admin app:assignable',
  }), () => clock.now);
  await assert.rejects(changed.getAccessToken(), /refresh failed/);
  assert.deepEqual(storage.data.get('token'), before);
  assert.equal(linear.calls.length, 2);
});

test('legacy array-form scope responses are accepted with the same allowlist', async () => {
  const storage = memoryStorage();
  const linear = fakeLinear();
  const auth = new MachineAuth(storage, client, ORG, async (input, init) => {
    if (String(input) === 'https://api.linear.app/oauth/token') {
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 86400,
        scope: ['app:assignable', 'write', 'read'] });
    }
    return linear.fetchFn(input, init);
  });
  assert.equal((await install(auth)).ok, true);
  assert.equal(await auth.getAccessToken(), 'access');
});

test('status checks Linear without exposing credentials; disconnect preserves unrelated storage', async () => {
  const { storage, linear } = setup();
  let revoked = false;
  const auth = new MachineAuth(storage, client, ORG, async (input, init) => {
    if (String(input).endsWith('/oauth/revoke')) { revoked = true; return new Response(); }
    if (revoked) return String(input).endsWith('/oauth/token')
      ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : new Response(null, { status: 401 });
    return linear.fetchFn(input, init);
  });
  await auth.completeInstall(stateOf((await auth.startInstall(REDIRECT, true))!), 'code', REDIRECT);
  await storage.put('queued-job', { sessionId: 'session-example' });
  assert.deepEqual(await auth.status(), { connected: true });
  await auth.disconnect();
  assert.deepEqual(await auth.status(), { connected: false });
  await assert.rejects(auth.getAccessToken(), /not installed|disconnected/);
  assert.deepEqual(await storage.get('queued-job'), { sessionId: 'session-example' });
  await auth.disconnect();
});

test('failed revocation blocks use and install until retried, without losing the install', async () => {
  const { storage, linear } = setup();
  let revoke = false;
  let fail = true;
  const auth = new MachineAuth(storage, client, ORG, async (input, init) => {
    if (String(input).endsWith('/oauth/revoke')) {
      if (fail) return new Response(null, { status: 503 });
      revoke = true;
      return new Response();
    }
    if (revoke) return String(input).endsWith('/oauth/token')
      ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : new Response(null, { status: 401 });
    return linear.fetchFn(input, init);
  });
  await auth.completeInstall(stateOf((await auth.startInstall(REDIRECT, true))!), 'code', REDIRECT);
  await assert.rejects(auth.disconnect(), /revocation failed/);
  await assert.rejects(auth.getAccessToken(), /disconnected/);
  assert.equal(await auth.startInstall(REDIRECT, true), undefined);
  fail = false;
  await auth.disconnect();
  assert.ok(await auth.startInstall(REDIRECT, true));
});

test('disconnect waits for an initial callback so its newly issued credentials are revoked too', async () => {
  const storage = memoryStorage();
  const linear = fakeLinear();
  let revoked = false;
  const auth = new MachineAuth(storage, client, ORG, async (input, init) => {
    if (String(input).endsWith('/oauth/revoke')) { revoked = true; return new Response(); }
    if (revoked) return String(input).endsWith('/oauth/token')
      ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : new Response(null, { status: 401 });
    return linear.fetchFn(input, init);
  });
  const state = stateOf((await auth.startInstall(REDIRECT, true))!);
  const held = linear.pause();
  const callback = auth.completeInstall(state, 'code', REDIRECT);
  await held.waiting;
  const disconnect = auth.disconnect();
  await new Promise((resolve) => setImmediate(resolve));
  held.release();
  assert.equal((await callback).ok, false);
  await disconnect;
  assert.equal(revoked, true);
  await assert.rejects(auth.getAccessToken(), /not installed/);
});
