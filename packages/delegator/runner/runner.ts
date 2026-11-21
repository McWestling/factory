// Factory Runner: claims one Cloud Inbox job at a time, checks it, starts the issue's
// agent in a new Orca worktree (or, for a closeout, do-closeout in the launch's existing one),
// and reports the outcome back through Cloud Inbox.
// It holds no Linear credential. Everything Cloud Inbox sends is untrusted input.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { ENDED_STATUSES, JOB_KINDS, LIVE_STATUSES, PULL_REQUEST, type Outcome as JobOutcome, type Task, type UpdateType, type Watch, type Watching as Recoverable } from '../contract.ts';
import { isLaunchEvidence, type Claim, type LaunchEvidence } from '../job.ts';
import { LEVELS, matchModel, parseIssue, readTag, type DelegatorIssue, type Level } from '../parse-issue.ts';

export const CONFIG_PATH = join(homedir(), '.config', 'factory-delegator', 'config.json');
const POLL_MS = 15_000;
/** Cloud Inbox's history window: a session not reclaimed by then never will be. */
const LAUNCH_KEEP_MS = 30 * 24 * 60 * 60_000;
const RETRY = 'Fix it and delegate again to retry.';
const BY_HAND = "Run do-closeout by hand if it's still needed.";
const DELEGATED = 'Delegated run: nobody is watching this session.';
/** Orca's id for a launch whose reply was lost, replayed with `--retry-launch`. */
const OPERATION = /^\d{13}-[0-9a-f]{32}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const ATTENDED = 'Attended run: a person will join this session in Orca. Ask every question with your question tool (AskUserQuestion) and wait for the answer.';
export const NOT_ALLOWED = "This machine doesn't accept dispatches from you.";

export type ModelSettings = { agent: string; model: string; effort?: string };
export type RunnerConfig = {
  inboxUrl: string;
  bearerSecret: string;
  /** The Linear app's name, as Cloud Inbox's queued thought shows it. */
  machine: string;
  allowedCreatorIds: readonly string[];
  /** Model name selected by a level or [model=] pin → how Orca starts it. */
  models: Readonly<Record<string, ModelSettings>>;
  levels: Readonly<Record<Level, string>>;
  skill: string;
  /** The planning repo (`owner/name`) every refine launch runs in. */
  refineRepo?: string;
};

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;
export type Deps = {
  fetch: typeof fetch;
  exec: Exec;
  log: (fields: Record<string, string>) => void;
  /** Private file of launch intents and outcomes, keyed by session id. */
  launches: string;
  watches: string;
  status: string;
  paused: string;
  /** Setup's drain request; the acknowledgment is written beside it as `<drain>.ack`. */
  drain?: string;
  now?: () => number;
};

type Outcome = { identifier: string | null; outcome: string; stage?: Stage; time: string };
type Status = {
  version: 1; updatedAt: string; pid: number;
  inbox: { status: 'ok' | 'unreachable'; lastOkAt: string | null };
  paused: boolean;
  current: { identifier: string; sessionId: string } | null;
  watching: { identifier: string; since: string }[];
  lastError: Outcome | null;
  recent: Outcome[];
};
const statuses = new WeakMap<Deps, Status>();
const failedStatusWrites = new WeakSet<Deps>();
const time = (deps: Deps) => new Date((deps.now ?? Date.now)()).toISOString();
const safeId = (id: string) => /^[\w-]{1,200}$/.test(id) ? id : null;
function status(deps: Deps): Status {
  let value = statuses.get(deps);
  if (!value) {
    value = { version: 1, updatedAt: time(deps), pid: process.pid,
      inbox: { status: 'unreachable', lastOkAt: null }, paused: false,
      current: null, watching: [], lastError: null, recent: [] };
    statuses.set(deps, value);
  }
  return value;
}

/** A disposable projection: failure must never affect launch or watch recovery. */
function writeStatus(deps: Deps) {
  try {
    const value = status(deps);
    value.updatedAt = time(deps);
    value.paused = existsSync(deps.paused);
    try {
      value.watching = Object.values(readWatches(deps)).map((job) => ({
        identifier: job.identifier ?? safeId(job.issueId) ?? 'unknown', since: new Date(job.at).toISOString(),
      }));
    } catch { /* Keep the last readable watch projection. */ }
    mkdirSync(dirname(deps.status), { recursive: true, mode: 0o700 });
    rmSync(`${deps.status}.tmp`, { force: true });
    writeFileSync(`${deps.status}.tmp`, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(`${deps.status}.tmp`, deps.status);
  } catch {
    if (!failedStatusWrites.has(deps)) {
      failedStatusWrites.add(deps);
      deps.log({ event: 'status', outcome: 'status-write-failed' });
    }
  }
}

export function startStatusHeartbeat(deps: Deps) {
  writeStatus(deps);
  return setInterval(() => { writeStatus(deps); acknowledgeDrain(deps); }, 10_000);
}

const active = new WeakMap<Deps, number>();

/** Counts claim and watch work, so a drain is acknowledged only between operations. */
async function busy<T>(deps: Deps, work: () => Promise<T>): Promise<T> {
  active.set(deps, (active.get(deps) ?? 0) + 1);
  try { return await work(); }
  finally { active.set(deps, active.get(deps)! - 1); acknowledgeDrain(deps); }
}

/** An unexpired setup request's nonce. While it stands, no claim or watch check starts. */
function drainRequest(deps: Deps): string | null {
  if (!deps.drain) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(deps.drain, 'utf8'));
    return isObject(value) && isText(value.nonce) && typeof value.until === 'number'
      && value.until > (deps.now ?? Date.now)() ? value.nonce : null;
  } catch { return null; }
}

/** Acknowledges a drain only with nothing in flight: no claim, job or watch check. Saved watches resume after a restart. */
export function acknowledgeDrain(deps: Deps) {
  const nonce = drainRequest(deps);
  if (!nonce || active.get(deps) || status(deps).current) return;
  try { readWatches(deps); } catch { return; }
  try {
    rmSync(`${deps.drain}.ack.tmp`, { force: true });
    writeFileSync(`${deps.drain}.ack.tmp`, JSON.stringify({ nonce, pid: process.pid }), { mode: 0o600, flag: 'wx' });
    renameSync(`${deps.drain}.ack.tmp`, `${deps.drain}.ack`);
  } catch { deps.log({ event: 'drain', outcome: 'drain-ack-failed' }); }
}

// Flag-like or shell-like values never reach argv, even though there's no shell.
const ARG = /^[\w.:]+[\w.:-]*$/;
const IDENTIFIER = /^[A-Z][A-Z0-9]*-[0-9]+$/;
// Every segment starts alphanumeric, so the last one is safe as `--name` too.
const BRANCH = /^[A-Za-z0-9][\w.-]*(\/[A-Za-z0-9][\w.-]*)*$/;

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads and checks the config, throwing with a reason (never a value) when it's unusable. */
export function loadConfig(path = CONFIG_PATH): RunnerConfig {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    throw new Error(`no config at ${path}`);
  }
  if (mode !== 0o600) throw new Error(`${path} must have mode 600 (chmod 600 it)`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!isObject(raw)) throw new Error('config must be a JSON object');
  const fail = (key: string, expected: string): never => {
    throw new Error(`config \`${key}\` must be ${expected}`);
  };

  const { inboxUrl, bearerSecret, machine, allowedCreatorIds, models, levels, skill = 'do-implement', refineRepo } = raw;
  let url: URL | undefined;
  try {
    url = new URL(String(inboxUrl));
  } catch {}
  if (!url || url.protocol !== 'https:' || url.search || url.hash) fail('inboxUrl', 'an https URL with no query');
  if (!isText(bearerSecret)) fail('bearerSecret', 'a nonempty string');
  if (!isText(machine)) fail('machine', 'a nonempty string');
  if (!Array.isArray(allowedCreatorIds) || !allowedCreatorIds.length || !allowedCreatorIds.every(isText)) {
    fail('allowedCreatorIds', 'a nonempty list of Linear user ids');
  }
  if (!isObject(models) || !Object.keys(models).length) fail('models', 'a nonempty map of model name to settings');
  for (const settings of Object.values(models as object)) {
    const { agent, model, effort } = isObject(settings) ? settings : ({} as Record<string, unknown>);
    if (typeof agent !== 'string' || !ARG.test(agent) || typeof model !== 'string' || !ARG.test(model)
      || (effort !== undefined && (typeof effort !== 'string' || !ARG.test(effort)))) {
      fail('models', 'a map of model name to {agent, model, effort?} with plain identifiers');
    }
  }
  if (!isObject(levels)) fail('levels', 'a map of light, standard and deep to configured model names');
  for (const level of LEVELS) {
    const name = (levels as Record<string, unknown>)[level];
    if (!Object.hasOwn(levels as object, level) || typeof name !== 'string' || !Object.hasOwn(models as object, name)) {
      fail(`levels.${level}`, 'a configured model name');
    }
  }
  if (typeof skill !== 'string' || !/^[a-z0-9-]+$/.test(skill)) fail('skill', 'a name matching ^[a-z0-9-]+$');
  if (refineRepo !== undefined && (typeof refineRepo !== 'string' || !REPO.test(refineRepo))) fail('refineRepo', 'an owner/name repo');

  return {
    inboxUrl: url!.href.replace(/\/+$/, ''),
    bearerSecret: bearerSecret as string,
    machine: machine as string,
    allowedCreatorIds: allowedCreatorIds as string[],
    models: models as Record<string, ModelSettings>,
    levels: levels as Record<Level, string>,
    skill: skill as string,
    ...(refineRepo === undefined ? {} : { refineRepo: refineRepo as string }),
  };
}

const configProblems = new WeakMap<Deps, string>();

/** Rereads the config before a claim, keeping the last good one when it's unusable. Logs once per change, never the value. */
export function rereadConfig(last: RunnerConfig, deps: Deps, path = CONFIG_PATH): RunnerConfig {
  try {
    const config = loadConfig(path);
    configProblems.delete(deps);
    return config;
  } catch (error) {
    let changed = '';
    try { changed = String(statSync(path).mtimeMs); } catch {}
    const problem = `${(error as Error).message} ${changed}`;
    if (configProblems.get(deps) !== problem) {
      configProblems.set(deps, problem);
      deps.log({ event: 'config', outcome: 'invalid' });
    }
    return last;
  }
}

/** The Runner API from Cloud Inbox. Every operation on a job carries its claim id. */
function inbox(config: RunnerConfig, deps: Deps) {
  const call = async (method: string, path: string, body?: unknown) => {
    let response: Response;
    try {
      response = await deps.fetch(`${config.inboxUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${config.bearerSecret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`cloud-inbox-${response.status}`);
      status(deps).inbox = { status: 'ok', lastOkAt: time(deps) };
    } catch (error) {
      status(deps).inbox.status = 'unreachable';
      throw error;
    }
    return response;
  };
  const job = (claim: Claim, op: string) =>
    `/jobs/${encodeURIComponent(claim.sessionId)}/${op}?claimId=${encodeURIComponent(claim.claimId)}`;
  return {
    async claim(): Promise<Claim | null> {
      const response = await call('POST', `/jobs/claim?kinds=${JOB_KINDS.join(',')}`);
      if (response.status === 204) return null;
      const claim = await response.json() as Partial<Claim>;
      if (!isText(claim.issueId) || !isText(claim.sessionId) || !isText(claim.claimId)) throw new Error('cloud-inbox-claim');
      return claim as Claim;
    },
    async task(claim: Claim): Promise<Partial<Task>> {
      const task: unknown = await (await call('GET', job(claim, 'task'))).json();
      if (!isObject(task)) throw new Error('cloud-inbox-task');
      return task as Partial<Task>;
    },
    update: (claim: Claim, type: UpdateType, body: string) => call('POST', job(claim, 'updates'), { type, body }),
    finish: (claim: Claim, outcome: JobOutcome, launch?: LaunchEvidence) => call('POST', job(claim, outcome), launch),
    watching: async () => {
      const value: unknown = await (await call('GET', '/jobs/watching')).json();
      if (!Array.isArray(value) || !value.every((entry) => isObject(entry) && isText(entry.sessionId)
        && isText(entry.issueId) && isText(entry.claimId) && typeof entry.at === 'number' && Number.isFinite(entry.at)
        && (entry.launch === undefined || isLaunchEvidence(entry.launch)))) {
        throw new Error('cloud-inbox-watching');
      }
      return value as Recoverable[];
    },
    watch: async (claim: Claim) => {
      const value: unknown = await (await call('GET', job(claim, 'watch'))).json();
      if (!isObject(value) || !isText(value.sessionStatus) || (value.issueState !== undefined && !isText(value.issueState)) || !Array.isArray(value.pullRequests)
        || !value.pullRequests.every((url) => typeof url === 'string' && PULL_REQUEST.test(url))) {
        throw new Error('cloud-inbox-watch');
      }
      return value as Watch;
    },
    report: (snapshot: Status) => call('PUT', '/pool/snapshot', snapshot),
    link: async (claim: Claim) => {
      const value: unknown = await (await call('POST', job(claim, 'pull-request'))).json();
      if (!isObject(value) || typeof value.url !== 'string'
        || !PULL_REQUEST.test(value.url)) throw new Error('cloud-inbox-pr');
      return value.url;
    },
  };
}

/** How Orca starts a configured model; Luna runs at high effort or more. */
function settings(config: RunnerConfig, model: string) {
  const { agent, model: id, effort: configuredEffort } = config.models[model]!;
  const effort = agent === 'codex' && /(?:^|-)luna(?:-|$)/i.test(id)
    && !['high', 'xhigh', 'max'].includes(configuredEffort ?? '') ? 'high' : configuredEffort;
  return { agent, id, effort };
}

/** The exact argv for `orca worktree create`, per docs/issue-format.md. */
export function launchArgs(config: RunnerConfig, repoPath: string, model: string, task: Pick<Task, 'identifier' | 'branchName'>, refine = false) {
  const { agent, id, effort } = settings(config, model);
  const skill = refine ? 'do-refine' : config.skill;
  return [
    'worktree', 'create',
    '--name', task.branchName.split('/').pop()!,
    '--repo', `path:${repoPath}`,
    '--branch', task.branchName,
    '--agent', agent,
    '--model', id,
    ...(effort ? ['--effort', effort] : []),
    `--prompt=${agent === 'codex' ? '$' : '/'}${skill} ${task.identifier}\n${refine ? ATTENDED : DELEGATED}`,
    '--setup', skill === 'do-implement' ? 'run' : 'skip',
    '--linear-issue', task.identifier,
    '--json',
  ];
}

/** The exact argv for a closeout's `orca agent launch` in the launch's existing worktree. */
function closeoutArgs(config: RunnerConfig, worktree: string, model: string, identifier: string) {
  const { agent, id, effort } = settings(config, model);
  return ['agent', 'launch', '--agent', agent, '--worktree', `path:${worktree}`, '--model', id,
    ...(effort ? ['--effort', effort] : []),
    '--prompt', `${agent === 'codex' ? '$' : '/'}do-closeout ${identifier}\n${DELEGATED}`, '--json'];
}

/** Runs `orca`, returning null on success or Orca's error code; a lost launch reply's id, or a created worktree's selector, goes in `reply`. */
// Open, create and its retry stay well inside Cloud Inbox's 10-minute lease. A closeout's worst case
// (open, lookups, launch, retry and replay) comes near it; an expired lease stays on this machine and its record recovers it.
// ponytail: a create killed at its timeout may leave a worktree behind; the job still fails.
async function orca(exec: Exec, args: string[], reply?: Reply): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await exec('orca', args, args[0] === 'open' ? 60_000 : args[1] === 'set' ? 30_000 : 120_000));
  } catch (error) {
    // Orca prints its JSON error and exits non-zero; no output means it never ran.
    stdout = String((error as { stdout?: unknown }).stdout ?? '');
    if (!stdout) return (error as { code?: unknown }).code === 'ENOENT' ? 'orca_not_found' : 'orca_failed';
  }
  try {
    const result = JSON.parse(stdout);
    if (result?.ok === true) {
      // Orca leaves out the worktree when it can't show it after a launch; the launch's worktree id still selects it.
      const path = result.result?.worktree?.path;
      const id = result.result?.launch?.worktreeId;
      if (reply && isText(path) && isAbsolute(path) && !path.includes('\0')) reply.worktree = `path:${path}`;
      else if (reply && isText(id) && !id.includes('\0')) reply.worktree = `id:${id}`;
      return null;
    }
    const code = result?.error?.code;
    const operationId = result?.error?.data?.operationId;
    if (reply && typeof operationId === 'string' && OPERATION.test(operationId)) reply.operationId = operationId;
    return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'orca_failed';
  } catch {
    return 'orca_bad_output';
  }
}

type Reply = { operationId?: string; worktree?: string };

/** Each stage the Runner launches, marked on its Orca workspace and Linear messages; GLOSSARY.md defines them. */
const STAGES = { refine: '🗺️', implement: '🛠️', closeout: '🧹' } as const;
type Stage = keyof typeof STAGES;
const stageOf = (launch: Pick<Launch, 'refine' | 'closeout'>): Stage =>
  launch.closeout ? 'closeout' : launch.refine ? 'refine' : 'implement';
const stage = (launch: Pick<Launch, 'refine' | 'closeout'>) => STAGES[stageOf(launch)];

type Launch = {
  at: number;
  repo: string;
  branch: string;
  model: string;
  launched: boolean;
  thoughtPosted: boolean;
  githubRepo?: string;
  /** A refine launch: it responds at launch and is never watched for a PR. */
  refine?: boolean;
  /** A closeout launch: like refine, it responds at launch and is never watched. */
  closeout?: boolean;
};
type Launches = Record<string, Launch>;

function readLaunches(deps: Deps): Launches {
  try {
    const launches: unknown = JSON.parse(readFileSync(deps.launches, 'utf8'));
    if (!isObject(launches) || !Object.values(launches).every((entry) =>
      isObject(entry)
        && typeof entry.at === 'number' && Number.isFinite(entry.at)
        && typeof entry.repo === 'string' && isAbsolute(entry.repo)
        && typeof entry.branch === 'string' && entry.branch.length <= 200 && BRANCH.test(entry.branch) && !entry.branch.includes('..')
        && (entry.githubRepo === undefined || isLaunchEvidence({ repo: entry.githubRepo, branch: entry.branch }))
        && isText(entry.model) && typeof entry.launched === 'boolean' && typeof entry.thoughtPosted === 'boolean'
        && (entry.refine === undefined || typeof entry.refine === 'boolean')
        && (entry.closeout === undefined || typeof entry.closeout === 'boolean')
    )) throw new Error('invalid launch record');
    return launches as Launches;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      deps.log({ event: 'launches', outcome: 'launches-unreadable' });
    }
    return {};
  }
}

function record(deps: Deps, log: (outcome: string) => void, change: (launches: Launches) => void): boolean {
  try {
    const launches = readLaunches(deps);
    change(launches);
    for (const [session, entry] of Object.entries(launches)) {
      if (!(entry.at > Date.now() - LAUNCH_KEEP_MS)) delete launches[session];
    }
    // Renamed into place, so a crash mid-write never leaves half a file.
    writeFileSync(`${deps.launches}.tmp`, JSON.stringify(launches), { mode: 0o600 });
    renameSync(`${deps.launches}.tmp`, deps.launches);
    return true;
  } catch {
    log('launch-record-failed');
    return false;
  }
}

/** Read-only evidence for an interrupted create; a conflict alone proves nothing. */
// shortcut: a worktree does not prove agent startup; use a durable caller-supplied launch id when Orca supports one.
const hasWorktree = async (deps: Deps, launch: Launch) => Boolean(await findWorktree(deps, launch.repo, launch.branch));

/** The checkout's one local, linked Orca worktree at `branch`, or undefined unless Orca shows exactly one. */
async function findWorktree(deps: Deps, repoPath: string, branch: string): Promise<Record<string, unknown> | undefined> {
  try {
    const selector = `path:${repoPath}`;
    const repo = JSON.parse((await deps.exec('orca', ['repo', 'show', '--repo', selector, '--json'], 30_000)).stdout);
    if (repo?.ok !== true || !isText(repo.result?.repo?.id) || repo.result.repo.path !== repoPath) return undefined;
    const list = JSON.parse((await deps.exec('orca', ['worktree', 'list', '--repo', selector, '--limit', '10000', '--json'], 30_000)).stdout);
    if (list?.ok !== true || !Array.isArray(list.result?.worktrees)) return undefined;
    // The primary checkout and archived worktrees never count: job content mustn't steer an agent into them.
    const rows = list.result.worktrees.filter((row: unknown): row is Record<string, unknown> =>
      isObject(row) && row.repoId === repo.result.repo.id && row.hostId === 'local'
      && row.branch === `refs/heads/${branch}` && row.isMainWorktree !== true && row.isArchived !== true);
    return rows.length === 1 ? rows[0] : undefined;
  } catch {
    return undefined;
  }
}

/** When each watch's agent was first seen stopped; a restart forgets it. */
const stoppedSince = new WeakMap<Deps, Map<string, number>>();
const STOP_WAIT_MS = 10 * 60_000;

/** A registered Orca repo row that is a checkout of GitHub `owner/name`. */
const isCheckoutOf = (row: Record<string, unknown>, repo: string) => row.kind === 'git'
  && isObject(row.gitRemoteIdentity) && typeof row.gitRemoteIdentity.canonicalKey === 'string'
  && row.gitRemoteIdentity.canonicalKey.toLowerCase() === `github.com/${repo.toLowerCase()}`;

type OrcaState = { repos: unknown[]; worktrees: unknown[] };

/** Orca's registered repos and worktrees, for one watch pass; null when Orca can't say. */
async function orcaState(deps: Deps): Promise<OrcaState | null> {
  try {
    const repos = JSON.parse((await deps.exec('orca', ['repo', 'list', '--json'], 30_000)).stdout);
    if (repos?.ok !== true || !Array.isArray(repos.result?.repos)) return null;
    const ps = JSON.parse((await deps.exec('orca', ['worktree', 'ps', '--limit', '10000', '--json'], 30_000)).stdout);
    if (ps?.ok !== true || !Array.isArray(ps.result?.worktrees)) return null;
    return { repos: repos.result.repos, worktrees: ps.result.worktrees };
  } catch {
    return null;
  }
}

/**
 * Whether every agent in the launch's worktree is done, matched like hasWorktree: the one registered
 * checkout of its GitHub repo, on this machine, at its exact branch. Undefined unless exactly one matches.
 */
function agentsDone(orca: OrcaState, launch: LaunchEvidence): boolean | undefined {
  const repos = orca.repos.filter(isObject).filter((row) => isCheckoutOf(row, launch.repo));
  const id = repos.length === 1 ? repos[0]!.id : undefined;
  if (!isText(id)) return undefined;
  const rows = orca.worktrees.filter(isObject).filter((row) => row.repoId === id && row.hostId === 'local'
    && row.branch === `refs/heads/${launch.branch}`);
  const agents = rows.length === 1 ? rows[0]!.agents : undefined;
  return Array.isArray(agents) ? agents.every((agent: unknown) => isObject(agent) && agent.state === 'done') : undefined;
}

type Watching = Recoverable & { ready: boolean; identifier?: string };
type Watches = Record<string, Watching>;

/** The saved watches, or a throw when the file can't be trusted. Setup checks a stopped Runner's file with it. */
export function readWatches(deps: Pick<Deps, 'watches'>): Watches {
  try {
    const value: unknown = JSON.parse(readFileSync(deps.watches, 'utf8'));
    if (!isObject(value) || !Object.entries(value).every(([id, entry]) => isObject(entry)
      && entry.sessionId === id && isText(entry.issueId) && isText(entry.claimId)
      && (entry.launch === undefined || isLaunchEvidence(entry.launch))
      && (entry.identifier === undefined || typeof entry.identifier === 'string' && IDENTIFIER.test(entry.identifier))
      && typeof entry.at === 'number' && Number.isFinite(entry.at) && typeof entry.ready === 'boolean')) {
      throw new Error('invalid watches');
    }
    return value as Watches;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('watches-unreadable');
  }
}

function changeWatches(deps: Deps, change: (watches: Watches) => void) {
  const watches = readWatches(deps);
  change(watches);
  mkdirSync(dirname(deps.watches), { recursive: true, mode: 0o700 });
  writeFileSync(`${deps.watches}.tmp`, JSON.stringify(watches), { mode: 0o600 });
  renameSync(`${deps.watches}.tmp`, deps.watches);
}

/** Import only this machine's open launches; local timestamps and claims survive restarts. */
export async function resumeWatches(config: RunnerConfig, deps: Deps): Promise<void> {
  try {
    const jobs = await inbox(config, deps).watching();
    changeWatches(deps, (watches) => {
      for (const job of jobs) watches[job.sessionId] ??= { ...job, ready: true };
    });
  } catch { deps.log({ event: 'watch', outcome: 'watch-resume-failed' }); }
  finally { writeStatus(deps); }
}

/** Watch recovery then completion checks, held off while setup drains the Runner. */
export async function checkWatches(config: RunnerConfig, deps: Deps): Promise<void> {
  if (drainRequest(deps)) return;
  await busy(deps, async () => { await resumeWatches(config, deps); await watchJobs(config, deps); });
}

/** One completion check per saved job; transient failures leave it for the next check. */
export async function watchJobs(config: RunnerConfig, deps: Deps): Promise<void> {
  let watches: Watches;
  try { watches = readWatches(deps); }
  catch { deps.log({ event: 'watch', outcome: 'watches-unreadable' }); writeStatus(deps); return; }
  const api = inbox(config, deps);
  const launches = readLaunches(deps);
  const since = stoppedSince.get(deps) ?? new Map<string, number>();
  stoppedSince.set(deps, since);
  for (const session of since.keys()) if (!watches[session]) since.delete(session);
  let orca: Promise<OrcaState | null> | undefined;
  /** True once the watch's agent has been stopped for STOP_WAIT_MS; unknown leaves the clock alone. */
  const stoppedLong = async (job: Watching) => {
    if (!job.launch) return false;
    const state = await (orca ??= orcaState(deps));
    const stopped = state ? agentsDone(state, job.launch) : undefined;
    if (stopped === false) since.delete(job.sessionId);
    if (stopped !== true) return false;
    const now = (deps.now ?? Date.now)();
    if (!since.has(job.sessionId)) since.set(job.sessionId, now);
    return now - since.get(job.sessionId)! >= STOP_WAIT_MS;
  };
  for (const job of Object.values(watches)) {
    const log = (outcome: string) => deps.log({ event: 'watch', session: job.sessionId, outcome });
    const change = (edit: (watches: Watches) => void) => changeWatches(deps, (current) => {
      // A reclaim may have replaced this claim while a request was in flight.
      if (current[job.sessionId]?.claimId === job.claimId) edit(current);
    });
    try {
      const saved = launches[job.sessionId];
      if (saved?.refine || saved?.closeout) {
        // Its launched report landed but the response didn't: post that instead of watching.
        await api.update(job, 'response', saved.closeout ? closing(config) : refining(config));
        change((current) => delete current[job.sessionId]);
        record(deps, log, (current) => delete current[job.sessionId]);
        log('finished');
        continue;
      }
      if (!job.ready) {
        // A lost launch acknowledgement may already have committed; watch verifies the claim below.
        await api.finish(job, 'launched', job.launch).catch((error: Error) => {
          if (error.message !== 'cloud-inbox-409') throw error;
        });
      }
      const status = await api.watch(job);
      if (ENDED_STATUSES.includes(status.sessionStatus)) {
        change((current) => delete current[job.sessionId]);
        log('ended');
        continue;
      }
      if (!LIVE_STATUSES.includes(status.sessionStatus)) {
        throw new Error('unknown session status');
      }
      if (!job.ready) change((current) => { current[job.sessionId]!.ready = true; });
      let body: string;
      if (status.pullRequests.length) {
        const url = await api.link(job);
        // A stop or final reply can land while the link is being added.
        const latest = await api.watch(job);
        if (ENDED_STATUSES.includes(latest.sessionStatus)) {
          change((current) => delete current[job.sessionId]);
          continue;
        }
        if (!LIVE_STATUSES.includes(latest.sessionStatus)) throw new Error('unknown session status');
        if (!latest.pullRequests.includes(url)) { log('pr-unconfirmed'); continue; }
        body = `Opened ${url}.`;
      } else if (status.issueState === 'canceled') {
        body = 'Issue canceled; stopped watching.';
      } else if (status.issueState === 'completed') {
        body = 'Issue completed; stopped watching. No PR from this launch was recognized.';
      } else if (await stoppedLong(job)) {
        body = 'The agent stopped without a PR; see its comment if it left one, or check the Orca worktree. Undelegate to release.';
      } else if ((deps.now ?? Date.now)() - job.at >= 24 * 60 * 60_000) {
        body = 'No PR after 24 h; check the Orca worktree.';
      } else { log('no-pr-yet'); continue; }
      await api.update(job, 'response', body);
      change((current) => delete current[job.sessionId]);
      log('finished');
    } catch (error) {
      if ((error as Error).message === 'cloud-inbox-409') {
        // 409 can also mean the PR attachment vanished; keep an otherwise active watch.
        try {
          const latest = await api.watch(job);
          if (ENDED_STATUSES.includes(latest.sessionStatus)) {
            change((current) => delete current[job.sessionId]);
          }
        } catch (retryError) {
          if ((retryError as Error).message === 'cloud-inbox-409') {
            try { change((current) => delete current[job.sessionId]); }
            catch { log('watch-save-failed'); }
          }
        }
        log('watch-conflict');
      } else log('watch-retry');
    } finally { writeStatus(deps); }
  }
}

const refining = (config: RunnerConfig) => `${STAGES.refine} Refining in Orca on ${config.machine}; continue there.`;
const closing = (config: RunnerConfig) => `${STAGES.closeout} Closing out in Orca on ${config.machine}; its completion comment lists anything still open.`;

/** Reports a recorded launch, retaining its claim for completion watching unless it's a refine or closeout launch. */
async function reportLaunch(config: RunnerConfig, api: ReturnType<typeof inbox>, deps: Deps, claim: Claim, log: (outcome: string) => void, launch: Launch) {
  const launched = launch.closeout ? 'closeout-launched' : 'launched';
  if (!launch.thoughtPosted) {
    const posted = await api.update(claim, 'thought', `${stage(launch)} Started ${launch.model} in Orca on \`${launch.branch}\`${launch.closeout ? ' for closeout' : ''}.`)
      .then(() => true, () => false);
    if (!posted) {
      // Keep the claim recoverable until its thought can be queued too.
      log('thought-failed');
      return launched;
    }
    launch.thoughtPosted = true;
    record(deps, log, (launches) => { launches[claim.sessionId] = launch; });
  }
  // A refine launch sends none, so no merge queues a closeout for it.
  const evidence = launch.githubRepo && !launch.refine ? { repo: launch.githubRepo, branch: launch.branch } : undefined;
  if (launch.refine || launch.closeout) {
    // A lost report leaves the launch record: a reclaim, or watch recovery once launched, finishes it.
    if (!await api.finish(claim, 'launched', evidence).then(() => true, () => false)) log('launched-report-failed');
    else if (!await api.update(claim, 'response', launch.closeout ? closing(config) : refining(config)).then(() => true, () => false)) log('response-failed');
    else record(deps, log, (launches) => delete launches[claim.sessionId]);
    return launched;
  }
  try {
    changeWatches(deps, (watches) => {
      if (watches[claim.sessionId]?.claimId !== claim.claimId) {
        const identifier = status(deps).current?.identifier;
        watches[claim.sessionId] = { ...claim, at: launch.at, ready: false,
          ...(launch.githubRepo ? { launch: { repo: launch.githubRepo, branch: launch.branch } } : {}),
          ...(identifier && IDENTIFIER.test(identifier) ? { identifier } : {}) };
      }
    });
  } catch {
    log('watch-save-failed');
    return 'launched';
  }
  if (await api.finish(claim, 'launched', evidence).then(() => true, () => false)) {
    try { changeWatches(deps, (watches) => { watches[claim.sessionId]!.ready = true; }); }
    catch { log('watch-save-failed'); }
    record(deps, log, (launches) => delete launches[claim.sessionId]);
  } else {
    log('launched-report-failed');
  }
  return 'launched';
}

/** The newest snapshot waiting behind each Runner's report in flight. */
const reports = new WeakMap<Deps, { next: Status | null }>();

/**
 * Sends the status snapshot to Cloud Inbox's pool in the background, one report at a
 * time, so they usually land in order. A report sent while one is in flight replaces any
 * still waiting. A slow or lost report never holds up a claim or a job.
 *
 * shortcut: ordering is best effort within one process. A report that timed out here can
 * still land after a newer one, and two processes for one machine can interleave. Fine
 * for a status display; if the pool ever drives dispatch, have Cloud Inbox check a
 * process generation and sequence number instead.
 */
function report(config: RunnerConfig, deps: Deps) {
  const snapshot = structuredClone(status(deps));
  const queued = reports.get(deps);
  if (queued) { queued.next = snapshot; return; }
  const state: { next: Status | null } = { next: snapshot };
  reports.set(deps, state);
  void (async () => {
    for (let next; (next = state.next);) {
      state.next = null;
      await inbox(config, deps).report(next).catch((error: Error) =>
        deps.log({ event: 'report', outcome: error.message.startsWith('cloud-inbox-') ? error.message : 'unreachable' }));
    }
    reports.delete(deps);
  })();
}

/** Checks one claimed job, launches it if it passes, and reports the outcome. */
export async function handleJob(config: RunnerConfig, deps: Deps, claim: Claim): Promise<string> {
  const value = status(deps);
  value.current = { identifier: safeId(claim.issueId) ?? 'unknown', sessionId: safeId(claim.sessionId) ?? 'unknown' };
  writeStatus(deps);
  let outcome = 'job-failed';
  const job: { stage?: Stage } = {};
  try { return outcome = await runJob(config, deps, claim, job); }
  finally {
    const entry = { identifier: value.current.identifier, outcome, ...job, time: time(deps) };
    value.recent = [...value.recent, entry].slice(-10);
    if (!['launched', 'undelegated', 'closeout-launched', 'closeout-canceled'].includes(outcome)) value.lastError = entry;
    value.current = null;
    writeStatus(deps);
  }
}

/** Sets `job.stage` once the stage is known, for the job's recent outcome. */
async function runJob(config: RunnerConfig, deps: Deps, claim: Claim, job: { stage?: Stage }): Promise<string> {
  const api = inbox(config, deps);
  const log = (outcome: string) => deps.log({ event: 'job', session: claim.sessionId, outcome });
  let closeout = false;
  const refuse = async (outcome: string, message: string, type: 'error' | 'response' = 'error') => {
    if (closeout) outcome = `closeout-${outcome}`;
    log(outcome);
    // Each report is tried even if the one before it failed; a lost report leaves the lease to expire.
    await api.update(claim, type, message).catch(() => log(`${type}-update-failed`));
    await api.finish(claim, 'failed').catch(() => log('failed-report-failed'));
    return outcome;
  };

  const saved = readLaunches(deps)[claim.sessionId];
  if (saved?.launched) {
    // Launched under an earlier claim whose report was lost: the agent is already running.
    log('launch-recovered');
    job.stage = stageOf(saved);
    return reportLaunch(config, api, deps, claim, log, saved);
  }

  let task: Partial<Task>;
  try {
    task = await api.task(claim);
    if (typeof task.identifier === 'string' && IDENTIFIER.test(task.identifier)) {
      status(deps).current!.identifier = task.identifier;
      writeStatus(deps);
    }
  } catch {
    return refuse('task-unreadable', `Couldn't read the issue from Cloud Inbox. Check that Cloud Inbox is connected. ${RETRY}`);
  }
  report(config, deps);
  closeout = task.kind === 'closeout';
  const retry = closeout ? BY_HAND : RETRY;
  const description = typeof task.description === 'string' ? task.description : '';
  const refine = !closeout && Array.isArray(task.labels) && task.labels.some((label) => typeof label === 'string' && label.startsWith('wayfinder:'));
  job.stage = stageOf({ closeout, refine });
  let issue: DelegatorIssue;
  let branchName = task.branchName;
  if (closeout) {
    // Cloud Inbox made this session itself and verified the launch, so the delegate and creator don't apply.
    if (task.skip === 'canceled') return refuse('canceled', 'Issue canceled; no closeout launched.', 'response');
    if (task.skip === 'unreadable') {
      return refuse('unreadable', `Couldn't read the merged PR from GitHub; check Cloud Inbox's GitHub token. Nothing launched. ${BY_HAND}`, 'response');
    }
    if (task.skip !== undefined || !isLaunchEvidence(task.launch)) {
      return refuse('unverified', `Couldn't verify the merged PR came from this launch; nothing launched. ${BY_HAND}`, 'response');
    }
    issue = { repo: task.launch.repo, level: 'standard' };
    branchName = task.launch.branch;
  } else if (task.delegated !== true) {
    // Reporting ends the claim; Cloud Inbox clears the delegate only while it's still this app.
    log('undelegated');
    await api.finish(claim, 'failed').catch(() => log('failed-report-failed'));
    return 'undelegated';
  } else if (!isText(task.creatorId) || !config.allowedCreatorIds.includes(task.creatorId)) {
    return refuse('creator-refused', NOT_ALLOWED);
  } else if (refine) {
    // Decision tickets carry no level or repo tag: they run in the planning repo with the deep model.
    if (!config.refineRepo) {
      return refuse('refused-refineRepo', `Decision tickets need the Runner config key \`refineRepo\` set to the planning repo (owner/name) on ${config.machine}. Set it and delegate again to retry.`);
    }
    issue = { repo: config.refineRepo, level: 'deep', model: readTag(description, 'model') };
  } else {
    const parsed = parseIssue(description);
    if ('field' in parsed) {
      return refuse(`refused-${parsed.field}`, `Refused \`${parsed.field}\`: expected ${parsed.expected}. ${RETRY}`);
    }
    issue = parsed;
  }
  const { identifier } = task;
  if (typeof identifier !== 'string' || !IDENTIFIER.test(identifier)) {
    return refuse('bad-identifier', `The issue id isn't a plain Linear id like ABC-123. ${retry}`);
  }
  if (typeof branchName !== 'string' || branchName.length > 200 || !BRANCH.test(branchName) || branchName.includes('..')) {
    return refuse('bad-branch', `The issue's Linear branch name isn't a plain git branch name. ${retry}`);
  }

  const matched = issue.model === undefined ? undefined : matchModel(issue.model, Object.keys(config.models));
  const model = matched ?? config.levels[issue.level];
  if (issue.model !== undefined && matched === undefined) {
    await api.update(claim, 'thought', `Couldn't match model pin \`${issue.model}\`; using level \`${issue.level}\` with ${model}.`);
  }
  const opened = await orca(deps.exec, ['open', '--json']);
  if (opened === 'orca_not_found') {
    return refuse('orca-not-found', `The Runner can't find the \`orca\` command on ${config.machine}. Put Orca's CLI on its PATH. ${retry}`);
  }
  let paths: string[];
  try {
    const listing = JSON.parse((await deps.exec('orca', ['repo', 'list', '--json'], 30_000)).stdout);
    if (listing?.ok !== true || !Array.isArray(listing.result?.repos)) throw new Error('invalid repo list');
    paths = [];
    for (const row of listing.result.repos) {
      if (!isObject(row)) throw new Error('invalid repo row');
      if (!isCheckoutOf(row, issue.repo)) continue;
      if (!isText(row.path) || !isAbsolute(row.path) || row.path.includes('\0')) throw new Error('invalid repo path');
      paths.push(row.path);
    }
  } catch {
    return refuse('orca-repos-unreadable', `Couldn't read registered repos from Orca on ${config.machine}. Check \`orca repo list --json\`. ${retry}`);
  }
  if (paths.length !== 1) {
    return refuse('refused-repo', paths.length === 0
      ? `Orca has no registered GitHub checkout for \`${issue.repo}\` on ${config.machine}. Add its checkout in Orca. ${retry}`
      : `Orca has multiple registered checkouts for \`${issue.repo}\` on ${config.machine}. Keep one registration for that GitHub repo. ${retry}`);
  }
  const repoPath = paths[0]!;

  // A closeout's worktree exists before it launches, so it can't show an interrupted launch.
  // ponytail: a Runner killed mid-launch relaunches closeout on reclaim; save Orca's operation id before launching if Orca ever takes one.
  if (!closeout && saved && saved.repo === repoPath
    && saved.branch === branchName && Object.hasOwn(config.models, saved.model) && await hasWorktree(deps, saved)) {
    saved.launched = true;
    record(deps, log, (launches) => { launches[claim.sessionId] = saved; });
    log('launch-recovered');
    return reportLaunch(config, api, deps, claim, log, saved);
  }

  let worktree: unknown;
  if (closeout) {
    worktree = (await findWorktree(deps, repoPath, branchName))?.path;
    if (!isText(worktree) || !isAbsolute(worktree) || worktree.includes('\0')) {
      return refuse('no-worktree', `The worktree for ${branchName} is gone on ${config.machine}; nothing launched. ${BY_HAND}`, 'response');
    }
  }

  const launch: Launch = { at: (deps.now ?? Date.now)(), repo: repoPath, branch: branchName, model, launched: false, thoughtPosted: false,
    ...(closeout ? { closeout } : { githubRepo: issue.repo }), ...(refine ? { refine } : {}) };
  if (!record(deps, log, (launches) => { launches[claim.sessionId] = launch; })) {
    return refuse('launch-record-failed', `Couldn't save the launch intent. Check the Runner config directory is writable. ${retry}`);
  }
  const args = closeout ? closeoutArgs(config, worktree as string, model, identifier)
    : launchArgs(config, repoPath, model, { identifier, branchName }, refine);
  const reply: Reply = {};
  let code = await orca(deps.exec, args, reply);
  if (code === 'runtime_unavailable') code = await orca(deps.exec, args, reply);
  // A lost reply may have started the agent: replay it once by its id, never as a fresh launch.
  if (closeout && code === 'agent_session_operation_unknown' && reply.operationId) {
    code = await orca(deps.exec, [...args, '--retry-launch', reply.operationId]);
  }
  if (code === 'runtime_unavailable') {
    return refuse('orca-unavailable', `Orca isn't running on ${config.machine}. ${closeout ? `Open Orca. ${BY_HAND}` : 'Open Orca and delegate again to retry.'}`);
  }
  if (code === 'orca_not_found') {
    return refuse('orca-not-found', `The Runner can't find the \`orca\` command on ${config.machine}. Put Orca's CLI on its PATH. ${retry}`);
  }
  if (code === 'repo_not_found') {
    return refuse('orca-repo_not_found', `Orca doesn't know ${issue.repo}'s checkout on ${config.machine}. Check its registration in Orca. ${retry}`);
  }
  if (closeout && code === 'agent_session_operation_unknown') {
    return refuse(`orca-${code}`, `Orca lost the launch reply, so the closeout may have started. Check the worktree for ${branchName} on ${config.machine} before you run do-closeout by hand.`);
  }
  if (code) return refuse(`orca-${code}`, `Orca couldn't start the agent (\`${code}\`). Check Orca on ${config.machine}. ${retry}`);

  launch.launched = true;
  record(deps, log, (launches) => { launches[claim.sessionId] = launch; });
  log(closeout ? 'closeout-launched' : 'launched');
  const outcome = await reportLaunch(config, api, deps, claim, log, launch);
  // Cosmetic, after the report: a failed rename is only logged, and a recovered launch keeps whatever name it has.
  const selector = closeout ? `path:${worktree as string}` : reply.worktree;
  const name = `${stage(launch)} ${branchName.split('/').pop()}`;
  if (!selector || await orca(deps.exec, ['worktree', 'set', '--worktree', selector, '--display-name', name, '--json'])) log('rename-failed');
  return outcome;
}

/** One poll: claims a job and handles it. Returns whether there was one. */
export async function poll(config: RunnerConfig, deps: Deps): Promise<boolean> {
  writeStatus(deps);
  report(config, deps);
  const value = status(deps);
  // Checked and counted with no await between, so a drain can't slip in before the claim.
  if (value.paused || drainRequest(deps)) return false;
  return busy(deps, async () => {
    let claim: Claim | null;
    try {
      claim = await inbox(config, deps).claim();
      value.inbox = { status: 'ok', lastOkAt: time(deps) };
    } catch (error) {
      value.inbox.status = 'unreachable';
      const message = (error as Error).message;
      value.lastError = { identifier: null, outcome: /^cloud-inbox-(\d{3}|claim)$/.test(message) ? message : 'unreachable', time: time(deps) };
      throw error;
    } finally { writeStatus(deps); }
    if (!claim) return false;
    await handleJob(config, deps, claim);
    return true;
  });
}

if (import.meta.main) {
  let config: RunnerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`factory-runner: ${(error as Error).message}`);
    process.exit(1);
  }
  // Setup checks a staged bundle against the installed config this way.
  if (process.argv[2] === '--check-config') process.exit(0);
  const run = promisify(execFile);
  const stateDir = join(isAbsolute(process.env.XDG_STATE_HOME ?? '') ? process.env.XDG_STATE_HOME!
    : join(homedir(), '.local', 'state'), 'factory');
  const deps: Deps = {
    fetch,
    exec: (file, args, timeout) => run(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }),
    log: (fields) => console.log(JSON.stringify(fields)),
    launches: join(dirname(CONFIG_PATH), 'launches.json'),
    watches: join(stateDir, 'watching.json'),
    status: join(stateDir, 'status.json'),
    paused: join(stateDir, 'paused'),
    drain: join(stateDir, 'drain.json'),
  };
  startStatusHeartbeat(deps);
  deps.log({ event: 'start', outcome: 'ok' });
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try { await checkWatches(config, deps); }
    finally { checking = false; }
  };
  void check();
  setInterval(check, 45_000);
  for (;;) {
    config = rereadConfig(config, deps);
    // Ids and outcomes only: the error itself may carry the URL or a body.
    await poll(config, deps).catch((error: Error) => deps.log({ event: 'claim', outcome: error.message.startsWith('cloud-inbox-') ? error.message : 'unreachable' }));
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
