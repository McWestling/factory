import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleJob, launchArgs, loadConfig, NOT_ALLOWED, poll, type Deps, type RunnerConfig, type Task } from './runner.ts';

const example = new URL('../config.example.json', import.meta.url);
const config: RunnerConfig = {
  inboxUrl: 'https://inbox.example/delegator',
  bearerSecret: 'bearer-example',
  machine: 'Example Mac',
  allowedCreatorIds: ['user-allowed'],
  repos: { 'owner/repo': '/repos/repo' },
  models: {
    'Claude Opus 5.5': { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    'GPT-6 Luna': { agent: 'codex', model: 'gpt-6-luna' },
  },
  skill: 'do-implement',
};
const claim = { issueId: 'issue-1', sessionId: 'session-1', claimId: 'claim-1' };
const description = (model = 'Claude Opus 5.5', repo = 'owner/repo') =>
  `\`[repo=${repo}]\`\n\n\`\`\`factory-run\ntarget: Orca\nmodel: ${model}\nreason: test\n\`\`\`\n`;
const goodTask: Task = {
  delegated: true,
  creatorId: 'user-allowed',
  identifier: 'ABC-123',
  description: description(),
  branchName: 'someone/abc-123-do-the-thing',
  statusType: 'unstarted',
};
const ok = JSON.stringify({ ok: true, result: {} });
const orcaError = (code: string) => Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ ok: false, error: { code } }) });

/** A fake Cloud Inbox and Orca, recording every call. */
function fakes(task: Partial<Task> = goodTask, orca: (string | Error)[] = [ok, ok]) {
  const requests: string[] = [];
  const updates: [string, string][] = [];
  const argv: string[][] = [];
  const deps: Deps = {
    async fetch(input, init) {
      const url = new URL(String(input));
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer bearer-example');
      const path = url.pathname.replace('/delegator', '');
      requests.push(`${init?.method} ${path}`);
      if (path === '/jobs/claim') return Response.json(claim);
      assert.equal(url.searchParams.get('claimId'), 'claim-1');
      if (path.endsWith('/task')) return Response.json(task);
      if (path.endsWith('/updates')) {
        const { type, body } = JSON.parse(String(init?.body));
        updates.push([type, body]);
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 204 });
    },
    async exec(file, args) {
      assert.equal(file, 'orca');
      argv.push(args);
      const next = orca.shift() ?? ok;
      if (next instanceof Error) throw next;
      return { stdout: next };
    },
    log() {},
  };
  return { deps, requests, updates, argv };
}

test('a launch runs orca open, then the exact worktree create argv', async () => {
  const f = fakes();
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
  assert.deepEqual(f.argv, [
    ['open', '--json'],
    ['worktree', 'create', '--name', 'abc-123-do-the-thing', '--repo', 'path:/repos/repo',
      '--branch', 'someone/abc-123-do-the-thing', '--agent', 'claude', '--model', 'claude-opus-5-5',
      '--effort', 'high', '--prompt=/do-implement ABC-123', '--setup', 'run', '--linear-issue', 'ABC-123', '--json'],
  ]);
});

test('a skill other than do-implement skips setup, and a model without effort omits it', () => {
  const args = launchArgs({ ...config, skill: 'do-refine' }, 'owner/repo', 'GPT-6 Luna', goodTask);
  assert.deepEqual(args, ['worktree', 'create', '--name', 'abc-123-do-the-thing', '--repo', 'path:/repos/repo',
    '--branch', 'someone/abc-123-do-the-thing', '--agent', 'codex', '--model', 'gpt-6-luna', '--prompt=/do-refine ABC-123',
    '--setup', 'skip', '--linear-issue', 'ABC-123', '--json']);
});

// Cloud Inbox's `launched` write-back makes the field changes (status unless already
// started/completed/canceled, Orca label, assignee); see its routes tests.
for (const statusType of ['unstarted', 'started', 'completed']) {
  test(`success on a ${statusType} issue posts the started thought, then reports launched, and nothing else`, async () => {
    const f = fakes({ ...goodTask, statusType });
    await poll(config, f.deps);
    assert.deepEqual(f.requests, [
      'POST /jobs/claim',
      'GET /jobs/session-1/task',
      'POST /jobs/session-1/updates',
      'POST /jobs/session-1/launched',
    ]);
    assert.deepEqual(f.updates, [['thought', 'Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing`.']]);
  });
}

const refusals: [string, Partial<Task>, string][] = [
  ['a null creator', { creatorId: null }, NOT_ALLOWED],
  ['a creator not on the allowlist', { creatorId: 'user-other' }, NOT_ALLOWED],
  ['no factory-run block', { description: '`[repo=owner/repo]`' },
    'Refused `factory-run`: expected a factory-run block with one nonempty model field. Fix it and delegate again to retry.'],
  ['a model not in config', { description: description('GPT-6 Astra') },
    'Refused `model`: expected an exact model name in the machine config. Fix it and delegate again to retry.'],
  ['a malformed repo tag', { description: description('Claude Opus 5.5', 'not a repo') },
    'Refused `repo`: expected a [repo=owner/name] tag matching ^[\\w.-]+/[\\w.-]+$. Fix it and delegate again to retry.'],
  ['a repo not on the allowlist', { description: description('Claude Opus 5.5', 'owner/other') },
    'Refused `repo`: expected a repo on the machine allowlist. Fix it and delegate again to retry.'],
  ['a flag-like branch name', { branchName: '--upload-pack=evil' },
    "The issue's Linear branch name isn't a plain git branch name. Fix it and delegate again to retry."],
  ['an unusual issue id', { identifier: '-x' }, "The issue id isn't a plain Linear id like ABC-123. Fix it and delegate again to retry."],
];
for (const [label, change, message] of refusals) {
  test(`${label} posts one error, reports failed, and never launches`, async () => {
    const f = fakes({ ...goodTask, ...change });
    assert.notEqual(await handleJob(config, f.deps, claim), 'launched');
    assert.deepEqual(f.updates, [['error', message]]);
    assert.deepEqual(f.requests.slice(-2), ['POST /jobs/session-1/updates', 'POST /jobs/session-1/failed']);
    assert.deepEqual(f.argv, []);
  });
}

test('an issue no longer delegated is dropped silently', async () => {
  const f = fakes({ ...goodTask, delegated: false });
  assert.equal(await handleJob(config, f.deps, claim), 'undelegated');
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.requests, ['GET /jobs/session-1/task', 'POST /jobs/session-1/failed']);
});

test('Orca still unavailable after one retry gets the Orca-down error', async () => {
  const f = fakes(goodTask, [ok, orcaError('runtime_unavailable'), orcaError('runtime_unavailable')]);
  assert.equal(await handleJob(config, f.deps, claim), 'orca-unavailable');
  assert.equal(f.argv.length, 3);
  assert.deepEqual(f.updates, [['error', "Orca isn't running on Example Mac. Open Orca and delegate again to retry."]]);
  assert.equal(f.requests.at(-1), 'POST /jobs/session-1/failed');
});

test('Orca becoming available on the retry launches', async () => {
  const f = fakes(goodTask, [orcaError('runtime_unavailable'), orcaError('runtime_unavailable'), ok]);
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
  assert.equal(f.argv.length, 3);
});

test('any other Orca failure names its code and is not retried', async () => {
  const f = fakes(goodTask, [ok, orcaError('repo_not_found')]);
  assert.equal(await handleJob(config, f.deps, claim), 'orca-repo_not_found');
  assert.equal(f.argv.length, 2);
  assert.deepEqual(f.updates, [['error', "Orca couldn't start the agent (`repo_not_found`). Fix it and delegate again to retry."]]);
});

test('an unreadable task is refused', async () => {
  const f = fakes();
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => String(input).includes('/task') ? new Response('', { status: 502 }) : fetch(input, init);
  assert.equal(await handleJob(config, f.deps, claim), 'task-unreadable');
  assert.deepEqual(f.requests.slice(-2), ['POST /jobs/session-1/updates', 'POST /jobs/session-1/failed']);
});

test('an empty queue claims nothing more', async () => {
  const f = fakes();
  f.deps.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await poll(config, f.deps), false);
  assert.deepEqual(f.argv, []);
});

const valid = JSON.parse(JSON.stringify({ ...config, skill: undefined }));
function writeConfig(dir: string, value: unknown, mode = 0o600) {
  const path = join(dir, '.config', 'factory-delegator', 'config.json');
  mkdirSync(join(dir, '.config', 'factory-delegator'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
  chmodSync(path, mode);
  return path;
}

test('the config loads, defaults the skill, and the example has every key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  assert.equal(loadConfig(writeConfig(dir, valid)).skill, 'do-implement');
  const exampleKeys = Object.keys(JSON.parse(readFileSync(example, 'utf8'))).sort();
  assert.deepEqual(exampleKeys, [...Object.keys(config)].sort());
});

const badConfigs: [string, unknown][] = [
  ['no allowlist', { ...valid, allowedCreatorIds: undefined }],
  ['an empty allowlist', { ...valid, allowedCreatorIds: [] }],
  ['no repos', { ...valid, repos: {} }],
  ['a relative repo path', { ...valid, repos: { 'owner/repo': 'repo' } }],
  ['no models', { ...valid, models: undefined }],
  ['a flag-like model', { ...valid, models: { X: { agent: 'claude', model: '--danger' } } }],
  ['a bad skill', { ...valid, skill: 'Do Implement' }],
  ['an http inbox', { ...valid, inboxUrl: 'http://inbox.example' }],
  ['no secret', { ...valid, bearerSecret: '' }],
];
for (const [label, value] of badConfigs) {
  test(`config with ${label} is refused`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-'));
    assert.throws(() => loadConfig(writeConfig(dir, value)));
  });
}

const runner = new URL('./runner.ts', import.meta.url).pathname;
const exits: [string, (home: string) => void][] = [
  ['missing', () => {}],
  ['too permissive', (home) => writeConfig(home, valid, 0o644)],
  ['without an allowlist', (home) => writeConfig(home, { ...valid, allowedCreatorIds: undefined })],
];
for (const [label, prepare] of exits) {
  test(`the Runner exits non-zero when the config is ${label}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'runner-home-'));
    prepare(home);
    const result = spawnSync(process.execPath, [runner], { env: { ...process.env, HOME: home }, timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /^factory-runner: /);
  });
}
