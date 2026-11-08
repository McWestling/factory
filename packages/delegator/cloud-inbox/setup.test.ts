import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, type SetupIO } from './setup.ts';

test('setup resumes an interrupted registration and reruns without changing credentials or redeploying', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-test-'));
  const file = join(dir, 'setup.local.json');
  const commands: string[][] = [];
  let interrupted = true;
  const answers: Record<string, string> = {
    accountId: 'account-example', name: 'factory-cloud-inbox', machine: 'example-machine',
    orgId: 'org-example', clientId: 'client-example', clientSecret: 'private-client', webhookSecret: 'private-webhook',
  };
  const io: SetupIO = {
    async ask(key) {
      if (key === 'clientSecret' && interrupted) throw new Error('interrupted');
      return answers[key]!;
    },
    async command(args) {
      commands.push(args);
      if (args.includes('list')) return '[]';
      if (args.includes('deploy')) return 'https://factory-cloud-inbox.example.workers.dev';
      return '';
    },
    say() {}, async open() {},
  };
  try {
    await assert.rejects(setup(file, io), /interrupted/);
    const before = JSON.parse(await readFile(file, 'utf8'));
    interrupted = false;
    await setup(file, io);
    const installed = await readFile(file, 'utf8');
    assert.equal(JSON.parse(installed).adminSecret, before.adminSecret);
    assert.equal(JSON.parse(installed).bearerSecret, before.bearerSecret);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const deploys = commands.filter((args) => args.includes('deploy')).length;
    await setup(file, { ...io, async ask() { throw new Error('rerun must not prompt'); } });
    assert.equal(await readFile(file, 'utf8'), installed);
    assert.equal(commands.filter((args) => args.includes('deploy')).length, deploys);
    const manifest = new URL(JSON.parse(installed).registrationUrl);
    assert.equal(manifest.searchParams.get('distribution'), 'private');
    assert.equal(manifest.searchParams.get('webhook.resourceTypes'), 'AgentSessionEvent');
    assert.equal(manifest.searchParams.get('webhook.enabled'), 'true');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('setup refuses remote secrets without the original checkpoint before deploying', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-test-'));
  const commands: string[][] = [];
  try {
    await assert.rejects(setup(join(dir, 'setup.local.json'), {
      async ask(key) { return key === 'accountId' ? 'account-example' : 'factory-cloud-inbox'; },
      async command(args) { commands.push(args); return '[{"name":"MACHINES"}]'; },
      say() {}, async open() {},
    }), /already has secrets/);
    assert.equal(commands.some((args) => args.includes('deploy')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an interrupted secret upload retries the identical complete configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-test-'));
  const file = join(dir, 'setup.local.json');
  let uploaded: string | undefined;
  let fail = true;
  const answers: Record<string, string> = { accountId: 'account-example', name: 'factory-cloud-inbox',
    machine: 'example-machine', orgId: 'org-example', clientId: 'client-example', clientSecret: 'secret', webhookSecret: 'webhook' };
  const io: SetupIO = {
    async ask(key) { return answers[key]!; }, say() {}, async open() {},
    async command(args, input) {
      if (args.includes('deploy')) return 'https://factory-cloud-inbox.example.workers.dev';
      if (args.includes('list')) return uploaded ? '[{"name":"MACHINES"}]' : '[]';
      if (args.includes('bulk')) {
        if (uploaded) assert.equal(input, uploaded);
        uploaded = input;
        if (fail) throw new Error('network interrupted');
      }
      return '';
    },
  };
  try {
    await assert.rejects(setup(file, io), /network interrupted/);
    fail = false;
    await setup(file, io);
    const secrets = JSON.parse(uploaded!);
    assert.equal(JSON.parse(secrets.MACHINES)['example-machine'].clientSecret, 'secret');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
