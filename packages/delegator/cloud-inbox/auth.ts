// Cloud Inbox config and the per-machine Linear OAuth install. Runs in the Worker and
// under Node for tests, so it uses only fetch and WebCrypto.

const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const TOKEN_URL = 'https://api.linear.app/oauth/token';
const GRAPHQL_URL = 'https://api.linear.app/graphql';
const SCOPES = ['read', 'write', 'app:assignable'];
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 60 * 60_000;
const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MIN_SECRET_LENGTH = 32;

export type MachineConfig = {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  bearerSecret: string;
};

export type Config = {
  orgId: string;
  adminSecret: string;
  machines: Record<string, MachineConfig>;
};

/** Reads Cloud Inbox's secrets. Returns a problem naming the bad key, never its value. */
export function readConfig(env: Record<string, unknown>): Config | string {
  const { LINEAR_ORG_ID: orgId, ADMIN_SECRET: adminSecret, MACHINES: raw } = env;
  if (typeof orgId !== 'string' || !orgId) return 'LINEAR_ORG_ID is missing';
  if (typeof adminSecret !== 'string' || adminSecret.length < MIN_SECRET_LENGTH) {
    return `ADMIN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  let machines: unknown;
  try {
    machines = JSON.parse(typeof raw === 'string' ? raw : '');
  } catch {
    return 'MACHINES is not JSON';
  }
  if (!machines || typeof machines !== 'object' || Array.isArray(machines)) {
    return 'MACHINES must be an object of machine name to secrets';
  }
  const entries = Object.entries(machines);
  if (!entries.length) return 'MACHINES is empty';
  const bearerSecrets = new Set<unknown>();
  const clientIds = new Set<unknown>();
  for (const [name, machine] of entries) {
    if (!MACHINE_NAME.test(name)) return `MACHINES has an invalid machine name`;
    const m = (machine ?? {}) as Record<string, unknown>;
    for (const key of ['clientId', 'clientSecret', 'webhookSecret', 'bearerSecret']) {
      if (typeof m[key] !== 'string' || !m[key]) return `MACHINES.${name}.${key} is missing`;
    }
    if (bearerSecrets.has(m.bearerSecret)) return 'MACHINES has duplicate bearerSecret values';
    if (clientIds.has(m.clientId)) return 'MACHINES has duplicate clientId values';
    bearerSecrets.add(m.bearerSecret);
    clientIds.add(m.clientId);
    if ((m.bearerSecret as string).length < MIN_SECRET_LENGTH) {
      return `MACHINES.${name}.bearerSecret must be at least ${MIN_SECRET_LENGTH} characters`;
    }
  }
  return { orgId, adminSecret, machines: machines as Record<string, MachineConfig> };
}

export const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Compares in time that depends only on the lengths, which aren't secret. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the request carries HTTP Basic auth whose password is the admin secret. */
export function isAdmin(request: Request, adminSecret: string): boolean {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  return colon >= 0 && timingSafeEqual(decoded.slice(colon + 1), adminSecret);
}

// A parse error's message quotes the body, which could hold a token, so swallow it.
async function json(res: Response): Promise<unknown> {
  if (!res.ok) return undefined;
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export type Storage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
};

type PendingState = { value: string; verifier: string; expiresAt: number; reinstall: boolean };
// orgId and clientId bind the token to the config that installed it. appName is the
// app's name in Linear; installs from before it was stored lack it.
type StoredToken = {
  accessToken: string; refreshToken: string; expiresAt: number; appUserId: string; appName?: string;
  orgId: string; clientId: string; scopes: string[];
};
type AppUser = { appUserId: string; appName?: string };
type Grant = { access_token: string; refresh_token: string; expires_in: number; scopes: string[] };

function cloudInboxScopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length === SCOPES.length && SCOPES.every((scope) => value.includes(scope));
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export type InstallResult =
  | { ok: true; appUserId: string }
  | { ok: false; reason: 'state' | 'reinstall' | 'superseded' | 'exchange' | 'org' };

/** One machine's install and token, kept in that machine's Durable Object storage. */
export class MachineAuth {
  #storage: Storage;
  #client: Pick<MachineConfig, 'clientId' | 'clientSecret'>;
  #orgId: string;
  #fetch: typeof fetch;
  #now: () => number;
  #refreshing?: Promise<string>;
  #installing = new Set<Promise<unknown>>();
  #disconnecting?: Promise<void>;

  constructor(
    storage: Storage,
    client: Pick<MachineConfig, 'clientId' | 'clientSecret'>,
    orgId: string,
    // Bounded, so a slow Linear can't hold a refresh, and the deliveries behind it, open.
    fetchFn: typeof fetch = (input, init) => fetch(input, { signal: AbortSignal.timeout(10_000), ...init }),
    now: () => number = Date.now,
  ) {
    this.#storage = storage;
    this.#client = client;
    this.#orgId = orgId;
    this.#fetch = fetchFn;
    this.#now = now;
  }

  /**
   * Returns Linear's authorize URL with a fresh single-use state, replacing any
   * pending one. Only an authenticated administrator may begin an install.
   */
  startInstall(redirectUri: string, admin: boolean): Promise<string | undefined> {
    return this.#trackInstall(this.#startInstall(redirectUri, admin));
  }

  #trackInstall<T>(pending: Promise<T>): Promise<T> {
    this.#installing.add(pending);
    void pending.finally(() => this.#installing.delete(pending)).catch(() => {});
    return pending;
  }

  async #startInstall(redirectUri: string, admin: boolean): Promise<string | undefined> {
    if (!admin || await this.#storage.get('disconnecting')) return undefined;
    const reinstall = Boolean(await this.#storage.get('token'));
    const value = hex(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    if (await this.#storage.get('disconnecting')) return undefined;
    const pending: PendingState = { value, verifier, expiresAt: this.#now() + STATE_TTL_MS, reinstall };
    await this.#storage.put('oauthState', pending);
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.#client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(','),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: value,
      actor: 'app',
    }).toString();
    return url.toString();
  }

  completeInstall(state: string, code: string, redirectUri: string): Promise<InstallResult> {
    return this.#trackInstall(this.#completeInstall(state, code, redirectUri));
  }

  async #completeInstall(state: string, code: string, redirectUri: string): Promise<InstallResult> {
    // No await between the read and the delete, so two callbacks can't both use one state.
    const pending = await this.#storage.get<PendingState>('oauthState');
    if (await this.#storage.get('disconnecting') || !pending || !timingSafeEqual(state, pending.value)) return { ok: false, reason: 'state' };
    await this.#storage.delete('oauthState');
    if (!pending.verifier || pending.expiresAt <= this.#now()) return { ok: false, reason: 'state' };
    const before = await this.#storage.get<StoredToken>('token');
    if (!pending.reinstall && before) return { ok: false, reason: 'reinstall' };

    const grant = await this.#grant({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: pending.verifier });
    if (!grant) return { ok: false, reason: 'exchange' };
    const viewer = await this.#viewer(grant.access_token);
    if (!viewer) return { ok: false, reason: 'exchange' };
    if (!timingSafeEqual(viewer.orgId, this.#orgId)) return { ok: false, reason: 'org' };


    // Requests interleave during the fetches above. Recheck with no await but storage's
    // between this read and the put, so the Durable Object's input gate makes it atomic.
    const current = await this.#storage.get<StoredToken>('token');
    if (current?.refreshToken !== before?.refreshToken) {
      return { ok: false, reason: pending.reinstall ? 'superseded' : 'reinstall' };
    }
    await this.#storage.put('token', this.#toStored(grant, { appUserId: viewer.id, appName: viewer.name }));
    if (await this.#storage.get('disconnecting')) return { ok: false, reason: 'superseded' };
    return { ok: true, appUserId: viewer.id };
  }

  /** The app user this machine was installed as, or undefined before the install. */
  async installation(): Promise<AppUser | undefined> {
    if (await this.#storage.get('disconnecting')) return undefined;
    const token = await this.#storage.get<StoredToken>('token');
    return token && { appUserId: token.appUserId, appName: token.appName };
  }

  /** Checks access at Linear, returning no credentials to the operator. */
  async status(): Promise<{ connected: boolean }> {
    if (!await this.installation()) return { connected: false };
    const viewer = await this.#viewer(await this.getAccessToken());
    const installed = await this.installation();
    if (!viewer || viewer.orgId !== this.#orgId || viewer.id !== installed?.appUserId) {
      throw new Error('Linear access failed. Check app access and workspace, then reconnect.');
    }
    return { connected: true };
  }

  /** Retains credentials on failure so revocation can be retried; never deletes jobs. */
  disconnect(): Promise<void> {
    return this.#disconnecting ??= this.#disconnect().finally(() => { this.#disconnecting = undefined; });
  }

  async #disconnect(): Promise<void> {
    await this.#storage.put('disconnecting', true);
    await this.#storage.delete('oauthState');
    // A rotating refresh already in flight must settle before we revoke its credentials.
    await Promise.allSettled([...this.#installing]);
    await this.#refreshing?.catch(() => {});
    const token = await this.#storage.get<StoredToken>('token');
    if (token) {
      for (const [value, hint] of [[token.refreshToken, 'refresh_token'], [token.accessToken, 'access_token']]) {
        const res = await this.#fetch('https://api.linear.app/oauth/revoke', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: value!, token_type_hint: hint! }),
        });
        if (!res.ok && res.status !== 400 && res.status !== 401) throw new Error('Linear revocation failed. Retry disconnect.');
      }
      const probe = await this.#fetch(GRAPHQL_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.accessToken}` },
        body: JSON.stringify({ query: '{ viewer { id } }' }),
      });
      if (probe.status !== 401) throw new Error('Linear still allows access or could not confirm revocation. Retry disconnect.');
      const refresh = await this.#fetch(TOKEN_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refreshToken,
          client_id: this.#client.clientId, client_secret: this.#client.clientSecret }),
      });
      if (refresh.ok) {
        // Keep any rotated pair available for the next revocation attempt.
        const grant = await json(refresh) as Grant | undefined;
        if (grant?.access_token && grant.refresh_token) {
          await this.#storage.put('token', { ...token, accessToken: grant.access_token, refreshToken: grant.refresh_token });
        }
        throw new Error('Linear still allows refresh. Retry disconnect.');
      }
      let error: unknown;
      try { error = (await refresh.json() as { error?: unknown }).error; } catch { /* No response bodies in errors. */ }
      if (refresh.status !== 400 || error !== 'invalid_grant') {
        throw new Error('Could not confirm refresh revocation. Retry disconnect or revoke the app in Linear.');
      }
      await this.#storage.delete('token');
    }
    await this.#storage.delete('disconnecting');
  }

  /** Returns the cached access token, refreshing it when under an hour remains. */
  async getAccessToken(): Promise<string> {
    if (await this.#storage.get('disconnecting')) throw new Error('Machine is disconnected; retry disconnect before reconnecting');
    const token = await this.#storage.get<StoredToken>('token');
    if (!token) throw new Error('Machine is not installed');
    // Also catches records from before the identity was stored.
    if (!cloudInboxScopes(token.scopes) || token.orgId !== this.#orgId || token.clientId !== this.#client.clientId) {
      throw new Error('Machine must be reinstalled: its token has other or unverified permissions or belongs to another org or client');
    }
    if (token.expiresAt - this.#now() > REFRESH_MARGIN_MS) return token.accessToken;
    // One refresh at a time: Linear rotates the refresh token.
    this.#refreshing ??= this.#refresh(token).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(token: StoredToken): Promise<string> {
    const grant = await this.#grant({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
    if (!grant) throw new Error('Token refresh failed');
    // The refresh token is the record's version: a reinstall or another refresh changes
    // it. Same atomic read-then-put as completeInstall.
    const current = await this.#storage.get<StoredToken>('token');
    if (current?.refreshToken !== token.refreshToken) throw new Error('Token was replaced during refresh');
    await this.#storage.put('token', this.#toStored(grant, token));
    return grant.access_token;
  }

  #toStored(grant: Grant, { appUserId, appName }: AppUser): StoredToken {
    return {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      expiresAt: this.#now() + grant.expires_in * 1000,
      appUserId,
      appName,
      orgId: this.#orgId,
      clientId: this.#client.clientId,
      scopes: grant.scopes,
    };
  }

  async #grant(params: Record<string, string>): Promise<Grant | undefined> {
    const res = await this.#fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...params,
        client_id: this.#client.clientId,
        client_secret: this.#client.clientSecret,
      }),
    });
    const body = (await json(res)) as (Partial<Grant> & { scope?: unknown }) | undefined;
    if (!body) return undefined;
    const scopes = typeof body.scope === 'string' ? body.scope.trim().split(/\s+/) : body.scope;
    if (!cloudInboxScopes(scopes) || typeof body.access_token !== 'string' || !body.access_token ||
      typeof body.refresh_token !== 'string' || !body.refresh_token ||
      typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) return undefined;
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in, scopes };
  }

  async #viewer(accessToken: string): Promise<{ id: string; name?: string; orgId: string } | undefined> {
    const res = await this.#fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query: '{ viewer { id name organization { id } } }' }),
    });
    type Viewer = { id?: unknown; name?: unknown; organization?: { id?: unknown } };
    const viewer = ((await json(res)) as { data?: { viewer?: Viewer } } | undefined)?.data?.viewer;
    const { id, name } = viewer ?? {};
    const orgId = viewer?.organization?.id;
    if (typeof id !== 'string' || typeof orgId !== 'string') return undefined;
    return { id, name: typeof name === 'string' ? name : undefined, orgId };
  }
}
