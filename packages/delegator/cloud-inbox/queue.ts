// The shared job queue every machine claims from, and the outbox of agent activities
// Cloud Inbox posts, kept in Cloud Inbox's Durable Object. Runs under Node for tests, so SQL goes through `Sql`,
// which both Cloudflare's SqlStorage and a node:sqlite adapter satisfy.

import { ENDED_STATUSES, LIVE_STATUSES, PULL_REQUEST, type JobKind, type Outcome, type Task, type UpdateType, type Watch, type Watching } from '../contract.ts';
import type { Claim, LaunchEvidence } from '../job.ts';
import type { AppAuth } from './auth.ts';
import { log } from './routes.ts';

const GRAPHQL_URL = 'https://api.linear.app/graphql';
const LEASE_MS = 10 * 60_000;
const HISTORY_MS = 30 * 24 * 60 * 60_000;
const POST_TIMEOUT_MS = 10_000;
/**
 * How long a delegation notification waits for Linear's own `created` event before Cloud Inbox
 * opens the session itself. A first delegation sends both, within a second of each other.
 * A notification also counts as the same delegation as a session Linear made within this long of
 * it, by Linear's own timestamps, however late either arrives.
 * ponytail: a `created` that arrives after the wait still gets a second session, which replaces
 * it; and delegating again within the wait of a session that was then stopped starts nothing.
 * Ask Linear for the issue's sessions if either ever happens.
 */
export const DELEGATION_WAIT_MS = 5_000;
/** How long after a delegation notification a `created` with no human creator can be Cloud Inbox's own. */
const OWN_SESSION_MS = 10 * 60_000;
// Leave room for Linear reads and linking within the Runner's 30-second deadline.
const METADATA_TIMEOUT_MS = 5_000;
const RETRY_MAX_MS = 60 * 60_000;
/** A machine unseen this long is reported offline: many missed 15-second polls. */
const OFFLINE_MS = 5 * 60_000;
/** The longest status update a machine may post, in characters. */
export const MAX_UPDATE_CHARS = 2000;
/** The Dispatch target label a launch sets. The Runner only launches in Orca. */
const DISPATCH_LABEL = 'Orca';

export const MESSAGES = {
  queued: (app: string) =>
    `Queued for ${app}. It starts when a machine picks it up, which can take a while if every machine is busy or asleep.`,
  replaced: 'Replaced by a newer delegation.',
  stopped: 'Stopped watching. The agent in Orca keeps running; stop it there if needed.',
  replies: "Delegator doesn't read replies; steer the agent in Orca.",
  expired: 'No machine picked up this closeout within 30 days, so it was dropped.',
  unreadable: "Can't read the PR; check the GitHub token.",
};

// Every Linear document Cloud Inbox sends. Variables come only from the job, never the machine.
const ACTIVITY = 'mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }';
const TASK = `query ($issue: String!, $session: String!) {
  issue(id: $issue) { identifier description branchName state { type } delegate { id } labels { nodes { name } } }
  agentSession(id: $session) { creator { id } } }`;
const CLOSEOUT_TASK = TASK.replace('labels { nodes { name } }', 'labels { nodes { name } } attachments { nodes { url } }');
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
const CREATE_SESSION = `mutation ($issue: String!) {
  agentSessionCreateOnIssue(input: { issueId: $issue }) { success agentSession { id } } }`;

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
  /** The session's human creator; absent when the app or an automation started it. */
  creatorId?: string;
  /** When Linear made the session, on a `created`. */
  createdAt?: number;
};

/**
 * A verified Inbox notification that the issue was delegated to the app. Linear sends one for
 * every delegation, but a session event only for an issue's first. `actorId` is who delegated.
 */
export type DelegatedEvent = {
  action: 'delegated'; appUserId: string; notificationId: string; issueId: string; actorId?: string;
  /** When Linear made the notification. */
  createdAt?: number;
};
/** A waiting delegation's outbox body: the issue, and who delegated it. */
type Delegation = { issue: string; creator: string | null };
/** A merged-PR `Attachment` update: the issue, and the PR's URL, repo (`owner/name`) and head branch. */
export type MergeEvent = { action: 'merged'; issueId: string; url: string; repo: string; branch: string };
/** A closeout's outbox body: the launch job it closes out, its issue, machine and PR URL. */
type Closeout = { launch: string; issue: string; machine: string; pr: string };

/** `waiting`: a delegation notification is waiting for Linear's `created`; `covered`: one already came. */
export type WebhookResult = 'queued' | 'duplicate' | 'no-match' | 'own-session' | 'answered' | 'ended' | 'no-issue' | 'app-user'
  | 'waiting' | 'covered';
/**
 * An outbox row: an activity, or a write-back. `launch` applies a launch's field changes
 * and `release` clears the delegate; their body holds the issue id, not text. `closeout`
 * creates a closeout job's session and then the job; its body holds the launch as JSON.
 * `delegation` does the same for an issue delegated without a session; its body is a `Delegation`.
 */
type RowType = UpdateType | 'launch' | 'release' | 'closeout' | 'delegation';

/** Why a Runner operation was refused: no current claim, an ended session, no PR, or Linear failed. */
export type Refusal = 'not-claimed' | 'ended' | 'no-pr' | 'linear';
/** What a Runner last reported, as it writes its local `status.json`. Cloud Inbox doesn't read it. */
export type Snapshot = Record<string, unknown>;
export type Pool = {
  queueDepth: number;
  machines: { name: string; online: boolean; lastSeenAt: string | null; snapshot: Snapshot | null }[];
};

type Id = { id?: string } | null | undefined;
type TaskData = {
  issue?: { identifier?: string; description?: string | null; branchName?: string; state?: { type?: string }; delegate?: Id;
    labels?: { nodes?: { name?: string }[] }; attachments?: { nodes?: { url?: string }[] } };
  agentSession?: { creator?: Id };
};
type PullRequest = { merged?: boolean; base?: { repo?: { full_name?: string } }; head?: { ref?: string; repo?: { full_name?: string } } };
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
 * A job's id is its session id. Any machine may claim a new job; the claim records
 * which one did, and only that machine can use it. A job is waiting while `queued` or
 * `claimed` with an expired lease; each issue keeps only its newest waiting job.
 *
 * An expired lease doesn't prove no agent started: the launch report may be what was
 * lost, and only the claiming machine's local state can tell. So once claimed, a job
 * goes back on the queue for that machine alone. If it never returns, the job waits
 * until the session is stopped or the issue is delegated again.
 *
 * Queue changes write the activities they need to the outbox in the same synchronous
 * step and call `schedule`; `deliver()` (the Durable Object's alarm) sends them later.
 *
 * A stopped or replaced session is recorded in `ended`, so a late `created` or reply
 * can't queue it again or post after its final response. Claiming a job cancels its
 * queued thought: once the Runner owns the session, that thought is obsolete.
 *
 * Each claim gets a fresh id, and only that claim, while its lease lasts, can record the
 * job's outcome.
 */
export class JobQueue {
  #sql: Sql;
  #auth: AppAuth;
  #fetch: typeof fetch;
  #now: () => number;
  #schedule: (at: number) => void;
  #draining?: Promise<void>;
  #githubToken?: string;

  constructor(
    sql: Sql,
    auth: AppAuth,
    schedule: (at: number) => void,
    fetchFn: typeof fetch = (input, init) => fetch(input, init),
    now: () => number = Date.now,
    githubToken?: string,
  ) {
    this.#sql = sql;
    this.#auth = auth;
    this.#fetch = fetchFn;
    this.#now = now;
    this.#schedule = schedule;
    this.#githubToken = githubToken;
    // `machine` is the machine whose claim holds the job. A closeout job `closes` a launch
    // job, whose PR is `pull_request`. `creator` is who delegated, for a session Cloud Inbox opened.
    const added = { kind: "TEXT NOT NULL DEFAULT 'delegation'", closes: 'TEXT', pull_request: 'TEXT', creator: 'TEXT' };
    sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL,
      state TEXT NOT NULL, lease_until INTEGER, updated_at INTEGER NOT NULL, claim_id TEXT, machine TEXT,
      launch_repo TEXT, launch_branch TEXT)`);
    const columns = new Set(sql.exec('PRAGMA table_info(jobs)').toArray().map((column) => column.name));
    for (const [name, type] of Object.entries(added)) {
      if (!columns.has(name)) sql.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
    }
    sql.exec('CREATE TABLE IF NOT EXISTS seen (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS seen_activities (id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS ended (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    // Sessions already told GitHub refused to show their PR, so the thought posts once.
    sql.exec('CREATE TABLE IF NOT EXISTS unreadable (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    // Sessions whose issue was delegated again, so their write-backs never apply.
    sql.exec('CREATE TABLE IF NOT EXISTS superseded (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    // Launch jobs whose merge already queued a closeout, so it queues once.
    sql.exec('CREATE TABLE IF NOT EXISTS closeouts (launch_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, at INTEGER NOT NULL)');
    // Delegation notifications already handled, so each starts one session at most.
    sql.exec('CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, at INTEGER NOT NULL)');
    // When each issue's newest delegation session arrived, and when Linear made it if Linear did,
    // so its notification opens no second one.
    sql.exec('CREATE TABLE IF NOT EXISTS delegated (issue_id TEXT PRIMARY KEY, at INTEGER NOT NULL, created_at INTEGER)');
    // `queued` marks the queued thought, which a claim cancels.
    sql.exec(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      type TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, queued INTEGER NOT NULL DEFAULT 0)`);
    // Each machine's latest snapshot only; no history.
    sql.exec('CREATE TABLE IF NOT EXISTS machines (name TEXT PRIMARY KEY, snapshot TEXT NOT NULL, seen_at INTEGER NOT NULL)');
  }

  /** Keeps `machine`'s latest snapshot and when it arrived. */
  async report(machine: string, snapshot: Snapshot): Promise<void> {
    this.#sql.exec(`INSERT INTO machines (name, snapshot, seen_at) VALUES (?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET snapshot = excluded.snapshot, seen_at = excluded.seen_at`,
      machine, JSON.stringify(snapshot), this.#now());
  }

  /** Every named machine's latest snapshot, and how many issues wait for a claim. */
  async pool(names: string[]): Promise<Pool> {
    const now = this.#now();
    const seen = new Map(this.#sql.exec('SELECT name, snapshot, seen_at FROM machines').toArray()
      .map((row) => [String(row.name), row]));
    // A closeout waits for its own machine, not the pool, so it isn't counted.
    const [waiting] = this.#sql.exec(`SELECT COUNT(DISTINCT issue_id) AS n FROM jobs
      WHERE kind = 'delegation' AND (state = 'queued' OR (state = 'claimed' AND lease_until <= ?))`, now).toArray();
    return {
      queueDepth: Number(waiting?.n ?? 0),
      machines: names.map((name) => {
        const row = seen.get(name);
        if (!row) return { name, online: false, lastSeenAt: null, snapshot: null };
        const at = Number(row.seen_at);
        return { name, online: now - at < OFFLINE_MS, lastSeenAt: new Date(at).toISOString(), snapshot: JSON.parse(String(row.snapshot)) };
      }),
    };
  }

  /** Acts on a webhook whose signature, timestamp and org the Worker already checked. */
  async webhook(event: AgentEvent | MergeEvent | DelegatedEvent): Promise<WebhookResult> {
    if (event.action === 'merged') return this.#merged(event);
    const app = await this.#auth.installation();
    if (!app || app.appUserId !== event.appUserId) return 'app-user';
    // No await from here on, so each change and the activities it needs are atomic.
    const now = this.#now();
    if (event.action === 'delegated') return this.#delegated(event, now);
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
    if (this.#ownSession(event, app)) return 'own-session';
    const fresh = this.#sql.exec(
      'INSERT INTO seen (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING session_id',
      event.sessionId, now).toArray();
    // A replayed delegation is older than what came after it, so it supersedes nothing.
    if (!fresh.length) return ended ? 'ended' : 'duplicate';
    // A new delegation supersedes the issue's older jobs, even if it was stopped before
    // this webhook arrived.
    this.#supersede(event.sessionId, event.issueId, now, event.createdAt);
    if (ended) return 'ended';
    this.#queueDelegation(event.sessionId, event.issueId, null, app.appName, now);
    this.#wake();
    return 'queued';
  }

  /**
   * A new delegation session of the issue: supersedes its older jobs, and covers a delegation
   * notification still waiting, or arriving within the wait, so that one opens no second session.
   */
  #supersede(sessionId: string, issueId: string, now: number, createdAt?: number) {
    this.#sql.exec(`INSERT INTO superseded (session_id, at) SELECT id, ? FROM jobs WHERE issue_id = ? AND id != ?
      ON CONFLICT DO NOTHING`, now, issueId, sessionId);
    this.#sql.exec(`INSERT INTO delegated (issue_id, at, created_at) VALUES (?, ?, ?)
      ON CONFLICT (issue_id) DO UPDATE SET at = excluded.at, created_at = excluded.created_at`, issueId, now, createdAt ?? null);
    this.#sql.exec("DELETE FROM outbox WHERE type = 'delegation' AND json_extract(body, '$.issue') = ?", issueId);
  }

  /** Queues the delegation job with its queued thought, replacing the issue's older waiting jobs. */
  #queueDelegation(sessionId: string, issueId: string, creator: string | null, appName: string | undefined, now: number) {
    this.#sql.exec("INSERT INTO jobs (id, issue_id, state, updated_at, creator) VALUES (?, ?, 'queued', ?, ?)",
      sessionId, issueId, now, creator);
    this.#settle(now);
    this.#enqueue(sessionId, 'thought', MESSAGES.queued(appName ?? 'Delegator'), now, true);
  }

  /**
   * Each notification counts once. Unless a `created` for the issue came within the wait, or
   * Linear made that session within the wait of the notification, it waits that long for one; `#delegation` then opens the session. A newer notification of the
   * issue replaces one still waiting.
   */
  #delegated(event: DelegatedEvent, now: number): WebhookResult {
    if (!this.#sql.exec('INSERT INTO notifications (id, issue_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id',
      event.notificationId, event.issueId, now).toArray().length) return 'duplicate';
    if (this.#sql.exec('SELECT 1 FROM delegated WHERE issue_id = ? AND (at > ? OR abs(created_at - ?) < ?)',
      event.issueId, now - DELEGATION_WAIT_MS, event.createdAt ?? null, DELEGATION_WAIT_MS).toArray().length) return 'covered';
    this.#sql.exec("DELETE FROM outbox WHERE type = 'delegation' AND json_extract(body, '$.issue') = ?", event.issueId);
    const delegation: Delegation = { issue: event.issueId, creator: event.actorId ?? null };
    this.#enqueue(`delegation:${event.notificationId}`, 'delegation', JSON.stringify(delegation), now, false, DELEGATION_WAIT_MS);
    this.#wake();
    return 'waiting';
  }

  /**
   * Queues a closeout once per launch, when the issue's newest unsuperseded launch made this
   * PR. The session is created later, from the outbox; `#closeout` then queues the job.
   */
  #merged(event: MergeEvent): WebhookResult {
    const now = this.#now();
    const [launch] = this.#sql.exec(`SELECT id, machine, launch_repo, launch_branch FROM jobs
      WHERE issue_id = ? AND state = 'launched' AND kind = 'delegation' AND id NOT IN (SELECT session_id FROM superseded)
      ORDER BY rowid DESC LIMIT 1`, event.issueId).toArray();
    // A refine launch has no evidence, so it never matches.
    if (!launch?.launch_repo || String(launch.launch_repo).toLowerCase() !== event.repo.toLowerCase()
      || launch.launch_branch !== event.branch) return 'no-match';
    const id = String(launch.id);
    if (!this.#sql.exec('INSERT INTO closeouts (launch_id, issue_id, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING launch_id',
      id, event.issueId, now).toArray().length) return 'duplicate';
    const closeout: Closeout = { launch: id, issue: event.issueId, machine: String(launch.machine), pr: event.url };
    this.#enqueue(`closeout:${id}`, 'closeout', JSON.stringify(closeout), now);
    this.#wake();
    return 'queued';
  }

  /**
   * True for Linear's `created` webhook of a session Cloud Inbox made, for a closeout or for a
   * delegation that came without one: a session with no human creator, on an issue that has a
   * closeout, a recent delegation notification or one still waiting. Linear may send it before, or without, the create's
   * response, so a closeout or delegation still waiting on that create adopts the session.
   */
  #ownSession(event: AgentEvent, app: { appUserId: string; appName?: string }): boolean {
    if (event.creatorId && event.creatorId !== app.appUserId) return false;
    const issueId = event.issueId!;
    const now = this.#now();
    if (!this.#sql.exec(`SELECT 1 FROM closeouts WHERE issue_id = ?
      UNION ALL SELECT 1 FROM notifications WHERE issue_id = ? AND at > ?
      UNION ALL SELECT 1 FROM outbox WHERE type = 'delegation' AND json_extract(body, '$.issue') = ?`,
      issueId, issueId, now - OWN_SESSION_MS, issueId).toArray().length) return false;
    // A replay of a session already handled must not take another pending create.
    if (this.#sql.exec('SELECT 1 FROM seen WHERE session_id = ?', event.sessionId).toArray().length) return true;
    const [pending] = this.#sql.exec(`SELECT id, type, body FROM outbox WHERE type IN ('closeout', 'delegation')
      AND json_extract(body, '$.issue') = ? ORDER BY id LIMIT 1`, issueId).toArray();
    // ponytail: a retry that created a second session before this webhook arrived leaves this one
    // empty, as does a human's `created` that took the waiting delegation while its create was in
    // flight (logged `adopted`). With a closeout and a delegation both pending, the older takes it.
    const seen = () => this.#sql.exec('INSERT INTO seen (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING', event.sessionId, now);
    if (!pending) {
      seen();
      return true;
    }
    this.#sql.exec('DELETE FROM outbox WHERE id = ?', Number(pending.id));
    if (pending.type === 'closeout') {
      this.#queueCloseout(event.sessionId, JSON.parse(String(pending.body)), now);
    } else {
      seen();
      const { creator } = JSON.parse(String(pending.body)) as Delegation;
      this.#supersede(event.sessionId, issueId, now);
      this.#queueDelegation(event.sessionId, issueId, creator, app.appName, now);
    }
    this.#wake();
    return true;
  }

  /**
   * Claims the oldest waiting job of `kinds` new or last held by `machine`, with a fresh
   * lease, or returns undefined. Only a Runner that asks for closeout jobs gets them.
   */
  async claim(machine: string, kinds: readonly JobKind[] = ['delegation']): Promise<Claim | undefined> {
    const now = this.#now();
    if (this.#settle(now)) this.#wake();
    const claimId = crypto.randomUUID();
    const [row] = this.#sql.exec(
      `UPDATE jobs SET state = 'claimed', lease_until = ?, updated_at = ?, claim_id = ?, machine = ?
       WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND (machine IS NULL OR machine = ?)
         AND kind IN (${kinds.map(() => '?').join(', ')}) ORDER BY rowid LIMIT 1)
       RETURNING id, issue_id`,
      now + LEASE_MS, now, claimId, machine, machine, ...kinds).toArray();
    if (!row) return undefined;
    // The Runner owns the session now, so its queued thought is obsolete. One already in
    // flight is never retried: a failure updates a row that is gone.
    this.#sql.exec('DELETE FROM outbox WHERE session_id = ? AND queued = 1', String(row.id));
    return { issueId: String(row.issue_id), sessionId: String(row.id), claimId };
  }

  /**
   * Records a claim's outcome and queues a delegation's write-back: a launch's field changes,
   * or clearing a failed job's delegate. A closeout has none. False unless it's the job's current claim, held by
   * `machine`, and its lease hasn't expired.
   */
  async finish(machine: string, id: string, claimId: string, outcome: Outcome, launch?: LaunchEvidence): Promise<boolean> {
    const now = this.#now();
    const [row] = this.#sql.exec(
      `UPDATE jobs SET state = ?, lease_until = NULL, updated_at = ?, launch_repo = ?, launch_branch = ?
       WHERE id = ? AND state = 'claimed' AND claim_id = ? AND machine = ? AND lease_until > ? RETURNING issue_id, kind`,
      outcome, now, launch?.repo ?? null, launch?.branch ?? null, id, claimId, machine, now).toArray();
    if (!row) return false;
    if (row.kind === 'closeout') return true;
    this.#enqueue(id, outcome === 'launched' ? 'launch' : 'release', String(row.issue_id), now);
    this.#wake();
    return true;
  }

  /** `machine`'s launched jobs, to recover completion watches after an upgrade or loss of its local state. */
  async watching(machine: string): Promise<Watching[]> {
    return this.#sql.exec(`SELECT id, issue_id, claim_id, updated_at, launch_repo, launch_branch FROM jobs WHERE state = 'launched'
      AND machine = ? AND id NOT IN (SELECT session_id FROM ended)
      AND id NOT IN (SELECT session_id FROM superseded)`, machine).toArray().map((row) => ({
      sessionId: String(row.id), issueId: String(row.issue_id), claimId: String(row.claim_id), at: Number(row.updated_at),
      ...(row.launch_repo && row.launch_branch ? { launch: { repo: String(row.launch_repo), branch: String(row.launch_branch) } } : {}),
    }));
  }

  /**
   * The job's issue id while `machine`'s claim `claimId` holds it: claimed with a live
   * lease, or launched by that claim.
   */
  #held(machine: string, id: string, claimId: string): string | undefined {
    const [row] = this.#sql.exec(
      `SELECT issue_id FROM jobs WHERE id = ? AND claim_id = ? AND machine = ?
       AND ((state = 'claimed' AND lease_until > ?) OR state = 'launched')`, id, claimId, machine, this.#now()).toArray();
    return row ? String(row.issue_id) : undefined;
  }

  /** Reads what the Runner checks before launch, from the job's own issue and session. */
  async task(machine: string, id: string, claimId: string): Promise<Task | Refusal> {
    const issueId = this.#held(machine, id, claimId);
    if (!issueId) return 'not-claimed';
    // A closeout's launch is the job it closes, kept as long as the closeout.
    const [job] = this.#sql.exec(`SELECT c.kind, c.creator, l.launch_repo, l.launch_branch FROM jobs c
      LEFT JOIN jobs l ON l.id = c.closes WHERE c.id = ?`, id).toArray();
    const closeout = job?.kind === 'closeout';
    const data = await this.#read<TaskData>(closeout ? CLOSEOUT_TASK : TASK, { issue: issueId, session: id });
    const issue = data?.issue;
    if (!issue?.identifier || !issue.branchName || !issue.state?.type) return 'linear';
    const app = await this.#auth.installation();
    const task: Task = {
      delegated: Boolean(app && issue.delegate?.id === app.appUserId),
      // A session Cloud Inbox opened has no creator; whoever delegated stands in for them.
      creatorId: (job?.creator as string | null) ?? data?.agentSession?.creator?.id ?? null,
      identifier: issue.identifier,
      description: issue.description ?? '',
      branchName: issue.branchName,
      statusType: issue.state.type,
      labels: (issue.labels?.nodes ?? []).flatMap((label) => typeof label.name === 'string' ? [label.name] : []),
    };
    if (!closeout) return task;
    const launch = job.launch_repo && job.launch_branch
      ? { repo: String(job.launch_repo), branch: String(job.launch_branch) } : undefined;
    if (issue.state.type === 'canceled') return { ...task, kind: 'closeout', launch, skip: 'canceled' };
    const urls = (issue.attachments?.nodes ?? []).map((a) => a.url ?? '');
    const read = launch && await this.#launchPullRequests('task', id, urls, launch);
    if (read && read.found.some(({ pr }) => pr.merged === true)) return { ...task, kind: 'closeout', launch };
    return { ...task, kind: 'closeout', launch, skip: read?.unreadable ? 'unreadable' : 'unverified' };
  }

  /**
   * Queues a status update on the job's session, behind its earlier activities. A
   * `response` or `error` ends the session, so later updates are refused.
   */
  async update(machine: string, id: string, claimId: string, type: UpdateType, body: string): Promise<'queued' | Refusal> {
    // Completion messages must pass ownership checks before ending the session.
    if (type === 'response' && body.startsWith('Opened ')) {
      const found = await this.watch(machine, id, claimId);
      if (typeof found === 'string') return found;
      if (ENDED_STATUSES.includes(found.sessionStatus)) return 'ended';
      if (!LIVE_STATUSES.includes(found.sessionStatus)) return 'linear';
      if (!found.pullRequests.some((url) => body === `Opened ${url}.`)) return 'no-pr';
    }
    if (!this.#held(machine, id, claimId)) return 'not-claimed';
    // No await from here on, so a stop can't land between the check and the write.
    if (this.#sql.exec('SELECT 1 FROM ended WHERE session_id = ?', id).toArray().length) return 'ended';
    const now = this.#now();
    if (type === 'thought') this.#enqueue(id, type, body, now);
    else this.#end(id, body, now, type);
    this.#wake();
    return 'queued';
  }

  /** Only attachments whose authoritative repository and head match the recorded launch. */
  async watch(machine: string, id: string, claimId: string): Promise<Watch | Refusal> {
    const issueId = this.#held(machine, id, claimId);
    if (!issueId) return 'not-claimed';
    const data = await this.#read<WatchData>(WATCH, { issue: issueId, session: id });
    const status = data?.agentSession?.status;
    if (!status) return 'linear';
    if (ENDED_STATUSES.includes(status)) {
      if (this.#held(machine, id, claimId) !== issueId) return 'not-claimed';
      return { sessionStatus: status, pullRequests: [] };
    }
    if (!data?.issue) return 'linear';
    const urls = (data.issue.attachments?.nodes ?? []).map((a) => a.url ?? '');
    const [row] = this.#sql.exec('SELECT launch_repo, launch_branch FROM jobs WHERE id = ? AND claim_id = ?', id, claimId).toArray();
    const { found, unreadable } = row?.launch_repo && row.launch_branch
      ? await this.#launchPullRequests('watch', id, urls, { repo: String(row.launch_repo), branch: String(row.launch_branch) })
      : { found: [], unreadable: false };
    const pullRequests = found.map(({ url }) => url);
    // A stop, replacement or reclaim may have landed during metadata reads.
    if (this.#held(machine, id, claimId) !== issueId) return 'not-claimed';
    if (this.#sql.exec('SELECT 1 FROM superseded WHERE session_id = ?', id).toArray().length) return 'not-claimed';
    if (this.#sql.exec('SELECT 1 FROM ended WHERE session_id = ?', id).toArray().length) {
      return { sessionStatus: 'complete', pullRequests: [] };
    }
    if (unreadable && !pullRequests.length && this.#sql.exec(
      'INSERT INTO unreadable (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING session_id',
      id, this.#now()).toArray().length) {
      this.#enqueue(id, 'thought', MESSAGES.unreadable, this.#now());
      this.#wake();
    }
    return { sessionStatus: status, issueState: data.issue.state?.type, pullRequests };
  }

  /**
   * The GitHub PRs among `urls` whose base and head repo are the launch's repo and whose head is
   * its branch, read from GitHub under one deadline. `unreadable` when GitHub refused one for a
   * token problem, not a rate limit. `event` and `session` only label the log lines.
   */
  async #launchPullRequests(event: string, session: string, urls: string[], launch: LaunchEvidence) {
    const found: { url: string; pr: PullRequest }[] = [];
    let unreadable = false;
    const repo = launch.repo.toLowerCase();
    const metadataSignal = AbortSignal.timeout(METADATA_TIMEOUT_MS);
    for (const url of urls.filter((url) => PULL_REQUEST.test(url))) {
      if (metadataSignal.aborted) break;
      const path = new URL(url).pathname.split('/');
      if (`${path[1]}/${path[2]}`.toLowerCase() !== repo) continue;
      try {
        // Without a token, only public repos' PRs can be read.
        const response = await this.#fetch(`https://api.github.com/repos/${path[1]}/${path[2]}/pulls/${path[4]}`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'factory-delegator',
            ...(this.#githubToken ? { Authorization: `Bearer ${this.#githubToken}` } : {}) },
          // Workers' fetch throws on `redirect: 'error'`; a redirect stays unverified as a non-2xx.
          signal: metadataSignal, redirect: 'manual',
        });
        if (!response.ok) {
          log({ event, session, outcome: `pr-metadata-${response.status}` });
          // A missing, expired or unapproved token, or a repo it doesn't cover; a rate limit
          // (primary or secondary, as GitHub marks them) is transient, not a token problem.
          const limited = response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0'
            || response.headers.has('retry-after') || /rate limit/i.test(await response.text()));
          if ([401, 403, 404].includes(response.status) && !limited) unreadable = true;
          continue;
        }
        const pr = await response.json() as PullRequest;
        metadataSignal.throwIfAborted();
        if (pr.base?.repo?.full_name?.toLowerCase() === repo && pr.head?.repo?.full_name?.toLowerCase() === repo
          && pr.head?.ref === launch.branch) found.push({ url, pr });
      } catch {
        // Unverifiable ownership stays unverified.
        log({ event, session, outcome: 'pr-metadata-failed' });
      }
    }
    return { found, unreadable };
  }

  /** Links the first verified launch pull request on the session as "Pull request". */
  async linkPullRequest(machine: string, id: string, claimId: string): Promise<{ url: string } | Refusal> {
    const found = await this.watch(machine, id, claimId);
    if (typeof found === 'string') return found;
    if (ENDED_STATUSES.includes(found.sessionStatus)) return 'ended';
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
        log({ event: 'activity', session: sessionId, type, outcome: 'retry', attempt: String(attempts) });
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

  #enqueue(sessionId: string, type: RowType, body: string, now: number, queued = false, wait = 0) {
    this.#sql.exec('INSERT INTO outbox (session_id, type, body, created_at, next_at, queued) VALUES (?, ?, ?, ?, ?, ?)',
      sessionId, type, body, now, now + wait, queued ? 1 : 0);
  }

  /** Marks a session ended and posts its final activity, cancelling its thoughts not yet sent. */
  #end(sessionId: string, body: string, now: number, type: 'response' | 'error' = 'response') {
    this.#sql.exec('INSERT INTO ended (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING', sessionId, now);
    this.#sql.exec("DELETE FROM outbox WHERE session_id = ? AND type = 'thought'", sessionId);
    this.#enqueue(sessionId, type, body, now);
  }

  /**
   * Drops expired history, including activities Linear has refused for the whole window, and
   * ends closeouts no machine claimed in that window. True if it ended any.
   */
  #expire(now: number): boolean {
    // Remove stopped claims before pruning the markers that prevent requeueing.
    this.#sql.exec(`DELETE FROM jobs WHERE state = 'claimed' AND lease_until <= ?
      AND id IN (SELECT session_id FROM ended)`, now);
    // A launch stays while a closeout of it is in the window, so its task can still name the launch.
    this.#sql.exec(`DELETE FROM jobs WHERE state IN ('launched', 'failed') AND updated_at <= ?
      AND id NOT IN (SELECT closes FROM jobs WHERE closes IS NOT NULL AND updated_at > ?)`, now - HISTORY_MS, now - HISTORY_MS);
    const unclaimed = this.#sql.exec("DELETE FROM jobs WHERE kind = 'closeout' AND state = 'queued' AND updated_at <= ? RETURNING id",
      now - HISTORY_MS).toArray();
    for (const { id } of unclaimed) this.#end(String(id), MESSAGES.expired, now);
    this.#sql.exec('DELETE FROM seen WHERE at <= ?', now - HISTORY_MS);
    this.#sql.exec('DELETE FROM seen_activities WHERE at <= ?', now - HISTORY_MS);
    this.#sql.exec('DELETE FROM ended WHERE at <= ?', now - HISTORY_MS);
    this.#sql.exec('DELETE FROM unreadable WHERE at <= ?', now - HISTORY_MS);
    this.#sql.exec('DELETE FROM notifications WHERE at <= ?', now - HISTORY_MS);
    this.#sql.exec('DELETE FROM delegated WHERE at <= ?', now - HISTORY_MS);
    // Kept while its launch row is, so a launch never queues a second closeout.
    this.#sql.exec('DELETE FROM closeouts WHERE at <= ? AND launch_id NOT IN (SELECT id FROM jobs)', now - HISTORY_MS);
    // Kept while a write-back of the session is still pending, however old.
    this.#sql.exec('DELETE FROM superseded WHERE at <= ? AND session_id NOT IN (SELECT session_id FROM outbox)',
      now - HISTORY_MS);
    // ponytail: an activity Linear keeps refusing is dropped after the history window.
    for (const { session_id, type } of this.#sql.exec(
      'DELETE FROM outbox WHERE created_at <= ? RETURNING session_id, type', now - HISTORY_MS).toArray()) {
      log({ event: 'activity', session: String(session_id), type: String(type), outcome: 'expired' });
    }
    return unclaimed.length > 0;
  }

  /**
   * Drops expired history, puts expired leases back on their machine's queue, and keeps only the
   * newest waiting job per issue, ending each replaced session. True if it ended any.
   */
  #settle(now: number): boolean {
    let replaced = this.#expire(now);
    const waiting = this.#sql.exec(
      "SELECT id, issue_id FROM jobs WHERE state = 'queued' OR (state = 'claimed' AND lease_until <= ?) ORDER BY rowid DESC",
      now).toArray();
    const issues = new Set<unknown>();
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
      if (type === 'closeout') return await this.#closeout(token, body);
      if (type === 'delegation') return await this.#delegation(token, id, body);
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
   * label in its group; and the session creator, or whoever delegated a session Cloud Inbox
   * opened, as assignee. Dropped once the issue is
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
    const [job] = this.#sql.exec('SELECT creator FROM jobs WHERE id = ?', sessionId).toArray();
    const creator = (job?.creator as string | null) ?? agentSession?.creator?.id;
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
   * Creates a closeout's session on the issue, then queues the job pinned to the launch's
   * machine, with the session id as its id. Dropped once a newer delegation supersedes the
   * launch, so a closeout never replaces a waiting delegation.
   */
  async #closeout(token: string, body: string): Promise<boolean> {
    const closeout = JSON.parse(body) as Closeout;
    if (this.#superseded(closeout.launch)) return true;
    const data = await this.#linear<{ agentSessionCreateOnIssue?: { success?: boolean; agentSession?: Id } }>(
      token, CREATE_SESSION, { issue: closeout.issue });
    const session = data.agentSessionCreateOnIssue?.agentSession?.id;
    if (data.agentSessionCreateOnIssue?.success !== true || !session) return false;
    this.#queueCloseout(session, closeout, this.#now());
    return true;
  }

  /**
   * Opens the session for a delegation Linear sent no `created` for, then queues its job. Dropped
   * if the issue is no longer delegated to the app. A `created` that arrived meanwhile removed
   * this row: Linear's echo of this session adopted it, or another session covers the delegation
   * and this one ends as replaced.
   */
  async #delegation(token: string, row: number, body: string): Promise<boolean> {
    const { issue: issueId, creator } = JSON.parse(body) as Delegation;
    const waiting = () => this.#sql.exec('SELECT 1 FROM outbox WHERE id = ?', row).toArray().length > 0;
    const { issue } = await this.#linear<{ issue?: { delegate?: Id } }>(token, DELEGATE, { issue: issueId });
    if (!issue) return false;
    const app = await this.#auth.installation();
    const done = (outcome: string, session?: string) => {
      log({ event: 'delegation', issue: issueId, ...(session && { session }), outcome });
      return true;
    };
    if (!app || issue.delegate?.id !== app.appUserId) return done('not-delegated');
    if (!waiting()) return done('covered');
    const data = await this.#linear<{ agentSessionCreateOnIssue?: { success?: boolean; agentSession?: Id } }>(
      token, CREATE_SESSION, { issue: issueId });
    const session = data.agentSessionCreateOnIssue?.agentSession?.id;
    if (data.agentSessionCreateOnIssue?.success !== true || !session) return false;
    // No await from here on. Marked seen, so a later `created` webhook for it is a duplicate.
    const now = this.#now();
    if (!this.#sql.exec('INSERT INTO seen (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING session_id',
      session, now).toArray().length) return done('adopted', session);
    if (!waiting()) {
      this.#end(session, MESSAGES.replaced, now);
      return done('replaced', session);
    }
    this.#supersede(session, issueId, now);
    this.#queueDelegation(session, issueId, creator, app.appName, now);
    return done('queued', session);
  }

  /**
   * Queues the closeout job for its new session, unless the session was already handled
   * (adopted from Linear's webhook) or a newer delegation superseded the launch meanwhile.
   */
  #queueCloseout(session: string, { launch, issue, machine, pr }: Closeout, now: number) {
    // Marked seen, so a later `created` webhook for it is a duplicate.
    if (!this.#sql.exec('INSERT INTO seen (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING session_id',
      session, now).toArray().length) return;
    if (this.#superseded(launch)) return this.#end(session, MESSAGES.replaced, now);
    this.#sql.exec(`INSERT INTO jobs (id, issue_id, state, updated_at, machine, kind, closes, pull_request)
      VALUES (?, ?, 'queued', ?, ?, 'closeout', ?, ?) ON CONFLICT DO NOTHING`, session, issue, now, machine, launch, pr);
  }

  #superseded(sessionId: string): boolean {
    return this.#sql.exec('SELECT 1 FROM superseded WHERE session_id = ?', sessionId).toArray().length > 0;
  }

  /**
   * Applies a write-back's field changes unless its row was cancelled or a newer delegation
   * of the issue arrived, checked with no await before the edit is sent.
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
