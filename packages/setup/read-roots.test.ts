import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeReadVerdict, codexReadVerdict, grantClaudeReads, readRule } from './read-roots.ts';

/** A temp home with Claude settings holding the given text, or none. */
function home(text?: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'read-roots-')));
  mkdirSync(join(dir, '.claude'));
  const path = join(dir, '.claude/settings.json');
  if (text !== undefined) writeFileSync(path, text, { mode: 0o644 });
  return { dir, path, read: () => readFileSync(path, 'utf8') };
}

test('read rules use the absolute-root form and escape literal glob characters', () => {
  assert.equal(readRule('/Users/me/My Code'), 'Read(//Users/me/My Code/**)');
  assert.equal(readRule('/a/[x]*?{y}\\z'), 'Read(//a/\\[x\\]\\*\\?\\{y\\}\\\\z/**)');
});

test('a missing settings file is created with only the read rules', () => {
  const h = home();
  assert.ok(grantClaudeReads(h.path, ['/a', '/b b'], h.dir).ok);
  assert.deepEqual(JSON.parse(h.read()), { permissions: { allow: ['Read(//a/**)', 'Read(//b b/**)'] } });
});

test('a root with glob characters is granted once across repeat runs', () => {
  const h = home('{}');
  grantClaudeReads(h.path, ['/a/[x]'], h.dir);
  const once = h.read();
  assert.match(grantClaudeReads(h.path, ['/a/[x]'], h.dir).line, /already grants them/);
  assert.equal(h.read(), once);
});

test('roots an existing grant covers get nothing new', () => {
  const h = home('');
  for (const permissions of [
    { allow: [readRule(h.dir)] },
    { allow: ['Read(~/Code/**)'] },
    { allow: ['Read'] },
    { allow: ['Read(~/**)'] },
    { allow: ['Read(//**)'] },
    { additionalDirectories: ['~/Code'] },
  ]) {
    const text = JSON.stringify({ permissions });
    writeFileSync(h.path, text);
    assert.match(grantClaudeReads(h.path, [join(h.dir, 'Code'), join(h.dir, 'Code/sub')], h.dir).line, /already grants them/, text);
    assert.equal(h.read(), text, text);
  }
});

test('a narrower or glob grant is not mistaken for one covering the root', () => {
  const h = home(JSON.stringify({ permissions: { allow: ['Read(//a/sub/**)', 'Read(//a/*/**)', 'Read(//ab/**)', 'Read(~a/**)', 'Read(/a/**)'] } }));
  assert.match(grantClaudeReads(h.path, ['/a'], h.dir).line, /added Read\(\/\/a\/\*\*\)/);
  // Unescaped, [x] is a character class matching /a/x, not the folder literally named [x].
  writeFileSync(h.path, JSON.stringify({ permissions: { allow: ['Read(//a/[x]/**)'] } }));
  assert.match(grantClaudeReads(h.path, ['/a/[x]'], h.dir).line, /added Read\(\/\/a\/\\\[x\\\]\/\*\*\)/);
});

test('stricter existing restrictions are reported and nothing is written', () => {
  const h = home();
  for (const [permissions, message] of [
    [{ deny: ['Read(//a/**)'] }, /deny Read\(\/\/a\/\*\*\) covers \/a\/repo/],
    [{ ask: ['Read'] }, /ask Read covers \/a\/repo/],
    [{ deny: ['Read(//**)'] }, /deny Read\(\/\/\*\*\) covers/],
    [{ blockReadsOutsideWorkingDirectories: true }, /blockReadsOutsideWorkingDirectories/],
  ] as const) {
    const text = JSON.stringify({ permissions });
    writeFileSync(h.path, text);
    const result = grantClaudeReads(h.path, ['/a/repo'], h.dir);
    assert.equal(result.ok, false, text);
    assert.match(result.line, message);
    assert.match(result.line, /won't weaken/);
    assert.equal(h.read(), text, 'leaves the settings untouched');
  }
});

test('narrower restrictions stay in place beside the new grant', () => {
  const h = home(JSON.stringify({ permissions: { deny: ['Read(**/.env)', 'Read(//a/secrets/**)'], ask: ['Bash(rm *)'] } }));
  assert.ok(grantClaudeReads(h.path, ['/a'], h.dir).ok);
  assert.deepEqual(JSON.parse(h.read()).permissions, { deny: ['Read(**/.env)', 'Read(//a/secrets/**)'], ask: ['Bash(rm *)'], allow: ['Read(//a/**)'] });
});

test('malformed settings fail without being replaced', () => {
  for (const text of ['{"permissions": {', '[]', '"x"', '{"permissions": []}', '{"permissions": {"allow": "Read"}}', '{"permissions": {"deny": [1]}}']) {
    const h = home(text);
    const result = grantClaudeReads(h.path, ['/a'], h.dir);
    assert.equal(result.ok, false, text);
    assert.match(result.line, /Nothing was changed/);
    assert.equal(h.read(), text);
  }
});

test('symlinked settings are updated through the link, keeping the link and the file mode', () => {
  const h = home();
  const dotfiles = join(h.dir, 'dotfiles/claude-settings.json');
  mkdirSync(join(h.dir, 'dotfiles'));
  writeFileSync(dotfiles, JSON.stringify({ model: 'opus' }), { mode: 0o640 });
  symlinkSync(dotfiles, h.path);
  const result = grantClaudeReads(h.path, ['/a'], h.dir);
  assert.match(result.line, new RegExp(`a link to ${dotfiles}`));
  assert.ok(lstatSync(h.path).isSymbolicLink());
  assert.equal(readlinkSync(h.path), dotfiles);
  assert.equal(statSync(dotfiles).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(readFileSync(dotfiles, 'utf8')), { model: 'opus', permissions: { allow: ['Read(//a/**)'] } });
});

test('a link to a missing settings file is refused', () => {
  const h = home();
  symlinkSync(join(h.dir, 'gone.json'), h.path);
  const result = grantClaudeReads(h.path, ['/a'], h.dir);
  assert.match(result.line, /link to a missing file/);
  assert.ok(lstatSync(h.path).isSymbolicLink());
});

const probes = [{ path: '/a/.factory-read-probe-1/probe.txt', nonce: 'factory-read-1' }, { path: '/b/.factory-read-probe-2/probe.txt', nonce: 'factory-read-2' }];
const claude = (events: object[]) => [...events, { type: 'result', is_error: false, result: 'done', permission_denials: [] }].map((event) => JSON.stringify(event)).join('\n');
const read = (id: string, path: string, content: string, isError = false) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } },
];

test('Claude read verification needs each probe read with its nonce, and Read calls only', () => {
  assert.equal(claudeReadVerdict(claude([...read('1', probes[0]!.path, '1\tfactory-read-1'), ...read('2', probes[1]!.path, '1\tfactory-read-2')]), probes), null);
  for (const [label, stdout, message] of [
    ['one probe unread', claude(read('1', probes[0]!.path, '1\tfactory-read-1')), /couldn't read \/b\//],
    ['a made-up answer', claude([{ type: 'assistant', message: { content: [{ type: 'text', text: 'factory-read-1 factory-read-2' }] } }]), /couldn't read \/a\/.*\/b\//],
    ['the nonce for the wrong file', claude([...read('1', probes[0]!.path, 'factory-read-2'), ...read('2', probes[1]!.path, 'factory-read-1')]), /couldn't read \/a\/.*\/b\//],
    ['a denied read', claude(read('1', probes[0]!.path, 'Claude requested permissions', true)).replace('"permission_denials":[]', '"permission_denials":[{}]'), /denied permission/],
    ['another tool', claude([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } }]), /other than Read \(Bash\)/],
    ['malformed output', 'nope', /malformed/],
    ['a run cut short', JSON.stringify(read('1', probes[0]!.path, 'factory-read-1')[0]), /without a complete run/],
  ] as const) assert.match(String(claudeReadVerdict(stdout, probes)), message, label);
});

const codex = (items: object[]) => [{ type: 'turn.started' }, ...items.map((item) => ({ type: 'item.completed', item })), { type: 'turn.completed' }]
  .map((event) => JSON.stringify(event)).join('\n');
const cat = (output: string, status = 'completed') => ({ type: 'command_execution', command: 'cat', aggregated_output: output, exit_code: 0, status });

test('Codex read verification needs each nonce in a completed command, and no edits', () => {
  assert.equal(codexReadVerdict(codex([cat('factory-read-1\nfactory-read-2\n'), { type: 'agent_message', text: 'done' }]), probes), null);
  for (const [label, stdout, message] of [
    ['one probe unread', codex([cat('factory-read-1\n')]), /couldn't read \/b\//],
    ['a failed command', codex([cat('factory-read-1\nfactory-read-2\n', 'failed')]), /couldn't read \/a\//],
    ['a file change', codex([cat('factory-read-1\nfactory-read-2\n'), { type: 'file_change', changes: [] }]), /other than read \(file_change\)/],
    ['a turn cut short', codex([]).split('\n').slice(0, -1).join('\n'), /without a complete turn/],
  ] as const) assert.match(String(codexReadVerdict(stdout, probes)), message, label);
});

test('checking existing grants never writes missing grants or ignores invalid settings', () => {
  for (const text of ['{}', '{', JSON.stringify({ permissions: { allow: ['Read'], deny: ['Read'] } })]) {
    const h = home(text);
    assert.equal(grantClaudeReads(h.path, [h.dir], h.dir, true).ok, false);
    assert.equal(h.read(), text);
  }
});
