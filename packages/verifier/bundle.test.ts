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
