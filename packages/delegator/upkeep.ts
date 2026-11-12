// The Runner half of `npm run setup`: safely updates an existing Runner app from this checkout.
// It never installs a missing Runner or restarts a busy one.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
const OLD_RUNNER = `The installed Runner predates safe draining, so setup won't restart it. Nothing was changed. To update it safely:
  1. In the Factory Runner menu, turn on Pause new work.
  2. Wait until the menu shows Paused, with no current job and nothing Waiting for a PR, for at least a minute.
  3. Choose Stop Runner.
  4. Rerun this command. It refreshes the stopped Runner and leaves it stopped.
  5. Choose Start Runner, then turn off Pause new work.`;

export type Result = { ok: boolean; line: string };
export const lastLine = (error: unknown) =>
  String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n').pop()?.slice(0, 300) || 'no output';
export const readJson = (path: string): any => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export const alive = (pid: unknown) => {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Rebuilds an installed Runner app, swapping it in only once the Runner is proven idle. */
export async function updateRunner(deps: UpkeepDeps): Promise<Result> {
  try { return await runner(deps); } catch (error) {
    return { ok: false, line: `runner: failed (${(error as Error).message}). Check ~/Applications for the Factory Runner app.` };
  } finally {
    const drain = join(deps.stateDir, 'drain.json');
    for (const path of [drain, `${drain}.ack`, `${drain}.tmp`, join(deps.home, 'Applications', 'Factory Runner.app.staged')]) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

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
  /** Why a stopped Runner can't be refreshed now, or null when it's still stopped with nothing outstanding. */
  const stoppedRefusal = async () => {
    if (await pid() !== null) return fail('refused. The stopped Runner was started while setup was building. Nothing was replaced; rerun when it\'s idle.');
    const status = readJson(join(deps.stateDir, 'status.json'));
    if (alive(status?.pid) && Date.now() - Date.parse(status.updatedAt) < 30_000) {
      return fail(`refused. A Runner process (pid ${status.pid}) is running outside launchd. Stop it, then rerun.`);
    }
    const watches = existsSync(join(deps.stateDir, 'watching.json')) ? readJson(join(deps.stateDir, 'watching.json')) : {};
    if (!watches || typeof watches !== 'object' || Object.keys(watches).length) {
      return fail('refused. The stopped Runner has open or unreadable watches. Start it, let Waiting for a PR clear, then rerun.');
    }
    return null;
  };
  if (running === null) { const refusal = await stoppedRefusal(); if (refusal) return refusal; }

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

  // The build takes a while; a stopped Runner may have been started meanwhile.
  if (running === null) { const refusal = await stoppedRefusal(); if (refusal) return refusal; }
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
  const reopen = ' Run `npm run menubar` to restart the menu bar app on its new version.';
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
  if (!await wait(10, async () => await pid() === null)) {
    return fail(`failed. The new Runner didn't confirm it started, and it couldn't be stopped, so both bundles were left in place: the new one at ${app}, the previous one at ${previous}. To roll back, run \`launchctl bootout ${service}\` until \`launchctl print ${service}\` fails, move the new bundle aside, rename the previous one to ${app}, then choose Start Runner. Don't rerun setup first; it replaces the previous bundle.`);
  }
  rmSync(failed, { recursive: true, force: true });
  renameSync(app, failed);
  renameSync(previous, app);
  const restored = await start(Date.now());
  return fail(`failed. The new Runner didn't start, so the previous bundle was restored${restored ? ` and restarted (pid ${restored})` : ', but it didn\'t start either; check ~/Library/Logs/factory-delegator'}. The failed bundle is at ${failed}.`);
}

/** Runs `fn` while holding the setup lock, so two setups never update the same machine at once. */
export async function withLock(deps: Pick<UpkeepDeps, 'stateDir' | 'print'>, fn: () => Promise<number>): Promise<number> {
  mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  const lock = join(deps.stateDir, 'setup.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); } catch {
    const other = Number(readFileSync(lock, 'utf8'));
    if (alive(other)) { deps.print(`setup: refused. Another setup (pid ${other}) is running.`); return 1; }
    writeFileSync(lock, String(process.pid), { mode: 0o600 });
  }
  try { return await fn(); } finally { rmSync(lock, { force: true }); }
}
