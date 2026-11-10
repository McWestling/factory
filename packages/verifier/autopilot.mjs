import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function run({ request, repo, eventName, event, wait = [], linear,
  warn = console.warn, number: selectedNumber }) {
  if (eventName === 'status' && event.context === 'autopilot') return;
  const base = '/repos/' + repo;
  const repository = await request(base);
  const sha = event.check_run?.head_sha ?? event.check_suite?.head_sha ?? event.workflow_run?.head_sha ?? event.sha;
  let numbers = selectedNumber ? [selectedNumber] : event.pull_request ? [event.pull_request.number] :
    (await request(base + '/commits/' + sha + '/pulls?per_page=100')).map(p => p.number);
  for (const number of new Set(numbers)) {
    const path = base + '/pulls/' + number;
    const pr = await request(path);
    if (pr.state === 'closed' || pr.head.repo?.full_name !== repo ||
        pr.base.ref !== repository.default_branch) continue;
    if (sha && pr.head.sha !== sha) continue;
    const labels = pr.labels.map(l => typeof l === 'string' ? l : l.name);
    // Ready PRs are otherwise untouched; a new push invalidates the old label.
    if (eventName === 'pull_request_target' && event.action === 'synchronize' &&
        labels.includes('ready-to-merge')) {
      await request(base + '/issues/' + number + '/labels/ready-to-merge', null, 'DELETE');
    }
    if (!pr.draft) continue;
    const ticket = pr.title.match(/\(([A-Z][A-Z0-9]*-\d+)\)$/)?.[1] ??
      pr.head.ref.match(/(?:^|[^a-z0-9])([a-z][a-z0-9]*-\d+)(?=$|[^0-9])/i)?.[1]?.toUpperCase();
    const status = async (state, description) => request(base + '/statuses/' + pr.head.sha,
      { state, context: 'autopilot', description: description.slice(0, 140) });
    if (labels.includes('no-autopilot') || !ticket) {
      await status('success', 'skipped: ' + (labels.includes('no-autopilot') ? 'no-autopilot' : 'no ticket id'));
      continue;
    }
    const runs = (await request(base + '/commits/' + pr.head.sha + '/check-runs?per_page=100')).check_runs;
    const statuses = await request(base + '/commits/' + pr.head.sha + '/statuses?per_page=100');
    const checks = new Map();
    // REST returns newest first; never let an older attempt override a rerun.
    runs.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
    for (const r of runs) if (!checks.has(r.name)) checks.set(r.name, {
      green: r.status === 'completed' && ['success', 'neutral', 'skipped'].includes(r.conclusion),
      failed: r.status === 'completed' && !['success', 'neutral', 'skipped'].includes(r.conclusion),
      url: r.html_url });
    for (const s of statuses) if (!checks.has(s.context)) checks.set(s.context, {
      green: s.state === 'success', failed: ['failure', 'error'].includes(s.state), url: s.target_url });
    const names = [...new Set(['verifier', ...wait])];
    const failed = names.filter(n => checks.get(n)?.failed);
    const pending = names.filter(n => !checks.get(n)?.green && !checks.get(n)?.failed);
    const problems = pr.mergeable === false ? [...failed, 'conflicts with main'] : failed;
    if (!problems.length && (pending.length || pr.mergeable !== true)) {
      await status('pending', 'waiting on: ' + (pending.length ? pending.join(', ') : 'mergeability'));
      continue;
    }
    // Re-read before mutations: events may have queued behind a newer push.
    if ((await request(path)).head.sha !== pr.head.sha) continue;
    const pass = !problems.length;
    await status(pass ? 'success' : 'failure', pass ? 'ready to merge' : 'needs fix: ' + problems.join(', '));
    if (pass) {
      await request('/graphql', { query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}', variables: { id: pr.node_id } });
      await request(base + '/issues/' + number + '/labels', { labels: ['ready-to-merge'] });
    } else if (labels.includes('ready-to-merge') && event.action !== 'synchronize') {
      await request(base + '/issues/' + number + '/labels/ready-to-merge', null, 'DELETE');
    }
    const marker = 'factory-autopilot: ' + repo + '#' + number + ' ' + pr.head.sha +
      ' ' + (pass ? 'pass' : 'fail') + ' ' + [...problems].sort().join(', ');
    const body = (pass ? 'Hosted checks passed and GitHub reports no merge conflict. PR is ready for review.' :
      'Needs a fix:\n' + problems.map(n => checks.get(n)?.url ? '- [' + n + '](' + checks.get(n).url + ')' : '- ' + n).join('\n')) +
      '\n\n' + marker + (pass ? '' :
      '\n\nMerge the latest origin/main first, fix the listed checks or conflicts, commit the fixes, run full scripts/factory-verifier preflight on the clean tree, then push.');
    if (linear) await linear(ticket, marker, body);
    else warn('Linear credentials missing; skipping autopilot comment.');
  }
}

export function linearReporter({ clientId, clientSecret, fetcher = fetch,
  tokenUrl = 'https://api.linear.app/oauth/token', apiUrl = 'https://api.linear.app/graphql',
  warn = console.warn }) {
  if (!clientId || !clientSecret) return undefined;
  let token;
  async function graph(query, variables) {
    const response = await fetcher(apiUrl, { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }) });
    if (!response.ok) throw Error('Linear request failed: ' + response.status);
    const result = await response.json();
    if (result.errors?.every(e => e.extensions?.code === 'ENTITY_NOT_FOUND')) return { issue: null };
    if (result.errors) throw Error('Linear GraphQL request failed');
    return result.data;
  }
  return async (ticket, marker, body) => {
    if (!token) {
      const response = await fetcher(tokenUrl, { method: 'POST',
        body: new URLSearchParams({ grant_type: 'client_credentials',
          client_id: clientId, client_secret: clientSecret, scope: 'read,write' }) });
      if (!response.ok) throw Error('Linear token exchange failed: ' + response.status);
      token = (await response.json()).access_token;
      if (!token) throw Error('Linear token exchange returned no token');
    }
    const data = await graph('query($id:String!){issue(id:$id){id}}', { id: ticket });
    if (!data.issue) { warn('Linear ticket not found: ' + ticket); return; }
    let after = null;
    do {
      const result = await graph('query($id:String!,$after:String){issue(id:$id){comments(first:100,after:$after){nodes{body} pageInfo{hasNextPage endCursor}}}}',
        { id: ticket, after });
      const comments = result.issue.comments;
      if (comments.nodes.some(c => c.body.split('\n').includes(marker))) return;
      after = comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : null;
    } while (after);
    const result = await graph('mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}',
      { input: { issueId: data.issue.id, body } });
    if (!result.commentCreate.success) throw Error('Linear comment creation failed');
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const api = process.env.GITHUB_API_URL || 'https://api.github.com';
    const request = async (path, body, method) => {
      const response = await fetch(api + path, { method: method || (body ? 'POST' : 'GET'),
        headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
          Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw Error('GitHub request failed: ' + response.status);
      if (response.status === 204) return {};
      const result = await response.json();
      if (result.errors) throw Error('GitHub GraphQL request failed');
      const next = response.headers.get('link')?.match(/<([^>]+)>; rel="next"/)?.[1];
      if (next) {
        const more = await request(next.slice(api.length));
        if (Array.isArray(result)) return [...result, ...more];
        if (result.check_runs) result.check_runs.push(...more.check_runs);
      }
      return result;
    };
    await run({ request, number: process.env.AUTOPILOT_PR, repo: process.env.GITHUB_REPOSITORY,
      eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      wait: JSON.parse(execFileSync('python3', ['scripts/factory-verifier', 'autopilot-config'], { encoding: 'utf8' })).wait,
      linear: linearReporter({ clientId: process.env.FACTORY_LINEAR_CLIENT_ID,
        clientSecret: process.env.FACTORY_LINEAR_CLIENT_SECRET }) });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
