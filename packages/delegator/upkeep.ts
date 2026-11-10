// Factory upkeep: after merging Factory changes, refreshes installed Factory skills and
// safely updates an existing Runner from this clean checkout of the default branch.
// It never changes git state, installs anything missing, or restarts a busy Runner.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export type UpkeepDeps = {
  exec: (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;
  home: string;
  stateDir: string;
  /** The checkout this command runs from. */
  root: string;
  node: string;
  uid: number;
  sleep: (ms: number) => Promise<void>;
  print: (line: string) => void;
};

const LABEL = 'com.factory.factory-delegator.runner';
// Everything the installer bundles from source, checked byte for byte after staging.
const BUNDLED = ['job.ts', 'parse-issue.ts', 'runner/runner.ts', 'runner/launchd/install.sh',
  'runner/launchd/runner.plist', 'menubar/menubar.plist'];
const OLD_RUNNER = `The installed Runner predates safe draining, so upkeep won't restart it. Nothing was changed. To update it safely:
  1. In the Factory Runner menu, turn on Pause new work.
  2. Wait until the menu shows Paused, with no current job and nothing Waiting for a PR, for at least a minute.
  3. Choose Stop Runner.
  4. Rerun this command. It refreshes the stopped Runner and leaves it stopped.
  5. Choose Start Runner, then turn off Pause new work.`;

type Result = { ok: boolean; line: string };
const short = (sha: string) => sha.slice(0, 7);
const lastLine = (error: unknown) =>
  String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n').pop()?.slice(0, 300) || 'no output';
const readJson = (path: string): any => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const alive = (pid: unknown) => {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Checks this is a clean checkout of origin's current default branch; returns HEAD. */
async function source(deps: UpkeepDeps): Promise<string> {
  const git = async (...args: string[]) => (await deps.exec('git', ['-C', deps.root, ...args], 30_000)).stdout.trim();
  const step = async (failure: string, ...args: string[]) => {
    try { return await git(...args); } catch { throw new Error(failure); }
  };
  const origin = await step(`${deps.root} isn't a git checkout with an origin`, 'remote', 'get-url', 'origin');
  if (!/github\.com[:/]mcwestling\/factory(\.git)?$/i.test(origin)) {
    throw new Error('origin isn\'t mcwestling/factory. Run upkeep from a Factory checkout.');
  }
  if (await step('couldn\'t read the checkout\'s status', '--no-optional-locks', 'status', '--porcelain')) {
    throw new Error('the checkout has uncommitted or untracked changes. Commit, stash or remove them, then rerun.');
  }
  const head = await step('couldn\'t read HEAD', 'rev-parse', 'HEAD');
  const remote = await step('couldn\'t reach origin to read its default branch', 'ls-remote', '--symref', 'origin', 'HEAD');
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(remote)?.[1];
  const tip = /^([0-9a-f]{40})\tHEAD$/m.exec(remote)?.[1];
  if (!branch || !tip) throw new Error('couldn\'t read origin\'s default branch');
  if (head !== tip) {
    throw new Error(`HEAD ${short(head)} isn't origin's ${branch} (${short(tip)}). Check out ${branch} and pull it, then rerun.`);
  }
  return head;
}

/** Updates the installed Factory skills with the skills CLI, then checks each matches HEAD. */
async function skills(deps: UpkeepDeps, head: string): Promise<Result> {
  const lock = join(deps.home, '.agents', '.skill-lock.json');
  const installed = () => (readJson(lock)?.skills ?? {}) as Record<string, { source?: unknown; skillFolderHash?: unknown }>;
  const names = Object.entries(installed())
    .filter(([, skill]) => String(skill?.source).toLowerCase() === 'mcwestling/factory').map(([name]) => name);
  if (!names.length) return { ok: true, line: 'skills: skipped. No Factory skills are installed; the README shows how to install them.' };
  try {
    await deps.exec('npx', ['--yes', 'skills', 'update', '-g', '-y', ...names], 600_000);
  } catch (error) {
    return { ok: false, line: `skills: failed. The skills installer exited with an error (${lastLine(error)}).` };
  }
  const after = installed();
  const stale: string[] = [];
  for (const name of names) {
    // The installer records each skill folder's git tree hash.
    const tree = await deps.exec('git', ['-C', deps.root, 'rev-parse', `${head}:skills/${name}`], 30_000)
      .then(({ stdout }) => stdout.trim(), () => null);
    if (!tree || after[name]?.skillFolderHash !== tree) stale.push(name);
  }
  if (stale.length) return { ok: false, line: `skills: failed. Still not at ${short(head)} after updating: ${stale.join(', ')}.` };
  return { ok: true, line: `skills: refreshed ${names.join(', ')} to ${short(head)}.` };
}

/** Rebuilds an installed Runner app, swapping it in only once the Runner is proven idle. */
async function runner(deps: UpkeepDeps): Promise<Result> {
  const app = join(deps.home, 'Applications', 'Factory Runner.app');
  const staged = `${app}.staged`, previous = `${app}.previous`, failed = `${app}.failed`;
  const plist = join(deps.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const drain = join(deps.stateDir, 'drain.json');
  const service = `gui/${deps.uid}/${LABEL}`;
  const fail = (reason: string): Result => ({ ok: false, line: `runner: ${reason}` });
  // A crash mid-swap leaves only the previous bundle; put it back first.
  if (!existsSync(app) && existsSync(previous)) renameSync(previous, app);
  if (!existsSync(app)) return { ok: true, line: 'runner: skipped. No Factory Runner app is installed.' };

  /** The loaded Runner's pid, 0 when loaded but not running, or null when not loaded. */
  const pid = async () => {
    try {
      const { stdout } = await deps.exec('launchctl', ['print', service], 30_000);
      return Number(/^\s*pid = (\d+)$/m.exec(stdout)?.[1] ?? 0);
    } catch { return null; }
  };
  const wait = async (seconds: number, done: () => Promise<boolean>) => {
    for (let i = 0; i < seconds; i++) { if (await done()) return true; await deps.sleep(1000); }
    return done();
  };
  const start = async (after: number) => {
    try { await deps.exec('launchctl', ['bootstrap', `gui/${deps.uid}`, plist], 30_000); } catch { return 0; }
    let started = 0;
    await wait(30, async () => {
      const current = await pid(), status = readJson(join(deps.stateDir, 'status.json'));
      if (current && status?.pid === current && Date.parse(status.updatedAt) >= after - 1000) started = current;
      return started > 0;
    });
    return started;
  };

  const running = await pid();
  if (running === 0) return fail('refused. The Runner agent is loaded but not running. Check ~/Library/Logs/factory-delegator, then rerun.');
  if (running && !readFileSync(join(app, 'Contents/Resources/runner/runner.ts'), 'utf8').includes('DRAIN_PROTOCOL = 1')) {
    return fail(`refused. ${OLD_RUNNER}`);
  }
  if (running === null) {
    const status = readJson(join(deps.stateDir, 'status.json'));
    if (alive(status?.pid) && Date.now() - Date.parse(status.updatedAt) < 30_000) {
      return fail(`refused. A Runner process (pid ${status.pid}) is running outside launchd. Stop it, then rerun.`);
    }
    const watches = existsSync(join(deps.stateDir, 'watching.json')) ? readJson(join(deps.stateDir, 'watching.json')) : {};
    if (!watches || typeof watches !== 'object' || Object.keys(watches).length) {
      return fail('refused. The stopped Runner has open or unreadable watches. Start it, let Waiting for a PR clear, then rerun.');
    }
  }

  rmSync(staged, { recursive: true, force: true });
  try {
    await deps.exec('sh', [join(deps.root, 'packages/delegator/runner/launchd/install.sh'), '--build-app', staged], 600_000);
    for (const file of BUNDLED) {
      if (!readFileSync(join(staged, 'Contents/Resources', file)).equals(readFileSync(join(deps.root, 'packages/delegator', file)))) {
        throw new Error(file);
      }
    }
    if (!(statSync(join(staged, 'Contents/MacOS/FactoryRunnerMenuBar')).mode & 0o111)) throw new Error('menu app');
  } catch (error) {
    return fail(`failed. The staged build didn't complete (${lastLine(error)}). The installed Runner is unchanged.`);
  }
  if (existsSync(plist)) {
    try {
      await deps.exec(deps.node, [join(staged, 'Contents/Resources/runner/runner.ts'), '--check-config'], 30_000);
    } catch (error) {
      return fail(`refused. The installed config doesn't fit the new Runner (${lastLine(error)}). The installed Runner is unchanged; update the config to match config.example.json, then rerun.`);
    }
  }

  if (running) {
    const nonce = randomUUID();
    rmSync(`${drain}.ack`, { force: true });
    writeFileSync(`${drain}.tmp`, JSON.stringify({ nonce, until: Date.now() + 120_000 }), { mode: 0o600 });
    renameSync(`${drain}.tmp`, drain);
    const acked = await wait(60, async () => {
      const ack = readJson(`${drain}.ack`);
      return ack?.nonce === nonce && ack.pid === running;
    });
    if (!acked || await pid() !== running) {
      return fail('refused. The Runner is busy (a claim, job or watch is in progress) or didn\'t confirm it was idle within 60 s. Nothing was changed; rerun when the menu shows nothing in progress or Waiting for a PR.');
    }
    try { await deps.exec('launchctl', ['bootout', service], 60_000); } catch {}
    if (!await wait(10, async () => await pid() === null)) {
      return fail('failed. Couldn\'t stop the Runner to replace it. The installed bundle is unchanged.');
    }
  }

  const stoppedAt = Date.now();
  rmSync(previous, { recursive: true, force: true });
  try {
    renameSync(app, previous);
    try { renameSync(staged, app); } catch (error) { renameSync(previous, app); throw error; }
  } catch (error) {
    rmSync(drain, { force: true });
    const back = running ? await start(Date.now()) : 0;
    return fail(`failed. Couldn't swap in the new bundle (${(error as Error).message}); the previous one is in place${
      !running ? '' : back ? ` and restarted (pid ${back})` : ' but didn\'t restart; check ~/Library/Logs/factory-delegator'}.`);
  }
  rmSync(drain, { force: true });
  const reopen = ' Quit and reopen the menu bar app to load its new version.';
  if (!running) {
    rmSync(previous, { recursive: true, force: true });
    return { ok: true, line: `runner: refreshed${existsSync(plist) ? ' and left stopped' : ' the app; no Runner agent is installed'}.${reopen}` };
  }
  const started = await start(stoppedAt);
  if (started) {
    rmSync(previous, { recursive: true, force: true });
    return { ok: true, line: `runner: refreshed and restarted (pid ${running} → ${started}).${reopen}` };
  }
  try { await deps.exec('launchctl', ['bootout', service], 60_000); } catch {}
  await wait(10, async () => await pid() === null);
  rmSync(failed, { recursive: true, force: true });
  renameSync(app, failed);
  renameSync(previous, app);
  const restored = await start(Date.now());
  return fail(`failed. The new Runner didn't start, so the previous bundle was restored${restored ? ` and restarted (pid ${restored})` : ', but it didn\'t start either; check ~/Library/Logs/factory-delegator'}. The failed bundle is at ${failed}.`);
}

/** Runs upkeep and returns the exit code: 0 only when every requested step succeeded or was skipped. */
export async function upkeep(deps: UpkeepDeps): Promise<number> {
  mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  const lock = join(deps.stateDir, 'upkeep.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); } catch {
    const other = Number(readFileSync(lock, 'utf8'));
    if (alive(other)) { deps.print(`upkeep: refused. Another upkeep (pid ${other}) is running.`); return 1; }
    writeFileSync(lock, String(process.pid), { mode: 0o600 });
  }
  const drain = join(deps.stateDir, 'drain.json');
  const staged = join(deps.home, 'Applications', 'Factory Runner.app.staged');
  try {
    let head: string;
    try { head = await source(deps); } catch (error) {
      deps.print(`source: refused. ${(error as Error).message}`);
      deps.print('skills: not run.\nrunner: not run.');
      return 1;
    }
    deps.print(`source: mcwestling/factory at ${short(head)}.`);
    const results = [await skills(deps, head)];
    deps.print(results[0]!.line);
    results.push(await runner(deps).catch((error: Error) =>
      ({ ok: false, line: `runner: failed (${error.message}). Check ~/Applications for the Factory Runner app.` })));
    deps.print(results[1]!.line);
    return results.every((result) => result.ok) ? 0 : 1;
  } finally {
    for (const path of [drain, `${drain}.ack`, `${drain}.tmp`, staged, lock]) rmSync(path, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const run = promisify(execFile);
  const state = process.env.XDG_STATE_HOME;
  process.exitCode = await upkeep({
    exec: (file, args, timeout) => run(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }),
    home: homedir(),
    stateDir: join(state && isAbsolute(state) ? state : join(homedir(), '.local', 'state'), 'factory'),
    root: resolve(import.meta.dirname, '../..'),
    node: process.execPath,
    uid: process.getuid!(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    print: (line) => console.log(line),
  });
}
