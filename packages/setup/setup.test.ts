import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeVerdict, codexVerdict, setup, type SetupDeps } from './setup.ts';

const HEAD = 'b'.repeat(40);
const SUPPORT = ['grilling', 'domain-modeling', 'research', 'prototype', 'tdd', 'codebase-design', 'code-review'];
const WHOAMI = JSON.stringify({ user: { id: 'user-id', email: 'person@example.com' }, workspace: { id: 'ws-id' } });

/** Claude's stream-json for one run: init, then the given tool calls and their results, then a result event. */
function claudeRun({ skills = ['do-a', 'do-b', ...SUPPORT.map((name) => `mattpocock-skills:${name}`)],
  status = 'connected', calls = [{ name: 'mcp__claude_ai_Linear__whoami', result: WHOAMI }] as { name: string; result: string; isError?: boolean }[] } = {}) {
  const events: object[] = [{ type: 'system', subtype: 'init', skills, mcp_servers: [{ name: 'claude.ai Linear', status }] }];
  calls.forEach((call, index) => {
    events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${index}`, name: call.name, input: {} }] } });
    events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${index}`, is_error: call.isError ?? false, content: [{ type: 'text', text: call.result }] }] } });
  });
  events.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }, { type: 'result', subtype: 'success', is_error: false, result: 'done' });
  return events.map((event) => JSON.stringify(event)).join('\n');
}

/** Codex exec --json for one run. */
function codexRun({ items = [{ type: 'mcp_tool_call', server: 'linear', tool: 'whoami', status: 'completed', error: null, result: { content: [{ type: 'text', text: WHOAMI }] } }] as object[] } = {}) {
  return [{ type: 'thread.started' }, { type: 'turn.started' }, ...items.map((item) => ({ type: 'item.completed', item })),
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, { type: 'turn.completed' }].map((event) => JSON.stringify(event)).join('\n');
}

/** A disposable Mac: a fixture fork checkout and a temp home, with every CLI faked. */
function machine({ agents = ['claude'], installed = ['claude', 'codex'] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'setup-'));
  const root = join(home, 'factory');
  for (const name of ['do-a', 'do-b']) {
    mkdirSync(join(root, 'skills', name), { recursive: true });
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), `# ${name}`);
  }
  const lock = join(home, '.agents/.skill-lock.json');
  mkdirSync(join(home, '.agents'), { recursive: true });
  writeFileSync(lock, JSON.stringify({ skills: { 'someone-elses': { source: 'other/repo', skillFolderHash: 'keep' } } }));
  const m = {
    home, root, lock, installed,
    git: { origin: 'git@github.com:Someone/factory.git', status: '', head: HEAD, tip: HEAD },
    gh: true,
    /** Supporting-skill state per agent: 'plugin', 'cli' or 'none'. */
    support: { claude: 'none', codex: 'none', cursor: 'none' } as Record<string, string>,
    claude: claudeRun(),
    codex: codexRun(),
    codexSkills: ['do-a', 'do-b', ...SUPPORT.map((name) => `mattpocock-skills:${name}`)],
    calls: [] as string[],
    output: [] as string[],
    answers: [] as string[],
    deps: undefined as unknown as SetupDeps,
  };
  const fail = (stderr: string, stdout = '') => Object.assign(new Error('exit 1'), { stderr, stdout });
  const display: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
  const bins: Record<string, string> = { claude: 'claude', codex: 'codex', agent: 'cursor' };
  m.deps = {
    home, root, stateDir: join(home, '.local/state/factory'), node: '/usr/bin/node', uid: 501,
    platform: 'darwin', nodeVersion: '26.7.0', agents,
    sleep: async () => {},
    print: (line) => m.output.push(line),
    ask: null,
    async rpc(file, args, messages) {
      m.calls.push(`${file} ${args.join(' ')} ${messages.map((message) => (message as { method: string }).method).join(',')}`);
      return [{}, { data: [{ skills: m.codexSkills.map((name) => ({ name, enabled: true })) }] }];
    },
    async exec(file, args) {
      const call = `${file} ${args.join(' ')}`;
      m.calls.push(call);
      if (bins[file] && args[0] === '--version') {
        if (!m.installed.includes(bins[file]!)) throw fail(`${file}: command not found`);
        return { stdout: '1.0.0' };
      }
      if (file === 'swiftc' || call === 'git --version') return { stdout: 'ok' };
      if (file === 'gh') { if (!m.gh) throw fail('You are not logged into any GitHub hosts.'); return { stdout: '' }; }
      if (file === 'git') {
        const [, , command, ...rest] = args;
        if (command === 'remote') return { stdout: m.git.origin };
        if (command === '--no-optional-locks') return { stdout: m.git.status };
        if (command === 'rev-parse' && rest[0] === 'HEAD') return { stdout: m.git.head };
        if (command === 'rev-parse') return { stdout: `tree-${rest[0]!.split('/').pop()}` };
        if (command === 'ls-remote') return { stdout: `ref: refs/heads/main\tHEAD\n${m.git.tip}\tHEAD\n` };
      }
      if (file === 'npx' && args.includes('ls')) {
        return { stdout: JSON.stringify(Object.entries(m.support).filter(([, form]) => form === 'cli')
          .flatMap(([agent]) => SUPPORT.map((name) => ({ name, source: 'mattpocock/skills', agents: [display[agent]] })))) };
      }
      if (file === 'npx' && args.includes('add')) {
        const repo = args[args.indexOf('add') + 1]!;
        if (repo === 'mattpocock/skills') return { stdout: '' };
        const value = JSON.parse(readFileSync(lock, 'utf8'));
        for (const name of ['do-a', 'do-b']) value.skills[name] = { source: repo, skillFolderHash: `tree-${name}` };
        writeFileSync(lock, JSON.stringify(value));
        return { stdout: '' };
      }
      if (call === 'claude plugin list --json') {
        return { stdout: JSON.stringify(m.support.claude === 'plugin' ? [{ id: 'mattpocock-skills@claude-plugins-official', enabled: true }] : []) };
      }
      if (call === 'codex plugin list --json') {
        return { stdout: JSON.stringify({ installed: m.support.codex === 'plugin' ? [{ pluginId: 'mattpocock-skills@mattpocock', enabled: true }] : [] }) };
      }
      if (call === 'codex mcp list --json') return { stdout: JSON.stringify([{ name: 'linear', enabled: true, transport: { url: 'https://mcp.linear.app/mcp' } }]) };
      if (file === 'claude' && args[0] === '-p') return { stdout: m.claude };
      if (file === 'codex' && args[0] === 'exec') return { stdout: m.codex };
      if (file === 'claude' || file === 'codex') return { stdout: '' };
      throw fail(`unexpected call: ${call}`);
    },
  };
  return { ...m, m, run: () => setup(m.deps) };
}

const changes = (calls: string[]) => calls.filter((call) => / (add|install|update|upgrade|remove|uninstall) /.test(` ${call} `) && !call.startsWith('git '));

test('a fresh install from a fork installs Factory and supporting skills for the chosen agent only, then verifies it', async () => {
  const mac = machine();
  assert.equal(await mac.run(), 0, mac.m.output.join('\n'));
  assert.deepEqual(changes(mac.m.calls), [
    "npx --yes skills add Someone/factory -g -y --skill * -a claude-code",
    'claude plugin install mattpocock-skills@claude-plugins-official',
  ]);
  const lock = JSON.parse(readFileSync(mac.lock, 'utf8')).skills;
  assert.equal(lock['someone-elses'].skillFolderHash, 'keep');
  assert.ok(mac.m.calls.some((call) => call.startsWith('claude -p ')), 'starts a fresh Claude process');
  assert.ok(!mac.m.calls.some((call) => call.startsWith('codex exec')), "doesn't touch the unselected agent");
  assert.ok(!mac.m.output.join('\n').includes('person@example.com'), 'never prints the identity payload');
  assert.match(mac.m.output.at(-1)!, /^claude: verified/);
});

test('a repeat install keeps each agent on its existing form and leaves unselected agents alone', async () => {
  const mac = machine({ agents: ['claude', 'codex'], installed: ['claude', 'codex', 'cursor'] });
  mac.m.support = { claude: 'plugin', codex: 'cli', cursor: 'cli' };
  mac.m.codexSkills = ['do-a', 'do-b', ...SUPPORT];
  assert.equal(await mac.run(), 0, mac.m.output.join('\n'));
  assert.equal(await mac.run(), 0, 'and again');
  const once = [
    'npx --yes skills add Someone/factory -g -y --skill * -a claude-code codex',
    'claude plugin update mattpocock-skills@claude-plugins-official',
    'npx --yes skills add mattpocock/skills --skill * -g -a codex -y',
  ];
  assert.deepEqual(changes(mac.m.calls), [...once, ...once]);
  assert.ok(!mac.m.calls.some((call) => / -a .*cursor|^agent (?!--version)/.test(call)), 'Cursor is never touched');
});

test('missing prerequisites refuse before anything changes', async () => {
  const mac = machine({ agents: ['claude', 'codex'], installed: ['claude'] });
  mac.m.gh = false;
  mac.m.deps.nodeVersion = '22.19.0';
  assert.equal(await mac.run(), 1);
  assert.deepEqual(changes(mac.m.calls), []);
  const output = mac.m.output.join('\n');
  assert.match(output, /Node 22\.19\.0 is too old/);
  assert.match(output, /gh auth login/);
  assert.match(output, /codex: the codex command is missing/);
  assert.ok(!mac.m.calls.some((call) => call.startsWith('git -C')), 'reads no checkout state');
});

test('an existing Runner needs its build tools checked too', async () => {
  const mac = machine();
  mkdirSync(join(mac.home, 'Applications/Factory Runner.app'), { recursive: true });
  mac.m.deps.nodeVersion = '24.1.0';
  assert.equal(await mac.run(), 1);
  assert.match(mac.m.output.join('\n'), /Runner needs Node 26/);
  assert.deepEqual(changes(mac.m.calls), []);
});

test('setup refuses off macOS without touching anything', async () => {
  const mac = machine();
  mac.m.deps.platform = 'linux';
  assert.equal(await mac.run(), 1);
  assert.deepEqual(mac.m.calls, []);
  assert.match(mac.m.output[0]!, /macOS only/);
});

test('no agent named and none found is a prerequisite failure', async () => {
  const mac = machine({ agents: [], installed: [] });
  assert.equal(await mac.run(), 1);
  assert.match(mac.m.output[0]!, /No agent CLI found/);
});

test('with no agents named, setup picks every agent CLI it finds', async () => {
  const mac = machine({ agents: [], installed: ['codex'] });
  assert.equal(await mac.run(), 0, mac.m.output.join('\n'));
  assert.equal(changes(mac.m.calls)[0], 'npx --yes skills add Someone/factory -g -y --skill * -a codex');
});

for (const [origin, repo] of [
  ['https://github.com/Someone/factory.git', 'Someone/factory'],
  ['https://github.com/Someone/factory', 'Someone/factory'],
  ['ssh://git@github.com/someone/my.factory.git', 'someone/my.factory'],
]) {
  test(`origin ${origin} installs from ${repo}`, async () => {
    const mac = machine();
    mac.m.git.origin = origin;
    assert.equal(await mac.run(), 0, mac.m.output.join('\n'));
    assert.match(changes(mac.m.calls)[0]!, new RegExp(` add ${repo.replace('.', '\\.')} `));
  });
}

for (const [label, change, message] of [
  ['a non-GitHub origin', (mac: ReturnType<typeof machine>) => { mac.m.git.origin = 'https://gitlab.com/someone/factory.git'; }, /isn't a GitHub repo/],
  ['a dirty checkout', (mac: ReturnType<typeof machine>) => { mac.m.git.status = '?? notes.txt'; }, /uncommitted or untracked/],
  ['a checkout behind origin', (mac: ReturnType<typeof machine>) => { mac.m.git.tip = 'c'.repeat(40); }, /isn't origin's main/],
] as const) {
  test(`${label} refuses before anything changes`, async () => {
    const mac = machine();
    change(mac);
    assert.equal(await mac.run(), 1);
    assert.match(mac.m.output.join('\n'), message);
    assert.deepEqual(changes(mac.m.calls), []);
  });
}

test('an agent with both the plugin and bare supporting skills is reported, not changed', async () => {
  const mac = machine();
  mac.m.support.claude = 'plugin';
  mac.m.deps.exec = ((exec) => async (file: string, args: string[], timeout: number) => {
    if (file === 'npx' && args.includes('ls')) {
      return { stdout: JSON.stringify(SUPPORT.map((name) => ({ name, source: 'mattpocock/skills', agents: ['Claude Code', 'Codex'] }))) };
    }
    return exec(file, args, timeout);
  })(mac.m.deps.exec);
  assert.equal(await mac.run(), 1);
  assert.match(mac.m.output.join('\n'), /supporting skills \(claude\): both the mattpocock-skills plugin and bare skills/);
  assert.deepEqual(changes(mac.m.calls), ['npx --yes skills add Someone/factory -g -y --skill * -a claude-code']);
});

test("a CLI install that would expose bare skills to Codex's plugin is deferred", async () => {
  const mac = machine({ agents: ['cursor'], installed: ['cursor', 'codex'] });
  mac.m.support.codex = 'plugin';
  assert.equal(await mac.run(), 1);
  assert.match(mac.m.output.join('\n'), /supporting skills \(cursor\): not installed\. The skills CLI would also expose bare copies to Codex/);
  assert.deepEqual(changes(mac.m.calls), ['npx --yes skills add Someone/factory -g -y --skill * -a cursor']);
  assert.match(mac.m.output.at(-1)!, /^cursor: verification unsupported/);
});

const factory = ['do-a', 'do-b'];

test('Claude verification accepts only one real whoami result from a connected Linear server', () => {
  assert.equal(claudeVerdict(claudeRun(), factory), null);
  assert.equal(claudeVerdict(claudeRun({ skills: ['do-a', 'do-b', ...SUPPORT] }), factory), null, 'bare supporting skills count');
  assert.equal(claudeVerdict(claudeRun({ calls: [{ name: 'mcp__claude_ai_Linear__whoami', result: 'Unauthorized', isError: true },
    { name: 'mcp__claude_ai_Linear__whoami', result: WHOAMI }] }), factory), null, 'a repeated whoami is fine once one answers');
  for (const [label, stdout, message] of [
    ['fabricated success', claudeRun({ calls: [] }), /done without calling Linear whoami/],
    ['a failed call', claudeRun({ calls: [{ name: 'mcp__claude_ai_Linear__whoami', result: 'Unauthorized', isError: true }] }), /whoami call failed/],
    ['a result with no Linear user', claudeRun({ calls: [{ name: 'mcp__claude_ai_Linear__whoami', result: '{"ok":true}' }] }), /whoami call failed/],
    ['a stray tool', claudeRun({ calls: [{ name: 'mcp__claude_ai_Linear__save_issue', result: WHOAMI }] }), /other than Linear whoami \(mcp__claude_ai_Linear__save_issue\)/],
    ['an unauthenticated server', claudeRun({ status: 'needs-auth' }), /is needs-auth\. Run claude, type \/mcp, and authenticate claude\.ai Linear/],
    ['a missing Factory skill', claudeRun({ skills: ['do-a', ...SUPPORT] }), /can't discover: do-b/],
    ['a partial supporting set', claudeRun({ skills: ['do-a', 'do-b', ...SUPPORT.slice(1)] }), /can't discover: grilling/],
    ['a signed-out Claude', [JSON.stringify({ type: 'system', subtype: 'init', skills: [], mcp_servers: [] }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })].join('\n'), /^claude failed: Not logged in · Please run \/login$/],
    ['malformed output', 'not json', /malformed output/],
    ['a run cut short', claudeRun().split('\n').slice(0, -1).join('\n'), /without a complete run/],
  ] as const) {
    assert.match(String(claudeVerdict(stdout, factory)), message, label);
  }
  assert.match(String(claudeVerdict(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }), factory)), /without a complete run/, 'a success exit alone');
});

test('Codex verification accepts only one completed whoami on its Linear server', () => {
  assert.equal(codexVerdict(codexRun(), 'linear'), null);
  const whoami = { type: 'mcp_tool_call', server: 'linear', tool: 'whoami', status: 'completed', error: null, result: { content: [{ type: 'text', text: WHOAMI }] } };
  assert.equal(codexVerdict(codexRun({ items: [whoami, whoami] }), 'linear'), null, 'a repeated whoami is fine');
  for (const [label, stdout, message] of [
    ['fabricated success', codexRun({ items: [] }), /done without calling Linear whoami/],
    ['a failed call', codexRun({ items: [{ type: 'mcp_tool_call', server: 'linear', tool: 'whoami', status: 'failed', error: { message: 'auth' }, result: null }] }), /codex mcp login linear/],
    ['a shell command', codexRun({ items: [{ type: 'command_execution', command: 'curl' }] }), /other than Linear whoami \(command_execution\)/],
    ['another server', codexRun({ items: [{ type: 'mcp_tool_call', server: 'other', tool: 'whoami', status: 'completed', result: { content: [{ type: 'text', text: WHOAMI }] } }] }), /other than Linear whoami/],
    ['malformed output', '{"type":', /malformed output/],
    ['a turn cut short', codexRun().split('\n').slice(0, -1).join('\n'), /without a complete turn/],
  ] as const) {
    assert.match(String(codexVerdict(stdout, 'linear')), message, label);
  }
});

test('a failed verification fails setup, and a missing Codex skill is named', async () => {
  const mac = machine({ agents: ['codex'] });
  mac.m.codexSkills = ['do-a', ...SUPPORT.map((name) => `mattpocock-skills:${name}`)];
  assert.equal(await mac.run(), 1);
  assert.match(mac.m.output.at(-1)!, /^codex: codex can't discover: do-b/);
  assert.ok(!mac.m.calls.some((call) => call.startsWith('codex exec')), 'skips the Linear call once skills are missing');
});

test('a timed-out agent fails verification', async () => {
  const mac = machine();
  mac.m.deps.exec = ((exec) => async (file: string, args: string[], timeout: number) => {
    if (file === 'claude' && args[0] === '-p') throw Object.assign(new Error('timeout'), { killed: true, stdout: '' });
    return exec(file, args, timeout);
  })(mac.m.deps.exec);
  assert.equal(await mac.run(), 1);
  assert.match(mac.m.output.at(-1)!, /^claude: couldn't run the check \(claude timed out\)/);
});

test('Cursor verification is reported unsupported, so setup fails', async () => {
  const mac = machine({ agents: ['cursor'], installed: ['cursor'] });
  assert.equal(await mac.run(), 1);
  assert.match(mac.m.output.at(-1)!, /^cursor: verification unsupported/);
});

test('at a terminal, setup waits for the fix and verifies again', async () => {
  const mac = machine();
  mac.m.claude = claudeRun({ status: 'needs-auth' });
  mac.m.deps.ask = async () => { mac.m.claude = claudeRun(); return ''; };
  assert.equal(await mac.run(), 0, mac.m.output.join('\n'));
  assert.match(mac.m.output.join('\n'), /needs-auth[\s\S]*claude: verified/);
  assert.equal(mac.m.calls.filter((call) => call.startsWith('claude -p')).length, 2);
});
