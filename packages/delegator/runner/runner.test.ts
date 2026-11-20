import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppAuth } from '../cloud-inbox/auth.ts';
import { JobQueue } from '../cloud-inbox/queue.ts';
import { handleRunner } from '../cloud-inbox/routes.ts';
import { acknowledgeDrain, checkWatches, readWatches, startStatusHeartbeat, handleJob, launchArgs, loadConfig, NOT_ALLOWED, poll, rereadConfig, resumeWatches, watchJobs, type Deps, type RunnerConfig, type Task } from './runner.ts';

const example = new URL('../config.example.json', import.meta.url);
const config: RunnerConfig = {
  inboxUrl: 'https://inbox.example/delegator',
  bearerSecret: 'bearer-example',
  machine: 'Example Mac',
  allowedCreatorIds: ['user-allowed'],
  models: {
    'Claude Opus 5.5': { agent: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    'GPT-6 Luna': { agent: 'codex', model: 'gpt-6-luna' },
  },
  levels: { light: 'GPT-6 Luna', standard: 'Claude Opus 5.5', deep: 'Claude Opus 5.5' },
  skill: 'do-implement',
  refineRepo: 'owner/repo',
};
const claim = { issueId: 'issue-1', sessionId: 'session-1', claimId: 'claim-1' };
const description = (model = 'Claude Opus 5.5', repo = 'owner/repo') =>
  `[repo=${repo}] [level=standard] [model=${model}]`;
const goodTask: Task = {
  delegated: true,
  creatorId: 'user-allowed',
  identifier: 'ABC-123',
  description: description(),
  branchName: 'someone/abc-123-do-the-thing',
  statusType: 'unstarted',
};
const ok = JSON.stringify({ ok: true, result: {} });
const registeredRepo = { id: 'repo-1', kind: 'git', path: '/repos/repo', gitRemoteIdentity: { canonicalKey: 'github.com/owner/repo' } };
const repoList = (repos: unknown[] = [registeredRepo]) => JSON.stringify({ ok: true, result: { repos } });
const orcaError = (code: string) => Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ ok: false, error: { code } }) });

/** A fake Cloud Inbox and Orca, recording every call. */
function fakes(task: Partial<Task> | null = goodTask, orca: (string | Error)[] = [ok, ok]) {
  const requests: string[] = [];
  const updates: [string, string][] = [];
  const snapshots: { paused: boolean; current: { identifier: string } | null }[] = [];
  const argv: string[][] = [];
  const stateDir = mkdtempSync(join(tmpdir(), 'runner-watch-'));
  const deps: Deps = {
    async fetch(input, init) {
      const url = new URL(String(input));
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer bearer-example');
      const path = url.pathname.replace('/delegator', '');
      if (path === '/pool/snapshot') {
        assert.equal(init?.method, 'PUT');
        snapshots.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
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
      if (args[0] === 'repo' && args[1] === 'list') return { stdout: repoList() };
      const next = orca.shift() ?? ok;
      if (next instanceof Error) throw next;
      return { stdout: next };
    },
    log() {},
    launches: join(mkdtempSync(join(tmpdir(), 'runner-state-')), 'launches.json'),
    watches: join(stateDir, 'watching.json'),
    status: join(stateDir, 'status.json'),
    paused: join(stateDir, 'paused'),
  };
  return { deps, requests, updates, snapshots, argv };
}

test('a launched job keeps its claim for completion watching after a restart', async () => {
  const f = fakes();
  await handleJob(config, f.deps, claim);
  const saved = JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1'];
  assert.equal(saved.claimId, claim.claimId);
  assert.equal(saved.issueId, claim.issueId);
  assert.equal(saved.ready, true);
  assert.deepEqual(saved.launch, { repo: 'owner/repo', branch: goodTask.branchName });
});

async function watching() {
  const f = fakes();
  await handleJob(config, f.deps, claim);
  f.requests.length = 0;
  f.updates.length = 0;
  const status = { sessionStatus: 'active', issueState: 'started', pullRequests: [] as string[] };
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/watch') || path.endsWith('/pull-request')) {
      assert.equal(new URL(String(input)).searchParams.get('claimId'), claim.claimId);
      f.requests.push(`${init?.method} ${path.replace('/delegator', '')}`);
      return Response.json(path.endsWith('/watch') ? status : { url: status.pullRequests[0] });
    }
    return fetch(input, init);
  };
  return { ...f, status };
}

test('a PR is linked before the final response, and a restart does not repeat it', async () => {
  const f = await watching();
  f.status.pullRequests = ['https://github.com/owner/repo/pull/7'];
  const restarted = { ...f.deps };
  await watchJobs(config, restarted);
  await watchJobs(config, { ...restarted });
  assert.deepEqual(f.requests, ['GET /jobs/session-1/watch', 'POST /jobs/session-1/pull-request',
    'GET /jobs/session-1/watch', 'POST /jobs/session-1/updates']);
  assert.deepEqual(f.updates, [['response', 'Opened https://github.com/owner/repo/pull/7.']]);
  assert.deepEqual(JSON.parse(readFileSync(f.deps.watches, 'utf8')), {});
});

test('the no-PR timeout starts at launch and replies once at 24 hours', async () => {
  const f = await watching();
  const at = JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1'].at;
  f.deps.now = () => at + 24 * 60 * 60_000 - 1;
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, []);
  f.deps.now = () => at + 24 * 60 * 60_000;
  await watchJobs(config, f.deps);
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, [['response', 'No PR after 24 h; check the Orca worktree.']]);
});

for (const sessionStatus of ['complete', 'error', 'stopped']) {
  test(`a ${sessionStatus} session is dropped without linking or replying`, async () => {
    const f = await watching();
    f.status.sessionStatus = sessionStatus;
    f.status.pullRequests = ['https://github.com/owner/repo/pull/7'];
    await watchJobs(config, f.deps);
    assert.deepEqual(f.requests, ['GET /jobs/session-1/watch']);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(JSON.parse(readFileSync(f.deps.watches, 'utf8')), {});
  });
}

test('a session ending while its PR is linked gets no final response', async () => {
  const f = await watching();
  f.status.pullRequests = ['https://github.com/owner/repo/pull/7'];
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes('/pull-request')) f.status.sessionStatus = 'complete';
    return response;
  };
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, []);
  assert.deepEqual(JSON.parse(readFileSync(f.deps.watches, 'utf8')), {});
});

test('a failed link is retried after restart before posting a final response', async () => {
  const f = await watching();
  f.status.pullRequests = ['https://github.com/owner/repo/pull/7'];
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => String(input).includes('/pull-request')
    ? new Response(null, { status: 502 }) : fetch(input, init);
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, []);
  assert.ok(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1']);
  await watchJobs(config, { ...f.deps, fetch });
  assert.equal(f.updates.length, 1);
});

test('a PR removed between checking and linking keeps the session watched', async () => {
  const f = await watching();
  f.status.pullRequests = ['https://github.com/owner/repo/pull/7'];
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => String(input).includes('/pull-request')
    ? new Response(null, { status: 409 }) : fetch(input, init);
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, []);
  assert.ok(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1']);
});

test('unknown status and malformed PR URLs never produce a final response', async () => {
  const f = await watching();
  f.status.sessionStatus = 'unexpected';
  await watchJobs(config, f.deps);
  f.status.sessionStatus = 'active';
  f.status.pullRequests = ['https://github.com.evil.example/owner/repo/pull/7'];
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, []);
  assert.ok(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1']);
});

test('a failed watch-state write keeps the launch reclaimable instead of forgetting it', async () => {
  const f = fakes();
  mkdirSync(f.deps.watches);
  await handleJob(config, f.deps, claim);
  assert.ok(!f.requests.includes('POST /jobs/session-1/launched'));
  assert.equal(JSON.parse(readFileSync(f.deps.launches, 'utf8'))['session-1'].launched, true);
});

test('a launch runs orca open, then the exact worktree create argv', async () => {
  const f = fakes();
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
  assert.deepEqual(f.argv, [
    ['open', '--json'],
    ['repo', 'list', '--json'],
    ['worktree', 'create', '--name', 'abc-123-do-the-thing', '--repo', 'path:/repos/repo',
      '--branch', 'someone/abc-123-do-the-thing', '--agent', 'claude', '--model', 'claude-opus-5-5',
      '--effort', 'high', '--prompt=/do-implement ABC-123\nDelegated run: nobody is watching this session.', '--setup', 'run', '--linear-issue', 'ABC-123', '--json'],
  ]);
});

test('Codex uses a dollar prefix for do-implement', () => {
  const args = launchArgs(config, '/repos/repo', 'GPT-6 Luna', goodTask);
  assert.ok(args.includes('--prompt=$do-implement ABC-123\nDelegated run: nobody is watching this session.'));
});

test('Luna launches at high effort minimum and preserves higher effort', () => {
  for (const effort of [undefined, 'low', 'medium', 'high', 'xhigh', 'max']) {
    const settings = { ...config.models['GPT-6 Luna']!, effort };
    const args = launchArgs({ ...config, models: { ...config.models, 'GPT-6 Luna': settings } }, '/repos/repo', 'GPT-6 Luna', goodTask);
    assert.equal(args[args.indexOf('--effort') + 1], effort === 'xhigh' || effort === 'max' ? effort : 'high');
  }
});

test('a skill other than do-implement skips setup and Luna still gets high effort', () => {
  const args = launchArgs({ ...config, skill: 'do-refine' }, '/repos/repo', 'GPT-6 Luna', goodTask);
  assert.deepEqual(args, ['worktree', 'create', '--name', 'abc-123-do-the-thing', '--repo', 'path:/repos/repo',
    '--branch', 'someone/abc-123-do-the-thing', '--agent', 'codex', '--model', 'gpt-6-luna', '--effort', 'high', '--prompt=$do-refine ABC-123\nDelegated run: nobody is watching this session.',
    '--setup', 'skip', '--linear-issue', 'ABC-123', '--json']);
});

// Cloud Inbox's `launched` write-back makes the field changes (status unless already
// started/completed/canceled, Orca label, assignee); see "launched keeps the status of
// an issue" in cloud-inbox/routes.test.ts. The Runner's requests don't vary with status.
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
    assert.deepEqual(f.updates, [['thought', '🛠️ Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing`.']]);
  });
}

const refusals: [string, Partial<Task>, string][] = [
  ['a null creator', { creatorId: null }, NOT_ALLOWED],
  ['a creator not on the allowlist', { creatorId: 'user-other' }, NOT_ALLOWED],
  ['no level tag', { description: '`[repo=owner/repo]`' },
    'Refused `level`: expected a [level=…] tag with light, standard or deep. Fix it and delegate again to retry.'],
  ['a malformed repo tag', { description: description('Claude Opus 5.5', 'not a repo') },
    'Refused `repo`: expected a [repo=owner/name] tag matching ^[\\w.-]+/[\\w.-]+$. Fix it and delegate again to retry.'],
  ['a flag-like branch name', { branchName: '--upload-pack=evil' },
    "The issue's Linear branch name isn't a plain git branch name. Fix it and delegate again to retry."],
  ['a branch segment that starts with a dash', { branchName: 'someone/-x' },
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
  assert.equal(f.argv.length, 4);
  assert.deepEqual(f.updates, [['error', "Orca isn't running on Example Mac. Open Orca and delegate again to retry."]]);
  assert.equal(f.requests.at(-1), 'POST /jobs/session-1/failed');
});

test('Orca becoming available on the retry launches', async () => {
  const f = fakes(goodTask, [orcaError('runtime_unavailable'), orcaError('runtime_unavailable'), ok]);
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
  assert.equal(f.argv.length, 4);
});

const orcaFailures: [string | Error, string][] = [
  [orcaError('repo_not_found'), "Orca doesn't know owner/repo's checkout on Example Mac. Check its registration in Orca. Fix it and delegate again to retry."],
  [Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' }), "The Runner can't find the `orca` command on Example Mac. Put Orca's CLI on its PATH. Fix it and delegate again to retry."],
  [orcaError('worktree_conflict'), "Orca couldn't start the agent (`worktree_conflict`). Check Orca on Example Mac. Fix it and delegate again to retry."],
  [JSON.stringify({ ok: false, error: { code: 'Not A Code; rm -rf' } }), "Orca couldn't start the agent (`orca_failed`). Check Orca on Example Mac. Fix it and delegate again to retry."],
];
for (const [failure, message] of orcaFailures) {
  test(`an Orca failure is reported, not retried: ${message.slice(0, 40)}`, async () => {
    const f = fakes(goodTask, [ok, failure]);
    assert.notEqual(await handleJob(config, f.deps, claim), 'launched');
    assert.equal(f.argv.length, 3);
    assert.deepEqual(f.updates, [['error', message]]);
    assert.equal(f.requests.at(-1), 'POST /jobs/session-1/failed');
  });
}

test('an unreadable task is refused', async () => {
  const f = fakes();
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => String(input).includes('/task') ? new Response('', { status: 502 }) : fetch(input, init);
  assert.equal(await handleJob(config, f.deps, claim), 'task-unreadable');
  assert.deepEqual(f.requests.slice(-2), ['POST /jobs/session-1/updates', 'POST /jobs/session-1/failed']);
});

test('a null task is refused as unreadable and never launches', async () => {
  const f = fakes(null);
  assert.equal(await handleJob(config, f.deps, claim), 'task-unreadable');
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0]![0], 'error');
  assert.deepEqual(f.requests.slice(-2), ['POST /jobs/session-1/updates', 'POST /jobs/session-1/failed']);
  assert.deepEqual(f.argv, []);
});

/** The real queue and Runner API behind the Runner's fetch, with Linear faked. */
function realInbox(labels: string[] = []) {
  const db = new DatabaseSync(':memory:');
  const clock = { now: 1_800_000_000_000 };
  const issueEdits: Record<string, unknown>[] = [];
  const thoughts: string[] = [];
  const responses: string[] = [];
  const links: string[] = [];
  let sessionStatus = 'active';
  let pullRequests: string[] = [];
  const linear: typeof fetch = async (input, init) => {
    if (String(input).startsWith('https://api.github.com/')) {
      // As in Workers, whose fetch throws on `redirect: 'error'`.
      if (init?.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
      return Response.json({
        base: { repo: { full_name: 'owner/repo' } }, head: { ref: goodTask.branchName, repo: { full_name: 'owner/repo' } },
      });
    }
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes('agentActivityCreate')) {
      if (variables.input.content.type === 'thought') thoughts.push(variables.input.content.body);
      if (variables.input.content.type === 'response') {
        responses.push(variables.input.content.body);
        sessionStatus = 'complete';
      }
      return Response.json({ data: { agentActivityCreate: { success: true } } });
    }
    if (query.includes('agentSessionUpdate')) {
      links.push(variables.url);
      return Response.json({ data: { agentSessionUpdate: { success: true } } });
    }
    if (query.includes('attachments')) return Response.json({ data: {
      issue: { attachments: { nodes: pullRequests.map((url) => ({ url })) } }, agentSession: { status: sessionStatus },
    } });
    if (query.includes('issueUpdate')) {
      issueEdits.push(variables.input);
      return Response.json({ data: { issueUpdate: { success: true } } });
    }
    return Response.json({ data: {
      issue: {
        identifier: goodTask.identifier, description: goodTask.description, branchName: goodTask.branchName,
        state: { type: 'unstarted' }, delegate: { id: 'app-user' }, team: { id: 'team-1', states: { nodes: [] } },
        labels: { nodes: labels.map((name) => ({ id: `label-${name}`, name })) },
      },
      agentSession: { creator: { id: 'user-allowed' } },
      issueLabels: { nodes: [] },
    } });
  };
  const auth = { installation: async () => ({ appUserId: 'app-user', appName: 'Example' }), getAccessToken: async () => 'token' };
  const queue = new JobQueue({ exec: (query, ...bindings) => {
    const rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows };
  } }, auth as unknown as AppAuth, () => {}, linear, () => clock.now);
  const inboxConfig = { orgId: 'org', adminSecret: 'admin',
    app: { clientId: 'client', clientSecret: 'secret', webhookSecret: 'webhook' },
    machines: { 'example-machine': config.bearerSecret, 'other-machine': 'bearer-other' } };
  const ops: string[] = [];
  let loseLaunched = 0;
  let loseThought = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    url.pathname = url.pathname.replace('/delegator', '');
    ops.push(url.pathname.split('/').pop()!);
    if (url.pathname.endsWith('/updates') && loseThought-- > 0) throw new TypeError('fetch failed');
    // Lost before it reaches Cloud Inbox.
    if (url.pathname.endsWith('/launched') && loseLaunched-- > 0) throw new TypeError('fetch failed');
    return handleRunner(new Request(url, init), inboxConfig, queue);
  };
  const state = () => db.prepare('SELECT state FROM jobs').all().map((row) => row.state);
  return { queue, clock, issueEdits, thoughts, responses, links, ops, fetch, state,
    prs: (urls: string[]) => { pullRequests = urls; }, lose: (n: number) => { loseLaunched = n; },
    loseThought: () => { loseThought = 1; } };
}

const refineTask: Partial<Task> = { ...goodTask, description: 'Decide which way to go.', labels: ['Factory', 'wayfinder:grilling'] };
const refineConfig: RunnerConfig = { ...config, levels: { ...config.levels, deep: 'GPT-6 Luna' } };
const attended = 'Attended run: a person will join this session in Orca. Ask every question with your question tool (AskUserQuestion) and wait for the answer.';
const refining = '🗺️ Refining in Orca on Example Mac; continue there.';

const created = (path: string) => JSON.stringify({ ok: true, result: { worktree: { path } } });
const renamed = (path: string, name: string) => ['worktree', 'set', '--worktree', `path:${path}`, '--display-name', name, '--json'];

for (const [stage, task, cfg, name] of [
  ['an implement', goodTask, config, '🛠️ abc-123-do-the-thing'],
  ['a refine', refineTask, refineConfig, '🗺️ abc-123-do-the-thing'],
] as const) {
  test(`${stage} launch names its new workspace with the stage emoji, keeping --name plain`, async () => {
    const f = fakes(task, [ok, created('/worktrees/abc-123')]);
    assert.equal(await handleJob(cfg, f.deps, claim), 'launched');
    const create = f.argv.find((args) => args[1] === 'create')!;
    assert.equal(create[create.indexOf('--name') + 1], 'abc-123-do-the-thing');
    assert.deepEqual(f.argv.at(-1), renamed('/worktrees/abc-123', name));
  });
}

test('a failed rename is logged but leaves the outcome, lastError and messages alone', async () => {
  const outcomes: unknown[] = [];
  const f = fakes(goodTask, [ok, created('/worktrees/abc-123'), orcaError('worktree_not_found')]);
  f.deps.log = (fields) => outcomes.push(fields.outcome);
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
  assert.deepEqual(f.argv.filter((args) => args[1] === 'set').length, 1);
  assert.ok(outcomes.includes('rename-failed'));
  assert.equal(JSON.parse(readFileSync(f.deps.status, 'utf8')).lastError, null);
  assert.deepEqual(f.updates, [['thought', '🛠️ Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing`.']]);
});

test('a rename gets a short timeout, so a hung Orca holds the job for 30 seconds at most', async () => {
  const f = fakes(goodTask, [ok, created('/worktrees/abc-123')]);
  const timeouts: number[] = [];
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, timeout) => { if (args[1] === 'set') timeouts.push(timeout); return exec(file, args, timeout); };
  await handleJob(config, f.deps, claim);
  assert.deepEqual(timeouts, [30_000]);
});

test('a create reply without the worktree renames it by the launch\'s worktree id instead', async () => {
  const reply = JSON.stringify({ ok: true, result: { lineage: null, launch: { worktreeId: 'repo-1::/worktrees/abc-123' } } });
  const f = fakes(goodTask, [ok, reply]);
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
  assert.deepEqual(f.argv.at(-1), ['worktree', 'set', '--worktree', 'id:repo-1::/worktrees/abc-123',
    '--display-name', '🛠️ abc-123-do-the-thing', '--json']);
});

test('a create reply naming no worktree runs no rename and logs it as failed', async () => {
  const outcomes: unknown[] = [];
  const f = fakes(goodTask, [ok, ok]);
  f.deps.log = (fields) => outcomes.push(fields.outcome);
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
  assert.ok(!f.argv.some((args) => args[1] === 'set'));
  assert.ok(outcomes.includes('rename-failed'));
  assert.equal(JSON.parse(readFileSync(f.deps.status, 'utf8')).lastError, null);
});

test('a wayfinder issue without tags launches do-refine in refineRepo with the deep model, attended, without setup', async () => {
  const f = fakes(refineTask);
  assert.equal(await handleJob(refineConfig, f.deps, claim), 'launched');
  assert.deepEqual(f.argv.at(-1), ['worktree', 'create', '--name', 'abc-123-do-the-thing', '--repo', 'path:/repos/repo',
    '--branch', 'someone/abc-123-do-the-thing', '--agent', 'codex', '--model', 'gpt-6-luna', '--effort', 'high',
    `--prompt=$do-refine ABC-123\n${attended}`, '--setup', 'skip', '--linear-issue', 'ABC-123', '--json']);
});

test('a refine launch still honours a model pin', async () => {
  const f = fakes({ ...refineTask, description: '[model=Claude Opus 5.5]' });
  await handleJob(refineConfig, f.deps, claim);
  const args = f.argv.at(-1)!;
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.ok(args.includes(`--prompt=/do-refine ABC-123\n${attended}`));
});

test('a refine launch without refineRepo set is refused, naming the key', async () => {
  const f = fakes(refineTask);
  assert.equal(await handleJob({ ...refineConfig, refineRepo: undefined }, f.deps, claim), 'refused-refineRepo');
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0]![0], 'error');
  assert.match(f.updates[0]![1], /`refineRepo`/);
  assert.deepEqual(f.requests.slice(-2), ['POST /jobs/session-1/updates', 'POST /jobs/session-1/failed']);
  assert.deepEqual(f.argv, []);
});

test('a refine launch posts its response after reporting launched, and is never watched', async () => {
  const f = fakes(refineTask);
  await poll(refineConfig, f.deps);
  assert.deepEqual(f.requests, ['POST /jobs/claim', 'GET /jobs/session-1/task', 'POST /jobs/session-1/updates',
    'POST /jobs/session-1/launched', 'POST /jobs/session-1/updates']);
  assert.deepEqual(f.updates, [['thought', '🗺️ Started GPT-6 Luna in Orca on `someone/abc-123-do-the-thing`.'], ['response', refining]]);
  assert.deepEqual(readWatches(f.deps), {});
  assert.equal(readFileSync(f.deps.launches, 'utf8'), '{}');
});

for (const afterDelivery of [false, true]) {
  test(`a refine launch whose report was lost ${afterDelivery ? 'after' : 'before'} delivery responds once and is never watched`, async () => {
    const inbox = realInbox(['wayfinder:grilling']);
    await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
    const f = fakes();
    let lost = false;
    f.deps.fetch = async (input, init) => {
      if (!lost && String(input).includes('/launched')) {
        lost = true;
        if (afterDelivery) await inbox.fetch(input, init);
        throw new TypeError('lost launch report');
      }
      return inbox.fetch(input, init);
    };
    await poll(refineConfig, f.deps);
    inbox.clock.now += 10 * 60_000;
    await poll(refineConfig, f.deps);
    await checkWatches(refineConfig, f.deps);
    await inbox.queue.deliver();
    await checkWatches(refineConfig, f.deps);
    assert.deepEqual(inbox.responses, [refining]);
    assert.deepEqual(inbox.state(), ['launched']);
    assert.equal(f.argv.filter((args) => args[0] === 'worktree').length, 1);
    assert.deepEqual(readWatches(f.deps), {});
    assert.equal(readFileSync(f.deps.launches, 'utf8'), '{}');
  });
}

for (const accepted of [false, true]) {
  test(`a refine response lost ${accepted ? 'after Cloud Inbox accepts it' : 'before Cloud Inbox accepts it'} is posted once after a restart`, async () => {
    const inbox = realInbox(['wayfinder:grilling']);
    await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
    const first = fakes();
    let lost = false;
    first.deps.fetch = async (input, init) => {
      if (!lost && String(input).includes('/updates') && JSON.parse(String(init?.body)).type === 'response') {
        lost = true;
        if (accepted) await inbox.fetch(input, init);
        throw new TypeError('lost response');
      }
      return inbox.fetch(input, init);
    };
    await poll(refineConfig, first.deps);
    assert.ok(lost);
    assert.deepEqual(inbox.state(), ['launched']);
    await inbox.queue.deliver();

    // A new process with the same launches, watches and status files.
    const second = fakes();
    const restarted: Deps = { ...first.deps, exec: second.deps.exec, fetch: inbox.fetch };
    await checkWatches(refineConfig, restarted);
    await inbox.queue.deliver();
    inbox.clock.now += 10 * 60_000;
    assert.equal(await poll(refineConfig, restarted), false);
    await checkWatches(refineConfig, restarted);
    await inbox.queue.deliver();

    assert.deepEqual(inbox.responses, [refining]);
    assert.equal([...first.argv, ...second.argv].filter((args) => args[0] === 'worktree').length, 1);
    assert.deepEqual(readWatches(restarted), {});
  });
}

test('a final response accepted before a lost acknowledgement is not queued twice', async () => {
  const inbox = realInbox();
  await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
  const f = fakes();
  f.deps.fetch = inbox.fetch;
  await poll(config, f.deps);
  inbox.prs(['https://github.com/owner/repo/pull/7']);
  f.deps.fetch = async (input, init) => {
    const response = await inbox.fetch(input, init);
    if (String(input).includes('/updates')) throw new TypeError('lost acknowledgement');
    return response;
  };
  await watchJobs(config, f.deps);
  assert.ok(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1']);
  await watchJobs(config, { ...f.deps, fetch: inbox.fetch });
  await inbox.queue.deliver();
  await watchJobs(config, { ...f.deps, fetch: inbox.fetch });
  assert.deepEqual(inbox.responses, ['Opened https://github.com/owner/repo/pull/7.']);
  assert.equal(inbox.links[0], 'https://github.com/owner/repo/pull/7');
  assert.deepEqual(JSON.parse(readFileSync(f.deps.watches, 'utf8')), {});
});

test('an upgraded Runner retains a legacy watch without evidence and never posts a contextual PR', async () => {
  const inbox = realInbox();
  await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
  const old = await inbox.queue.claim('example-machine');
  await inbox.queue.finish('example-machine', old!.sessionId, old!.claimId, 'launched');
  inbox.prs(['https://github.com/owner/repo/pull/7']);
  const f = fakes();
  f.deps.fetch = inbox.fetch;
  await resumeWatches(config, f.deps);
  await watchJobs(config, f.deps);
  await inbox.queue.deliver();
  await resumeWatches(config, f.deps);
  await watchJobs(config, f.deps);
  await inbox.queue.deliver();
  assert.deepEqual(inbox.responses, []);
  assert.ok(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1']);
  assert.deepEqual(f.argv, []);
});

for (const afterDelivery of [false, true]) {
  test(`completion watching resumes after a launch report lost ${afterDelivery ? 'after' : 'before'} delivery`, async () => {
    const inbox = realInbox();
    await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
    const f = fakes();
    let lost = false;
    f.deps.fetch = async (input, init) => {
      if (!lost && String(input).includes('/launched')) {
        lost = true;
        if (afterDelivery) await inbox.fetch(input, init);
        throw new TypeError('lost launch report');
      }
      return inbox.fetch(input, init);
    };
    await poll(config, f.deps);
    assert.equal(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1'].ready, false);
    const restarted = { ...f.deps, fetch: inbox.fetch };
    await watchJobs(config, restarted);
    assert.deepEqual(inbox.state(), ['launched']);
    assert.equal(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1'].ready, true);
    inbox.prs(['https://github.com/owner/repo/pull/7']);
    await watchJobs(config, restarted);
    await inbox.queue.deliver();
    assert.deepEqual(inbox.responses, ['Opened https://github.com/owner/repo/pull/7.']);
    assert.equal(f.argv.filter((args) => args[1] === 'create').length, 1);
  });
}

for (const restart of [false, true]) {
  test(`a lost launch report is recovered on reclaim${restart ? ' after a Runner restart' : ''}, launching once`, async () => {
    const inbox = realInbox();
    await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
    let f = fakes();
    f.deps.fetch = inbox.fetch;
    inbox.lose(1);
    assert.equal(await poll(config, f.deps), true);
    assert.deepEqual(inbox.state(), ['claimed']);
    const argv = f.argv;
    if (restart) {
      // A new process: nothing carries over but the launches file.
      const launches = f.deps.launches;
      f = fakes();
      f.deps = { ...f.deps, fetch: inbox.fetch, launches };
    }
    inbox.clock.now += 10 * 60_000;
    assert.equal(await poll(config, f.deps), true);
    await inbox.queue.deliver();
    const runs = restart ? [...argv, ...f.argv] : argv;
    assert.equal(runs.filter((args) => args[0] === 'worktree').length, 1);
    assert.deepEqual(inbox.state(), ['launched']);
    assert.ok(!inbox.ops.includes('failed'));
    assert.ok(inbox.issueEdits.length > 0 && inbox.issueEdits.every((edit) => !('delegateId' in edit)));
    assert.equal(readFileSync(f.deps.launches, 'utf8'), '{}');
    assert.deepEqual(inbox.thoughts, ['🛠️ Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing`.']);
  });
}

test("another machine can't relaunch a job whose launch report was lost; the original machine recovers it", async () => {
  const inbox = realInbox();
  await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
  const a = fakes();
  a.deps.fetch = inbox.fetch;
  inbox.lose(1);
  assert.equal(await poll(config, a.deps), true);
  assert.deepEqual(inbox.state(), ['claimed']);

  // A's lease runs out while it's away. B has no access to A's launches.json.
  inbox.clock.now += 10 * 60_000;
  const b = fakes();
  b.deps.fetch = inbox.fetch;
  const other = { ...config, bearerSecret: 'bearer-other', machine: 'Other Mac' };
  assert.equal(await poll(other, b.deps), false);
  assert.deepEqual(b.argv, []);
  assert.deepEqual(inbox.state(), ['queued']);

  // A comes back: the watch loop runs first, as at startup, then A reclaims and recovers.
  await checkWatches(config, a.deps);
  assert.equal(await poll(config, a.deps), true);
  await inbox.queue.deliver();
  assert.deepEqual(inbox.state(), ['launched']);
  assert.equal(a.argv.filter((args) => args[0] === 'worktree').length, 1);
  assert.equal(readFileSync(a.deps.launches, 'utf8'), '{}');
  assert.equal(JSON.parse(readFileSync(a.deps.watches, 'utf8'))['session-1'].ready, true);
  assert.deepEqual(inbox.thoughts, ['🛠️ Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing`.']);
  assert.equal(await poll(other, b.deps), false);
  assert.deepEqual(b.argv, []);
});

// The fields below mirror the read-only Orca CLI JSON, with no live launches.
const repoInfo = JSON.stringify({ ok: true, result: { repo: { id: 'repo-1', path: '/repos/repo' } } });
const listed = (rows: unknown[]) => JSON.stringify({ ok: true, result: { worktrees: rows, truncated: false } });
const matchingWorktree = { repoId: 'repo-1', hostId: 'local', branch: `refs/heads/${goodTask.branchName}` };

for (const [label, listing, recovers, repoOutput = repoInfo] of [
  ['exact repo and branch', listed([matchingWorktree]), true],
  ['no worktree', listed([]), false],
  ['a different repo', listed([{ ...matchingWorktree, repoId: 'other' }]), false],
  ['a different branch', listed([{ ...matchingWorktree, branch: 'refs/heads/other' }]), false],
  ['a remote worktree', listed([{ ...matchingWorktree, hostId: 'remote' }]), false],
  ['malformed output', 'null', false],
  ['a different checkout path', listed([matchingWorktree]), false, JSON.stringify({ ok: true, result: { repo: { id: 'repo-1', path: '/repos/other' } } })],
  ['malformed repo output', listed([matchingWorktree]), false, 'null'],
  ['a malformed row', listed([null, { branch: 'refs/heads/other' }]), false],
] as const) {
  test(`a create whose outcome write was skipped recovers only with ${label}`, async (t) => {
    const inbox = realInbox();
    await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
    const f = fakes();
    f.deps.fetch = inbox.fetch;
    inbox.loseThought();
    let created = false;
    const rename = fs.renameSync;
    // Simulate death after create: only the pre-create file survives the first poll.
    const mocked = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
      if (!created) rename(...args);
    });
    syncBuiltinESMExports();
    f.deps.exec = async (_file, args) => {
      f.argv.push(args);
      if (args[0] === 'repo' && args[1] === 'list') return { stdout: repoList() };
      if (args[0] === 'worktree' && args[1] === 'create') created = true;
      return { stdout: ok };
    };
    try {
      await poll(config, f.deps);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(JSON.parse(readFileSync(f.deps.launches, 'utf8'))['session-1']?.launched, false);
    const restarted = fakes();
    restarted.deps = { ...restarted.deps, fetch: inbox.fetch, launches: f.deps.launches };
    restarted.deps.exec = async (_file, args) => {
      restarted.argv.push(args);
      if (args[0] === 'repo' && args[1] === 'list') return { stdout: repoList() };
      if (args[0] === 'repo') return { stdout: repoOutput };
      if (args[0] === 'worktree' && args[1] === 'list') return { stdout: listing };
      if (args[0] === 'worktree' && args[1] === 'create') throw orcaError('worktree_conflict');
      return { stdout: ok };
    };
    inbox.clock.now += 10 * 60_000;
    await poll(config, restarted.deps);
    await inbox.queue.deliver();
    const creates = [...f.argv, ...restarted.argv].filter((args) => args[0] === 'worktree' && args[1] === 'create');
    assert.equal(creates.length, recovers ? 1 : 2);
    assert.deepEqual(inbox.state(), [recovers ? 'launched' : 'failed']);
    assert.equal(inbox.ops.includes('failed'), !recovers);
    assert.equal(inbox.issueEdits.some((edit) => 'delegateId' in edit), !recovers);
    if (recovers) {
      assert.deepEqual(restarted.argv, [
        ['open', '--json'],
        ['repo', 'list', '--json'],
        ['repo', 'show', '--repo', 'path:/repos/repo', '--json'],
        ['worktree', 'list', '--repo', 'path:/repos/repo', '--limit', '10000', '--json'],
      ]);
    }
  });
}

test('recovery posts a lost thought once and remembers it across another reclaim', async () => {
  const inbox = realInbox();
  await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
  const f = fakes();
  f.deps.fetch = inbox.fetch;
  inbox.lose(1);
  inbox.loseThought();
  await poll(config, f.deps);
  assert.equal(inbox.thoughts.length, 0);
  for (let i = 0; i < 2; i++) {
    const restarted = fakes();
    restarted.deps = { ...restarted.deps, fetch: inbox.fetch, launches: f.deps.launches };
    inbox.clock.now += 10 * 60_000;
    await poll(config, restarted.deps);
    await inbox.queue.deliver();
    assert.deepEqual(restarted.argv, []);
  }
  assert.deepEqual(inbox.thoughts, ['🛠️ Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing`.']);
  assert.deepEqual(inbox.state(), ['launched']);
});

for (const contents of ['{broken', 'null', '{"session-1":42}', '{"session-1":{"at":42}}']) {
  test(`a corrupt launch file logs once per read without throwing: ${contents}`, async () => {
    const f = fakes(null);
    const logs: Record<string, string>[] = [];
    f.deps.log = (fields) => { logs.push(fields); };
    writeFileSync(f.deps.launches, contents);
    await assert.doesNotReject(() => poll(config, f.deps));
    assert.deepEqual(logs.filter((fields) => fields.outcome === 'launches-unreadable'), [
      { event: 'launches', outcome: 'launches-unreadable' },
    ]);
  });
}

test('an unreadable launch file logs without throwing', async () => {
  const f = fakes(null);
  const logs: Record<string, string>[] = [];
  f.deps.log = (fields) => { logs.push(fields); };
  mkdirSync(f.deps.launches);
  await assert.doesNotReject(() => poll(config, f.deps));
  assert.deepEqual(logs.filter((fields) => fields.outcome === 'launches-unreadable'), [
    { event: 'launches', outcome: 'launches-unreadable' },
  ]);
});

test('a failed intent write refuses before a worktree can be created', async () => {
  const f = fakes();
  f.deps.launches = join(f.deps.launches, 'missing', 'launches.json');
  assert.equal(await handleJob(config, f.deps, claim), 'launch-record-failed');
  assert.deepEqual(f.argv, [['open', '--json'], ['repo', 'list', '--json']]);
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

test('the example loads once its placeholders are filled, with one model at two efforts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  const filled = JSON.parse(readFileSync(example, 'utf8').replace(/<[^>]*>/g, 'x'));
  const { models, levels } = loadConfig(writeConfig(dir, filled));
  const [deep, standard] = [models[levels.deep]!, models[levels.standard]!];
  assert.notEqual(levels.deep, levels.standard);
  assert.deepEqual([deep.agent, deep.model], [standard.agent, standard.model]);
  assert.notEqual(deep.effort, standard.effort);
});

const badConfigs: [string, unknown][] = [
  ['no allowlist', { ...valid, allowedCreatorIds: undefined }],
  ['an empty allowlist', { ...valid, allowedCreatorIds: [] }],
  ['no models', { ...valid, models: undefined }],
  ['a flag-like model', { ...valid, models: { X: { agent: 'claude', model: '--danger' } } }],
  ['a bad skill', { ...valid, skill: 'Do Implement' }],
  ['a bad refineRepo', { ...valid, refineRepo: 'not a repo' }],
  ['an http inbox', { ...valid, inboxUrl: 'http://inbox.example' }],
  ['an inbox URL with a query', { ...valid, inboxUrl: 'https://inbox.example/delegator?x=1' }],
  ['no secret', { ...valid, bearerSecret: '' }],
];
for (const [label, value] of badConfigs) {
  test(`config with ${label} is refused`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-'));
    assert.throws(() => loadConfig(writeConfig(dir, value)));
  });
}

test("a config edit changes the next launch's level model without a restart", async () => {
  const path = writeConfig(mkdtempSync(join(tmpdir(), 'runner-')), config);
  const f = fakes({ ...goodTask, description: '[repo=owner/repo] [level=standard]' });
  writeConfig(dirname(dirname(dirname(path))), { ...config, levels: { ...config.levels, standard: 'GPT-6 Luna' } });
  assert.equal(await handleJob(rereadConfig(config, f.deps, path), f.deps, claim), 'launched');
  assert.ok(f.argv[2]!.includes('gpt-6-luna'));
});

test('an invalid config on reread keeps the last good one and logs once per change, without its value', () => {
  const path = writeConfig(mkdtempSync(join(tmpdir(), 'runner-')), config);
  const logs: Record<string, string>[] = [];
  const f = fakes();
  f.deps.log = (fields) => logs.push(fields);
  const home = dirname(dirname(dirname(path)));
  writeConfig(home, { ...config, bearerSecret: '' });
  assert.equal(rereadConfig(config, f.deps, path), config);
  assert.equal(rereadConfig(config, f.deps, path), config);
  assert.deepEqual(logs, [{ event: 'config', outcome: 'invalid' }]);
  writeConfig(home, { ...config, levels: { ...config.levels, light: 'nope' } });
  rereadConfig(config, f.deps, path);
  assert.equal(logs.length, 2);
  writeConfig(home, config);
  assert.deepEqual(rereadConfig(config, f.deps, path), config);
  writeConfig(home, { ...config, bearerSecret: '' });
  rereadConfig(config, f.deps, path);
  assert.equal(logs.length, 3);
});

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

test('an idle poll publishes the private menu bar status contract', async () => {
  const f = fakes();
  f.deps.now = () => 1_800_000_000_000;
  f.deps.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await poll(config, f.deps), false);
  assert.deepEqual(JSON.parse(readFileSync(f.deps.status, 'utf8')), {
    version: 1, updatedAt: '2027-01-15T08:00:00.000Z', pid: process.pid,
    inbox: { status: 'ok', lastOkAt: '2027-01-15T08:00:00.000Z' },
    paused: false, current: null, watching: [], lastError: null, recent: [],
  });
  assert.equal(fs.statSync(f.deps.status).mode & 0o777, 0o600);
});

test('status shows the current launch, then its outcome and open watch without private task data', async () => {
  const f = fakes();
  f.deps.now = () => 1_800_000_000_000;
  const exec = f.deps.exec;
  f.deps.exec = async (...args) => {
    const status = JSON.parse(readFileSync(f.deps.status, 'utf8'));
    assert.deepEqual(status.current, { identifier: 'ABC-123', sessionId: 'session-1' });
    return exec(...args);
  };
  await poll(config, f.deps);
  const text = readFileSync(f.deps.status, 'utf8');
  const status = JSON.parse(text);
  assert.equal(status.current, null);
  assert.deepEqual(status.watching, [{ identifier: 'ABC-123', since: '2027-01-15T08:00:00.000Z' }]);
  assert.deepEqual(status.recent, [{ identifier: 'ABC-123', outcome: 'launched', time: '2027-01-15T08:00:00.000Z' }]);
  assert.equal(status.lastError, null);
  for (const secret of [config.bearerSecret, config.inboxUrl, goodTask.description, goodTask.branchName, claim.claimId]) {
    assert.ok(!text.includes(secret));
  }
});

test('failed jobs retain the last error and only the ten latest outcomes', async () => {
  const f = fakes(goodTask, [ok, orcaError('worktree_conflict')]);
  f.deps.now = () => 1_800_000_000_000;
  await poll(config, f.deps);
  const failure = { identifier: 'ABC-123', outcome: 'orca-worktree_conflict', time: '2027-01-15T08:00:00.000Z' };
  assert.deepEqual(JSON.parse(readFileSync(f.deps.status, 'utf8')).lastError, failure);
  for (let i = 0; i < 11; i++) await poll(config, f.deps);
  const status = JSON.parse(readFileSync(f.deps.status, 'utf8'));
  assert.equal(status.current, null);
  assert.equal(status.recent.length, 10);
  assert.ok(status.recent.every((entry: { outcome: string }) => entry.outcome === 'launched'));
  assert.deepEqual(status.lastError, failure);
});

test('pause prevents claims while recovery and PR watching continue, and removal resumes pickup', async () => {
  const f = await watching();
  writeFileSync(f.deps.paused, '');
  f.status.pullRequests = ['https://github.com/owner/repo/pull/7'];
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => String(input).endsWith('/jobs/watching')
    ? Response.json([]) : fetch(input, init);
  assert.equal(await poll(config, f.deps), false);
  assert.deepEqual(f.requests, []);
  await resumeWatches(config, f.deps);
  await watchJobs(config, f.deps);
  const status = JSON.parse(readFileSync(f.deps.status, 'utf8'));
  assert.equal(status.paused, true);
  assert.equal(status.inbox.status, 'ok');
  assert.deepEqual(status.watching, []);
  assert.equal(f.updates[0]?.[0], 'response');
  fs.unlinkSync(f.deps.paused);
  assert.equal(await poll(config, f.deps), true);
  assert.equal(JSON.parse(readFileSync(f.deps.status, 'utf8')).paused, false);
});

test('each poll reports the status snapshot to Cloud Inbox, even while paused', async () => {
  const f = fakes();
  writeFileSync(f.deps.paused, '');
  assert.equal(await poll(config, f.deps), false);
  assert.deepEqual(f.requests, []);
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.snapshots[0]!.paused, true);
  assert.deepEqual(f.snapshots[0], JSON.parse(readFileSync(f.deps.status, 'utf8')));
});

test('a job reports its issue as current once the task is read, and a failed report never stops it', async () => {
  const f = fakes();
  await poll(config, f.deps);
  assert.deepEqual(f.snapshots.map((snapshot) => snapshot.current?.identifier ?? null), [null, 'ABC-123']);

  const g = fakes();
  const fetch = g.deps.fetch;
  const logged: string[] = [];
  g.deps.log = (fields) => { logged.push(`${fields.event} ${fields.outcome}`); };
  g.deps.fetch = async (input, init) => String(input).endsWith('/pool/snapshot')
    ? new Response(null, { status: 404 }) : fetch(input, init);
  assert.equal(await poll(config, g.deps), true);
  assert.ok(logged.includes('report cloud-inbox-404'));
  assert.deepEqual(JSON.parse(readFileSync(g.deps.status, 'utf8')).recent.map((entry: { outcome: string }) => entry.outcome), ['launched']);
});

test('reports go out one at a time, so a slow older report never lands after a newer one', async () => {
  const f = fakes();
  const fetch = f.deps.fetch;
  const arrived: { paused: boolean; current: { identifier: string } | null }[] = [];
  let inFlight = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  f.deps.fetch = async (input, init) => {
    if (!String(input).endsWith('/pool/snapshot')) return fetch(input, init);
    assert.equal(++inFlight, 1, 'one report at a time');
    if (!arrived.length) await held; // The first, idle report is slow to reach Cloud Inbox.
    arrived.push(JSON.parse(String(init?.body)));
    inFlight--;
    return new Response(null, { status: 204 });
  };
  assert.equal(await poll(config, f.deps), true, 'a slow report never holds up the job');
  writeFileSync(f.deps.paused, '');
  assert.equal(await poll(config, f.deps), false);
  release();
  for (let i = 0; i < 50 && arrived.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  // The job's report was superseded while it waited, so only the newest state follows the slow one.
  assert.deepEqual(arrived.map((snapshot) => [snapshot.paused, snapshot.current?.identifier ?? null]),
    [[false, null], [true, null]]);
  assert.deepEqual(arrived[1], JSON.parse(readFileSync(f.deps.status, 'utf8')));
});

test('a status write failure logs once without stopping polls and later writes recover', async () => {
  const f = fakes();
  const logs: Record<string, string>[] = [];
  f.deps.log = (entry) => logs.push(entry);
  mkdirSync(f.deps.status);
  await poll(config, f.deps);
  await poll(config, f.deps);
  assert.equal(logs.filter((entry) => entry.outcome === 'status-write-failed').length, 1);
  fs.rmdirSync(f.deps.status);
  await poll(config, f.deps);
  assert.equal(JSON.parse(readFileSync(f.deps.status, 'utf8')).recent.length, 3);
});

test('claim failures preserve last contact time without copying error text into status', async () => {
  const f = fakes();
  f.deps.now = () => 1_800_000_000_000;
  f.deps.fetch = async () => new Response(null, { status: 204 });
  await poll(config, f.deps);
  f.deps.now = () => 1_800_000_001_000;
  f.deps.fetch = async () => { throw new Error(config.inboxUrl + config.bearerSecret); };
  await assert.rejects(() => poll(config, f.deps));
  const status = JSON.parse(readFileSync(f.deps.status, 'utf8'));
  assert.deepEqual(status.inbox, { status: 'unreachable', lastOkAt: '2027-01-15T08:00:00.000Z' });
  assert.deepEqual(status.lastError, { identifier: null, outcome: 'unreachable', time: '2027-01-15T08:00:01.000Z' });
});

test('a stale status temporary file cannot weaken permissions or leak through a symlink', async () => {
  const f = fakes();
  const other = join(dirname(f.deps.status), 'other');
  writeFileSync(other, 'untouched');
  fs.symlinkSync(other, `${f.deps.status}.tmp`);
  await poll(config, f.deps);
  assert.equal(readFileSync(other, 'utf8'), 'untouched');
  assert.equal(fs.statSync(f.deps.status).mode & 0o777, 0o600);
});

test('heartbeat keeps a pending launch fresh and stops refreshing when cleared', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_800_000_000_000 });
  const f = fakes();
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const launching = new Promise<void>((resolve) => { started = resolve; });
  const exec = f.deps.exec;
  f.deps.exec = async (...args) => {
    if (args[1][0] !== 'open') {
      started();
      await pending;
    }
    return exec(...args);
  };
  const heartbeat = startStatusHeartbeat(f.deps);
  t.after(() => clearInterval(heartbeat));
  const job = handleJob(config, f.deps, claim);
  await launching;
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(10_000);
    const snapshot = JSON.parse(readFileSync(f.deps.status, 'utf8'));
    assert.ok(Date.now() - Date.parse(snapshot.updatedAt) < 30_000);
    assert.deepEqual(snapshot.current, { identifier: 'ABC-123', sessionId: 'session-1' });
  }
  release();
  await job;
  clearInterval(heartbeat);
  t.mock.timers.tick(31_000);
  assert.ok(Date.now() - Date.parse(JSON.parse(readFileSync(f.deps.status, 'utf8')).updatedAt) > 30_000);
});

for (const [pin, model, id] of [
  ['luna', 'GPT-6 Luna', 'gpt-6-luna'],
  ['unknown', 'Claude Opus 5.5', 'claude-opus-5-5'],
  ['gpt6', 'Claude Opus 5.5', 'claude-opus-5-5'],
]) {
  test(`pin ${pin} launches ${model} and reports the actual model`, async () => {
    const f = fakes({ ...goodTask, description: description(pin) });
    if (pin !== 'luna') {
      const exec = f.deps.exec;
      f.deps.exec = async (...args) => {
        assert.deepEqual(f.updates[0], ['thought',
          `Couldn't match model pin \`${pin}\`; using level \`standard\` with ${model}.`]);
        return exec(...args);
      };
    }
    const models = { ...config.models, 'GPT-6 Astra': { agent: 'codex', model: 'gpt-6-astra' } };
    assert.equal(await handleJob({ ...config, models }, f.deps, claim), 'launched');
    assert.equal(f.argv[2]![f.argv[2]!.indexOf('--model') + 1], id);
    assert.equal(f.updates.at(-1)?.[1], `🛠️ Started ${model} in Orca on \`someone/abc-123-do-the-thing\`.`);
    assert.equal(f.updates.length, pin === 'luna' ? 1 : 2);
  });
}

for (const pin of ['', ' [model=]']) {
  test(`missing or empty pin ${JSON.stringify(pin)} uses the level without a fallback thought`, async () => {
    const f = fakes({ ...goodTask, description: `[repo=owner/repo] [level=light]${pin}` });
    assert.equal(await handleJob(config, f.deps, claim), 'launched');
    assert.ok(f.argv[2]!.includes('gpt-6-luna'));
    assert.equal(f.updates.length, 1);
  });
}

for (const levels of [undefined, {}, { ...config.levels, standard: 'unknown' },
  { ...config.levels, light: 'toString' }]) {
  test(`config refuses invalid levels: ${JSON.stringify(levels)}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-'));
    assert.throws(() => loadConfig(writeConfig(dir, { ...valid, levels })), /config \`levels/);
  });
}

test('a registered repo resolves without a config entry, using its current path and GitHub casing', async () => {
  const f = fakes();
  const exec = f.deps.exec;
  f.deps.exec = (file, args, timeout) => args[0] === 'repo' && args[1] === 'list'
    ? Promise.resolve({ stdout: repoList([{ ...registeredRepo, path: '/new checkout/repo',
      gitRemoteIdentity: { canonicalKey: 'github.com/Owner/Repo' } }]) }) : exec(file, args, timeout);
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
  assert.ok(f.argv.some(args => args.includes('path:/new checkout/repo')));
});

for (const [label, output] of [
  ['missing repo', repoList([])],
  ['duplicate repo', repoList([registeredRepo, { ...registeredRepo, path: '/other/repo' }])],
  ['relative path', repoList([{ ...registeredRepo, path: 'repo' }])],
  ['malformed JSON', 'not json'],
  ['failed envelope', JSON.stringify({ ok: false })],
  ['malformed list', JSON.stringify({ ok: true, result: { repos: {} } })],
  ['malformed row', repoList([null])],
  ['folder', repoList([{ ...registeredRepo, kind: 'folder' }])],
  ['missing identity', repoList([{ kind: 'git', path: '/repos/repo' }])],
  ['wrong host', repoList([{ ...registeredRepo, gitRemoteIdentity: { canonicalKey: 'gitlab.com/owner/repo' } }])],
] as const) {
  test(`repo discovery refuses ${label} before saving intent or creating a worktree`, async () => {
    const f = fakes();
    const exec = f.deps.exec;
    f.deps.exec = (file, args, timeout) => args[0] === 'repo' && args[1] === 'list'
      ? Promise.resolve({ stdout: output }) : exec(file, args, timeout);
    assert.notEqual(await handleJob(config, f.deps, claim), 'launched');
    assert.equal(f.updates.length, 1);
    assert.equal(f.updates[0]?.[0], 'error');
    assert.equal(f.requests.at(-1), 'POST /jobs/session-1/failed');
    assert.ok(!f.argv.some(args => args[1] === 'create'));
    assert.ok(!fs.existsSync(f.deps.launches));
  });
}

test('legacy repos config is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  assert.deepEqual(loadConfig(writeConfig(dir, { ...config, repos: { 'owner/other': '/old/path' } })), config);
});


test('repo discovery failure reports an error without exposing CLI output', async () => {
  const f = fakes();
  const exec = f.deps.exec;
  f.deps.exec = (file, args, timeout) => args[0] === 'repo' && args[1] === 'list'
    ? Promise.reject(new Error('private CLI details')) : exec(file, args, timeout);
  assert.equal(await handleJob(config, f.deps, claim), 'orca-repos-unreadable');
  assert.deepEqual(f.updates, [['error', "Couldn't read registered repos from Orca on Example Mac. Check `orca repo list --json`. Fix it and delegate again to retry."]]);
  assert.ok(!f.argv.some(args => args[1] === 'create'));
});

test('new registrations are read on the next job without reloading config', async () => {
  const f = fakes();
  const exec = f.deps.exec;
  let repos: unknown[] = [];
  f.deps.exec = (file, args, timeout) => args[0] === 'repo' && args[1] === 'list'
    ? Promise.resolve({ stdout: repoList(repos) }) : exec(file, args, timeout);
  assert.equal(await handleJob(config, f.deps, claim), 'refused-repo');
  repos = [registeredRepo];
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
});

const requestDrain = (deps: Deps, nonce: string, until = Date.now() + 60_000) =>
  writeFileSync(deps.drain!, JSON.stringify({ nonce, until }));
const ack = (deps: Deps) => { try { return JSON.parse(readFileSync(`${deps.drain}.ack`, 'utf8')); } catch { return null; } };

test('a drain is not acknowledged while a claim is in flight behind a fresh idle heartbeat', async () => {
  const f = fakes(null);
  f.deps.drain = join(dirname(f.deps.status), 'drain.json');
  let release!: () => void;
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/jobs/claim')) await new Promise<void>((resolve) => { release = resolve; });
    return fetch(input, init);
  };
  const polling = poll(config, f.deps);
  requestDrain(f.deps, 'n1');
  const timer = startStatusHeartbeat(f.deps);
  clearInterval(timer);
  const idle = JSON.parse(readFileSync(f.deps.status, 'utf8'));
  assert.equal(idle.current, null);
  acknowledgeDrain(f.deps);
  assert.equal(ack(f.deps), null, 'an idle-looking status is not quiescence');
  release();
  await polling;
  acknowledgeDrain(f.deps);
  assert.deepEqual(ack(f.deps), { nonce: 'n1', pid: process.pid });
  f.requests.length = 0;
  assert.equal(await poll(config, f.deps), false);
  await checkWatches(config, f.deps);
  assert.deepEqual(f.requests, [], 'nothing new starts while drained');
});

test('saved watches are acknowledged, since they resume after a restart', async () => {
  const f = fakes();
  f.deps.drain = join(dirname(f.deps.status), 'drain.json');
  await handleJob(config, f.deps, claim);
  assert.ok(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1'], 'the launch is watched');
  requestDrain(f.deps, 'watching');
  acknowledgeDrain(f.deps);
  assert.deepEqual(ack(f.deps), { nonce: 'watching', pid: process.pid });
});

test('unreadable watches, a stale request or a corrupt request are never acknowledged', async () => {
  const f = fakes();
  f.deps.drain = join(dirname(f.deps.status), 'drain.json');
  for (const contents of ['{"s":', '[]', '{"s":{}}']) {
    writeFileSync(f.deps.watches, contents);
    requestDrain(f.deps, 'unreadable');
    acknowledgeDrain(f.deps);
    assert.equal(ack(f.deps), null, contents);
  }
  writeFileSync(f.deps.watches, '{}');
  requestDrain(f.deps, 'old', Date.now() - 1);
  acknowledgeDrain(f.deps);
  assert.equal(ack(f.deps), null);
  writeFileSync(f.deps.drain, '{"nonce":');
  acknowledgeDrain(f.deps);
  assert.equal(ack(f.deps), null);
  assert.equal(await poll(config, f.deps), true, 'an expired or corrupt request holds nothing off');
});

test('a PR losing ownership after linking stays watched without a success response', async () => {
  const f = await watching();
  f.status.pullRequests = ['https://github.com/owner/repo/pull/7'];
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes('/pull-request')) f.status.pullRequests = [];
    return response;
  };
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, []);
  assert.ok(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1']);
});

test('restart recovery accepts only the matching PR after contextual attachments', async () => {
  const inbox = realInbox();
  await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
  const f = fakes();
  f.deps.fetch = inbox.fetch;
  await poll(config, f.deps);
  // Lose all local watches; Cloud Inbox must recover launch evidence itself.
  writeFileSync(f.deps.watches, '{}');
  inbox.prs(['https://github.com/other/repo/pull/9', 'https://github.com/owner/repo/pull/7']);
  await resumeWatches(config, { ...f.deps });
  assert.deepEqual(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1'].launch,
    { repo: 'owner/repo', branch: goodTask.branchName });
  await watchJobs(config, { ...f.deps });
  await inbox.queue.deliver();
  assert.deepEqual(inbox.responses, ['Opened https://github.com/owner/repo/pull/7.']);
});

test("a matching PR completes its watch through Cloud Inbox's Workers fetch", async () => {
  const inbox = realInbox();
  await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
  const f = fakes();
  f.deps.fetch = inbox.fetch;
  await poll(config, f.deps);
  inbox.prs(['https://github.com/owner/repo/pull/7']);
  await watchJobs(config, f.deps);
  await inbox.queue.deliver();
  assert.deepEqual(inbox.links, ['https://github.com/owner/repo/pull/7']);
  assert.deepEqual(inbox.responses, ['Opened https://github.com/owner/repo/pull/7.']);
  assert.deepEqual(JSON.parse(readFileSync(f.deps.watches, 'utf8')), {});
});

test('a watch left open logs its session and why', async () => {
  const f = await watching();
  const lines: Record<string, string>[] = [];
  f.deps.log = (fields) => lines.push(fields);
  await watchJobs(config, f.deps);
  f.status.pullRequests = ['https://github.com/owner/repo/pull/7'];
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes('/pull-request')) f.status.pullRequests = [];
    return response;
  };
  await watchJobs(config, f.deps);
  assert.deepEqual(lines, [
    { event: 'watch', session: 'session-1', outcome: 'no-pr-yet' },
    { event: 'watch', session: 'session-1', outcome: 'pr-unconfirmed' },
  ]);
});

for (const [issueState, body] of [
  ['canceled', 'Issue canceled; stopped watching.'],
  ['completed', 'Issue completed; stopped watching. No PR from this launch was recognized.'],
]) {
  test(`a ${issueState} issue without a PR ends its watch once`, async () => {
    const f = await watching();
    f.status.issueState = issueState!;
    await watchJobs(config, f.deps);
    await watchJobs(config, f.deps);
    assert.deepEqual(f.updates, [['response', body]]);
    assert.deepEqual(JSON.parse(readFileSync(f.deps.watches, 'utf8')), {});
  });
}

test('a verified PR wins over a completed issue', async () => {
  const f = await watching();
  f.status.issueState = 'completed';
  f.status.pullRequests = ['https://github.com/owner/repo/pull/7'];
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, [['response', 'Opened https://github.com/owner/repo/pull/7.']]);
  assert.deepEqual(JSON.parse(readFileSync(f.deps.watches, 'utf8')), {});
});

test('a started issue without a PR keeps its watch before 24 hours', async () => {
  const f = await watching();
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, []);
  assert.ok(JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1']);
});

const STOPPED = 'The agent stopped without a PR; see its comment if it left one, or check the Orca worktree. Undelegate to release.';
const psOutput = (worktrees: unknown[]) => JSON.stringify({ ok: true, result: { worktrees } });
const row = (repoId: string, agents: unknown[], hostId = 'local', branch = goodTask.branchName) =>
  ({ repoId, hostId, branch: `refs/heads/${branch}`, agents });
const otherRepo = { id: 'repo-2', kind: 'git', path: '/repos/other', gitRemoteIdentity: { canonicalKey: 'github.com/other/repo' } };
/** Answers `orca worktree ps` with `agents` on the watch's worktree, counting the calls. */
function agentsAre(f: Awaited<ReturnType<typeof watching>>, agents: () => unknown[] | string | Error, repos: unknown[] = [registeredRepo, otherRepo]) {
  const clock = { now: Date.now(), ps: 0, repos: 0 };
  f.deps.now = () => clock.now;
  const exec = f.deps.exec;
  f.deps.exec = async (file, args, timeout) => {
    if (args[0] === 'repo' && args[1] === 'list') { clock.repos++; return { stdout: repoList(repos) }; }
    if (args[0] !== 'worktree' || args[1] !== 'ps') return exec(file, args, timeout);
    clock.ps++;
    const value = agents();
    if (value instanceof Error) throw value;
    return { stdout: typeof value === 'string' ? value : psOutput([
      row('repo-1', [], 'local', 'other/branch'),
      row('repo-1', value),
    ]) };
  };
  return clock;
}
const MINUTE = 60_000;

for (const [label, agents] of [['done', [{ state: 'done' }, { state: 'done' }]], ['gone', []]] as const) {
  test(`an agent ${label} without a PR gets the stop reply once at 10 minutes`, async () => {
    const f = await watching();
    const clock = agentsAre(f, () => [...agents]);
    await watchJobs(config, f.deps);
    clock.now += 10 * MINUTE - 1;
    await watchJobs(config, f.deps);
    assert.deepEqual(f.updates, []);
    clock.now += 1;
    await watchJobs(config, f.deps);
    await watchJobs(config, f.deps);
    assert.deepEqual(f.updates, [['response', STOPPED]]);
    assert.deepEqual(JSON.parse(readFileSync(f.deps.watches, 'utf8')), {});
  });
}

test('a working agent gets no reply, and working again resets the 10-minute clock', async () => {
  const f = await watching();
  let state = 'working';
  const clock = agentsAre(f, () => [{ state: 'done' }, { state }]);
  await watchJobs(config, f.deps);
  clock.now += 20 * MINUTE;
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, []);
  state = 'done';
  await watchJobs(config, f.deps);
  clock.now += 9 * MINUTE;
  state = 'blocked';
  await watchJobs(config, f.deps);
  state = 'done';
  await watchJobs(config, f.deps);
  clock.now += 9 * MINUTE;
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, []);
  clock.now += MINUTE;
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, [['response', STOPPED]]);
});

for (const [label, output] of [
  ['no matching worktree', JSON.stringify({ ok: true, result: { worktrees: [{ branch: 'refs/heads/other/branch', agents: [] }] } })],
  ['a failing orca', new Error('exit 1')],
  ['an orca error', JSON.stringify({ ok: false, error: { code: 'runtime_unavailable' } })],
  ['unparseable output', 'not json'],
] as const) {
  test(`${label} leaves a stopped watch to the 24 h reply`, async () => {
    const f = await watching();
    const at = JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1'].at;
    const clock = agentsAre(f, () => output);
    // Seen 10 minutes before the 24 h mark, so a wrong match would post the stop reply first.
    clock.now = at + 24 * 60 * 60_000 - 10 * MINUTE - 1;
    await watchJobs(config, f.deps);
    clock.now += 10 * MINUTE;
    await watchJobs(config, f.deps);
    assert.deepEqual(f.updates, []);
    clock.now += 1;
    await watchJobs(config, f.deps);
    assert.deepEqual(f.updates, [['response', 'No PR after 24 h; check the Orca worktree.']]);
  });
}

test('a watch without launch evidence never asks Orca and gets only the 24 h reply', async () => {
  const f = await watching();
  const saved = JSON.parse(readFileSync(f.deps.watches, 'utf8'));
  delete saved['session-1'].launch;
  writeFileSync(f.deps.watches, JSON.stringify(saved));
  const clock = agentsAre(f, () => []);
  clock.now = saved['session-1'].at + 24 * 60 * 60_000 - 1;
  await watchJobs(config, f.deps);
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, []);
  assert.equal(clock.ps, 0);
  clock.now += 1;
  await watchJobs(config, f.deps);
  assert.deepEqual(f.updates, [['response', 'No PR after 24 h; check the Orca worktree.']]);
});

for (const [label, set, body] of [
  ['a linked PR', (s: { pullRequests: string[] }) => { s.pullRequests = ['https://github.com/owner/repo/pull/7']; }, 'Opened https://github.com/owner/repo/pull/7.'],
  ['a canceled issue', (s: { issueState: string }) => { s.issueState = 'canceled'; }, 'Issue canceled; stopped watching.'],
  ['a completed issue', (s: { issueState: string }) => { s.issueState = 'completed'; }, 'Issue completed; stopped watching. No PR from this launch was recognized.'],
] as const) {
  test(`${label} wins over the stop reply`, async () => {
    const f = await watching();
    const clock = agentsAre(f, () => []);
    await watchJobs(config, f.deps);
    clock.now += 10 * MINUTE;
    set(f.status as never);
    await watchJobs(config, f.deps);
    assert.deepEqual(f.updates, [['response', body]]);
  });
}

test('Orca is asked about agents once per pass, however many watches', async () => {
  const f = await watching();
  const saved = JSON.parse(readFileSync(f.deps.watches, 'utf8'));
  saved['session-2'] = { ...saved['session-1'], sessionId: 'session-2' };
  writeFileSync(f.deps.watches, JSON.stringify(saved));
  const clock = agentsAre(f, () => []);
  await watchJobs(config, f.deps);
  assert.deepEqual([clock.ps, clock.repos], [1, 1]);
  clock.now += 10 * MINUTE;
  await watchJobs(config, f.deps);
  assert.deepEqual([clock.ps, clock.repos], [2, 2]);
  assert.deepEqual(f.updates, [['response', STOPPED], ['response', STOPPED]]);
});

for (const [watched, other] of [['done', 'working'], ['working', 'done']]) {
  for (const reversed of [false, true]) {
    test(`a ${watched} agent is judged by its own repo when another repo's ${other} agent shares the branch${reversed ? ', listed first' : ''}`, async () => {
      const f = await watching();
      const rows = [row('repo-1', [{ state: watched }]), row('repo-2', [{ state: other }]),
        row('repo-1', [{ state: other }], 'ssh-elsewhere')];
      const clock = agentsAre(f, () => psOutput(reversed ? [...rows].reverse() : rows));
      await watchJobs(config, f.deps);
      clock.now += 10 * MINUTE;
      await watchJobs(config, f.deps);
      assert.deepEqual(f.updates, watched === 'done' ? [['response', STOPPED]] : []);
    });
  }
}

for (const [label, repos, rows] of [
  ['two registered checkouts of the watched repo', [registeredRepo, { ...otherRepo, gitRemoteIdentity: registeredRepo.gitRemoteIdentity }], [row('repo-1', [])]],
  ['no registered checkout of the watched repo', [otherRepo], [row('repo-1', [])]],
  ['two local rows for the watched repo and branch', [registeredRepo], [row('repo-1', []), row('repo-1', [{ state: 'working' }])]],
  ['only another host has the branch', [registeredRepo], [row('repo-1', [], 'ssh-elsewhere')]],
  ['only another repo has the branch', [registeredRepo, otherRepo], [row('repo-2', [])]],
] as const) {
  test(`${label} leaves the watch to the 24 h reply`, async () => {
    const f = await watching();
    const at = JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1'].at;
    const clock = agentsAre(f, () => psOutput([...rows]), [...repos]);
    // Seen 10 minutes before the 24 h mark, so a wrong match would post the stop reply first.
    clock.now = at + 24 * 60 * 60_000 - 10 * MINUTE - 1;
    await watchJobs(config, f.deps);
    clock.now += 10 * MINUTE;
    await watchJobs(config, f.deps);
    assert.deepEqual(f.updates, []);
    clock.now += 1;
    await watchJobs(config, f.deps);
    assert.deepEqual(f.updates, [['response', 'No PR after 24 h; check the Orca worktree.']]);
  });
}

const closeoutTask: Partial<Task> = { ...goodTask, delegated: false, creatorId: null, statusType: 'completed',
  kind: 'closeout', launch: { repo: 'owner/repo', branch: goodTask.branchName } };
const closeoutWorktree = { ...matchingWorktree, path: '/worktrees/abc-123' };
const closing = '🧹 Closing out in Orca on Example Mac; its completion comment lists anything still open.';
const byHand = "Run do-closeout by hand if it's still needed.";
const lostLaunch = () => Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ ok: false,
  error: { code: 'agent_session_operation_unknown', data: { retrySafe: true, operationId: '1800000000000-0123456789abcdef0123456789abcdef' } } }) });

/** Fakes for a closeout: Orca knows the launch's checkout and lists `worktrees`; `launches` answer each agent launch. */
function closeoutFakes(task: Partial<Task> = closeoutTask, launches: (string | Error)[] = [ok], worktrees: unknown[] = [closeoutWorktree]) {
  const f = fakes(task);
  f.deps.exec = async (_file, args) => {
    f.argv.push(args);
    if (args[0] === 'repo' && args[1] === 'list') return { stdout: repoList() };
    if (args[0] === 'repo' && args[1] === 'show') return { stdout: repoInfo };
    if (args[0] === 'worktree' && args[1] === 'list') return { stdout: listed(worktrees) };
    if (args[0] === 'agent') {
      const next = launches.shift() ?? ok;
      if (next instanceof Error) throw next;
      return { stdout: next };
    }
    return { stdout: ok };
  };
  return f;
}
const agentLaunches = (argv: string[][]) => argv.filter((args) => args[0] === 'agent');
const closeoutArgv = (agent: string, model: string, effort: string, prefix: string) => ['agent', 'launch', '--agent', agent,
  '--worktree', 'path:/worktrees/abc-123', '--model', model, '--effort', effort,
  '--prompt', `${prefix}do-closeout ABC-123\nDelegated run: nobody is watching this session.`, '--json'];

test('the Runner claims closeout jobs as well as delegations', async () => {
  const f = fakes();
  const urls: string[] = [];
  const fetch = f.deps.fetch;
  f.deps.fetch = async (input, init) => { urls.push(String(input)); return fetch(input, init); };
  await poll(config, f.deps);
  const claimUrl = new URL(urls.find((url) => url.includes('/jobs/claim'))!);
  assert.equal(claimUrl.searchParams.get('kinds'), 'delegation,closeout');
});

test('a closeout with its worktree launches do-closeout there with the standard model, responds and is never watched', async () => {
  const f = closeoutFakes();
  assert.equal(await handleJob(config, f.deps, claim), 'closeout-launched');
  assert.deepEqual(agentLaunches(f.argv), [closeoutArgv('claude', 'claude-opus-5-5', 'high', '/')]);
  assert.deepEqual(f.updates, [['thought', '🧹 Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing` for closeout.'], ['response', closing]]);
  assert.deepEqual(f.requests, ['GET /jobs/session-1/task', 'POST /jobs/session-1/updates',
    'POST /jobs/session-1/launched', 'POST /jobs/session-1/updates']);
  assert.ok(!f.argv.some((args) => args[0] === 'worktree' && args[1] === 'create'));
  assert.deepEqual(f.argv.at(-1), renamed('/worktrees/abc-123', '🧹 abc-123-do-the-thing'));
  assert.deepEqual(readWatches(f.deps), {});
  assert.equal(readFileSync(f.deps.launches, 'utf8'), '{}');
  assert.equal(JSON.parse(readFileSync(f.deps.status, 'utf8')).lastError, null);
});

test('a Codex closeout gets a dollar prefix and the standard model settings', async () => {
  const f = closeoutFakes();
  await handleJob({ ...config, levels: { ...config.levels, standard: 'GPT-6 Luna' } }, f.deps, claim);
  assert.deepEqual(agentLaunches(f.argv), [closeoutArgv('codex', 'gpt-6-luna', 'high', '$')]);
});

for (const [label, task, worktrees, outcome, response, error] of [
  ['a canceled issue', { ...closeoutTask, skip: 'canceled' }, [closeoutWorktree], 'closeout-canceled', 'Issue canceled; no closeout launched.', false],
  ['an unverified PR', { ...closeoutTask, skip: 'unverified' }, [closeoutWorktree], 'closeout-unverified',
    `Couldn't verify the merged PR came from this launch; nothing launched. ${byHand}`, true],
  ['an unreadable PR', { ...closeoutTask, skip: 'unreadable' }, [closeoutWorktree], 'closeout-unreadable',
    `Couldn't read the merged PR from GitHub; check Cloud Inbox's GitHub token. Nothing launched. ${byHand}`, true],
  ['an unknown skip', { ...closeoutTask, skip: 'something-new' } as unknown as Partial<Task>, [closeoutWorktree], 'closeout-unverified',
    `Couldn't verify the merged PR came from this launch; nothing launched. ${byHand}`, true],
  ['a gone worktree', closeoutTask, [{ ...closeoutWorktree, hostId: 'remote' }], 'closeout-no-worktree',
    `The worktree for someone/abc-123-do-the-thing is gone on Example Mac; nothing launched. ${byHand}`, true],
  ['only the primary checkout at the branch', closeoutTask, [{ ...closeoutWorktree, isMainWorktree: true }], 'closeout-no-worktree',
    `The worktree for someone/abc-123-do-the-thing is gone on Example Mac; nothing launched. ${byHand}`, true],
  ['only an archived worktree at the branch', closeoutTask, [{ ...closeoutWorktree, isArchived: true }], 'closeout-no-worktree',
    `The worktree for someone/abc-123-do-the-thing is gone on Example Mac; nothing launched. ${byHand}`, true],
  ['two worktrees at the branch', closeoutTask, [closeoutWorktree, { ...closeoutWorktree, path: '/worktrees/other' }], 'closeout-no-worktree',
    `The worktree for someone/abc-123-do-the-thing is gone on Example Mac; nothing launched. ${byHand}`, true],
] as const) {
  test(`a closeout with ${label} launches nothing, responds and finishes failed`, async () => {
    const f = closeoutFakes(task, [ok], [...worktrees]);
    assert.equal(await handleJob(config, f.deps, claim), outcome);
    assert.deepEqual(agentLaunches(f.argv), []);
    assert.deepEqual(f.updates, [['response', response]]);
    assert.equal(f.requests.at(-1), 'POST /jobs/session-1/failed');
    assert.equal(JSON.parse(readFileSync(f.deps.status, 'utf8')).lastError?.outcome, error ? outcome : undefined);
  });
}

test('a lost closeout launch reply is retried once with its operation id, never as a fresh launch', async () => {
  const f = closeoutFakes(closeoutTask, [lostLaunch(), ok]);
  assert.equal(await handleJob(config, f.deps, claim), 'closeout-launched');
  const first = closeoutArgv('claude', 'claude-opus-5-5', 'high', '/');
  assert.deepEqual(agentLaunches(f.argv), [first, [...first, '--retry-launch', '1800000000000-0123456789abcdef0123456789abcdef']]);
});

test('a closeout launch failure ends with the by-hand advice and is not requeued', async () => {
  const f = closeoutFakes(closeoutTask, [orcaError('worktree_not_found')]);
  assert.equal(await handleJob(config, f.deps, claim), 'closeout-orca-worktree_not_found');
  assert.equal(agentLaunches(f.argv).length, 1);
  assert.deepEqual(f.updates, [['error', `Orca couldn't start the agent (\`worktree_not_found\`). Check Orca on Example Mac. ${byHand}`]]);
  assert.equal(f.requests.at(-1), 'POST /jobs/session-1/failed');
  assert.equal(JSON.parse(readFileSync(f.deps.status, 'utf8')).lastError?.outcome, 'closeout-orca-worktree_not_found');
});

test('a closeout whose replayed reply is lost too says it may have started', async () => {
  const f = closeoutFakes(closeoutTask, [lostLaunch(), lostLaunch()]);
  assert.equal(await handleJob(config, f.deps, claim), 'closeout-orca-agent_session_operation_unknown');
  assert.equal(agentLaunches(f.argv).length, 2);
  assert.deepEqual(f.updates, [['error', 'Orca lost the launch reply, so the closeout may have started. '
    + 'Check the worktree for someone/abc-123-do-the-thing on Example Mac before you run do-closeout by hand.']]);
});

test('Orca down for a closeout keeps the single retry and the by-hand advice', async () => {
  const f = closeoutFakes(closeoutTask, [orcaError('runtime_unavailable'), orcaError('runtime_unavailable')]);
  assert.equal(await handleJob(config, f.deps, claim), 'closeout-orca-unavailable');
  assert.equal(agentLaunches(f.argv).length, 2);
  assert.deepEqual(f.updates, [['error', `Orca isn't running on Example Mac. Open Orca. ${byHand}`]]);
});

test('a closeout whose launched report was lost is reported on reclaim without relaunching', async () => {
  const f = closeoutFakes();
  const fetch = f.deps.fetch;
  let lost = false;
  f.deps.fetch = async (input, init) => {
    if (!lost && String(input).includes('/launched')) { lost = true; throw new TypeError('lost'); }
    return fetch(input, init);
  };
  await handleJob(config, f.deps, claim);
  assert.deepEqual(f.updates, [['thought', '🧹 Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing` for closeout.']]);
  assert.equal(await handleJob(config, f.deps, claim), 'closeout-launched');
  assert.equal(agentLaunches(f.argv).length, 1);
  assert.deepEqual(f.updates.at(-1), ['response', closing]);
  assert.equal(f.updates.length, 2);
  assert.equal(readFileSync(f.deps.launches, 'utf8'), '{}');
});

test('a closeout whose response was lost after launched is answered by watch recovery, not watched', async () => {
  const f = closeoutFakes();
  const fetch = f.deps.fetch;
  let lost = false;
  f.deps.fetch = async (input, init) => {
    if (!lost && String(input).includes('/updates') && JSON.parse(String(init?.body)).type === 'response') { lost = true; throw new TypeError('lost'); }
    if (String(input).endsWith('/jobs/watching')) return Response.json([{ ...claim, at: 1 }]);
    return fetch(input, init);
  };
  await handleJob(config, f.deps, claim);
  await checkWatches(config, f.deps);
  assert.deepEqual(f.updates.map(([type]) => type), ['thought', 'response']);
  assert.deepEqual(f.updates.at(-1), ['response', closing]);
  assert.deepEqual(readWatches(f.deps), {});
});
