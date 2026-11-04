// Relay config and the per-machine Linear OAuth install. Runs in the Worker and
// under Node for tests, so it uses only fetch and WebCrypto.

const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const TOKEN_URL = 'https://api.linear.app/oauth/token';
const GRAPHQL_URL = 'https://api.linear.app/graphql';
const SCOPES = 'read,write,app:assignable';
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

/** Reads the relay's secrets. Returns a problem naming the bad key, never its value. */
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
  for (const [name, machine] of entries) {
    if (!MACHINE_NAME.test(name)) return `MACHINES has an invalid machine name`;
    const m = (machine ?? {}) as Record<string, unknown>;
    for (const key of ['clientId', 'clientSecret', 'webhookSecret', 'bearerSecret']) {
      if (typeof m[key] !== 'string' || !m[key]) return `MACHINES.${name}.${key} is missing`;
    }
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

type PendingState = { value: string; expiresAt: number; reinstall: boolean };
// orgId and clientId bind the token to the config that installed it. appName is the
// app's name in Linear; installs from before it was stored lack it.
type StoredToken = {
  accessToken: string; refreshToken: string; expiresAt: number; appUserId: string; appName?: string;
  orgId: string; clientId: string;
};
type AppUser = { appUserId: string; appName?: string };
type Grant = { access_token: string; refresh_token: string; expires_in: number };

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
   * pending one. Returns undefined when a token exists and `admin` is false.
   */
  async startInstall(redirectUri: string, admin: boolean): Promise<string | undefined> {
    if (!admin && (await this.#storage.get('token'))) return undefined;
    const value = hex(crypto.getRandomValues(new Uint8Array(32)));
    const pending: PendingState = { value, expiresAt: this.#now() + STATE_TTL_MS, reinstall: admin };
    await this.#storage.put('oauthState', pending);
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.#client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      state: value,
      actor: 'app',
    }).toString();
    return url.toString();
  }

  async completeInstall(state: string, code: string, redirectUri: string): Promise<InstallResult> {
    // No await between the read and the delete, so two callbacks can't both use one state.
    const pending = await this.#storage.get<PendingState>('oauthState');
    if (!pending || !timingSafeEqual(state, pending.value)) return { ok: false, reason: 'state' };
    await this.#storage.delete('oauthState');
    if (pending.expiresAt <= this.#now()) return { ok: false, reason: 'state' };
    const before = await this.#storage.get<StoredToken>('token');
    if (!pending.reinstall && before) return { ok: false, reason: 'reinstall' };

    const grant = await this.#grant({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
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
    return { ok: true, appUserId: viewer.id };
  }

  /** The app user this machine was installed as, or undefined before the install. */
  async installation(): Promise<AppUser | undefined> {
    const token = await this.#storage.get<StoredToken>('token');
    return token && { appUserId: token.appUserId, appName: token.appName };
  }

  /** Returns the cached access token, refreshing it when under an hour remains. */
  async getAccessToken(): Promise<string> {
    const token = await this.#storage.get<StoredToken>('token');
    if (!token) throw new Error('Machine is not installed');
    // Also catches records from before the identity was stored.
    if (token.orgId !== this.#orgId || token.clientId !== this.#client.clientId) {
      throw new Error('Machine must be reinstalled: its token is for another org or client');
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
    const body = (await json(res)) as Partial<Grant> | undefined;
    if (!body) return undefined;
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' ||
      typeof body.expires_in !== 'number') return undefined;
    return body as Grant;
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
