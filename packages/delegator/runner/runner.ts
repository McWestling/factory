// Factory Runner: claims one Cloud Inbox job at a time, checks it, starts the issue's
// agent in a new Orca worktree, and reports the outcome back through Cloud Inbox.
// It holds no Linear credential. Everything Cloud Inbox sends is untrusted input.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { isLaunchEvidence, type Claim, type LaunchEvidence } from '../job.ts';
import { LEVELS, matchModel, parseIssue, type Level } from '../parse-issue.ts';

export const CONFIG_PATH = join(homedir(), '.config', 'factory-delegator', 'config.json');
const POLL_MS = 15_000;
/** Cloud Inbox's history window: a session not reclaimed by then never will be. */
const LAUNCH_KEEP_MS = 30 * 24 * 60 * 60_000;
const RETRY = 'Fix it and delegate again to retry.';
export const NOT_ALLOWED = "This machine doesn't accept dispatches from you.";

export type ModelSettings = { agent: string; model: string; effort?: string };
export type RunnerConfig = {
  inboxUrl: string;
  bearerSecret: string;
  /** The Linear app's name, as Cloud Inbox's queued thought shows it. */
  machine: string;
  allowedCreatorIds: readonly string[];
  /** Preferred models name → how Orca starts it. */
  models: Readonly<Record<string, ModelSettings>>;
  levels: Readonly<Record<Level, string>>;
  skill: string;
};

export type Task = {
  delegated: boolean;
  creatorId: string | null;
  identifier: string;
  description: string;
  branchName: string;
  statusType: string;
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
  /** Upkeep's drain request; the acknowledgment is written beside it as `<drain>.ack`. */
  drain?: string;
  now?: () => number;
};

type Outcome = { identifier: string | null; outcome: string; time: string };
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

/** Upkeep reads this from the installed bundle to know the Runner can drain. */
export const DRAIN_PROTOCOL = 1;
const active = new WeakMap<Deps, number>();

/** Counts claim and watch work, so a drain is acknowledged only between operations. */
async function busy<T>(deps: Deps, work: () => Promise<T>): Promise<T> {
  active.set(deps, (active.get(deps) ?? 0) + 1);
  try { return await work(); }
  finally { active.set(deps, active.get(deps)! - 1); acknowledgeDrain(deps); }
}

/** An unexpired upkeep request's nonce. While it stands, no claim or watch check starts. */
function drainRequest(deps: Deps): string | null {
  if (!deps.drain) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(deps.drain, 'utf8'));
    return isObject(value) && isText(value.nonce) && typeof value.until === 'number'
      && value.until > (deps.now ?? Date.now)() ? value.nonce : null;
  } catch { return null; }
}

/** Acknowledges a drain only with nothing in flight: no claim, job, watch check or open watch. */
export function acknowledgeDrain(deps: Deps) {
  const nonce = drainRequest(deps);
  if (!nonce || active.get(deps) || status(deps).current) return;
  try { if (Object.keys(readWatches(deps)).length) return; } catch { return; }
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

  const { inboxUrl, bearerSecret, machine, allowedCreatorIds, models, levels, skill = 'do-implement' } = raw;
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

  return {
    inboxUrl: url!.href.replace(/\/+$/, ''),
    bearerSecret: bearerSecret as string,
    machine: machine as string,
    allowedCreatorIds: allowedCreatorIds as string[],
    models: models as Record<string, ModelSettings>,
    levels: levels as Record<Level, string>,
    skill: skill as string,
  };
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
      const response = await call('POST', '/jobs/claim');
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
    update: (claim: Claim, type: 'thought' | 'error' | 'response', body: string) => call('POST', job(claim, 'updates'), { type, body }),
    finish: (claim: Claim, outcome: 'launched' | 'failed', launch?: LaunchEvidence) => call('POST', job(claim, outcome), launch),
    watching: async () => {
      const value: unknown = await (await call('GET', '/jobs/watching')).json();
      if (!Array.isArray(value) || !value.every((entry) => isObject(entry) && isText(entry.sessionId)
        && isText(entry.issueId) && isText(entry.claimId) && typeof entry.at === 'number' && Number.isFinite(entry.at)
        && (entry.launch === undefined || isLaunchEvidence(entry.launch)))) {
        throw new Error('cloud-inbox-watching');
      }
      return value as (Claim & { at: number; launch?: LaunchEvidence })[];
    },
    watch: async (claim: Claim) => {
      const value: unknown = await (await call('GET', job(claim, 'watch'))).json();
      if (!isObject(value) || !isText(value.sessionStatus) || !Array.isArray(value.pullRequests)
        || !value.pullRequests.every((url) => typeof url === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/.test(url))) {
        throw new Error('cloud-inbox-watch');
      }
      return value as { sessionStatus: string; pullRequests: string[] };
    },
    link: async (claim: Claim) => {
      const value: unknown = await (await call('POST', job(claim, 'pull-request'))).json();
      if (!isObject(value) || typeof value.url !== 'string'
        || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/.test(value.url)) throw new Error('cloud-inbox-pr');
      return value.url;
    },
  };
}

/** The exact argv for `orca worktree create`, per docs/issue-format.md. */
export function launchArgs(config: RunnerConfig, repoPath: string, model: string, task: Pick<Task, 'identifier' | 'branchName'>) {
  const { agent, model: id, effort } = config.models[model]!;
  return [
    'worktree', 'create',
    '--name', task.branchName.split('/').pop()!,
    '--repo', `path:${repoPath}`,
    '--branch', task.branchName,
    '--agent', agent,
    '--model', id,
    ...(effort ? ['--effort', effort] : []),
    `--prompt=${agent === 'codex' ? '$' : '/'}${config.skill} ${task.identifier}\nDelegated run: nobody is watching this session.`,
    '--setup', config.skill === 'do-implement' ? 'run' : 'skip',
    '--linear-issue', task.identifier,
    '--json',
  ];
}

/** Runs `orca`, returning null on success or Orca's error code. */
// Open, create and its retry stay well inside Cloud Inbox's 10-minute lease.
// ponytail: a create killed at its timeout may leave a worktree behind; the job still fails.
async function orca(exec: Exec, args: string[]): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await exec('orca', args, args[0] === 'open' ? 60_000 : 120_000));
  } catch (error) {
    // Orca prints its JSON error and exits non-zero; no output means it never ran.
    stdout = String((error as { stdout?: unknown }).stdout ?? '');
    if (!stdout) return (error as { code?: unknown }).code === 'ENOENT' ? 'orca_not_found' : 'orca_failed';
  }
  try {
    const result = JSON.parse(stdout);
    if (result?.ok === true) return null;
    const code = result?.error?.code;
    return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'orca_failed';
  } catch {
    return 'orca_bad_output';
  }
}

type Launch = {
  at: number;
  repo: string;
  branch: string;
  model: string;
  launched: boolean;
  thoughtPosted: boolean;
  githubRepo?: string;
};
// Numbers are the previous file format: a confirmed local launch without thought metadata.
type Launches = Record<string, Launch | number>;

function readLaunches(deps: Deps): Launches {
  try {
    const launches: unknown = JSON.parse(readFileSync(deps.launches, 'utf8'));
    if (!isObject(launches) || !Object.values(launches).every((entry) =>
      typeof entry === 'number' ? Number.isFinite(entry) : isObject(entry)
        && typeof entry.at === 'number' && Number.isFinite(entry.at)
        && typeof entry.repo === 'string' && isAbsolute(entry.repo)
        && typeof entry.branch === 'string' && entry.branch.length <= 200 && BRANCH.test(entry.branch) && !entry.branch.includes('..')
        && (entry.githubRepo === undefined || isLaunchEvidence({ repo: entry.githubRepo, branch: entry.branch }))
        && isText(entry.model) && typeof entry.launched === 'boolean' && typeof entry.thoughtPosted === 'boolean'
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
      if (!((typeof entry === 'number' ? entry : entry.at) > Date.now() - LAUNCH_KEEP_MS)) delete launches[session];
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
async function hasWorktree(deps: Deps, launch: Launch): Promise<boolean> {
  try {
    const selector = `path:${launch.repo}`;
    const repo = JSON.parse((await deps.exec('orca', ['repo', 'show', '--repo', selector, '--json'], 30_000)).stdout);
    if (repo?.ok !== true || !isText(repo.result?.repo?.id) || repo.result.repo.path !== launch.repo) return false;
    const list = JSON.parse((await deps.exec('orca', ['worktree', 'list', '--repo', selector, '--limit', '10000', '--json'], 30_000)).stdout);
    return list?.ok === true && Array.isArray(list.result?.worktrees) && list.result.worktrees.some((row: unknown) =>
      isObject(row) && row.repoId === repo.result.repo.id && row.hostId === 'local'
      && row.branch === `refs/heads/${launch.branch}`);
  } catch {
    return false;
  }
}

type Watching = Claim & { at: number; ready: boolean; launch?: LaunchEvidence; identifier?: string };
type Watches = Record<string, Watching>;

function readWatches(deps: Deps): Watches {
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

/** Watch recovery then completion checks, held off while upkeep drains the Runner. */
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
  for (const job of Object.values(watches)) {
    const log = (outcome: string) => deps.log({ event: 'watch', session: job.sessionId, outcome });
    const change = (edit: (watches: Watches) => void) => changeWatches(deps, (current) => {
      // A reclaim may have replaced this claim while a request was in flight.
      if (current[job.sessionId]?.claimId === job.claimId) edit(current);
    });
    try {
      if (!job.ready) {
        // A lost launch acknowledgement may already have committed; watch verifies the claim below.
        await api.finish(job, 'launched', job.launch).catch((error: Error) => {
          if (error.message !== 'cloud-inbox-409') throw error;
        });
      }
      const status = await api.watch(job);
      if (['complete', 'error', 'stopped'].includes(status.sessionStatus)) {
        change((current) => delete current[job.sessionId]);
        log('ended');
        continue;
      }
      if (!['pending', 'active', 'awaitingInput', 'stale'].includes(status.sessionStatus)) {
        throw new Error('unknown session status');
      }
      if (!job.ready) change((current) => { current[job.sessionId]!.ready = true; });
      let body: string;
      if (status.pullRequests.length) {
        const url = await api.link(job);
        // A stop or final reply can land while the link is being added.
        const latest = await api.watch(job);
        if (['complete', 'error', 'stopped'].includes(latest.sessionStatus)) {
          change((current) => delete current[job.sessionId]);
          continue;
        }
        if (!['pending', 'active', 'awaitingInput', 'stale'].includes(latest.sessionStatus)) throw new Error('unknown session status');
        if (!latest.pullRequests.includes(url)) continue;
        body = `Opened ${url}.`;
      } else if ((deps.now ?? Date.now)() - job.at >= 24 * 60 * 60_000) {
        body = 'No PR after 24 h; check the Orca worktree.';
      } else continue;
      await api.update(job, 'response', body);
      change((current) => delete current[job.sessionId]);
      log('finished');
    } catch (error) {
      if ((error as Error).message === 'cloud-inbox-409') {
        // 409 can also mean the PR attachment vanished; keep an otherwise active watch.
        try {
          const latest = await api.watch(job);
          if (['complete', 'error', 'stopped'].includes(latest.sessionStatus)) {
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

/** Reports a recorded launch, retaining its claim for completion watching. */
async function reportLaunch(api: ReturnType<typeof inbox>, deps: Deps, claim: Claim, log: (outcome: string) => void, launch: Launch | number) {
  if (typeof launch !== 'number' && !launch.thoughtPosted) {
    const posted = await api.update(claim, 'thought', `Started ${launch.model} in Orca on \`${launch.branch}\`.`)
      .then(() => true, () => false);
    if (!posted) {
      // Keep the claim recoverable until its thought can be queued too.
      log('thought-failed');
      return 'launched';
    }
    launch.thoughtPosted = true;
    record(deps, log, (launches) => { launches[claim.sessionId] = launch; });
  }
  try {
    changeWatches(deps, (watches) => {
      if (watches[claim.sessionId]?.claimId !== claim.claimId) {
        const identifier = status(deps).current?.identifier;
        watches[claim.sessionId] = { ...claim, at: typeof launch === 'number' ? launch : launch.at, ready: false,
          ...(typeof launch !== 'number' && launch.githubRepo ? { launch: { repo: launch.githubRepo, branch: launch.branch } } : {}),
          ...(identifier && IDENTIFIER.test(identifier) ? { identifier } : {}) };
      }
    });
  } catch {
    log('watch-save-failed');
    return 'launched';
  }
  const evidence = typeof launch !== 'number' && launch.githubRepo ? { repo: launch.githubRepo, branch: launch.branch } : undefined;
  if (await api.finish(claim, 'launched', evidence).then(() => true, () => false)) {
    try { changeWatches(deps, (watches) => { watches[claim.sessionId]!.ready = true; }); }
    catch { log('watch-save-failed'); }
    record(deps, log, (launches) => delete launches[claim.sessionId]);
  } else {
    log('launched-report-failed');
  }
  return 'launched';
}

/** Checks one claimed job, launches it if it passes, and reports the outcome. */
export async function handleJob(config: RunnerConfig, deps: Deps, claim: Claim): Promise<string> {
  const value = status(deps);
  value.current = { identifier: safeId(claim.issueId) ?? 'unknown', sessionId: safeId(claim.sessionId) ?? 'unknown' };
  writeStatus(deps);
  let outcome = 'job-failed';
  try { return outcome = await runJob(config, deps, claim); }
  finally {
    const entry = { identifier: value.current.identifier, outcome, time: time(deps) };
    value.recent = [...value.recent, entry].slice(-10);
    if (outcome !== 'launched' && outcome !== 'undelegated') value.lastError = entry;
    value.current = null;
    writeStatus(deps);
  }
}

async function runJob(config: RunnerConfig, deps: Deps, claim: Claim): Promise<string> {
  const api = inbox(config, deps);
  const log = (outcome: string) => deps.log({ event: 'job', session: claim.sessionId, outcome });
  const refuse = async (outcome: string, message: string) => {
    log(outcome);
    // Each report is tried even if the one before it failed; a lost report leaves the lease to expire.
    await api.update(claim, 'error', message).catch(() => log('error-update-failed'));
    await api.finish(claim, 'failed').catch(() => log('failed-report-failed'));
    return outcome;
  };

  const saved = readLaunches(deps)[claim.sessionId];
  if (saved !== undefined && (typeof saved === 'number' || saved.launched)) {
    // Launched under an earlier claim whose report was lost: the agent is already running.
    log('launch-recovered');
    return reportLaunch(api, deps, claim, log, saved);
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
  if (task.delegated !== true) {
    // Reporting ends the claim; Cloud Inbox clears the delegate only while it's still this app.
    log('undelegated');
    await api.finish(claim, 'failed').catch(() => log('failed-report-failed'));
    return 'undelegated';
  }
  if (!isText(task.creatorId) || !config.allowedCreatorIds.includes(task.creatorId)) {
    return refuse('creator-refused', NOT_ALLOWED);
  }
  const issue = parseIssue(typeof task.description === 'string' ? task.description : '');
  if ('field' in issue) {
    return refuse(`refused-${issue.field}`, `Refused \`${issue.field}\`: expected ${issue.expected}. ${RETRY}`);
  }
  const { identifier, branchName } = task;
  if (typeof identifier !== 'string' || !IDENTIFIER.test(identifier)) {
    return refuse('bad-identifier', `The issue id isn't a plain Linear id like ABC-123. ${RETRY}`);
  }
  if (typeof branchName !== 'string' || branchName.length > 200 || !BRANCH.test(branchName) || branchName.includes('..')) {
    return refuse('bad-branch', `The issue's Linear branch name isn't a plain git branch name. ${RETRY}`);
  }

  const matched = issue.model === undefined ? undefined : matchModel(issue.model, Object.keys(config.models));
  const model = matched ?? config.levels[issue.level];
  if (issue.model !== undefined && matched === undefined) {
    await api.update(claim, 'thought', `Couldn't match model pin \`${issue.model}\`; using level \`${issue.level}\` with ${model}.`);
  }
  const opened = await orca(deps.exec, ['open', '--json']);
  if (opened === 'orca_not_found') {
    return refuse('orca-not-found', `The Runner can't find the \`orca\` command on ${config.machine}. Put Orca's CLI on its PATH. ${RETRY}`);
  }
  let paths: string[];
  try {
    const listing = JSON.parse((await deps.exec('orca', ['repo', 'list', '--json'], 30_000)).stdout);
    if (listing?.ok !== true || !Array.isArray(listing.result?.repos)) throw new Error('invalid repo list');
    paths = [];
    for (const row of listing.result.repos) {
      if (!isObject(row)) throw new Error('invalid repo row');
      if (row.kind !== 'git' || !isObject(row.gitRemoteIdentity)
        || typeof row.gitRemoteIdentity.canonicalKey !== 'string'
        || row.gitRemoteIdentity.canonicalKey.toLowerCase() !== `github.com/${issue.repo.toLowerCase()}`) continue;
      if (!isText(row.path) || !isAbsolute(row.path) || row.path.includes('\0')) throw new Error('invalid repo path');
      paths.push(row.path);
    }
  } catch {
    return refuse('orca-repos-unreadable', `Couldn't read registered repos from Orca on ${config.machine}. Check \`orca repo list --json\`. ${RETRY}`);
  }
  if (paths.length !== 1) {
    return refuse('refused-repo', paths.length === 0
      ? `Orca has no registered GitHub checkout for \`${issue.repo}\` on ${config.machine}. Add its checkout in Orca. ${RETRY}`
      : `Orca has multiple registered checkouts for \`${issue.repo}\` on ${config.machine}. Keep one registration for that GitHub repo. ${RETRY}`);
  }
  const repoPath = paths[0]!;

  if (saved && typeof saved !== 'number' && saved.repo === repoPath
    && saved.branch === branchName && Object.hasOwn(config.models, saved.model) && await hasWorktree(deps, saved)) {
    saved.launched = true;
    record(deps, log, (launches) => { launches[claim.sessionId] = saved; });
    log('launch-recovered');
    return reportLaunch(api, deps, claim, log, saved);
  }

  const launch: Launch = { at: (deps.now ?? Date.now)(), repo: repoPath, branch: branchName,
    model, githubRepo: issue.repo, launched: false, thoughtPosted: false };
  if (!record(deps, log, (launches) => { launches[claim.sessionId] = launch; })) {
    return refuse('launch-record-failed', `Couldn't save the launch intent. Check the Runner config directory is writable. ${RETRY}`);
  }
  const args = launchArgs(config, repoPath, model, { identifier, branchName });
  let code = await orca(deps.exec, args);
  if (code === 'runtime_unavailable') code = await orca(deps.exec, args);
  if (code === 'runtime_unavailable') {
    return refuse('orca-unavailable', `Orca isn't running on ${config.machine}. Open Orca and delegate again to retry.`);
  }
  if (code === 'orca_not_found') {
    return refuse('orca-not-found', `The Runner can't find the \`orca\` command on ${config.machine}. Put Orca's CLI on its PATH. ${RETRY}`);
  }
  if (code === 'repo_not_found') {
    return refuse('orca-repo_not_found', `Orca doesn't know ${issue.repo}'s checkout on ${config.machine}. Check its registration in Orca. ${RETRY}`);
  }
  if (code) return refuse(`orca-${code}`, `Orca couldn't start the agent (\`${code}\`). Check Orca on ${config.machine}. ${RETRY}`);

  launch.launched = true;
  record(deps, log, (launches) => { launches[claim.sessionId] = launch; });
  log('launched');
  return reportLaunch(api, deps, claim, log, launch);
}

/** One poll: claims a job and handles it. Returns whether there was one. */
export async function poll(config: RunnerConfig, deps: Deps): Promise<boolean> {
  writeStatus(deps);
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
  // Upkeep checks a staged bundle against the installed config this way.
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
    // Ids and outcomes only: the error itself may carry the URL or a body.
    await poll(config, deps).catch((error: Error) => deps.log({ event: 'claim', outcome: error.message.startsWith('cloud-inbox-') ? error.message : 'unreachable' }));
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
