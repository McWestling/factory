import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchModel, parseIssue } from './parse-issue.ts';

const repo = '[repo=example/project]';

test('reads level and optional model pin from tags', () => {
  assert.deepEqual(parseIssue(`${repo} [level=standard] [model=astra]`), {
    repo: 'example/project', level: 'standard', model: 'astra',
  });
});

for (const [level, expected] of [
  ['light', 'light'], ['standard', 'standard'], ['deep', 'deep'],
  ['LIGHT', 'light'], ['Standard', 'standard'], ['DeEp', 'deep'],
]) {
  test(`accepts level ${level}`, () => {
    assert.deepEqual(parseIssue(`[level=${level}] ${repo}`), {
      repo: 'example/project', level: expected, model: undefined,
    });
  });
}

test('reads escaped tags and keeps the first valid value of each kind', () => {
  assert.deepEqual(parseIssue(String.raw`\[level=\] \[level=DEEP\] \[repo=invalid\] \[repo=example/project\] \[model=astra\]
[level=deep] [repo=other/repo] [model=luna]`), {
    repo: 'example/project', level: 'deep', model: 'astra',
  });
  assert.deepEqual(parseIssue(`${repo} [level=light] [level=deep] [model=] [model=astra]`), {
    repo: 'example/project', level: 'light', model: 'astra',
  });
});

for (const tags of ['[level=] [level=light]', '[level=light|standard|deep] [level=light]',
  '[level=unknown] [level=light]', '[level=2] [level=light]']) {
  test(`skips invalid levels: ${tags}`, () => {
    assert.deepEqual(parseIssue(`${repo} ${tags}`), {
      repo: 'example/project', level: 'light', model: undefined,
    });
  });
}

test('skips an example level before deep', () => {
  assert.deepEqual(parseIssue(`${repo} [level=light|standard|deep] [level=deep]`), {
    repo: 'example/project', level: 'deep', model: undefined,
  });
});

for (const tags of ['', '[level=]', '[level=unknown]', '[level=1]', '[level=2]', '[level=3]', '[level=4]', '[level=standard',
  '```factory-run\nmodel: Example Model\n```']) {
  test(`refuses missing or unknown level: ${JSON.stringify(tags)}`, () => {
    assert.deepEqual(parseIssue(`${repo} ${tags}`), {
      field: 'level', expected: 'a [level=…] tag with light, standard or deep',
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

test('skips blank and malformed repos before the first valid repo', () => {
  assert.deepEqual(parseIssue(`[level=standard] [repo=] [repo=example] ${repo} [repo=other/repo]`), {
    repo: 'example/project', level: 'standard', model: undefined,
  });
});

test('accepts unknown model pins', () => {
  assert.deepEqual(parseIssue(`${repo} [level=standard] [model=unknown]`), {
    repo: 'example/project', level: 'standard', model: 'unknown',
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
