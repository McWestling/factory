// The relay's webhook route and daemon API. The Worker hands each request here with
// a way to reach a machine's queue, so `node:test` can drive the whole route.

import { hex, timingSafeEqual, type Config } from './auth.ts';
import type { AgentEvent, MachineQueue } from './queue.ts';

const TIMESTAMP_WINDOW_MS = 60_000;

/** Every relay route lives here, so a shared hostname can route `/dispatch/*` to this Worker. */
export const BASE_PATH = '/dispatch';

/** The request with the base path removed, or null if it's outside the base path. */
export function underBasePath(request: Request): Request | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${BASE_PATH}/`)) return null;
  url.pathname = url.pathname.slice(BASE_PATH.length);
  return new Request(url, request);
}

export type Machines = (machine: string) => Pick<MachineQueue, 'webhook' | 'claim' | 'finish'>;

// Logs ids and outcomes only: never bodies, headers, tokens or state.
export const log = (fields: Record<string, string>) => console.log(JSON.stringify(fields));
export const text = (status: number, body: string, headers?: HeadersInit) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } });

type Payload = {
  type?: unknown;
  action?: unknown;
  oauthClientId?: unknown;
  organizationId?: unknown;
  appUserId?: unknown;
  webhookTimestamp?: unknown;
  agentSession?: { id?: unknown; issueId?: unknown; issue?: { id?: unknown } };
  agentActivity?: { signal?: unknown };
};

async function signatureMatches(secret: string, raw: ArrayBuffer, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, raw)));
  return timingSafeEqual(mac, signature.toLowerCase());
}

/** `POST /webhook`: every check runs before the machine's queue sees the event. */
export async function handleWebhook(request: Request, config: Config, machines: Machines, now = Date.now()) {
  const raw = await request.arrayBuffer();
  let payload: Payload | null;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return text(400, 'Bad request');
  }
  const reject = (status: number, outcome: string) => {
    log({ event: 'webhook', outcome });
    return text(status, status === 401 ? 'Unauthorized' : 'Forbidden');
  };

  const entry = Object.entries(config.machines).find(([, m]) => m.clientId === payload?.oauthClientId);
  if (!entry) return reject(401, 'unknown-client');
  const [machine, { webhookSecret }] = entry;
  if (!(await signatureMatches(webhookSecret, raw, request.headers.get('Linear-Signature')))) {
    return reject(401, 'signature');
  }
  const sent = payload!.webhookTimestamp;
  if (typeof sent !== 'number' || Math.abs(now - sent) > TIMESTAMP_WINDOW_MS) return reject(401, 'stale');
  if (payload!.organizationId !== config.orgId) return reject(403, 'org');

  const { type, action, appUserId, agentSession, agentActivity } = payload!;
  if (type !== 'AgentSessionEvent' || (action !== 'created' && action !== 'prompted')) {
    log({ event: 'webhook', machine, outcome: 'ignored' });
    return text(200, 'OK');
  }
  const sessionId = agentSession?.id;
  if (typeof sessionId !== 'string' || !sessionId) return text(400, 'Bad request');
  const issueId = agentSession?.issue?.id ?? agentSession?.issueId;
  const event: AgentEvent = {
    action,
    appUserId: typeof appUserId === 'string' ? appUserId : '',
    sessionId,
    issueId: typeof issueId === 'string' && issueId ? issueId : undefined,
    stop: agentActivity?.signal === 'stop',
  };

  const result = await machines(machine).webhook(event);
  log({ event: 'webhook', machine, action, session: sessionId, outcome: result });
  return result === 'app-user' ? text(403, 'Forbidden') : text(200, 'OK');
}

/**
 * `POST /jobs/claim`, `POST /jobs/<id>/launched|failed`. The machine
 * comes only from the bearer secret that matched, never from the request.
 */
export async function handleDaemon(request: Request, config: Config, machines: Machines) {
  const header = request.headers.get('Authorization') ?? '';
  const secret = header.startsWith('Bearer ') ? header.slice(7) : '';
  let machine: string | undefined;
  // Compare against every machine, so the time taken doesn't say which matched.
  for (const [name, m] of Object.entries(config.machines)) {
    if (timingSafeEqual(secret, m.bearerSecret)) machine = name;
  }
  if (!machine) {
    log({ event: 'daemon', outcome: 'unauthorized' });
    return text(401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
  }

  const queue = machines(machine);
  const [, route, id, outcome, ...rest] = new URL(request.url).pathname.split('/');
  const method = request.method;

  if (method === 'POST' && route === 'jobs' && id === 'claim' && outcome === undefined) {
    const job = await queue.claim();
    log({ event: 'claim', machine, outcome: job ? 'claimed' : 'empty', ...(job && { session: job.sessionId }) });
    return job ? Response.json(job) : new Response(null, { status: 204 });
  }
  if (method === 'POST' && route === 'jobs' && id && (outcome === 'launched' || outcome === 'failed') && !rest.length) {
    const recorded = await queue.finish(id, outcome);
    log({ event: outcome, machine, session: id, outcome: recorded ? 'recorded' : 'not-claimed' });
    return recorded ? new Response(null, { status: 204 }) : text(409, 'Job is not claimed');
  }
  return text(404, 'Not found');
}
