// One machine's job queue and the agent activities the relay posts, kept in that
// machine's Durable Object. Runs under Node for tests, so SQL goes through `Sql`,
// which both Cloudflare's SqlStorage and a node:sqlite adapter satisfy.

import type { Job } from '../job.ts';
import type { MachineAuth } from './auth.ts';
import { log } from './routes.ts';

const GRAPHQL_URL = 'https://api.linear.app/graphql';
const LEASE_MS = 10 * 60_000;
const HISTORY_MS = 30 * 24 * 60 * 60_000;
// ponytail: one lend per 10 s, held in memory. Eviction resets it, but eviction only
// happens when the machine's Durable Object is idle, so it can't be used to hammer.
const LEND_INTERVAL_MS = 10_000;

export const MESSAGES = {
  queued: (machine: string) =>
    `Queued on ${machine}. It starts when ${machine} picks it up, which can take a while if the machine is busy or asleep.`,
  replaced: 'Replaced by a newer dispatch.',
  stopped: 'Stopped watching. The agent in Orca keeps running; stop it there if needed.',
  replies: "Dispatch doesn't read replies; steer the agent in Orca.",
};

const ACTIVITY = 'mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }';

export type Sql = {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
};

/** The verified fields of an AgentSessionEvent webhook that the queue acts on. */
export type AgentEvent = {
  action: 'created' | 'prompted';
  appUserId: string;
  sessionId: string;
  issueId?: string;
  stop: boolean;
};

export type WebhookResult = 'queued' | 'duplicate' | 'answered' | 'no-issue' | 'app-user';
export type Outcome = 'launched' | 'failed';
export type LendResult = { ok: true; accessToken: string } | { ok: false; retryAfter?: number };

/**
 * A job's id is its session id. A job is waiting while `queued` or `claimed` with an
 * expired lease; each issue keeps only its newest waiting job.
 */
export class MachineQueue {
  #sql: Sql;
  #auth: MachineAuth;
  #machine: string;
  #fetch: typeof fetch;
  #now: () => number;
  #lentAt = -Infinity;

  constructor(
    sql: Sql,
    auth: MachineAuth,
    machine: string,
    fetchFn: typeof fetch = (input, init) => fetch(input, init),
    now: () => number = Date.now,
  ) {
    this.#sql = sql;
    this.#auth = auth;
    this.#machine = machine;
    this.#fetch = fetchFn;
    this.#now = now;
    sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL,
      state TEXT NOT NULL, lease_until INTEGER, updated_at INTEGER NOT NULL)`);
    sql.exec('CREATE TABLE IF NOT EXISTS seen (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  }

  /** Acts on a webhook whose signature, timestamp and org the Worker already checked. */
  async webhook(event: AgentEvent): Promise<WebhookResult> {
    const app = await this.#auth.installation();
    if (!app || app.appUserId !== event.appUserId) return 'app-user';

    if (event.action === 'prompted') {
      if (event.stop) {
        // A stopped session that hasn't been picked up yet shouldn't start later.
        this.#sql.exec("DELETE FROM jobs WHERE id = ? AND state = 'queued'", event.sessionId);
        await this.#post(event.sessionId, 'response', MESSAGES.stopped);
      } else {
        await this.#post(event.sessionId, 'thought', MESSAGES.replies);
      }
      return 'answered';
    }

    if (!event.issueId) return 'no-issue';
    // No await from here to the posts, so the dedupe, insert and replace are atomic.
    const now = this.#now();
    const fresh = this.#sql.exec(
      'INSERT INTO seen (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING session_id',
      event.sessionId, now).toArray();
    if (!fresh.length) return 'duplicate';
    this.#sql.exec("INSERT INTO jobs (id, issue_id, state, updated_at) VALUES (?, ?, 'queued', ?)",
      event.sessionId, event.issueId, now);
    await this.#replace(this.#settle(now));
    await this.#post(event.sessionId, 'thought', MESSAGES.queued(app.appName ?? this.#machine));
    return 'queued';
  }

  /** Claims the oldest waiting job with a fresh lease, or returns undefined. */
  async claim(): Promise<Job | undefined> {
    const now = this.#now();
    const replaced = this.#settle(now);
    const [row] = this.#sql.exec(
      `UPDATE jobs SET state = 'claimed', lease_until = ?, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE state = 'queued' ORDER BY rowid LIMIT 1) RETURNING id, issue_id`,
      now + LEASE_MS, now).toArray();
    await this.#replace(replaced);
    return row && { issueId: String(row.issue_id), sessionId: String(row.id) };
  }

  /** Records a claimed job's outcome. False if the job isn't claimed. */
  async finish(id: string, outcome: Outcome): Promise<boolean> {
    return this.#sql.exec(
      "UPDATE jobs SET state = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND state = 'claimed' RETURNING id",
      outcome, this.#now(), id).toArray().length > 0;
  }

  async lendToken(): Promise<LendResult> {
    const wait = this.#lentAt + LEND_INTERVAL_MS - this.#now();
    if (wait > 0) return { ok: false, retryAfter: Math.ceil(wait / 1000) };
    this.#lentAt = this.#now();
    try {
      return { ok: true, accessToken: await this.#auth.getAccessToken() };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Drops expired history, puts expired leases back on the queue, and keeps only the
   * newest waiting job per issue. Returns the session ids of the jobs it replaced.
   */
  #settle(now: number): string[] {
    this.#sql.exec("DELETE FROM jobs WHERE state IN ('launched', 'failed') AND updated_at <= ?", now - HISTORY_MS);
    this.#sql.exec('DELETE FROM seen WHERE at <= ?', now - HISTORY_MS);
    const waiting = this.#sql.exec(
      "SELECT id, issue_id FROM jobs WHERE state = 'queued' OR (state = 'claimed' AND lease_until <= ?) ORDER BY rowid DESC",
      now).toArray();
    const issues = new Set<unknown>();
    const replaced: string[] = [];
    for (const { id, issue_id } of waiting) {
      if (issues.has(issue_id)) {
        this.#sql.exec('DELETE FROM jobs WHERE id = ?', String(id));
        replaced.push(String(id));
      } else {
        issues.add(issue_id);
        this.#sql.exec("UPDATE jobs SET state = 'queued', lease_until = NULL WHERE id = ? AND state = 'claimed'", String(id));
      }
    }
    return replaced;
  }

  async #replace(sessionIds: string[]) {
    for (const id of sessionIds) await this.#post(id, 'response', MESSAGES.replaced);
  }

  /** Posts an agent activity. A failure is logged, never thrown: the queue write stands. */
  async #post(sessionId: string, type: 'thought' | 'response', body: string): Promise<void> {
    try {
      const token = await this.#auth.getAccessToken();
      const res = await this.#fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: ACTIVITY, variables: { input: { agentSessionId: sessionId, content: { type, body } } } }),
      });
      const result = res.ok ? ((await res.json()) as { data?: { agentActivityCreate?: { success?: boolean } } }) : undefined;
      if (result?.data?.agentActivityCreate?.success) return;
    } catch {
      // The message could quote a body or token; log the outcome only.
    }
    log({ event: 'activity', machine: this.#machine, session: sessionId, type, outcome: 'failed' });
  }
}
