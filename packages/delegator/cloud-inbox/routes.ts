// Cloud Inbox's webhook route and Runner API. The Worker hands each request here with
// a way to reach a machine's queue, so `node:test` can drive the whole route.

import { hex, timingSafeEqual, type Config } from './auth.ts';
import { MAX_UPDATE_CHARS, type AgentEvent, type MachineQueue, type Refusal, type UpdateType } from './queue.ts';

const TIMESTAMP_WINDOW_MS = 60_000;
/** Far above any agent session event; anything larger is refused before it's parsed. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
/** Room for the longest status update in JSON, escapes included. */
const MAX_UPDATE_BYTES = 16 * 1024;

/** Every Cloud Inbox route lives here, so a shared hostname can route `/delegator/*` to this Worker. */
export const BASE_PATH = '/delegator';

/** The request with the base path removed, or null if it's outside the base path. */
export function underBasePath(request: Request): Request | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${BASE_PATH}/`)) return null;
  url.pathname = url.pathname.slice(BASE_PATH.length);
  return new Request(url, request);
}

export type Machines = (machine: string) =>
  Pick<MachineQueue, 'webhook' | 'claim' | 'finish' | 'task' | 'update' | 'watch' | 'linkPullRequest'>;

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
  agentActivity?: { id?: unknown; signal?: unknown };
};

async function signatureMatches(secret: string, raw: ArrayBuffer, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, raw)));
  return timingSafeEqual(mac, signature.toLowerCase());
}

/** The body, or null past `limit` bytes. Counts as it reads, since Content-Length may be absent or wrong. */
async function readBounded(request: Request, limit: number): Promise<ArrayBuffer | null> {
  if (Number(request.headers.get('Content-Length')) > limit) return null;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => {}); // Stop reading; the sender's fate doesn't affect the answer.
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks).arrayBuffer();
}

/** `POST /webhook`: every check runs before the machine's queue sees the event. */
export async function handleWebhook(request: Request, config: Config, machines: Machines, now = Date.now()) {
  const reject = (status: number, outcome: string) => {
    log({ event: 'webhook', outcome });
    return text(status, status === 401 ? 'Unauthorized' : status === 413 ? 'Payload too large' : 'Forbidden');
  };
  // Refused before the body is read: only a well-formed HMAC-SHA256 can ever match.
  const signature = request.headers.get('Linear-Signature') ?? '';
  if (!/^[0-9a-f]{64}$/i.test(signature)) return reject(401, 'signature');
  const raw = await readBounded(request, MAX_WEBHOOK_BYTES);
  if (!raw) return reject(413, 'too-large');
  let payload: Payload | null;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return text(400, 'Bad request');
  }

  const entry = Object.entries(config.machines).find(([, m]) => m.clientId === payload?.oauthClientId);
  if (!entry) return reject(401, 'unknown-client');
  const [machine, { webhookSecret }] = entry;
  if (!(await signatureMatches(webhookSecret, raw, signature))) return reject(401, 'signature');
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
  const activityId = agentActivity?.id;
  const stop = agentActivity?.signal === 'stop';
  // A stop needs no id, as a session ends once; it still has to work if the id is ever absent.
  if (action === 'prompted' && !stop && (typeof activityId !== 'string' || !activityId)) return text(400, 'Bad request');
  const event: AgentEvent = {
    action,
    appUserId: typeof appUserId === 'string' ? appUserId : '',
    sessionId,
    issueId: typeof issueId === 'string' && issueId ? issueId : undefined,
    activityId: typeof activityId === 'string' ? activityId : undefined,
    stop,
  };

  const result = await machines(machine).webhook(event);
  log({ event: 'webhook', machine, action, session: sessionId, outcome: result });
  return result === 'app-user' ? text(403, 'Forbidden') : text(200, 'OK');
}

const REFUSED: Record<Refusal, [number, string]> = {
  'not-claimed': [409, 'Claim is not current'],
  ended: [409, 'Session has ended'],
  'no-pr': [409, 'No pull request on the issue'],
  linear: [502, 'Linear request failed'],
};
const UPDATE_TYPES: readonly string[] = ['thought', 'response', 'error'] satisfies UpdateType[];

/** A status update's `{type, body}`, or null. Any other field is ignored. */
async function readUpdate(request: Request): Promise<{ type: UpdateType; body: string } | 'too-large' | null> {
  const raw = await readBounded(request, MAX_UPDATE_BYTES);
  if (!raw) return 'too-large';
  let parsed: { type?: unknown; body?: unknown } | null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  const { type, body } = parsed ?? {};
  if (typeof type !== 'string' || !UPDATE_TYPES.includes(type)) return null;
  if (typeof body !== 'string' || !body.trim() || body.length > MAX_UPDATE_CHARS) return null;
  return { type: type as UpdateType, body };
}

/**
 * `POST /jobs/claim`, and named operations on a claimed job:
 * `GET /jobs/<id>/task|watch`, `POST /jobs/<id>/updates|pull-request|launched|failed`,
 * each with `?claimId=<claimId>`. The machine comes only from the bearer secret that
 * matched, and the issue and session only from the job, never from the request.
 */
export async function handleRunner(request: Request, config: Config, machines: Machines) {
  const header = request.headers.get('Authorization') ?? '';
  const secret = header.startsWith('Bearer ') ? header.slice(7) : '';
  let machine: string | undefined;
  // Compare against every machine, so the time taken doesn't say which matched.
  for (const [name, m] of Object.entries(config.machines)) {
    if (timingSafeEqual(secret, m.bearerSecret)) machine = name;
  }
  if (!machine) {
    log({ event: 'runner', outcome: 'unauthorized' });
    return text(401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
  }

  const queue = machines(machine);
  const url = new URL(request.url);
  const [, route, id, op, ...rest] = url.pathname.split('/');
  const method = request.method;

  if (method === 'POST' && route === 'jobs' && id === 'claim' && op === undefined) {
    const job = await queue.claim();
    log({ event: 'claim', machine, outcome: job ? 'claimed' : 'empty', ...(job && { session: job.sessionId }) });
    return job ? Response.json(job) : new Response(null, { status: 204 });
  }
  const operation = `${method} ${op}`;
  const known = ['GET task', 'GET watch', 'POST updates', 'POST pull-request', 'POST launched', 'POST failed'];
  if (route !== 'jobs' || !id || id === 'claim' || !known.includes(operation) || rest.length) return text(404, 'Not found');
  const claimId = url.searchParams.get('claimId');
  if (!claimId) return text(400, 'claimId is required');
  const done = (outcome: string, extra?: Record<string, string>) =>
    log({ event: op!, machine: machine!, session: id, outcome, ...extra });
  const refused = (reason: Refusal) => {
    done(reason);
    return text(...REFUSED[reason]);
  };

  if (op === 'launched' || op === 'failed') {
    const recorded = await queue.finish(id, claimId, op);
    if (!recorded) return refused('not-claimed');
    done('recorded');
    return new Response(null, { status: 204 });
  }
  if (op === 'updates') {
    const update = await readUpdate(request);
    if (update === 'too-large') return text(413, 'Payload too large');
    if (!update) return text(400, `Expected {type: thought|response|error, body: 1-${MAX_UPDATE_CHARS} characters}`);
    const result = await queue.update(id, claimId, update.type, update.body);
    if (result !== 'queued') return refused(result);
    done('queued', { type: update.type });
    return new Response(null, { status: 202 });
  }
  const result = op === 'task' ? await queue.task(id, claimId)
    : op === 'watch' ? await queue.watch(id, claimId)
    : await queue.linkPullRequest(id, claimId);
  if (typeof result === 'string') return refused(result);
  done('ok');
  return Response.json(result);
}
