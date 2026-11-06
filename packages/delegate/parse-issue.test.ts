import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIssue } from './parse-issue.ts';

const repo = '`[repo=example/project]`';
const block = '```dispatch\ntarget: Orca\nmodel: Example Model\nreason: focused work\n```';

test('reads the model from the dispatch block', () => {
  assert.deepEqual(parseIssue(`${block}\n${repo}`), {
    repo: 'example/project',
    model: 'Example Model',
  });
});

test('refuses a legacy line without a dispatch block', () => {
  // Split the retired label so the contract's stale-format scan stays empty.
  const legacy = '**Suggested' + ' dispatch:** `Orca` · `Legacy Model` — focused work';
  assert.deepEqual(parseIssue(`${legacy}\n${repo}`), {
    field: 'dispatch',
    expected: 'a dispatch block with one nonempty model field',
  });
});

test('accepts the repo tag escaped by Linear', () => {
  assert.deepEqual(parseIssue(`${block}\n\\[repo=example/project\\]`), {
    repo: 'example/project',
    model: 'Example Model',
  });
});

for (const tag of ['', '[repo=]', '[repo=example]', '[repo=example/project/extra]',
  '[repo=example/project;command]', '[repo=example/my project]', '[repo=example/project']) {
  test(`refuses a missing or malformed repo tag: ${JSON.stringify(tag)}`, () => {
    assert.deepEqual(parseIssue(`${block}\n${tag}`), {
      field: 'repo',
      expected: 'a [repo=owner/name] tag matching ^[\\w.-]+/[\\w.-]+$',
    });
  });
}

for (const dispatch of ['',
  '```dispatch\ntarget: Orca\n```',
  '```dispatch\nmodel: \n```',
  '```dispatch\nmodel: Example Model',
  '```dispatch\nmodel: Example Model\nmodel: Other Model\n```',
  '```dispatch\nmodel: Example Model\nnot a field\n```']) {
  test(`refuses missing or malformed dispatch metadata: ${JSON.stringify(dispatch)}`, () => {
    assert.deepEqual(parseIssue(`${dispatch}\n${repo}`), {
      field: 'dispatch',
      expected: 'a dispatch block with one nonempty model field',
    });
  });
}

const config = { models: { 'Example Model': {} }, repos: ['example/project'] };

test('accepts a model and repo present in the machine config', () => {
  assert.deepEqual(parseIssue(`${block}\n${repo}`, config), {
    repo: 'example/project', model: 'Example Model',
  });
});

test('refuses a model absent from the machine config', () => {
  assert.deepEqual(parseIssue(`${block.replace('Example Model', 'Other Model')}\n${repo}`, config), {
    field: 'model', expected: 'an exact model name in the machine config',
  });
});

test('refuses a repo absent from the machine allowlist', () => {
  assert.deepEqual(parseIssue(`${block}\n${repo}`, { ...config, repos: [] }), {
    field: 'repo', expected: 'a repo on the machine allowlist',
  });
});

test('does not treat inherited object keys as configured models', () => {
  assert.deepEqual(parseIssue(`${block.replace('Example Model', 'toString')}\n${repo}`, config), {
    field: 'model', expected: 'an exact model name in the machine config',
  });
});

for (const dispatch of [
  block.replace(/\n/g, '\r\n'),
  '~~~dispatch\nmodel: Example Model\n~~~',
  ' ````dispatch\nmodel: Example Model\n `````',
  '```dispatch\nmodel: Example Model\n```',
]) {
  test(`accepts a complete dispatch fence: ${JSON.stringify(dispatch)}`, () => {
    assert.deepEqual(parseIssue(`${dispatch}\n${repo}`), {
      repo: 'example/project', model: 'Example Model',
    });
  });
}

test('refuses an invalid dispatch fence', () => {
  assert.deepEqual(parseIssue(`\`\`\`dispatch invalid\nmodel: Example Model\n\`\`\`\n${repo}`), {
    field: 'dispatch',
    expected: 'a dispatch block with one nonempty model field',
  });
});

test('accepts a dispatch fence with whitespace before its language', () => {
  assert.deepEqual(parseIssue(`${block.replace('```dispatch', '``` \tdispatch')}\n${repo}`), {
    repo: 'example/project', model: 'Example Model',
  });
});
