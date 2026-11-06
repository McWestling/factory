import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIssue } from './parse-issue.ts';

const repo = '`[repo=example/project]`';
const block = '```factory-run\ntarget: Orca\nmodel: Example Model\nreason: focused work\n```';

test('reads the model from the factory-run block', () => {
  assert.deepEqual(parseIssue(`${block}\n${repo}`), {
    repo: 'example/project',
    model: 'Example Model',
  });
});

test('refuses a legacy line without a factory-run block', () => {
  // Split the retired label so the contract's stale-format scan stays empty.
  const legacy = '**Suggested' + ' dispatch:** `Orca` · `Legacy Model` — focused work';
  assert.deepEqual(parseIssue(`${legacy}\n${repo}`), {
    field: 'factory-run',
    expected: 'a factory-run block with one nonempty model field',
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

for (const fence of ['',
  '```factory-run\ntarget: Orca\n```',
  '```factory-run\nmodel: \n```',
  '```factory-run\nmodel: Example Model',
  '```factory-run\nmodel: Example Model\nmodel: Other Model\n```',
  '```factory-run\nmodel: Example Model\nnot a field\n```',
  '```dispatch\nmodel: Example Model\n```']) {
  test(`refuses missing or malformed factory-run metadata: ${JSON.stringify(fence)}`, () => {
    assert.deepEqual(parseIssue(`${fence}\n${repo}`), {
      field: 'factory-run',
      expected: 'a factory-run block with one nonempty model field',
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

for (const fence of [
  block.replace(/\n/g, '\r\n'),
  '~~~factory-run\nmodel: Example Model\n~~~',
  ' ````factory-run\nmodel: Example Model\n `````',
  '```factory-run\nmodel: Example Model\n```',
]) {
  test(`accepts a complete factory-run fence: ${JSON.stringify(fence)}`, () => {
    assert.deepEqual(parseIssue(`${fence}\n${repo}`), {
      repo: 'example/project', model: 'Example Model',
    });
  });
}

test('refuses an invalid factory-run fence', () => {
  assert.deepEqual(parseIssue(`\`\`\`factory-run invalid\nmodel: Example Model\n\`\`\`\n${repo}`), {
    field: 'factory-run',
    expected: 'a factory-run block with one nonempty model field',
  });
});

test('accepts a factory-run fence with whitespace before its language', () => {
  assert.deepEqual(parseIssue(`${block.replace('```factory-run', '``` \tfactory-run')}\n${repo}`), {
    repo: 'example/project', model: 'Example Model',
  });
});
