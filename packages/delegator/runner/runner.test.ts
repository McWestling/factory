import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { MachineAuth } from '../cloud-inbox/auth.ts';
import { MachineQueue } from '../cloud-inbox/queue.ts';
import { handleRunner } from '../cloud-inbox/routes.ts';
import { startStatusHeartbeat, handleJob, launchArgs, loadConfig, NOT_ALLOWED, poll, resumeWatches, watchJobs, type Deps, type RunnerConfig, type Task } from './runner.ts';

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
  levels: { light: 'GPT-6 Luna', standard: 'Claude Opus 5.5', deep: 'Claude Opus 5.5' },
  skill: 'do-implement',
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
const orcaError = (code: string) => Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ ok: false, error: { code } }) });

/** A fake Cloud Inbox and Orca, recording every call. */
function fakes(task: Partial<Task> | null = goodTask, orca: (string | Error)[] = [ok, ok]) {
  const requests: string[] = [];
  const updates: [string, string][] = [];
  const argv: string[][] = [];
  const stateDir = mkdtempSync(join(tmpdir(), 'runner-watch-'));
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
    launches: join(mkdtempSync(join(tmpdir(), 'runner-state-')), 'launches.json'),
    watches: join(stateDir, 'watching.json'),
    status: join(stateDir, 'status.json'),
    paused: join(stateDir, 'paused'),
  };
  return { deps, requests, updates, argv };
}

test('a launched job keeps its claim for completion watching after a restart', async () => {
  const f = fakes();
  await handleJob(config, f.deps, claim);
  const saved = JSON.parse(readFileSync(f.deps.watches, 'utf8'))['session-1'];
  assert.equal(saved.claimId, claim.claimId);
  assert.equal(saved.issueId, claim.issueId);
  assert.equal(saved.ready, true);
});

async function watching() {
  const f = fakes();
  await handleJob(config, f.deps, claim);
  f.requests.length = 0;
  f.updates.length = 0;
  const status = { sessionStatus: 'active', pullRequests: [] as string[] };
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
    ['worktree', 'create', '--name', 'abc-123-do-the-thing', '--repo', 'path:/repos/repo',
      '--branch', 'someone/abc-123-do-the-thing', '--agent', 'claude', '--model', 'claude-opus-5-5',
      '--effort', 'high', '--prompt=/do-implement ABC-123\nDelegated run: nobody is watching this session.', '--setup', 'run', '--linear-issue', 'ABC-123', '--json'],
  ]);
});

test('Codex uses a dollar prefix for do-implement', () => {
  const args = launchArgs(config, 'owner/repo', 'GPT-6 Luna', goodTask);
  assert.ok(args.includes('--prompt=$do-implement ABC-123\nDelegated run: nobody is watching this session.'));
});

test('a skill other than do-implement skips setup, and a model without effort omits it', () => {
  const args = launchArgs({ ...config, skill: 'do-refine' }, 'owner/repo', 'GPT-6 Luna', goodTask);
  assert.deepEqual(args, ['worktree', 'create', '--name', 'abc-123-do-the-thing', '--repo', 'path:/repos/repo',
    '--branch', 'someone/abc-123-do-the-thing', '--agent', 'codex', '--model', 'gpt-6-luna', '--prompt=$do-refine ABC-123\nDelegated run: nobody is watching this session.',
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
    assert.deepEqual(f.updates, [['thought', 'Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing`.']]);
  });
}

const refusals: [string, Partial<Task>, string][] = [
  ['a null creator', { creatorId: null }, NOT_ALLOWED],
  ['a creator not on the allowlist', { creatorId: 'user-other' }, NOT_ALLOWED],
  ['no level tag', { description: '`[repo=owner/repo]`' },
    'Refused `level`: expected a [level=…] tag with 1/light, 2/standard, 3/deep. Fix it and delegate again to retry.'],
  ['a malformed repo tag', { description: description('Claude Opus 5.5', 'not a repo') },
    'Refused `repo`: expected a [repo=owner/name] tag matching ^[\\w.-]+/[\\w.-]+$. Fix it and delegate again to retry.'],
  ['a repo not on the allowlist', { description: description('Claude Opus 5.5', 'owner/other') },
    'Refused `repo`: expected a repo on the machine allowlist. Fix it and delegate again to retry.'],
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
  assert.equal(f.argv.length, 3);
  assert.deepEqual(f.updates, [['error', "Orca isn't running on Example Mac. Open Orca and delegate again to retry."]]);
  assert.equal(f.requests.at(-1), 'POST /jobs/session-1/failed');
});

test('Orca becoming available on the retry launches', async () => {
  const f = fakes(goodTask, [orcaError('runtime_unavailable'), orcaError('runtime_unavailable'), ok]);
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
  assert.equal(f.argv.length, 3);
});

const orcaFailures: [string | Error, string][] = [
  [orcaError('repo_not_found'), "Orca doesn't know owner/repo's checkout on Example Mac. Add it in Orca, or fix its path in the Runner config. Fix it and delegate again to retry."],
  [Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' }), "The Runner can't find the `orca` command on Example Mac. Put Orca's CLI on its PATH. Fix it and delegate again to retry."],
  [orcaError('worktree_conflict'), "Orca couldn't start the agent (`worktree_conflict`). Check Orca on Example Mac. Fix it and delegate again to retry."],
  [JSON.stringify({ ok: false, error: { code: 'Not A Code; rm -rf' } }), "Orca couldn't start the agent (`orca_failed`). Check Orca on Example Mac. Fix it and delegate again to retry."],
];
for (const [failure, message] of orcaFailures) {
  test(`an Orca failure is reported, not retried: ${message.slice(0, 40)}`, async () => {
    const f = fakes(goodTask, [ok, failure]);
    assert.notEqual(await handleJob(config, f.deps, claim), 'launched');
    assert.equal(f.argv.length, 2);
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
function realInbox() {
  const db = new DatabaseSync(':memory:');
  const clock = { now: 1_800_000_000_000 };
  const issueEdits: Record<string, unknown>[] = [];
  const thoughts: string[] = [];
  const responses: string[] = [];
  const links: string[] = [];
  let sessionStatus = 'active';
  let pullRequests: string[] = [];
  const linear: typeof fetch = async (_, init) => {
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
        state: { type: 'unstarted' }, delegate: { id: 'app-user' }, team: { id: 'team-1', states: { nodes: [] } }, labels: { nodes: [] },
      },
      agentSession: { creator: { id: 'user-allowed' } },
      issueLabels: { nodes: [] },
    } });
  };
  const auth = { installation: async () => ({ appUserId: 'app-user', appName: 'Example' }), getAccessToken: async () => 'token' };
  const queue = new MachineQueue({ exec: (query, ...bindings) => {
    const rows = db.prepare(query).all(...bindings);
    return { toArray: () => rows };
  } }, auth as unknown as MachineAuth, 'example-machine', () => {}, linear, () => clock.now);
  const inboxConfig = { orgId: 'org', adminSecret: 'admin', machines: {
    'example-machine': { clientId: 'client', clientSecret: 'secret', webhookSecret: 'webhook', bearerSecret: config.bearerSecret },
  } };
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
    return handleRunner(new Request(url, init), inboxConfig, () => queue);
  };
  const state = () => db.prepare('SELECT state FROM jobs').all().map((row) => row.state);
  return { queue, clock, issueEdits, thoughts, responses, links, ops, fetch, state,
    prs: (urls: string[]) => { pullRequests = urls; }, lose: (n: number) => { loseLaunched = n; },
    loseThought: () => { loseThought = 1; } };
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

test('an upgraded Runner recovers an old launched job and posts its PR once', async () => {
  const inbox = realInbox();
  await inbox.queue.webhook({ action: 'created', appUserId: 'app-user', sessionId: 'session-1', issueId: 'issue-1', stop: false });
  const old = await inbox.queue.claim();
  await inbox.queue.finish(old!.sessionId, old!.claimId, 'launched');
  inbox.prs(['https://github.com/owner/repo/pull/7']);
  const f = fakes();
  f.deps.fetch = inbox.fetch;
  await resumeWatches(config, f.deps);
  await watchJobs(config, f.deps);
  await inbox.queue.deliver();
  await resumeWatches(config, f.deps);
  await watchJobs(config, f.deps);
  await inbox.queue.deliver();
  assert.deepEqual(inbox.responses, ['Opened https://github.com/owner/repo/pull/7.']);
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
    assert.deepEqual(inbox.thoughts, ['Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing`.']);
  });
}

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
  assert.deepEqual(inbox.thoughts, ['Started Claude Opus 5.5 in Orca on `someone/abc-123-do-the-thing`.']);
  assert.deepEqual(inbox.state(), ['launched']);
});

for (const contents of ['{broken', 'null', '{"session-1":{"at":42}}']) {
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

test('a failed intent write refuses before Orca can start', async () => {
  const f = fakes();
  f.deps.launches = join(f.deps.launches, 'missing', 'launches.json');
  assert.equal(await handleJob(config, f.deps, claim), 'launch-record-failed');
  assert.deepEqual(f.argv, []);
  assert.deepEqual(f.requests.slice(-2), ['POST /jobs/session-1/updates', 'POST /jobs/session-1/failed']);
});

test('the previous numeric launch file still recovers without Orca', async () => {
  const f = fakes();
  writeFileSync(f.deps.launches, JSON.stringify({ 'session-1': Date.now() }));
  assert.equal(await handleJob(config, f.deps, claim), 'launched');
  assert.deepEqual(f.argv, []);
  assert.deepEqual(f.requests, ['POST /jobs/session-1/launched']);
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
  ['an inbox URL with a query', { ...valid, inboxUrl: 'https://inbox.example/delegator?x=1' }],
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
    assert.equal(f.argv[1]![f.argv[1]!.indexOf('--model') + 1], id);
    assert.equal(f.updates.at(-1)?.[1], `Started ${model} in Orca on \`someone/abc-123-do-the-thing\`.`);
    assert.equal(f.updates.length, pin === 'luna' ? 1 : 2);
  });
}

for (const pin of ['', ' [model=]']) {
  test(`missing or empty pin ${JSON.stringify(pin)} uses the level without a fallback thought`, async () => {
    const f = fakes({ ...goodTask, description: `[repo=owner/repo] [level=light]${pin}` });
    assert.equal(await handleJob(config, f.deps, claim), 'launched');
    assert.ok(f.argv[1]!.includes('gpt-6-luna'));
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
