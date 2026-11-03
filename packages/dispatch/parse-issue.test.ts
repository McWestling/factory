import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIssue } from './parse-issue.ts';

const repo = '`[repo=example/project]`';
const block = '```dispatch\ntarget: Orca\nmodel: Example Model\nreason: focused work\n```';
const legacy = '**Suggested dispatch:** `Orca` · `Legacy Model` — focused work';

test('reads the model from the dispatch block before the legacy line', () => {
  assert.deepEqual(parseIssue(`${legacy}\n${block}\n${repo}`), {
    repo: 'example/project',
    model: 'Example Model',
  });
});

test('reads the second code span of the legacy Suggested dispatch line', () => {
  assert.deepEqual(parseIssue(`${legacy}\n${repo}`), {
    repo: 'example/project',
    model: 'Legacy Model',
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

for (const dispatch of ['', '**Suggested dispatch:** `Orca`',
  '**Suggested dispatch:** `Orca` · ` `',
  '```dispatch\ntarget: Orca\n```',
  '```dispatch\nmodel: \n```',
  '```dispatch\nmodel: Example Model',
  '```dispatch\nmodel: Example Model\nmodel: Other Model\n```',
  '```dispatch\nmodel: Example Model\nnot a field\n```']) {
  test(`refuses missing or malformed dispatch metadata: ${JSON.stringify(dispatch)}`, () => {
    assert.deepEqual(parseIssue(`${dispatch}\n${repo}`), {
      field: 'dispatch',
      expected: 'a dispatch block with one nonempty model field or a legacy Suggested dispatch line with target and model code spans',
    });
  });
}

test('refuses a malformed block even when a legacy line is available', () => {
  assert.equal('field' in parseIssue(`\`\`\`dispatch\ntarget: Orca\n\`\`\`\n${legacy}\n${repo}`), true);
});

const config = { models: { 'Example Model': {} }, repos: ['example/project'] };

test('accepts a model and repo present in the machine config', () => {
  assert.deepEqual(parseIssue(`${block}\n${repo}`, config), {
    repo: 'example/project', model: 'Example Model',
  });
});

test('refuses a model absent from the machine config', () => {
  assert.deepEqual(parseIssue(`${legacy}\n${repo}`, config), {
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

test('refuses an invalid dispatch fence instead of using the legacy line', () => {
  assert.deepEqual(parseIssue(`\`\`\`dispatch invalid\nmodel: Example Model\n\`\`\`\n${legacy}\n${repo}`), {
    field: 'dispatch',
    expected: 'a dispatch block with one nonempty model field or a legacy Suggested dispatch line with target and model code spans',
  });
});
