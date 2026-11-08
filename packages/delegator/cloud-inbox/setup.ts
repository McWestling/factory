// Operator tooling only: Linear access/refresh tokens never leave the Worker.
import { spawn, spawnSync } from 'node:child_process';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { readConfig, type Config } from './auth.ts';

type State = Partial<Record<'accountId' | 'name' | 'machine' | 'orgId' | 'adminSecret' | 'bearerSecret' |
  'clientId' | 'clientSecret' | 'webhookSecret' | 'origin' | 'registrationUrl', string>> & {
  config?: Config; uploading?: boolean; uploaded?: boolean; imported?: boolean;
};
export type SetupIO = {
  ask(key: string, label: string, secret?: boolean): Promise<string>;
  command(args: string[], input?: string): Promise<string>;
  say(message: string): void;
  open(url: string): Promise<void>;
};
const random = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const DEFAULT_FILE = fileURLToPath(new URL('../.cloud-inbox.local.json', import.meta.url));

async function load(file: string): Promise<State> {
  try {
    await chmod(file, 0o600);
    return JSON.parse(await readFile(file, 'utf8')) as State;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Cannot read setup checkpoint. Restore its backup; do not replace a working installation.');
  }
}
async function save(file: string, state: State) {
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(`${file}.tmp`, 0o600);
  await rename(`${file}.tmp`, file);
}
function validate(state: State): Config {
  const config = state.config;
  const result = readConfig({ LINEAR_ORG_ID: config?.orgId, ADMIN_SECRET: config?.adminSecret,
    MACHINES: JSON.stringify(config?.machines) });
  if (typeof result === 'string') throw new Error(result);
  if (!state.machine || !Object.hasOwn(result.machines, state.machine)) throw new Error('Saved machine key is missing. Restore the checkpoint.');
  return result;
}
async function wranglerConfig(file: string, state: State) {
  if (!state.name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(state.name) ||
    !state.accountId || !/^[a-zA-Z0-9-]+$/.test(state.accountId)) throw new Error('Invalid Worker name or account ID.');
  const template = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const toml = template.replace(/^name = .*$/m, `name = ${JSON.stringify(state.name)}\naccount_id = ${JSON.stringify(state.accountId)}`)
    .replace(/^main = .*$/m, `main = ${JSON.stringify(fileURLToPath(new URL('./worker.ts', import.meta.url)))}`);
  await writeFile(`${file}.toml`, toml, { mode: 0o600 });
  return ['--config', `${file}.toml`];
}

export async function setup(file: string, io: SetupIO): Promise<void> {
  const state = await load(file);
  const fill = async (key: keyof State, label: string, secret = false) => {
    if (state[key]) return;
    const answer = (await io.ask(key, label, secret)).trim();
    if (!answer) throw new Error(`${key} is required. Rerun setup to resume.`);
    if (['name', 'machine'].includes(key) && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(answer)) throw new Error('Use lowercase letters, digits and hyphens, at most 63 characters. Rerun setup.');
    if (key === 'accountId' && !/^[a-zA-Z0-9-]+$/.test(answer)) throw new Error('Invalid account ID. Rerun setup.');
    Object.assign(state, { [key]: answer });
    await save(file, state);
  };
  await fill('accountId', 'Cloudflare account ID (from your account dashboard)');
  await fill('name', 'Worker name (use the existing name on upgrades; e.g. factory-cloud-inbox)');
  const flags = await wranglerConfig(file, state);
  const run = (args: string[], input?: string) => io.command([...args, ...flags], input);
  if (!state.origin) {
    // Check before deploying: a lost checkpoint must never rotate existing remote secrets.
    const secrets = JSON.parse(await run(['secret', 'list'])) as unknown[];
    if (secrets.length && !state.imported) {
      throw new Error('This Worker already has secrets. Restore the checkpoint or run import with its original .dev.vars before setup.');
    }
    const deployed = await run(['deploy', '--keep-vars']);
    const origin = deployed.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/)?.[0];
    if (!origin) throw new Error('No workers.dev URL returned. Enable workers.dev for this supported setup path, then rerun.');
    state.origin = origin;
    await save(file, state);
  }
  if (!state.config) {
    await fill('machine', 'Stable machine key (e.g. example-machine; never rename an existing key)');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(state.machine!)) throw new Error('Invalid machine key. Use lowercase letters, digits and hyphens, at most 63 characters.');
    await fill('orgId', 'Linear workspace organization UUID (from your admin or Linear MCP)');
    state.adminSecret ??= random();
    state.bearerSecret ??= random();
    if (!state.registrationUrl) {
      const url = new URL('https://linear.app/settings/api/applications/new');
      url.search = new URLSearchParams({ distribution: 'private', 'developer.name': 'Factory operator',
        'oauth.client_name': `Factory ${state.machine}`, 'oauth.client_uri': `${state.origin}/delegator`,
        'oauth.redirect_uris': `${state.origin}/delegator/callback/${state.machine}`,
        'oauth.grant_types': 'authorization_code', 'webhook.enabled': 'true',
        'webhook.url': `${state.origin}/delegator/webhook`, 'webhook.resourceTypes': 'AgentSessionEvent' }).toString();
      state.registrationUrl = url.href;
    }
    await save(file, state);
    io.say('One-time Linear approval: create the private app on this prefilled page; keep webhook delivery enabled.');
    io.say(state.registrationUrl);
    await io.open(state.registrationUrl);
    await fill('clientId', 'App client ID');
    await fill('clientSecret', 'App client secret', true);
    await fill('webhookSecret', 'App webhook signing secret', true);
    state.config = { orgId: state.orgId!, adminSecret: state.adminSecret!, machines: {
      [state.machine!]: { clientId: state.clientId!, clientSecret: state.clientSecret!,
        webhookSecret: state.webhookSecret!, bearerSecret: state.bearerSecret! },
    } };
    await save(file, state);
  }
  const config = validate(state);
  if (!state.uploaded) {
    const secrets = JSON.parse(await run(['secret', 'list'])) as unknown[];
    if (secrets.length && !state.uploading && !state.imported) {
      throw new Error('Remote secrets appeared during setup. Restore/import original configuration before continuing.');
    }
    state.uploading = true;
    await save(file, state);
    await run(['secret', 'bulk'], JSON.stringify({ LINEAR_ORG_ID: config.orgId,
      ADMIN_SECRET: config.adminSecret, MACHINES: JSON.stringify(config.machines) }));
    state.uploaded = true;
    await save(file, state);
  }
  io.say(`Setup URL: ${state.origin}/delegator/install/${state.machine}`);
  io.say('Run npm run inbox -- connect to authorize, then npm run inbox -- status to check access.');
  io.say('Owner authentication is saved in the private checkpoint. Back it up securely. Runner pairing is not implemented yet.');
}

/** Deliberate correction/rotation of app credentials, preserving all machine authorities. */
export async function credentials(file: string, io: SetupIO): Promise<void> {
  const state = await load(file);
  const config = validate(state);
  const machine = config.machines[state.machine!]!;
  const clientId = (await io.ask('clientId', 'Original app client ID (correct a typo; do not replace a working app)')).trim();
  const clientSecret = (await io.ask('clientSecret', 'App client secret', true)).trim();
  const webhookSecret = (await io.ask('webhookSecret', 'App webhook signing secret', true)).trim();
  state.config = { ...config, machines: { ...config.machines,
    [state.machine!]: { ...machine, clientId, clientSecret, webhookSecret } } };
  validate(state);
  state.uploaded = false;
  state.uploading = true;
  await save(file, state);
  await setup(file, io);
}

async function main() {
  process.umask(0o077);
  const action = process.argv[2] ?? 'setup';
  const file = DEFAULT_FILE;
  const command: SetupIO['command'] = (args, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), ...args],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    let output = '';
    let diagnostic = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { diagnostic += data; });
    child.on('error', () => reject(new Error('Cannot start Wrangler. Run npm ci --ignore-scripts.')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code) => code === 0 ? resolve(output) : args[0] === 'secret' && args[1] === 'list' && /(?:code: 10007|Worker [^\n]+ not found\.)/.test(output + diagnostic) ? resolve('[]') : reject(new Error(`Wrangler ${args[0]} failed. Check login, account ID and Workers/Durable Object permissions. No secrets were logged.`)));
  });
  const open = async (url: string) => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
      child.on('error', () => reject(new Error('Could not open browser. Open the setup URL manually.')));
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Could not open browser.')));
    });
  };
  if (action === 'login') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'login'], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Cloudflare login failed.')));
    });
    return;
  }
  if (action === 'import') {
    if (Object.keys(await load(file)).length) throw new Error('Checkpoint exists. Restore a backup rather than overwriting it.');
    const env = parseEnv(await readFile(process.argv[3] ?? '.dev.vars', 'utf8'));
    const config = readConfig(env);
    if (typeof config === 'string') throw new Error(config);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    try {
      const machine = await rl.question('Existing stable machine key: ');
      if (!Object.hasOwn(config.machines, machine)) throw new Error('Machine is not in imported config.');
      await save(file, { config, machine, imported: true });
    } finally { rl.close(); }
    console.log('Imported original configuration. Run setup with the original Worker name and account.');
    return;
  }
  if (action === 'setup' || action === 'credentials') {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    try {
      await (action === 'credentials' ? credentials : setup)(file, { command, open, say: console.log, async ask(_key, label, secret) {
        if (!secret) return rl.question(`${label}: `);
        // Disable terminal echo while reading credentials; never put them in argv or logs.
        console.log(`${label} (input hidden):`);
        if (process.stdin.isTTY && spawnSync('stty', ['-echo'], { stdio: 'inherit' }).status !== 0) {
          throw new Error('Could not hide input. No credential was read.');
        }
        try { return await rl.question(''); }
        finally {
          if (process.stdin.isTTY) spawnSync('stty', ['echo'], { stdio: 'inherit' });
          console.log();
        }
      } });
    } finally { rl.close(); }
    return;
  }
  if (!['update', 'connect', 'reconnect', 'status', 'disconnect'].includes(action)) throw new Error('Use login, setup, import, credentials, update, connect, reconnect, status or disconnect.');
  const state = await load(file);
  const config = validate(state);
  if (!state.uploaded || !state.origin) throw new Error('Run setup first.');
  if (action === 'update') {
    await command(['deploy', '--keep-vars', ...await wranglerConfig(file, state)]);
    console.log('Updated code; configuration, tokens and jobs preserved.');
    return;
  }
  const route = action === 'connect' || action === 'reconnect' ? 'install' : action;
  const response = await fetch(`${state.origin}/delegator/${route}/${state.machine}`, {
    method: action === 'disconnect' ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Basic ${Buffer.from(`owner:${config.adminSecret}`).toString('base64')}` },
  });
  if (route === 'install') {
    const location = response.headers.get('location');
    if (response.status !== 302 || !location || new URL(location).origin !== 'https://linear.app') {
      throw new Error('Could not begin connection. Check owner credentials, configuration, or finish a pending disconnect.');
    }
    await open(location);
    console.log('Approve in Linear, then run status. Tokens remain inside Cloud Inbox.');
  } else {
    if (!response.ok) throw new Error('Cloud Inbox could not verify the operation. Check owner credentials and Linear app access; retry disconnect or reconnect as appropriate.');
    console.log(action === 'status' ? (await response.json() as { connected: boolean }).connected
      ? 'Connected: workspace and app identity verified against Linear.' : 'Disconnected. Run connect.'
      : 'Disconnected: access and refresh revocation verified; jobs preserved.');
  }
}
if (import.meta.main) main().catch((error: unknown) => {
  // Unexpected provider/JSON errors may contain secrets; only report our own fixed diagnostics.
  console.error(error instanceof Error && !['SyntaxError', 'TypeError'].includes(error.name) ? error.message : 'Setup failed. Check account access and saved configuration, then rerun.');
  process.exitCode = 1;
});
