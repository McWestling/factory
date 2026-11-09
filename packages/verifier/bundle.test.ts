import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const source = new URL('./', import.meta.url);
test('bundle copies executable source and rejects stale content or permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'verifier-bundle-'));
  try {
    cpSync(source, join(root, 'packages/verifier'), { recursive: true });
    const script = join(root, 'packages/verifier/bundle.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(run('--check').status, 0);
    assert.equal(run().status, 0);
    assert.equal(run('--check').status, 0);
    const bundle = join(root, 'skills/do-factory-setup/verifier/factory-verifier');
    writeFileSync(bundle, 'stale');
    assert.notEqual(run('--check').status, 0);
    assert.equal(run().status, 0);
    chmodSync(bundle, 0o644);
    assert.notEqual(run('--check').status, 0);
    assert.equal(run().status, 0);
    assert.equal(run('--check').status, 0);
    assert.deepEqual(readFileSync(bundle), readFileSync(new URL('factory-verifier', source)));
    const workflow = join(root, 'skills/do-factory-setup/verifier/factory-verifier.yml');
    assert.deepEqual(readFileSync(workflow), readFileSync(new URL('factory-verifier.yml', source)));
    writeFileSync(workflow, 'stale');
    assert.notEqual(run('--check').status, 0);
    assert.equal(run().status, 0);
    rmSync(workflow);
    assert.notEqual(run('--check').status, 0);
    assert.equal(run().status, 0);
    chmodSync(workflow, 0o755);
    assert.notEqual(run('--check').status, 0);
    assert.equal(run().status, 0);
    assert.equal(run('--check').status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('report job includes failed and timed-out checks but excludes successful checks', async () => {
  const workflow = readFileSync(new URL('factory-verifier.yml', source), 'utf8');
  const script = workflow.split('          script: |\n')[1].split('      - name: Report failures')[0];
  const context = {
    repo: { owner: 'example', repo: 'repo' }, sha: 'head',
    serverUrl: 'https://github.com', runId: 42,
  };
  const runs = ['failure', 'timed_out', 'success'].map(conclusion => ({
    name: conclusion, conclusion, app: { slug: 'github-actions' },
    details_url: 'https://github.com/example/repo/actions/runs/42/job/1',
  }));
  const outputs: Record<string, string> = {};
  const execute = new Function('github', 'context', 'require', 'core',
    `return (async () => { ${script} })()`);
  await execute({ rest: { checks: { listForRef: 'listForRef' } }, paginate: async () => runs },
    context, () => ({ execFileSync: () => JSON.stringify({ checks: ['failure', 'timed_out', 'success'] }) }),
    { setOutput: (name: string, value: string) => { outputs[name] = value; } });
  assert.deepEqual(outputs, { checks: 'failure,timed_out' });
  assert.ok(workflow.includes('FAILED_CHECKS: ${{ steps.failures.outputs.checks }}'));
  assert.ok(workflow.includes('--failed "$FAILED_CHECKS"'));
});
