// One machine's job queue and the outbox of agent activities Cloud Inbox posts, kept in
// that machine's Durable Object. Runs under Node for tests, so SQL goes through `Sql`,
// which both Cloudflare's SqlStorage and a node:sqlite adapter satisfy.

import type { Claim, LaunchEvidence } from '../job.ts';
import type { MachineAuth } from './auth.ts';
import { log } from './routes.ts';

const GRAPHQL_URL = 'https://api.linear.app/graphql';
const LEASE_MS = 10 * 60_000;
const HISTORY_MS = 30 * 24 * 60 * 60_000;
const POST_TIMEOUT_MS = 10_000;
// Leave room for Linear reads and linking within the Runner's 30-second deadline.
const METADATA_TIMEOUT_MS = 5_000;
const RETRY_MAX_MS = 60 * 60_000;
/** The longest status update a machine may post, in characters. */
export const MAX_UPDATE_CHARS = 2000;
/** The Dispatch target label a launch sets. The Runner only launches in Orca. */
const DISPATCH_LABEL = 'Orca';
const PULL_REQUEST = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/;

export const MESSAGES = {
  queued: (machine: string) =>
    `Queued on ${machine}. It starts when ${machine} picks it up, which can take a while if the machine is busy or asleep.`,
  replaced: 'Replaced by a newer delegation.',
  stopped: 'Stopped watching. The agent in Orca keeps running; stop it there if needed.',
  replies: "Delegator doesn't read replies; steer the agent in Orca.",
};

// Every Linear document Cloud Inbox sends. Variables come only from the job, never the machine.
const ACTIVITY = 'mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }';
const TASK = `query ($issue: String!, $session: String!) {
  issue(id: $issue) { identifier description branchName state { type } delegate { id } }
  agentSession(id: $session) { creator { id } } }`;
const WATCH = `query ($issue: String!, $session: String!) {
  issue(id: $issue) { state { type } attachments { nodes { url } } } agentSession(id: $session) { status } }`;
const LINK = `mutation ($session: String!, $url: String!) {
  agentSessionUpdate(id: $session, input: { addedExternalUrls: [{ label: "Pull request", url: $url }] }) { success } }`;
const LAUNCH = `query ($issue: String!, $session: String!) {
  issue(id: $issue) { delegate { id } state { type } team { id states(filter: { type: { eq: "started" } }) { nodes { id position } } }
    labels { nodes { id parent { id } } } }
  agentSession(id: $session) { creator { id } }
  issueLabels(filter: { name: { eq: "${DISPATCH_LABEL}" } }) { nodes { id team { id } parent { id } } } }`;
const DELEGATE = 'query ($issue: String!) { issue(id: $issue) { delegate { id } } }';
const ISSUE_UPDATE = 'mutation ($issue: String!, $input: IssueUpdateInput!) { issueUpdate(id: $issue, input: $input) { success } }';

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
export type UpdateType = 'thought' | 'response' | 'error';
/**
 * An outbox row: an activity, or a write-back. `launch` applies a launch's field changes
 * and `release` clears the delegate; their body holds the issue id, not text.
 */
type RowType = UpdateType | 'launch' | 'release';

/** Why a Runner operation was refused: no current claim, an ended session, no PR, or Linear failed. */
export type Refusal = 'not-claimed' | 'ended' | 'no-pr' | 'linear';
/** What the Runner checks before launch. */
export type Task = {
  delegated: boolean;
  creatorId: string | null;
  identifier: string;
  description: string;
  branchName: string;
  statusType: string;
};
export type Watch = { sessionStatus: string; issueState?: string; pullRequests: string[] };

type Id = { id?: string } | null | undefined;
type TaskData = {
  issue?: { identifier?: string; description?: string | null; branchName?: string; state?: { type?: string }; delegate?: Id };
  agentSession?: { creator?: Id };
};
type WatchData = { issue?: { state?: { type?: string }; attachments?: { nodes?: { url?: string }[] } }; agentSession?: { status?: string } };
type LaunchData = {
  issue?: {
    delegate?: Id;
    state?: { type?: string };
    team?: { id?: string; states?: { nodes?: { id: string; position: number }[] } };
    labels?: { nodes?: { id: string; parent?: Id }[] };
  };
  agentSession?: { creator?: Id };
  issueLabels?: { nodes?: { id: string; team?: Id; parent?: Id }[] };
};

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
    for (const column of ['launch_repo', 'launch_branch']) {
      if (!sql.exec('PRAGMA table_info(jobs)').toArray().some((row) => row.name === column)) {
        sql.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
      }
    }
    sql.exec('CREATE TABLE IF NOT EXISTS seen (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS seen_activities (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS ended (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    // Sessions whose issue was delegated again, so their write-backs never apply.
    sql.exec('CREATE TABLE IF NOT EXISTS superseded (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
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
    const fresh = this.#sql.exec(
      'INSERT INTO seen (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING session_id',
      event.sessionId, now).toArray();
    // A replayed delegation is older than what came after it, so it supersedes nothing.
    if (!fresh.length) return ended ? 'ended' : 'duplicate';
    // A new delegation supersedes the issue's older jobs, even if it was stopped before
    // this webhook arrived.
    this.#sql.exec(`INSERT INTO superseded (session_id, at) SELECT id, ? FROM jobs WHERE issue_id = ? AND id != ?
      ON CONFLICT DO NOTHING`, now, event.issueId, event.sessionId);
    if (ended) return 'ended';
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

  /**
   * Records a claim's outcome and queues its write-back: a launch's field changes, or
   * clearing a failed job's delegate. False unless it's the job's current claim and its
   * lease hasn't expired.
   */
  async finish(id: string, claimId: string, outcome: Outcome, launch?: LaunchEvidence): Promise<boolean> {
    const now = this.#now();
    const [row] = this.#sql.exec(
      `UPDATE jobs SET state = ?, lease_until = NULL, updated_at = ?, launch_repo = ?, launch_branch = ?
       WHERE id = ? AND state = 'claimed' AND claim_id = ? AND lease_until > ? RETURNING issue_id`,
      outcome, now, launch?.repo ?? null, launch?.branch ?? null, id, claimId, now).toArray();
    if (!row) return false;
    this.#enqueue(id, outcome === 'launched' ? 'launch' : 'release', String(row.issue_id), now);
    this.#wake();
    return true;
  }

  /** Recover completion watches after an upgrade or loss of the machine's local state. */
  async watching(): Promise<(Claim & { at: number; launch?: LaunchEvidence })[]> {
    return this.#sql.exec(`SELECT id, issue_id, claim_id, updated_at, launch_repo, launch_branch FROM jobs WHERE state = 'launched'
      AND claim_id IS NOT NULL AND id NOT IN (SELECT session_id FROM ended)
      AND id NOT IN (SELECT session_id FROM superseded)`).toArray().map((row) => ({
      sessionId: String(row.id), issueId: String(row.issue_id), claimId: String(row.claim_id), at: Number(row.updated_at),
      ...(row.launch_repo && row.launch_branch ? { launch: { repo: String(row.launch_repo), branch: String(row.launch_branch) } } : {}),
    }));
  }

  /** The job's issue id while `claimId` holds it: claimed with a live lease, or launched by that claim. */
  #held(id: string, claimId: string): string | undefined {
    const [row] = this.#sql.exec(
      `SELECT issue_id FROM jobs WHERE id = ? AND claim_id = ?
       AND ((state = 'claimed' AND lease_until > ?) OR state = 'launched')`, id, claimId, this.#now()).toArray();
    return row ? String(row.issue_id) : undefined;
  }

  /** Reads what the Runner checks before launch, from the job's own issue and session. */
  async task(id: string, claimId: string): Promise<Task | Refusal> {
    const issueId = this.#held(id, claimId);
    if (!issueId) return 'not-claimed';
    const data = await this.#read<TaskData>(TASK, { issue: issueId, session: id });
    const issue = data?.issue;
    if (!issue?.identifier || !issue.branchName || !issue.state?.type) return 'linear';
    const app = await this.#auth.installation();
    return {
      delegated: Boolean(app && issue.delegate?.id === app.appUserId),
      creatorId: data?.agentSession?.creator?.id ?? null,
      identifier: issue.identifier,
      description: issue.description ?? '',
      branchName: issue.branchName,
      statusType: issue.state.type,
    };
  }

  /**
   * Queues a status update on the job's session, behind its earlier activities. A
   * `response` or `error` ends the session, so later updates are refused.
   */
  async update(id: string, claimId: string, type: UpdateType, body: string): Promise<'queued' | Refusal> {
    // Older Runners use the same completion message; they must pass ownership checks too.
    if (type === 'response' && body.startsWith('Opened ')) {
      const found = await this.watch(id, claimId);
      if (typeof found === 'string') return found;
      if (['complete', 'error', 'stopped'].includes(found.sessionStatus)) return 'ended';
      if (!['pending', 'active', 'awaitingInput', 'stale'].includes(found.sessionStatus)) return 'linear';
      if (!found.pullRequests.some((url) => body === `Opened ${url}.`)) return 'no-pr';
    }
    if (!this.#held(id, claimId)) return 'not-claimed';
    // No await from here on, so a stop can't land between the check and the write.
    if (this.#sql.exec('SELECT 1 FROM ended WHERE session_id = ?', id).toArray().length) return 'ended';
    const now = this.#now();
    if (type === 'thought') this.#enqueue(id, type, body, now);
    else this.#end(id, body, now, type);
    this.#wake();
    return 'queued';
  }

  /** Only attachments whose authoritative repository and head match the recorded launch. */
  async watch(id: string, claimId: string): Promise<Watch | Refusal> {
    const issueId = this.#held(id, claimId);
    if (!issueId) return 'not-claimed';
    const data = await this.#read<WatchData>(WATCH, { issue: issueId, session: id });
    const status = data?.agentSession?.status;
    if (!status) return 'linear';
    if (['complete', 'error', 'stopped'].includes(status)) {
      if (this.#held(id, claimId) !== issueId) return 'not-claimed';
      return { sessionStatus: status, pullRequests: [] };
    }
    if (!data?.issue) return 'linear';
    const urls = (data.issue.attachments?.nodes ?? []).map((a) => a.url ?? '');
    const [launch] = this.#sql.exec('SELECT launch_repo, launch_branch FROM jobs WHERE id = ? AND claim_id = ?', id, claimId).toArray();
    const pullRequests: string[] = [];
    if (launch?.launch_repo && launch.launch_branch) {
      const metadataSignal = AbortSignal.timeout(METADATA_TIMEOUT_MS);
      for (const url of urls.filter((url) => PULL_REQUEST.test(url))) {
        if (metadataSignal.aborted) break;
        const path = new URL(url).pathname.split('/');
        if (`${path[1]}/${path[2]}`.toLowerCase() !== String(launch.launch_repo).toLowerCase()) continue;
        try {
          // shortcut: public metadata only, add GitHub credentials when private PR detection is required.
          const response = await this.#fetch(`https://api.github.com/repos/${path[1]}/${path[2]}/pulls/${path[4]}`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'factory-delegator' },
            // Workers' fetch throws on `redirect: 'error'`; a redirect stays unverified as a non-2xx.
            signal: metadataSignal, redirect: 'manual',
          });
          if (!response.ok) {
            log({ event: 'watch', session: id, outcome: `pr-metadata-${response.status}` });
            continue;
          }
          const pr = await response.json() as { base?: { repo?: { full_name?: string } }; head?: { ref?: string; repo?: { full_name?: string } } };
          metadataSignal.throwIfAborted();
          const repo = String(launch.launch_repo).toLowerCase();
          if (pr.base?.repo?.full_name?.toLowerCase() === repo && pr.head?.repo?.full_name?.toLowerCase() === repo
            && pr.head?.ref === launch.launch_branch) pullRequests.push(url);
        } catch {
          // Unverifiable ownership stays watched.
          log({ event: 'watch', session: id, outcome: 'pr-metadata-failed' });
        }
      }
    }
    // A stop, replacement or reclaim may have landed during metadata reads.
    if (this.#held(id, claimId) !== issueId) return 'not-claimed';
    if (this.#sql.exec('SELECT 1 FROM superseded WHERE session_id = ?', id).toArray().length) return 'not-claimed';
    if (this.#sql.exec('SELECT 1 FROM ended WHERE session_id = ?', id).toArray().length) {
      return { sessionStatus: 'complete', pullRequests: [] };
    }
    return { sessionStatus: status, issueState: data.issue.state?.type, pullRequests };
  }

  /** Links the first verified launch pull request on the session as "Pull request". */
  async linkPullRequest(id: string, claimId: string): Promise<{ url: string } | Refusal> {
    const found = await this.watch(id, claimId);
    if (typeof found === 'string') return found;
    if (['complete', 'error', 'stopped'].includes(found.sessionStatus)) return 'ended';
    const url = found.pullRequests[0];
    if (!url) return 'no-pr';
    const data = await this.#read<{ agentSessionUpdate?: { success?: boolean } }>(LINK, { session: id, url });
    return data?.agentSessionUpdate?.success === true ? { url } : 'linear';
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
      const type = String(row.type) as RowType;
      if (await this.#send(id, sessionId, type, String(row.body))) {
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

  #enqueue(sessionId: string, type: RowType, body: string, now: number, queued = false) {
    this.#sql.exec('INSERT INTO outbox (session_id, type, body, created_at, next_at, queued) VALUES (?, ?, ?, ?, ?, ?)',
      sessionId, type, body, now, now, queued ? 1 : 0);
  }

  /** Marks a session ended and posts its final activity, cancelling its thoughts not yet sent. */
  #end(sessionId: string, body: string, now: number, type: 'response' | 'error' = 'response') {
    this.#sql.exec('INSERT INTO ended (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING', sessionId, now);
    this.#sql.exec("DELETE FROM outbox WHERE session_id = ? AND type = 'thought'", sessionId);
    this.#enqueue(sessionId, type, body, now);
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
    // Kept while a write-back of the session is still pending, however old.
    this.#sql.exec('DELETE FROM superseded WHERE at <= ? AND session_id NOT IN (SELECT session_id FROM outbox)',
      now - HISTORY_MS);
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

  /** Sends one outbox row. True on success; a failure, including the token's, is never thrown. */
  async #send(id: number, sessionId: string, type: RowType, body: string): Promise<boolean> {
    try {
      const token = await this.#auth.getAccessToken();
      // Cancelled while the token refreshed: nothing left to send.
      if (!this.#sql.exec('SELECT 1 FROM outbox WHERE id = ?', id).toArray().length) return true;
      if (type === 'launch') return await this.#launch(token, id, body, sessionId);
      if (type === 'release') return await this.#release(token, id, body, sessionId);
      const data = await this.#linear<{ agentActivityCreate?: { success?: boolean } }>(token, ACTIVITY,
        { input: { agentSessionId: sessionId, content: { type, body } } });
      return data.agentActivityCreate?.success === true;
    } catch {
      // The message could quote a body or token, so it isn't logged.
      return false;
    }
  }

  /**
   * A launch's field changes: `In Progress` (the team's first started status) unless the
   * issue is already started, completed or canceled; the `Orca` label, replacing any other
   * label in its group; and the session creator as assignee. Dropped once the issue is
   * handed to someone else or delegated again.
   */
  async #launch(token: string, row: number, issueId: string, sessionId: string): Promise<boolean> {
    const { issue, agentSession, issueLabels } = await this.#linear<LaunchData>(token, LAUNCH, { issue: issueId, session: sessionId });
    if (!issue?.state?.type) return false;
    const app = await this.#auth.installation();
    if (!app || issue.delegate?.id !== app.appUserId) return true;
    const input: Record<string, unknown> = {};
    if (['triage', 'backlog', 'unstarted'].includes(issue.state.type)) {
      const [started] = (issue.team?.states?.nodes ?? []).toSorted((a, b) => a.position - b.position);
      if (started) input.stateId = started.id;
    }
    const label = issueLabels?.nodes?.find((l) => !l.team || l.team.id === issue.team?.id);
    if (label) {
      input.addedLabelIds = [label.id];
      const group = label.parent?.id;
      const siblings = (issue.labels?.nodes ?? []).filter((l) => group && l.parent?.id === group && l.id !== label.id);
      if (siblings.length) input.removedLabelIds = siblings.map((l) => l.id);
    }
    const creator = agentSession?.creator?.id;
    if (creator) input.assigneeId = creator;
    return this.#updateIssue(token, row, issueId, sessionId, input);
  }

  /** Clears the delegate, but only while it's still this app: a newer delegation keeps its own. */
  async #release(token: string, row: number, issueId: string, sessionId: string): Promise<boolean> {
    const { issue } = await this.#linear<{ issue?: { delegate?: Id } }>(token, DELEGATE, { issue: issueId });
    if (!issue) return false;
    const app = await this.#auth.installation();
    if (!app || issue.delegate?.id !== app.appUserId) return true;
    return this.#updateIssue(token, row, issueId, sessionId, { delegateId: null });
  }

  /**
   * Applies a write-back's field changes unless its row was cancelled or a newer delegation
   * of the issue reached this machine, checked with no await before the edit is sent.
   */
  async #updateIssue(token: string, row: number, issueId: string, sessionId: string, input: Record<string, unknown>): Promise<boolean> {
    const stale = !this.#sql.exec('SELECT 1 FROM outbox WHERE id = ?', row).toArray().length
      || this.#sql.exec('SELECT 1 FROM superseded WHERE session_id = ?', sessionId).toArray().length;
    if (stale) return true;
    const data = await this.#linear<{ issueUpdate?: { success?: boolean } }>(token, ISSUE_UPDATE, { issue: issueId, input });
    return data.issueUpdate?.success === true;
  }

  /** A read or write the Runner waits on. Undefined if Linear or the token failed. */
  async #read<T>(query: string, variables: Record<string, unknown>): Promise<T | undefined> {
    try {
      return await this.#linear<T>(await this.#auth.getAccessToken(), query, variables);
    } catch {
      return undefined; // Never logged: the message could quote task content or a token.
    }
  }

  /** One GraphQL request, bounded by the timeout. Throws unless Linear returns data without errors. */
  async #linear<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.#fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const result = res.ok ? ((await res.json()) as { data?: T; errors?: unknown }) : undefined;
    if (!result?.data || result.errors) throw new Error('Linear request failed');
    return result.data;
  }
}
