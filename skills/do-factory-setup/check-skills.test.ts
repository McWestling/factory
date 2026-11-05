import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const script = new URL('./check-skills.ts', import.meta.url).pathname;

test('reports only stale factory skills and stays silent on unavailable data', async () => {
  const home = await mkdtemp(join(tmpdir(), 'factory-skills-'));
  const bin = join(home, 'bin');
  const lockDir = join(home, '.agents');
  await mkdir(bin);
  await mkdir(lockDir);
  const gh = join(bin, 'gh');
  await writeFile(gh, '#!/bin/sh\nprintf \'%s\' \'[{"name":"do-refine","sha":"new"},{"name":"do-triage","sha":"same"}]\'\n');
  await chmod(gh, 0o755);
  const run = () => execFileSync(process.execPath, [script], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  try {
    await writeFile(join(lockDir, '.skill-lock.json'), JSON.stringify({
      skills: {
        'do-refine': { source: 'mcwestling/factory', skillFolderHash: 'old' },
        'do-triage': { source: 'mcwestling/factory', skillFolderHash: 'same' },
        other: { source: 'someone/else', skillFolderHash: 'old' },
      },
    }));
    assert.equal(run(), 'Out of date: do-refine. Run: npx skills update -g -y do-refine\n');
    await writeFile(gh, '#!/bin/sh\nexit 1\n');
    assert.equal(run(), '');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
