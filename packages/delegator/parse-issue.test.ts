import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchModel, parseIssue } from './parse-issue.ts';

const repo = '[repo=example/project]';

test('reads level, optional model pin and target from tags', () => {
  assert.deepEqual(parseIssue(`${repo} [level=standard] [model=astra] [target=Orca]`), {
    repo: 'example/project', level: 'standard', model: 'astra', target: 'Orca',
  });
});

for (const [level, expected] of [
  ['light', 'light'], ['standard', 'standard'], ['deep', 'deep'],
  ['1', 'light'], ['2', 'standard'], ['3', 'deep'],
  ['LIGHT', 'light'], ['Standard', 'standard'], ['DeEp', 'deep'],
]) {
  test(`accepts level ${level}`, () => {
    assert.deepEqual(parseIssue(`[level=${level}] ${repo}`), { repo: 'example/project', level: expected });
  });
}

test('reads escaped tags and keeps the first of each kind', () => {
  assert.deepEqual(parseIssue(String.raw`\[level=2\] \[repo=example/project\] \[model=astra\] \[target=Claude\]
[level=deep] [repo=other/repo] [model=luna] [target=Orca]`), {
    repo: 'example/project', level: 'standard', model: 'astra', target: 'Claude',
  });
  assert.deepEqual(parseIssue(`${repo} [level=light] [level=deep] [model=] [model=astra] [target=] [target=Orca]`), {
    repo: 'example/project', level: 'light', model: '', target: '',
  });
});

for (const tags of ['', '[level=]', '[level=unknown] [level=light]', '[level=4]', '[level=standard',
  '```factory-run\nmodel: Example Model\n```']) {
  test(`refuses missing or unknown level: ${JSON.stringify(tags)}`, () => {
    assert.deepEqual(parseIssue(`${repo} ${tags}`), {
      field: 'level', expected: 'a [level=…] tag with 1/light, 2/standard, 3/deep',
    });
  });
}

for (const tag of ['', '[repo=]', '[repo=example]', '[repo=example/project/extra]',
  '[repo=example/project;command]', '[repo=example/my project]', '[repo=example/project']) {
  test(`refuses missing or malformed repo: ${JSON.stringify(tag)}`, () => {
    assert.deepEqual(parseIssue(`[level=standard] ${tag}`), {
      field: 'repo', expected: 'a [repo=owner/name] tag matching ^[\\w.-]+/[\\w.-]+$',
    });
  });
}

test('enforces the repo allowlist without refusing model pins', () => {
  assert.deepEqual(parseIssue(`${repo} [level=standard] [model=unknown]`, { repos: ['example/project'] }), {
    repo: 'example/project', level: 'standard', model: 'unknown',
  });
  assert.deepEqual(parseIssue(`${repo} [level=standard]`, { repos: [] }), {
    field: 'repo', expected: 'a repo on the machine allowlist',
  });
});

test('matches normalized model pins, refusing ambiguous or empty matches', () => {
  const names = ['GPT-6 Astra', 'GPT-6 Luna'];
  for (const pin of ['GPT-6 Astra', 'gpt6astra', 'astra']) {
    assert.equal(matchModel(pin, names), 'GPT-6 Astra');
  }
  for (const pin of ['gpt6', 'unknown', '', '---']) assert.equal(matchModel(pin, names), undefined);
  assert.equal(matchModel('gpt6', ['GPT-6 Astra', 'GPT-6']), 'GPT-6');
});
