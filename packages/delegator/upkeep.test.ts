import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { acknowledgeDrain, poll, type Deps, type RunnerConfig } from './runner/runner.ts';
import { upkeep, type UpkeepDeps } from './upkeep.ts';

const root = resolve(import.meta.dirname, '../..');
const HEAD = 'a'.repeat(40);
const LABEL = 'com.factory.factory-delegator.runner';
const BUNDLED = ['job.ts', 'parse-issue.ts', 'runner/runner.ts', 'runner/launchd/install.sh',
  'runner/launchd/runner.plist', 'menubar/menubar.plist'];

/** A disposable machine: real files under a temp home, with git, the skills CLI, the installer and launchd faked. */
function machine({ runner = 'running' as 'running' | 'stopped' | 'none', oldRunner = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'upkeep-'));
  const stateDir = join(home, '.local/state/factory');
  const app = join(home, 'Applications/Factory Runner.app');
  const plist = join(home, 'Library/LaunchAgents', `${LABEL}.plist`);
  const config = join(home, '.config/factory-delegator/config.json');
  const lock = join(home, '.agents/.skill-lock.json');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ skills: {
    'do-implement': { source: 'McWestling/factory', skillFolderHash: 'old' },
    'other-skill': { source: 'someone/else', skillFolderHash: 'x' },
  } }));
  const bundle = (dir: string, version: string) => {
    for (const file of BUNDLED) {
      mkdirSync(dirname(join(dir, 'Contents/Resources', file)), { recursive: true });
      writeFileSync(join(dir, 'Contents/Resources', file), version === 'source'
        ? readFileSync(join(root, 'packages/delegator', file)) : `${oldRunner ? '' : 'export const DRAIN_PROTOCOL = 1;'} ${version}`);
    }
    mkdirSync(join(dir, 'Contents/MacOS'), { recursive: true });
    writeFileSync(join(dir, 'Contents/MacOS/FactoryRunnerMenuBar', ''), version);
    chmodSync(join(dir, 'Contents/MacOS/FactoryRunnerMenuBar'), 0o755);
  };
  if (runner !== 'none') {
    bundle(app, 'old');
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, '<plist/>');
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, '{"bearerSecret":"secret-value"}', { mode: 0o600 });
  }

  const m = {
    home, stateDir, app, plist, config,
    pid: runner === 'running' ? process.pid as number | null : null,
    nextPid: 4242,
    git: { origin: 'git@github.com:McWestling/factory.git', status: '', head: HEAD, tip: HEAD },
    fail: new Set<string>(),
    calls: [] as string[],
    onSleep: () => {},
    deps: undefined as unknown as UpkeepDeps,
    output: [] as string[],
  };
  const error = (stderr: string) => Object.assign(new Error('exit 1'), { stderr });
  m.deps = {
    home, stateDir, root, node: '/usr/bin/node', uid: 501,
    print: (line) => m.output.push(line),
    sleep: async () => { m.onSleep(); await new Promise((done) => setImmediate(done)); },
    async exec(file, args) {
      const call = `${file} ${args.join(' ')}`;
      m.calls.push(call);
      const key = [...m.fail].find((part) => call.includes(part));
      if (key) throw error(`${key} broke`);
      if (file === 'git') {
        const [, , command, ...rest] = args;
        if (command === 'remote') return { stdout: m.git.origin };
        if (command === '--no-optional-locks') return { stdout: m.git.status };
        if (command === 'rev-parse' && rest[0] === 'HEAD') return { stdout: m.git.head };
        if (command === 'rev-parse') return { stdout: `tree-${rest[0]!.split('/').pop()}` };
        if (command === 'ls-remote') return { stdout: `ref: refs/heads/main\tHEAD\n${m.git.tip}\tHEAD\n` };
      }
      if (file === 'npx') {
        const value = JSON.parse(readFileSync(lock, 'utf8'));
        value.skills['do-implement'].skillFolderHash = 'tree-do-implement';
        writeFileSync(lock, JSON.stringify(value));
        return { stdout: '' };
      }
      if (file === 'sh' && args[1] === '--build-app') { bundle(args[2]!, 'source'); return { stdout: '' }; }
      if (file === '/usr/bin/node') return { stdout: '' };
      if (file === 'launchctl' && args[0] === 'print') {
        if (m.pid === null) throw error('Could not find service');
        return { stdout: `${args[1]} = {\n\tstate = running\n\tpid = ${m.pid}\n}` };
      }
      if (file === 'launchctl' && args[0] === 'bootout') { m.pid = null; return { stdout: '' }; }
      if (file === 'launchctl' && args[0] === 'bootstrap') {
        m.pid = m.nextPid++;
        writeFileSync(join(stateDir, 'status.json'), JSON.stringify({ pid: m.pid, updatedAt: new Date().toISOString() }));
        return { stdout: '' };
      }
      throw new Error(`unexpected ${call}`);
    },
  };
  const launchctl = () => m.calls.filter((call) => call.startsWith('launchctl') && !call.startsWith('launchctl print'));
  const bundled = () => readFileSync(join(app, 'Contents/Resources/runner/runner.ts'), 'utf8');
  return { ...m, m, launchctl, bundled, run: () => upkeep(m.deps) };
}

/** The real Runner's drain handling, sharing the machine's state directory. */
function runnerOn(stateDir: string) {
  let release = () => {};
  const held = new Promise<void>((done) => { release = done; });
  const deps: Deps = {
    fetch: async (input) => {
      if (new URL(String(input)).pathname.endsWith('/claim')) { await held; return new Response(null, { status: 204 }); }
      return new Response(null, { status: 204 });
    },
    exec: async () => ({ stdout: '' }),
    log() {},
    launches: join(stateDir, 'launches.json'),
    watches: join(stateDir, 'watching.json'),
    status: join(stateDir, 'status.json'),
    paused: join(stateDir, 'paused'),
    drain: join(stateDir, 'drain.json'),
  };
  const config = { inboxUrl: 'https://inbox.example', bearerSecret: 'b', machine: 'm', allowedCreatorIds: ['u'],
    models: { M: { agent: 'claude', model: 'm' } }, levels: { light: 'M', standard: 'M', deep: 'M' }, skill: 'do-implement' } as RunnerConfig;
  return { deps, release, claiming: poll(config, deps) };
}

test('a claim in flight behind an idle heartbeat blocks the swap until the Runner acknowledges quiescence', async () => {
  const machineA = machine();
  const busy = runnerOn(machineA.stateDir);
  machineA.m.onSleep = () => acknowledgeDrain(busy.deps);
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output.join('\n'), /runner: refused\. The Runner is busy/);
  assert.deepEqual(machineA.launchctl(), [], 'never stopped or restarted');
  assert.match(machineA.bundled(), /old/);
  assert.equal(existsSync(join(machineA.stateDir, 'drain.json')), false, 'the hold-off is lifted');
  busy.release();
  await busy.claiming;

  const machineB = machine();
  const late = runnerOn(machineB.stateDir);
  let sleeps = 0;
  machineB.m.onSleep = () => { if (++sleeps === 3) late.release(); acknowledgeDrain(late.deps); };
  assert.equal(await machineB.run(), 0);
  assert.ok(sleeps >= 3, 'waited for the claim to finish');
  assert.deepEqual(machineB.launchctl(), [`launchctl bootout gui/501/${LABEL}`, `launchctl bootstrap gui/501 ${machineB.plist}`]);
  assert.equal(machineB.bundled(), readFileSync(join(root, 'packages/delegator/runner/runner.ts'), 'utf8'));
  assert.match(machineB.m.output.join('\n'), new RegExp(`runner: refreshed and restarted \\(pid ${process.pid} → 4242\\)`));
  await late.claiming;
});

test('a stale acknowledgment or no acknowledgment refuses without stopping the Runner', async () => {
  const machineA = machine();
  writeFileSync(join(machineA.stateDir, 'status.json'), JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString(), current: null, paused: true }));
  writeFileSync(join(machineA.stateDir, 'drain.json.ack'), JSON.stringify({ nonce: 'earlier', pid: process.pid }));
  machineA.m.onSleep = () => {
    const request = JSON.parse(readFileSync(join(machineA.stateDir, 'drain.json'), 'utf8'));
    writeFileSync(join(machineA.stateDir, 'drain.json.ack'), JSON.stringify({ nonce: request.nonce, pid: 999_999 }));
  };
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output.join('\n'), /runner: refused\. The Runner is busy/);
  assert.deepEqual(machineA.launchctl(), []);
});

test('an open watch keeps the Runner from acknowledging, so upkeep refuses', async () => {
  const machineA = machine();
  const runner = runnerOn(machineA.stateDir);
  runner.release();
  await runner.claiming;
  writeFileSync(runner.deps.watches, JSON.stringify({ s: { sessionId: 's', issueId: 'i', claimId: 'c', at: 1, ready: true } }));
  machineA.m.onSleep = () => acknowledgeDrain(runner.deps);
  assert.equal(await machineA.run(), 1);
  assert.deepEqual(machineA.launchctl(), []);
});

test('a machine without the Runner app gets skills only', async () => {
  const machineA = machine({ runner: 'none' });
  assert.equal(await machineA.run(), 0);
  assert.deepEqual(machineA.m.output, ['source: mcwestling/factory at aaaaaaa.', 'skills: refreshed do-implement to aaaaaaa.',
    'runner: skipped. No Factory Runner app is installed.']);
  assert.ok(machineA.m.calls.includes('npx --yes skills update -g -y do-implement'), 'only Factory skills');
  assert.equal(machineA.m.calls.some((call) => call.startsWith('sh') || call.startsWith('launchctl')), false);
});

test('a skill failure is reported separately and still fails the run after a successful Runner refresh', async () => {
  const machineA = machine({ runner: 'stopped' });
  machineA.m.fail.add('npx');
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output[1]!, /^skills: failed\. The skills installer exited with an error \(npx broke\)/);
  assert.match(machineA.m.output[2]!, /^runner: refreshed and left stopped\./);

  const machineB = machine({ runner: 'none' });
  machineB.m.deps.exec = ((exec) => async (file: string, args: string[], timeout: number) =>
    file === 'npx' ? { stdout: '' } : exec(file, args, timeout))(machineB.m.deps.exec);
  assert.equal(await machineB.run(), 1);
  assert.match(machineB.m.output[1]!, /^skills: failed\. Still not at aaaaaaa after updating: do-implement\./);
});

test('a failed staged build leaves the installed Runner running and unchanged', async () => {
  const machineA = machine();
  machineA.m.fail.add('--build-app');
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output[2]!, /^runner: failed\. The staged build didn't complete \(--build-app broke\)\. The installed Runner is unchanged\./);
  assert.deepEqual(machineA.launchctl(), []);
  assert.match(machineA.bundled(), /old/);
  assert.equal(existsSync(`${machineA.app}.staged`), false);
  assert.equal(existsSync(join(machineA.stateDir, 'drain.json')), false, 'never asked to drain');
});

test('a new Runner that does not start is replaced by the restored previous bundle', async () => {
  const machineA = machine();
  const runner = runnerOn(machineA.stateDir);
  runner.release();
  await runner.claiming;
  machineA.m.onSleep = () => acknowledgeDrain(runner.deps);
  const exec = machineA.m.deps.exec;
  let starts = 0;
  machineA.m.deps.exec = async (file, args, timeout) => {
    if (file === 'launchctl' && args[0] === 'bootstrap' && ++starts === 1) { machineA.m.calls.push('launchctl bootstrap (crashes)'); return { stdout: '' }; }
    return exec(file, args, timeout);
  };
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output[2]!, /^runner: failed\. The new Runner didn't start, so the previous bundle was restored and restarted \(pid 4242\)/);
  assert.match(machineA.bundled(), /old/);
});

test('stopped, paused and login-disabled choices, config and state survive a refresh', async () => {
  const machineA = machine({ runner: 'stopped' });
  writeFileSync(join(machineA.stateDir, 'paused'), '');
  writeFileSync(join(machineA.home, '.config/factory-delegator/launches.json'), '{"s":1}');
  const before = readFileSync(machineA.config);
  assert.equal(await machineA.run(), 0);
  assert.match(machineA.m.output[2]!, /^runner: refreshed and left stopped\./);
  assert.deepEqual(machineA.launchctl(), [], 'no bootstrap, enable or disable for either agent');
  assert.equal(machineA.m.pid, null);
  assert.ok(existsSync(join(machineA.stateDir, 'paused')));
  assert.deepEqual(readFileSync(machineA.config), before);
  assert.equal(readFileSync(join(machineA.home, '.config/factory-delegator/launches.json'), 'utf8'), '{"s":1}');
  assert.ok(machineA.m.calls.includes(`/usr/bin/node ${machineA.app}.staged/Contents/Resources/runner/runner.ts --check-config`));
  assert.equal(machineA.m.output.join('\n').includes('secret-value'), false);

  const running = machine();
  writeFileSync(join(running.stateDir, 'paused'), '');
  const runner = runnerOn(running.stateDir);
  await runner.claiming;
  running.m.onSleep = () => acknowledgeDrain(runner.deps);
  assert.equal(await running.run(), 0);
  assert.ok(existsSync(join(running.stateDir, 'paused')), 'a paused Runner restarts paused');
  assert.equal(running.launchctl().some((call) => / (enable|disable) /.test(call)), false);
});

test('a stopped Runner with open watches or a live stray process is not refreshed', async () => {
  const machineA = machine({ runner: 'stopped' });
  writeFileSync(join(machineA.stateDir, 'watching.json'), '{"s":{}}');
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output[2]!, /^runner: refused\. The stopped Runner has open or unreadable watches/);
  assert.match(machineA.bundled(), /old/);

  const machineB = machine({ runner: 'stopped' });
  writeFileSync(join(machineB.stateDir, 'status.json'), JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() }));
  assert.equal(await machineB.run(), 1);
  assert.match(machineB.m.output[2]!, /is running outside launchd/);
});

for (const [label, change, message] of [
  ['a dirty', (m: ReturnType<typeof machine>) => { m.m.git.status = '?? notes.txt'; }, /uncommitted or untracked changes/],
  ['an unmerged', (m: ReturnType<typeof machine>) => { m.m.git.head = 'b'.repeat(40); }, /HEAD bbbbbbb isn't origin's main \(aaaaaaa\)\. Check out main and pull it/],
  ['an untrusted', (m: ReturnType<typeof machine>) => { m.m.git.origin = 'https://github.com/someone/fork.git'; }, /origin isn't mcwestling\/factory/],
] as const) {
  test(`${label} checkout refuses before running anything but read-only git`, async () => {
    const machineA = machine();
    change(machineA);
    assert.equal(await machineA.run(), 1);
    assert.match(machineA.m.output[0]!, message);
    assert.deepEqual(machineA.m.output.slice(1), ['skills: not run.\nrunner: not run.']);
    assert.ok(machineA.m.calls.every((call) => /^git -C \S+ (remote get-url|--no-optional-locks status|rev-parse HEAD|ls-remote)/.test(call)));
  });
}

test('an incompatible config refuses before the Runner is drained or replaced', async () => {
  const machineA = machine();
  machineA.m.fail.add('--check-config');
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output[2]!, /^runner: refused\. The installed config doesn't fit the new Runner \(--check-config broke\)/);
  assert.deepEqual(machineA.launchctl(), []);
  assert.match(machineA.bundled(), /old/);
});

test('an older Runner without drain support refuses with the safe manual procedure', async () => {
  const machineA = machine({ oldRunner: true });
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output[2]!, /predates safe draining[\s\S]*Pause new work[\s\S]*Stop Runner[\s\S]*Rerun this command[\s\S]*Start Runner/);
  assert.deepEqual(machineA.launchctl(), []);
  assert.equal(machineA.m.calls.some((call) => call.startsWith('sh')), false);
});

test('a second upkeep refuses while one is running', async () => {
  const machineA = machine({ runner: 'none' });
  writeFileSync(join(machineA.stateDir, 'upkeep.lock'), String(process.ppid));
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output[0]!, /Another upkeep \(pid \d+\) is running/);
  assert.equal(existsSync(join(machineA.stateDir, 'upkeep.lock')), true, "the other run's lock stays");
});

test('a stopped Runner started during the staged build is not replaced, and the old backup is kept', async () => {
  const machineA = machine({ runner: 'stopped' });
  mkdirSync(`${machineA.app}.previous`);
  writeFileSync(`${machineA.app}.previous/marker`, 'earlier backup');
  const exec = machineA.m.deps.exec;
  machineA.m.deps.exec = async (file, args, timeout) => {
    const result = await exec(file, args, timeout);
    if (args[1] === '--build-app') machineA.m.pid = 5150;
    return result;
  };
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output[2]!, /^runner: refused\. The stopped Runner was started while upkeep was building\. Nothing was replaced/);
  assert.match(machineA.bundled(), /old/);
  assert.equal(readFileSync(`${machineA.app}.previous/marker`, 'utf8'), 'earlier backup');
  assert.equal(machineA.m.pid, 5150, 'the started Runner is left running');
  assert.deepEqual(machineA.launchctl(), []);
});

test('a new Runner that never reports and cannot be stopped leaves both bundles in place', async () => {
  const machineA = machine();
  const runner = runnerOn(machineA.stateDir);
  runner.release();
  await runner.claiming;
  machineA.m.onSleep = () => acknowledgeDrain(runner.deps);
  const exec = machineA.m.deps.exec;
  let bootouts = 0;
  machineA.m.deps.exec = async (file, args, timeout) => {
    if (file === 'launchctl' && args[0] === 'bootstrap') {
      machineA.m.calls.push('launchctl bootstrap (no heartbeat)');
      machineA.m.pid = machineA.m.nextPid++;
      return { stdout: '' };
    }
    if (file === 'launchctl' && args[0] === 'bootout' && ++bootouts > 1) {
      machineA.m.calls.push('launchctl bootout (fails)');
      throw Object.assign(new Error('exit 1'), { stderr: 'Boot-out failed' });
    }
    return exec(file, args, timeout);
  };
  assert.equal(await machineA.run(), 1);
  assert.match(machineA.m.output[2]!, /^runner: failed\. The new Runner didn't confirm it started, and it couldn't be stopped, so both bundles were left in place[\s\S]*launchctl bootout gui\/501\//);
  assert.equal(machineA.bundled(), readFileSync(join(root, 'packages/delegator/runner/runner.ts'), 'utf8'), 'the new bundle stays installed');
  assert.match(readFileSync(`${machineA.app}.previous/Contents/Resources/runner/runner.ts`, 'utf8'), /old/);
  assert.equal(existsSync(`${machineA.app}.failed`), false);
  assert.equal(machineA.m.pid, 4242, 'the service is still running');
  assert.equal(machineA.m.calls.filter((call) => call.startsWith('launchctl bootstrap')).length, 1, 'no restart of the previous bundle');
});
