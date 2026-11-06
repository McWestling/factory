// One machine's job queue and the outbox of agent activities Cloud Inbox posts, kept in
// that machine's Durable Object. Runs under Node for tests, so SQL goes through `Sql`,
// which both Cloudflare's SqlStorage and a node:sqlite adapter satisfy.

import type { Claim } from '../job.ts';
import type { MachineAuth } from './auth.ts';
import { log } from './routes.ts';

const GRAPHQL_URL = 'https://api.linear.app/graphql';
const LEASE_MS = 10 * 60_000;
const HISTORY_MS = 30 * 24 * 60 * 60_000;
const POST_TIMEOUT_MS = 10_000;
const RETRY_MAX_MS = 60 * 60_000;

export const MESSAGES = {
  queued: (machine: string) =>
    `Queued on ${machine}. It starts when ${machine} picks it up, which can take a while if the machine is busy or asleep.`,
  replaced: 'Replaced by a newer delegation.',
  stopped: 'Stopped watching. The agent in Orca keeps running; stop it there if needed.',
  replies: "Delegate doesn't read replies; steer the agent in Orca.",
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
  /** Linear's stable id for a prompt. The route requires it unless `stop` is set. */
  activityId?: string;
  stop: boolean;
};

export type WebhookResult = 'queued' | 'duplicate' | 'answered' | 'ended' | 'no-issue' | 'app-user';
export type Outcome = 'launched' | 'failed';
type ActivityType = 'thought' | 'response';

// An outbox row is the head of its session when no earlier row for that session is
// pending. Only heads are sent, so a session's activities go out in the order written.
const HEAD = 'NOT EXISTS (SELECT 1 FROM outbox p WHERE p.session_id = o.session_id AND p.id < o.id)';

/**
 * A job's id is its session id. A job is waiting while `queued` or `claimed` with an
 * expired lease; each issue keeps only its newest waiting job.
 *
 * Queue changes write the activities they need to the outbox in the same synchronous
 * step and call `schedule`; `deliver()` (the Durable Object's alarm) sends them later.
 *
 * A stopped or replaced session is recorded in `ended`, so a late `created` or reply
 * can't queue it again or post after its final response. Claiming a job cancels its
 * queued thought: once the Runner owns the session, that thought is obsolete.
 *
 * Each claim gets a fresh id, and only that claim, while its lease lasts, can record the
 * job's outcome. A row claimed before ids existed has none, so it can't be finished: its
 * lease runs out and the job goes back on the queue.
 */
export class MachineQueue {
  #sql: Sql;
  #auth: MachineAuth;
  #machine: string;
  #fetch: typeof fetch;
  #now: () => number;
  #schedule: (at: number) => void;
  #draining?: Promise<void>;

  constructor(
    sql: Sql,
    auth: MachineAuth,
    machine: string,
    schedule: (at: number) => void,
    fetchFn: typeof fetch = (input, init) => fetch(input, init),
    now: () => number = Date.now,
  ) {
    this.#sql = sql;
    this.#auth = auth;
    this.#machine = machine;
    this.#fetch = fetchFn;
    this.#now = now;
    this.#schedule = schedule;
    sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL,
      state TEXT NOT NULL, lease_until INTEGER, updated_at INTEGER NOT NULL)`);
    // Added after the first deployments, so existing tables need it too.
    if (!sql.exec('PRAGMA table_info(jobs)').toArray().some((column) => column.name === 'claim_id')) {
      sql.exec('ALTER TABLE jobs ADD COLUMN claim_id TEXT');
    }
    sql.exec('CREATE TABLE IF NOT EXISTS seen (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS seen_activities (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS ended (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    // `queued` marks the queued thought, which a claim cancels.
    sql.exec(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      type TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, queued INTEGER NOT NULL DEFAULT 0)`);
  }

  /** Acts on a webhook whose signature, timestamp and org the Worker already checked. */
  async webhook(event: AgentEvent): Promise<WebhookResult> {
    const app = await this.#auth.installation();
    if (!app || app.appUserId !== event.appUserId) return 'app-user';
    // No await from here on, so each change and the activities it needs are atomic.
    const now = this.#now();
    const ended = this.#sql.exec('SELECT 1 FROM ended WHERE session_id = ?', event.sessionId).toArray().length > 0;

    if (event.action === 'prompted') {
      // Its final response is already written, so a repeated stop adds nothing.
      if (ended) return 'ended';
      if (event.stop) {
        // A stopped session that hasn't been picked up yet shouldn't start later.
        this.#sql.exec("DELETE FROM jobs WHERE id = ? AND state = 'queued'", event.sessionId);
        this.#end(event.sessionId, MESSAGES.stopped, now);
      } else {
        const fresh = this.#sql.exec(
          'INSERT INTO seen_activities (id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING id',
          event.activityId!, now).toArray();
        if (!fresh.length) return 'duplicate';
        this.#enqueue(event.sessionId, 'thought', MESSAGES.replies, now);
      }
      this.#wake();
      return 'answered';
    }

    if (!event.issueId) return 'no-issue';
    if (ended) return 'ended';
    const fresh = this.#sql.exec(
      'INSERT INTO seen (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING session_id',
      event.sessionId, now).toArray();
    if (!fresh.length) return 'duplicate';
    this.#sql.exec("INSERT INTO jobs (id, issue_id, state, updated_at) VALUES (?, ?, 'queued', ?)",
      event.sessionId, event.issueId, now);
    this.#settle(now);
    this.#enqueue(event.sessionId, 'thought', MESSAGES.queued(app.appName ?? this.#machine), now, true);
    this.#wake();
    return 'queued';
  }

  /** Claims the oldest waiting job with a fresh lease, or returns undefined. */
  async claim(): Promise<Claim | undefined> {
    const now = this.#now();
    if (this.#settle(now)) this.#wake();
    const claimId = crypto.randomUUID();
    const [row] = this.#sql.exec(
      `UPDATE jobs SET state = 'claimed', lease_until = ?, updated_at = ?, claim_id = ?
       WHERE id = (SELECT id FROM jobs WHERE state = 'queued' ORDER BY rowid LIMIT 1) RETURNING id, issue_id`,
      now + LEASE_MS, now, claimId).toArray();
    if (!row) return undefined;
    // The Runner owns the session now, so its queued thought is obsolete. One already in
    // flight is never retried: a failure updates a row that is gone.
    this.#sql.exec('DELETE FROM outbox WHERE session_id = ? AND queued = 1', String(row.id));
    return { issueId: String(row.issue_id), sessionId: String(row.id), claimId };
  }

  /** Records a claim's outcome. False unless it's the job's current claim and its lease hasn't expired. */
  async finish(id: string, claimId: string, outcome: Outcome): Promise<boolean> {
    const now = this.#now();
    return this.#sql.exec(
      `UPDATE jobs SET state = ?, lease_until = NULL, updated_at = ?
       WHERE id = ? AND state = 'claimed' AND claim_id = ? AND lease_until > ? RETURNING id`,
      outcome, now, id, claimId, now).toArray().length > 0;
  }

  /**
   * Sends pending activities, each session's in order, one request at a time. A failure
   * stays in the outbox and is retried with backoff; only a success removes it.
   */
  deliver(): Promise<void> {
    return (this.#draining ??= this.#drain());
  }

  async #drain(): Promise<void> {
    await null; // Lets deliver() store this drain before an empty outbox clears it.
    this.#expire(this.#now());
    for (;;) {
      const [row] = this.#sql.exec(
        `SELECT id, session_id, type, body, attempts FROM outbox o WHERE next_at <= ? AND ${HEAD} ORDER BY id LIMIT 1`,
        this.#now()).toArray();
      if (!row) {
        // Cleared with no await after the query, so a later deliver() starts a new drain.
        this.#draining = undefined;
        this.#wake();
        return;
      }
      const id = Number(row.id);
      const sessionId = String(row.session_id);
      const type = String(row.type) as ActivityType;
      if (await this.#post(id, sessionId, type, String(row.body))) {
        this.#sql.exec('DELETE FROM outbox WHERE id = ?', id);
      } else {
        const attempts = Number(row.attempts) + 1;
        log({ event: 'activity', machine: this.#machine, session: sessionId, type, outcome: 'retry', attempt: String(attempts) });
        // A row cancelled while in flight is already gone, so this updates nothing.
        this.#sql.exec('UPDATE outbox SET attempts = ?, next_at = ? WHERE id = ?',
          attempts, this.#now() + Math.min(RETRY_MAX_MS, 5_000 * 2 ** attempts), id);
      }
    }
  }

  /** Asks to be woken at the earliest time a pending activity can be sent. */
  #wake() {
    const [row] = this.#sql.exec(`SELECT MIN(next_at) AS at FROM outbox o WHERE ${HEAD}`).toArray();
    if (row?.at != null) this.#schedule(Number(row.at));
  }

  #enqueue(sessionId: string, type: ActivityType, body: string, now: number, queued = false) {
    this.#sql.exec('INSERT INTO outbox (session_id, type, body, created_at, next_at, queued) VALUES (?, ?, ?, ?, ?, ?)',
      sessionId, type, body, now, now, queued ? 1 : 0);
  }

  /** Marks a session ended and posts its final response, cancelling its thoughts not yet sent. */
  #end(sessionId: string, body: string, now: number) {
    this.#sql.exec('INSERT INTO ended (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING', sessionId, now);
    this.#sql.exec("DELETE FROM outbox WHERE session_id = ? AND type = 'thought'", sessionId);
    this.#enqueue(sessionId, 'response', body, now);
  }

  /** Drops expired history, including activities Linear has refused for the whole window. */
  #expire(now: number) {
    // Remove stopped claims before pruning the markers that prevent requeueing.
    this.#sql.exec(`DELETE FROM jobs WHERE state = 'claimed' AND lease_until <= ?
      AND id IN (SELECT session_id FROM ended)`, now);
    this.#sql.exec("DELETE FROM jobs WHERE state IN ('launched', 'failed') AND updated_at <= ?", now - HISTORY_MS);
    this.#sql.exec('DELETE FROM seen WHERE at <= ?', now - HISTORY_MS);
    this.#sql.exec('DELETE FROM seen_activities WHERE at <= ?', now - HISTORY_MS);
    this.#sql.exec('DELETE FROM ended WHERE at <= ?', now - HISTORY_MS);
    // ponytail: an activity Linear keeps refusing is dropped after the history window.
    for (const { session_id, type } of this.#sql.exec(
      'DELETE FROM outbox WHERE created_at <= ? RETURNING session_id, type', now - HISTORY_MS).toArray()) {
      log({ event: 'activity', machine: this.#machine, session: String(session_id), type: String(type), outcome: 'expired' });
    }
  }

  /**
   * Drops expired history, puts expired leases back on the queue, and keeps only the
   * newest waiting job per issue, ending each replaced session. True if it replaced any.
   */
  #settle(now: number): boolean {
    this.#expire(now);
    const waiting = this.#sql.exec(
      "SELECT id, issue_id FROM jobs WHERE state = 'queued' OR (state = 'claimed' AND lease_until <= ?) ORDER BY rowid DESC",
      now).toArray();
    const issues = new Set<unknown>();
    let replaced = false;
    for (const { id, issue_id } of waiting) {
      if (issues.has(issue_id)) {
        this.#sql.exec('DELETE FROM jobs WHERE id = ?', String(id));
        this.#end(String(id), MESSAGES.replaced, now);
        replaced = true;
      } else {
        issues.add(issue_id);
        this.#sql.exec("UPDATE jobs SET state = 'queued', lease_until = NULL WHERE id = ? AND state = 'claimed'", String(id));
      }
    }
    return replaced;
  }

  /** Posts an agent activity. True on success; a failure, including the token's, is never thrown. */
  async #post(id: number, sessionId: string, type: ActivityType, body: string): Promise<boolean> {
    try {
      const token = await this.#auth.getAccessToken();
      // Cancelled while the token refreshed: nothing left to send.
      if (!this.#sql.exec('SELECT 1 FROM outbox WHERE id = ?', id).toArray().length) return true;
      const res = await this.#fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: ACTIVITY, variables: { input: { agentSessionId: sessionId, content: { type, body } } } }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      const result = res.ok ? ((await res.json()) as { data?: { agentActivityCreate?: { success?: boolean } } }) : undefined;
      return result?.data?.agentActivityCreate?.success === true;
    } catch {
      // The message could quote a body or token, so it isn't logged.
      return false;
    }
  }
}
