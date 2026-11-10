import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './autopilot.mjs';

function fixture(overrides = {}) {
  const pr = { number: 1, node_id: 'PR', draft: true, title: 'Fix (ABC-123)',
    labels: [], head: { sha: 'head', ref: 'abc-123-fix', repo: { full_name: 'example/repo' } },
    base: { ref: 'main' }, mergeable: true, ...overrides };
  const writes = [];
  const request = async (path, body) => {
    if (body) { writes.push({ path, body }); return {}; }
    if (path === '/repos/example/repo') return { default_branch: 'main' };
    if (path.includes('/pulls/')) return pr;
    if (path.includes('/check-runs')) return { check_runs: [{ name: 'verifier', status: 'completed', conclusion: 'success', html_url: 'https://logs' }] };
    if (path.includes('/statuses')) return [];
    throw Error(path);
  };
  return { pr, writes, request, event: { pull_request: pr }, eventName: 'pull_request_target',
    repo: 'example/repo', wait: [], warn: () => {} };
}
test('qualified draft passes and is marked ready', async () => {
  const f = fixture();
  await run(f);
  assert.ok(f.writes.some(w => w.body.query?.includes('markPullRequestReadyForReview')));
  assert.ok(f.writes.some(w => w.body.labels?.includes('ready-to-merge')));
  assert.ok(f.writes.some(w => w.body.description === 'ready to merge'));
});

for (const [name, overrides, description] of [
  ['branch fallback', { title: 'Fix' }, 'ready to merge'],
  ['opt out', { labels: [{ name: 'no-autopilot' }] }, 'skipped: no-autopilot'],
  ['no ticket', { title: 'Fix', head: { sha: 'head', ref: 'fix', repo: { full_name: 'example/repo' } } }, 'skipped: no ticket id'],
  ['unknown mergeability', { mergeable: null }, 'waiting on: mergeability'],
  ['conflict', { mergeable: false }, 'needs fix: conflicts with main'],
]) test(name, async () => {
  const f = fixture(overrides); await run(f);
  assert.equal(f.writes.find(w => w.body?.context === 'autopilot').body.description, description);
});
for (const overrides of [
  { draft: false },
  { head: { sha: 'head', repo: { full_name: 'fork/repo' } } },
  { base: { ref: 'release' } },
]) test('nonqualifying PR untouched ' + JSON.stringify(overrides), async () => {
  const f = fixture(overrides); await run(f); assert.deepEqual(f.writes, []);
});
test('waiting for extra check; new push removes label', async () => {
  const f = fixture({ labels: [{ name: 'ready-to-merge' }] });
  f.event.action = 'synchronize'; f.wait = ['deploy'];
  const original = f.request;
  f.request = async (path, body, method) => {
    if (method === 'DELETE') { f.writes.push({ path, method }); return {}; }
    return original(path, body);
  };
  await run(f);
  assert.equal(f.writes[0].method, 'DELETE');
  assert.equal(f.writes[1].body.description, 'waiting on: deploy');
});
test('failed check includes logs and ordered hand-back', async () => {
  const f = fixture(); const original = f.request;
  f.request = async (path, body) => path.includes('/check-runs') ?
    { check_runs: [{ name: 'verifier', status: 'completed', conclusion: 'failure', html_url: 'https://logs' }] } : original(path, body);
  let comment;
  f.linear = async (_ticket, _marker, body) => { comment = body; };
  await run(f);
  assert.equal(f.writes[0].body.description, 'needs fix: verifier');
  assert.match(comment, /\[verifier\]\(https:\/\/logs\)/);
  assert.match(comment, /origin\/main first.*fix.*commit.*full scripts\/factory-verifier preflight.*clean tree.*push/);
  assert.doesNotMatch(comment, /OVERRIDE|bypass/);
});
test('own status events ignored', async () => {
  const f = fixture(); f.eventName = 'status'; f.event = { context: 'autopilot' };
  await run(f); assert.deepEqual(f.writes, []);
});

import { createServer } from 'node:http';
import { linearReporter } from './autopilot.mjs';
test('fake Linear server receives pass and fail once each without leaking credentials', async t => {
  const comments = []; const warnings = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') {
      assert.equal(new URLSearchParams(raw).get('grant_type'), 'client_credentials');
      res.end(JSON.stringify({ access_token: 'secret-token' })); return;
    }
    const { query, variables } = JSON.parse(raw);
    let data;
    if (query.includes('commentCreate')) { comments.push(variables.input.body); data = { commentCreate: { success: true } }; }
    else if (query.includes('comments(')) data = { issue: { comments: { nodes: comments.map(body => ({ body })), pageInfo: { hasNextPage: false } } } };
    else data = { issue: { id: 'issue' } };
    res.end(JSON.stringify({ data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const linear = linearReporter({ clientId: 'secret-id', clientSecret: 'secret-value',
    tokenUrl: url + '/token', apiUrl: url + '/graphql', warn: s => warnings.push(s) });
  for (const fail of [false, true]) for (let i = 0; i < 2; i++) {
    const f = fixture(); f.linear = linear;
    if (fail) {
      const original = f.request;
      f.request = async (path, body) => path.includes('/check-runs') ?
        { check_runs: [{ name: 'verifier', status: 'completed', conclusion: 'failure', html_url: 'https://logs' }] } :
        original(path, body);
    }
    await run(f);
  }
  assert.equal(comments.length, 2);
  assert.match(comments[1], /https:\/\/logs/);
  assert.match(comments[0], /head pass/); assert.match(comments[1], /head fail verifier/);
  assert.doesNotMatch(JSON.stringify({ comments, warnings }), /secret-/);
});
test('newest rerun wins and stale head events do nothing', async () => {
  const f = fixture(); const original = f.request;
  f.request = async (path, body) => path.includes('/check-runs') ? { check_runs: [
    { id: 1, name: 'verifier', status: 'completed', conclusion: 'success' },
    { id: 2, name: 'verifier', status: 'in_progress' },
  ] } : original(path, body);
  await run(f);
  assert.equal(f.writes[0].body.description, 'waiting on: verifier');
  f.writes.length = 0; f.eventName = 'check_run';
  f.event = { check_run: { head_sha: 'old' }, pull_request: f.pr };
  await run(f); assert.deepEqual(f.writes, []);
});
test('missing credentials warn but preserve GitHub promotion', async () => {
  const f = fixture(); const warnings = [];
  f.linear = linearReporter({ clientId: 'only-id' }); f.warn = s => warnings.push(s);
  await run(f);
  assert.ok(f.writes.some(w => w.body.labels?.includes('ready-to-merge')));
  assert.match(warnings[0], /credentials missing/);
  assert.doesNotMatch(JSON.stringify(warnings), /only-id/);
});
