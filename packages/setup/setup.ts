// `npm run setup`: installs or refreshes Factory on a Mac from this checkout's origin, then proves each
// chosen agent can reach Linear and discover the skills. Run it again any time to update.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { loadConfig } from '../delegator/runner/runner.ts';
import { lastLine, outsideRunner, readJson, updateRunner, withLock, type Result, type UpkeepDeps } from '../delegator/upkeep.ts';

export type SetupDeps = UpkeepDeps & {
  platform: string;
  nodeVersion: string;
  /** Agents named on the command line; empty means every supported agent CLI found. */
  agents: string[];
  /** Asks the person at the terminal, hiding the answer when it's secret; null when nobody is there. */
  ask: ((question: string, secret?: boolean) => Promise<string>) | null;
  /** Runs a command attached to the terminal, for steps the person takes part in; resolves whether it exited 0. */
  interact: (file: string, args: string[]) => Promise<boolean>;
  /** Sends newline-delimited JSON-RPC messages, waiting for each response to a message with an id. */
  rpc: (file: string, args: string[], messages: object[], timeoutMs: number) => Promise<any[]>;
};

type Agent = { bin: string; id: string; display: string; plugin: boolean };
const AGENTS: Record<string, Agent> = {
  claude: { bin: 'claude', id: 'claude-code', display: 'Claude Code', plugin: true },
  codex: { bin: 'codex', id: 'codex', display: 'Codex', plugin: true },
  cursor: { bin: 'agent', id: 'cursor', display: 'Cursor', plugin: false },
};
const SUPPORT = ['grilling', 'domain-modeling', 'research', 'prototype', 'tdd', 'codebase-design', 'code-review'];
const PLUGIN = 'mattpocock-skills';
const PROMPT = 'Call the Linear MCP whoami tool exactly once, then reply with the single word done. Do not call any other tool.';
const short = (sha: string) => sha.slice(0, 7);
const atLeast = (version: string, major: number, minor = 0) => {
  const [a = 0, b = 0] = version.split('.').map(Number);
  return a > major || (a === major && b >= minor);
};

/** Fails unless every tool the setup needs is present, before anything changes. */
async function prerequisites(deps: SetupDeps, agents: string[], runner: boolean): Promise<string[]> {
  const problems: string[] = [];
  const has = (file: string, args: string[]) => deps.exec(file, args, 30_000).then(() => true, () => false);
  if (!atLeast(deps.nodeVersion, 22, 20)) problems.push(`Node ${deps.nodeVersion} is too old. Install Node 22.20 or newer.`);
  if (!await has('git', ['--version'])) problems.push('Git is missing. Run: xcode-select --install');
  if (!await has('gh', ['auth', 'status'])) problems.push('GitHub CLI is missing or signed out. Install it (brew install gh), then run: gh auth login');
  for (const name of agents) {
    if (!AGENTS[name]) problems.push(`${name} isn't a supported agent. Choose from: ${Object.keys(AGENTS).join(', ')}.`);
    else if (!await has(AGENTS[name].bin, ['--version'])) problems.push(`${name}: the ${AGENTS[name].bin} command is missing. Install it, sign in, then rerun.`);
  }
  if (runner) {
    if (!atLeast(deps.nodeVersion, 26)) problems.push(`The Factory Runner needs Node 26 to rebuild; this is Node ${deps.nodeVersion}.`);
    if (!await has('swiftc', ['--version'])) problems.push('The Factory Runner needs swiftc to rebuild. Run: xcode-select --install');
  }
  return problems;
}

/** Checks this is a clean checkout of origin's current default branch; returns the GitHub repo and HEAD. */
async function source(deps: SetupDeps): Promise<{ repo: string; head: string }> {
  const git = async (failure: string, ...args: string[]) => {
    try { return (await deps.exec('git', ['-C', deps.root, ...args], 30_000)).stdout.trim(); } catch { throw new Error(failure); }
  };
  const origin = await git(`${deps.root} isn't a git checkout with an origin`, 'remote', 'get-url', 'origin');
  const repo = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(origin)?.[1];
  if (!repo) throw new Error(`origin (${origin}) isn't a GitHub repo. Run setup from a clone of Factory or your fork of it.`);
  if (await git('couldn\'t read the checkout\'s status', '--no-optional-locks', 'status', '--porcelain')) {
    throw new Error('the checkout has uncommitted or untracked changes. Commit, stash or remove them, then rerun.');
  }
  const head = await git('couldn\'t read HEAD', 'rev-parse', 'HEAD');
  const remote = await git('couldn\'t reach origin to read its default branch', 'ls-remote', '--symref', 'origin', 'HEAD');
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(remote)?.[1];
  const tip = /^([0-9a-f]{40})\tHEAD$/m.exec(remote)?.[1];
  if (!branch || !tip) throw new Error('couldn\'t read origin\'s default branch');
  if (head !== tip) throw new Error(`HEAD ${short(head)} isn't origin's ${branch} (${short(tip)}). Check out ${branch} and pull it, then rerun.`);
  return { repo, head };
}

const factorySkills = (deps: SetupDeps) =>
  readdirSync(join(deps.root, 'skills')).filter((name) => existsSync(join(deps.root, 'skills', name, 'SKILL.md')));

/** Installs or refreshes every Factory skill for the chosen agents, then checks each matches HEAD. */
async function skills(deps: SetupDeps, agents: string[], repo: string, head: string): Promise<Result> {
  const names = factorySkills(deps);
  try {
    await deps.exec('npx', ['--yes', 'skills', 'add', repo, '-g', '-y', '--skill', '*', '-a', ...agents.map((name) => AGENTS[name]!.id)], 600_000);
  } catch (error) {
    return { ok: false, line: `skills: failed. The skills installer exited with an error (${lastLine(error)}).` };
  }
  const lock = (readJson(join(deps.home, '.agents', '.skill-lock.json'))?.skills ?? {}) as Record<string, { source?: unknown; skillFolderHash?: unknown }>;
  const stale: string[] = [];
  for (const name of names) {
    // The installer records each skill folder's git tree hash.
    const tree = await deps.exec('git', ['-C', deps.root, 'rev-parse', `${head}:skills/${name}`], 30_000).then(({ stdout }) => stdout.trim(), () => null);
    if (!tree || String(lock[name]?.source).toLowerCase() !== repo.toLowerCase() || lock[name]?.skillFolderHash !== tree) stale.push(name);
  }
  if (stale.length) return { ok: false, line: `skills: failed. Not at ${repo} ${short(head)} after installing: ${stale.join(', ')}.` };
  return { ok: true, line: `skills: ${names.length} Factory skills from ${repo} at ${short(head)} for ${agents.join(', ')}.` };
}

/** Which form of the supporting skills each agent has: its plugin, bare skills from the skills CLI, both or neither. */
async function supportForms(deps: SetupDeps) {
  const json = (file: string, args: string[]) => deps.exec(file, args, 60_000).then(({ stdout }) => JSON.parse(stdout), () => null);
  const claude = ((await json('claude', ['plugin', 'list', '--json'])) ?? []) as { id: string; enabled: boolean }[];
  const codex = ((await json('codex', ['plugin', 'list', '--json']))?.installed ?? []) as { pluginId: string; enabled: boolean }[];
  const plugins: Record<string, string | undefined> = {
    claude: claude.find((plugin) => plugin.id.startsWith(`${PLUGIN}@`) && plugin.enabled)?.id,
    codex: codex.find((plugin) => plugin.pluginId.startsWith(`${PLUGIN}@`) && plugin.enabled)?.pluginId,
  };
  const bare = ((await json('npx', ['--yes', 'skills', 'ls', '-g', '--json'])) ?? []) as { name: string; source?: string; agents?: string[] }[];
  const cli = (name: string) => bare.filter((skill) => String(skill.source).toLowerCase().includes('mattpocock/skills') && skill.agents?.includes(AGENTS[name]!.display));
  const pluginSkills = (name: string): string[] => {
    const marketplace = plugins[name]?.split('@')[1];
    const cache = join(deps.home, `.${name}`, 'plugins', 'cache', marketplace ?? '', PLUGIN);
    const installed = readJson(join(deps.home, `.${name}`, 'plugins', 'installed_plugins.json'))?.plugins?.[plugins[name] ?? '']?.[0]?.installPath;
    const versions = existsSync(cache) ? readdirSync(cache).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
    const directory = installed ?? (versions[0] ? join(cache, versions[0]) : null);
    const skills = directory && readJson(join(directory, '.claude-plugin', 'plugin.json'))?.skills;
    return Array.isArray(skills) ? skills.map((path: string) => path.split('/').at(-1)!) : [];
  };
  return { plugins, cli, pluginSkills };
}

/** Keeps each chosen agent's existing form of the supporting skills current, or installs one, plugin first. */
async function support(deps: SetupDeps, name: string, forms: Awaited<ReturnType<typeof supportForms>>): Promise<Result> {
  const run = (file: string, ...args: string[]) => deps.exec(file, args, 600_000);
  const plugin = forms.plugins[name];
  const bare = forms.cli(name);
  const hasCli = bare.some((skill) => SUPPORT.includes(skill.name));
  const done = (line: string) => ({ ok: true, line: `supporting skills (${name}): ${line}.` });
  const failed = (line: string) => ({ ok: false, line: `supporting skills (${name}): ${line}` });
  // The skills CLI keeps bare copies in ~/.agents/skills, which Codex reads, so a CLI install beside Codex's plugin duplicates them there.
  const cliBlocked = name !== 'codex' && forms.plugins.codex
    ? failed(`not installed. The skills CLI would also expose bare copies to Codex, which uses the ${PLUGIN} plugin. Choose one form for both agents, then rerun.`) : null;
  try {
    if (plugin && hasCli) {
      const provided = forms.pluginSkills(name);
      const extra = bare.map(({ name: skill }) => skill).filter((skill) => !provided.includes(skill));
      const command = `npx --yes skills remove ${bare.map(({ name: skill }) => `'${skill.replaceAll("'", "'\\''")}'`).join(' ')} -g${name === 'codex' ? '' : ` -a ${AGENTS[name]!.id}`} -y`;
      return failed(`both the ${PLUGIN} plugin and bare skills from the skills CLI are installed. Remove the CLI copies, then rerun:\n${command}\n${name === 'codex' ? 'Codex reads the shared CLI copies, so this removes these skills for all agents. ' : ''}${provided.length ? (extra.length ? `The plugin doesn't provide: ${extra.join(', ')}. Removing the CLI copies would lose these skills.` : 'No CLI-only skills would be lost.') : `Could not read the plugin skill list. Check these skills before removing: ${extra.join(', ')}.`} Nothing was changed.`);
    }
    if (plugin && name === 'claude') { await run('claude', 'plugin', 'update', plugin); return done(`refreshed the ${plugin} plugin`); }
    if (plugin) { await run('codex', 'plugin', 'marketplace', 'upgrade', plugin.split('@')[1]!); return done(`refreshed the ${plugin} plugin`); }
    if (hasCli || !AGENTS[name]!.plugin) {
      if (cliBlocked) return cliBlocked;
      await run('npx', '--yes', 'skills', 'add', 'mattpocock/skills', '--skill', '*', '-g', '-a', AGENTS[name]!.id, '-y');
      return done(hasCli ? 'refreshed with the skills CLI' : 'installed with the skills CLI');
    }
    if (name === 'claude') { await run('claude', 'plugin', 'install', `${PLUGIN}@claude-plugins-official`); return done(`installed the ${PLUGIN} plugin`); }
    await run('codex', 'plugin', 'marketplace', 'add', 'mattpocock/skills');
    await run('codex', 'plugin', 'add', `${PLUGIN}@mattpocock`);
    return done(`installed the ${PLUGIN} plugin`);
  } catch (error) {
    return failed(`failed (${lastLine(error)}).`);
  }
}

const events = (stdout: string): any[] => stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
/** True only for a real whoami answer: a Linear user with an id. Never returns or prints the payload. */
const whoamiOk = (content: unknown): boolean => [content].flat().some((part) => {
  try { return typeof JSON.parse(typeof part === 'string' ? part : (part as { text: string }).text).user?.id === 'string'; } catch { return false; }
});
/** Names the required skills an agent didn't list: every Factory skill, plus the supporting set all prefixed or all bare. */
const missingSkills = (listed: string[], factory: string[]) => {
  const prefixed = SUPPORT.map((name) => `${PLUGIN}:${name}`);
  const support = prefixed.every((name) => listed.includes(name)) ? prefixed : SUPPORT;
  return [...factory, ...support].filter((name) => !listed.includes(name));
};

/** Reads Claude's stream-json: the skills and MCP status from init, then Linear whoami calls only, one with a real answer. */
export function claudeVerdict(stdout: string, factory: string[]): string | null {
  let all: any[];
  try { all = events(stdout); } catch { return 'malformed output from claude.'; }
  const init = all.find((event) => event.type === 'system' && event.subtype === 'init');
  const result = all.find((event) => event.type === 'result');
  if (!init || !result) return 'claude ended without a complete run.';
  if (result.is_error) return `claude failed: ${String(result.result).slice(0, 200)}`;
  const missing = missingSkills(init.skills ?? [], factory);
  if (missing.length) return `claude can't discover: ${missing.join(', ')}. Rerun setup to reinstall them.`;
  const server = (init.mcp_servers ?? []).find((entry: { name: string }) => /linear/i.test(entry.name));
  if (!server) return 'claude has no Linear MCP server. Connect Linear in claude.ai Settings > Connectors, or run: claude mcp add --transport http linear https://mcp.linear.app/mcp';
  if (server.status !== 'connected') return `claude's Linear MCP server is ${server.status}. Run claude, type /mcp, and authenticate ${server.name}.`;
  const content = all.filter((event) => event.type === 'assistant' || event.type === 'user').flatMap((event) => event.message?.content ?? []);
  const uses = content.filter((part: any) => part.type === 'tool_use');
  const strays = uses.filter((use: any) => !/^mcp__.*linear.*__whoami$/i.test(use.name));
  if (strays.length) return `claude called a tool other than Linear whoami (${strays[0].name}).`;
  if (!uses.length) return 'claude reported done without calling Linear whoami.';
  const answered = content.some((part: any) => part.type === 'tool_result' && !part.is_error
    && uses.some((use: any) => use.id === part.tool_use_id) && whoamiOk(part.content));
  return answered ? null : `claude's Linear whoami call failed. Run claude, type /mcp, and reauthenticate ${server.name}.`;
}

/** Reads Codex's exec --json: whoami calls on its Linear server only, one with a real answer. */
export function codexVerdict(stdout: string, server: string): string | null {
  let all: any[];
  try { all = events(stdout); } catch { return 'malformed output from codex.'; }
  if (!all.some((event) => event.type === 'turn.completed')) return 'codex ended without a complete turn.';
  const items = all.filter((event) => event.type === 'item.completed').map((event) => event.item);
  const strays = items.filter((item) => !['agent_message', 'reasoning'].includes(item.type) && !(item.type === 'mcp_tool_call' && item.server === server && item.tool === 'whoami'));
  if (strays.length) return `codex ran something other than Linear whoami (${strays[0].type}${strays[0].tool ? ` ${strays[0].tool}` : ''}).`;
  const calls = items.filter((item) => item.type === 'mcp_tool_call');
  if (!calls.length) return 'codex reported done without calling Linear whoami.';
  const answered = calls.some((call) => !call.error && call.status === 'completed' && whoamiOk(call.result?.content));
  return answered ? null : `codex's Linear whoami call failed. Run: codex mcp login ${server}`;
}

/** Starts a fresh process of the agent with its own config and checks Linear and skill discovery; returns a failure or null. */
async function verifyOnce(deps: SetupDeps, name: string): Promise<string | null> {
  const factory = factorySkills(deps);
  const output = (file: string, args: string[]) => deps.exec(file, args, 180_000).then(({ stdout }) => stdout,
    (error) => { if ((error as { killed?: boolean }).killed) throw new Error(`${file} timed out`); return String((error as { stdout?: unknown }).stdout ?? ''); });
  try {
    if (name === 'claude') {
      return claudeVerdict(await output('claude', ['-p', PROMPT, '--output-format', 'stream-json', '--verbose', '--tools', '',
        '--allowedTools', 'mcp__*__whoami', '--no-session-persistence']), factory);
    }
    if (name === 'codex') {
      const servers = JSON.parse((await deps.exec('codex', ['mcp', 'list', '--json'], 60_000)).stdout) as { name: string; enabled: boolean; transport?: { url?: string } }[];
      const server = servers.find((entry) => String(entry.transport?.url).includes('mcp.linear.app') || /linear/i.test(entry.name));
      if (!server) return 'codex has no Linear MCP server. Run: codex mcp add linear --url https://mcp.linear.app/mcp, then: codex mcp login linear';
      if (!server.enabled) return `codex's Linear MCP server ${server.name} is disabled. Set enabled = true under [mcp_servers.${server.name}] in ~/.codex/config.toml.`;
      const [, list] = await deps.rpc('codex', ['app-server'], [
        { id: 1, method: 'initialize', params: { clientInfo: { name: 'factory-setup', version: '1' } } },
        { method: 'initialized' },
        { id: 2, method: 'skills/list', params: { cwds: [deps.root] } },
      ], 60_000);
      const listed = ((list?.data?.[0]?.skills ?? []) as { name: string; enabled: boolean }[]).filter((skill) => skill.enabled).map((skill) => skill.name);
      const missing = missingSkills(listed, factory);
      if (missing.length) return `codex can't discover: ${missing.join(', ')}. Rerun setup to reinstall them.`;
      return codexVerdict(await output('codex', ['exec', '--sandbox', 'read-only', '--ephemeral', '--json', '--skip-git-repo-check',
        '-c', `mcp_servers.${server.name}.enabled_tools=["whoami"]`, PROMPT]), server.name);
    }
    return 'verification unsupported. Cursor\'s agent CLI can\'t list its skills, so setup can\'t confirm them. Check Linear and the skills in Cursor yourself.';
  } catch (error) {
    return `couldn't run the check (${(error as Error).message}).`;
  }
}

/** Verifies an agent; with someone at the terminal, waits for each fix and checks again. */
async function verify(deps: SetupDeps, name: string): Promise<Result> {
  for (;;) {
    const failure = await verifyOnce(deps, name);
    if (!failure) return { ok: true, line: `${name}: verified. Linear whoami answered and every Factory and supporting skill is discoverable.` };
    if (!deps.ask || failure.startsWith('verification unsupported')) return { ok: false, line: `${name}: ${failure}` };
    deps.print(`${name}: ${failure}`);
    if ((await deps.ask('Fix that, then press Enter to check again, or type skip: ')).trim() === 'skip') return { ok: false, line: `${name}: skipped verification.` };
  }
}

const DELEGATOR = 'packages/delegator';
/** In the state dir while a first Runner install hasn't yet proven it connects. */
const PENDING = 'runner-install-pending';
/** The Linear app name Cloud Inbox setup's prefilled registration gives a machine. */
const appName = (machine: string) => `Factory ${machine}`;

/** Cloud Inbox's own guided setup, resumed from its checkpoint; returns this machine's connection or why it stopped. */
async function provisionInbox(deps: SetupDeps, ask: NonNullable<SetupDeps['ask']>): Promise<Result | { url: string; secret: string; machine: string }> {
  const cli = join(deps.root, DELEGATOR, 'cloud-inbox/setup.ts');
  const read = () => readJson(join(deps.root, DELEGATOR, '.cloud-inbox.local.json')) ?? {};
  const stopped = (step: string) => {
    const state = read();
    const done = [state.origin && 'Worker deployed', state.config && 'Linear app registered', state.uploaded && 'configuration uploaded'].filter(Boolean);
    return { ok: false, line: `runner: not installed. Cloud Inbox ${step} didn't finish. Done so far: ${done.join(', ') || 'nothing'}. `
      + 'Rerun npm run setup to pick up from there; it keeps the saved checkpoint and its secrets.' };
  };
  if (!read().uploaded) {
    if (!existsSync(join(deps.root, DELEGATOR, 'node_modules/wrangler'))) {
      return { ok: false, line: `runner: not installed. Cloud Inbox setup needs Wrangler. Run: npm --prefix ${DELEGATOR} ci --ignore-scripts, then rerun.` };
    }
    deps.print('Cloud Inbox needs a Cloudflare account with Workers and Durable Objects, and a Linear workspace admin to create a private app. Sign in to Cloudflare in your browser first.');
    if (!await deps.interact(deps.node, [cli, 'login'])) return stopped('sign-in');
    if (!await deps.interact(deps.node, [cli, 'setup']) || !read().uploaded) return stopped('setup');
  }
  const connected = () => deps.exec(deps.node, [cli, 'status'], 60_000).then(({ stdout }) => stdout.startsWith('Connected'), () => false);
  if (!await connected()) {
    if (!await deps.interact(deps.node, [cli, 'connect'])) return stopped('connection');
    do {
      if ((await ask('Approve Factory in Linear in your browser, then press Enter to check, or type skip: ')).trim() === 'skip') return stopped('connection');
    } while (!await connected());
  }
  const state = read();
  return { url: `${state.origin}/delegator`, secret: state.config?.machines?.[state.machine]?.bearerSecret, machine: appName(state.machine) };
}

/** The Runner's pid from launchd: 0 when loaded but not running (KeepAlive may restart it any moment), null when not loaded. */
const runnerPid = (deps: SetupDeps) => deps.exec('launchctl', ['print', `gui/${deps.uid}/com.factory.factory-delegator.runner`], 30_000)
  .then(({ stdout }) => Number(/^\s*pid = (\d+)$/m.exec(stdout)?.[1] ?? 0), () => null);

/** Waits for the newly installed Runner to start and reach Cloud Inbox, as launchd and its status.json report it. */
async function started(deps: SetupDeps, since: number): Promise<Result> {
  let pid: number | null = null;
  for (let second = 0; second <= 60; second++) {
    pid = await runnerPid(deps);
    const status = readJson(join(deps.stateDir, 'status.json'));
    if (pid && status?.pid === pid && Date.parse(status.updatedAt) >= since - 1000 && status.inbox?.status === 'ok') {
      return { ok: true, line: `runner: installed and connected (pid ${pid}); Cloud Inbox answered at ${status.inbox.lastOkAt}.` };
    }
    await deps.sleep(1000);
  }
  if (pid === 0) {
    return { ok: false, line: 'runner: installed, but its launchd agent is loaded and not running after 60 s. Check ~/Library/Logs/factory-delegator/runner.log, '
      + 'then rerun npm run setup to finish; it won\'t reinstall over a loaded Runner.' };
  }
  return { ok: false, line: `runner: installed, but it didn't ${pid ? 'reach Cloud Inbox' : 'start'} within 60 s. Check ~/Library/Logs/factory-delegator/runner.log `
    + 'and the config\'s inboxUrl and bearerSecret, then choose Start Runner in the Factory Runner menu.' };
}

/** Offers a first Runner install: reuses a valid config or writes one for an existing or new Cloud Inbox, then proves it connects. */
async function offerRunner(deps: SetupDeps): Promise<Result> {
  const stop = (ok: boolean, why: string) => ({ ok, line: `runner: not installed. ${why}` });
  const ask = deps.ask, pending = join(deps.stateDir, PENDING);
  // A first install that didn't prove itself connected is finished without asking again.
  if (existsSync(pending)) deps.print('runner: finishing the install an earlier setup started.');
  else if (!ask) return stop(true, 'Run npm run setup at a terminal to install it.');
  else if (!/^y/i.test((await ask('Install the Factory Runner, so this Mac takes work delegated in Linear? [y/N] ')).trim())) return stop(true, 'You can install it on a later run.');
  const has = (file: string, args: string[]) => deps.exec(file, args, 30_000).then(() => true, () => false);
  const missing = [
    !atLeast(deps.nodeVersion, 26) && `The Runner needs Node 26; this is Node ${deps.nodeVersion}.`,
    !await has('swiftc', ['--version']) && 'The Runner needs swiftc. Run: xcode-select --install',
    !await has('orca', ['--version']) && 'The Runner needs the orca command. Install Orca and its CLI.',
  ].filter(Boolean);
  if (missing.length) return stop(false, `${missing.join(' ')} Then rerun.`);

  const path = join(deps.home, '.config/factory-delegator/config.json');
  if (!existsSync(path)) {
    if (!ask) return stop(false, 'Its config is missing. Rerun npm run setup at a terminal.');
    let inbox: Result | { url: string; secret: string; machine: string };
    if (existsSync(join(deps.root, DELEGATOR, '.cloud-inbox.local.json'))) inbox = await provisionInbox(deps, ask);
    else {
      const choice = (await ask('Cloud Inbox: use one you already run (e), or set up a new one in your Cloudflare account (n)? [e/n] ')).trim().toLowerCase();
      if (choice === 'n') inbox = await provisionInbox(deps, ask);
      else if (choice === 'e') {
        inbox = {
          url: (await ask('Cloud Inbox URL, ending in /delegator: ')).trim(),
          secret: (await ask('This machine\'s bearer secret, from config.machines.<machine>.bearerSecret in the Inbox checkpoint: ', true)).trim(),
          machine: (await ask('This machine\'s Linear app name: ')).trim(),
        };
      } else return stop(true, 'No Cloud Inbox chosen.');
    }
    if ('ok' in inbox) return inbox;
    const example = readJson(join(deps.root, DELEGATOR, 'config.example.json'));
    const user = (await ask('Your Linear user id, so the Runner takes your delegations (ask your agent to call Linear whoami): ')).trim();
    const models: Record<string, { model: string }> = example.models;
    for (const [name, settings] of Object.entries(models)) {
      if (/^<.*>$/.test(settings.model)) settings.model = (await ask(`Model id Orca starts for ${name}: `)).trim();
    }
    const config = { ...example, inboxUrl: inbox.url, bearerSecret: inbox.secret, machine: inbox.machine, allowedCreatorIds: [user], models };
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    rmSync(`${path}.tmp`, { force: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { loadConfig(`${path}.tmp`); } catch (error) {
      rmSync(`${path}.tmp`, { force: true });
      return stop(false, `The answers don't make a valid config (${(error as Error).message.replace(`${path}.tmp`, 'it')}). Nothing was saved; rerun to try again.`);
    }
    renameSync(`${path}.tmp`, path);
    deps.print(`runner: saved its config to ${path}.`);
  }
  try { loadConfig(path); } catch (error) {
    return stop(false, `The existing config isn't valid (${(error as Error).message}). Fix it to match config.example.json, or move it aside, then rerun. Setup never overwrites it.`);
  }
  // Cleared only once a fresh status shows Cloud Inbox answering, so any earlier failure resumes here.
  writeFileSync(pending, '', { mode: 0o600 });
  const since = Date.now();
  // The plain installer restarts a loaded Runner without draining it, so it runs only when launchd has none
  // loaded and no Runner reports from outside launchd; a Runner an earlier try left is only checked.
  const install = join(deps.root, DELEGATOR, 'runner/launchd/install.sh');
  if (await runnerPid(deps) === null) {
    const outside = outsideRunner(deps.stateDir);
    if (outside) return { ok: false, line: `runner: not finished. A Runner process (pid ${outside}) is running outside launchd. Stop it, then rerun to finish the install.` };
    try {
      await deps.exec('sh', [install], 600_000);
    } catch (error) {
      return { ok: false, line: `runner: install failed (${lastLine(error)}). Fix that, then rerun to finish it.` };
    }
  }
  const result = await started(deps, since);
  if (!result.ok) return result;
  // The installer registers the menu bar app last, so a try that failed there left the Runner running without it.
  // Registering it alone never touches the Runner.
  const menu = `gui/${deps.uid}/com.factory.factory-delegator.menubar`;
  if (!await deps.exec('launchctl', ['print', menu], 30_000).then(() => true, () => false)) {
    try { await deps.exec('sh', [install, '--enable-app-login'], 60_000); } catch (error) {
      return { ok: false, line: `runner: connected, but the menu bar app didn't register to open at login (${lastLine(error)}). Rerun npm run setup to finish it.` };
    }
  }
  rmSync(pending, { force: true });
  return result;
}

/** Runs setup and returns the exit code: 0 only when every step and every chosen agent's verification passed. */
export async function setup(deps: SetupDeps): Promise<number> {
  if (deps.platform !== 'darwin') { deps.print('setup: refused. Factory setup supports macOS only. Nothing was changed.'); return 1; }
  return withLock(deps, async () => {
    const found = deps.agents.length ? deps.agents
      : (await Promise.all(Object.entries(AGENTS).map(([name, agent]) => deps.exec(agent.bin, ['--version'], 30_000).then(() => name, () => null)))).filter((name) => name !== null);
    // A `.previous` bundle alone is an update interrupted mid-swap, which the updater restores.
    // A pending first install isn't an installation yet, whatever it left behind; offerRunner finishes it.
    const runner = !existsSync(join(deps.stateDir, PENDING))
      && ['Factory Runner.app', 'Factory Runner.app.previous'].some((app) => existsSync(join(deps.home, 'Applications', app)));
    const problems = found.length ? await prerequisites(deps, found, runner)
      : ['No agent CLI found. Install Claude Code (claude), Codex (codex) or Cursor (agent), then rerun.'];
    if (problems.length) {
      for (const problem of problems) deps.print(`prerequisites: ${problem}`);
      deps.print('Nothing was changed.');
      return 1;
    }
    let checkout: { repo: string; head: string };
    try { checkout = await source(deps); } catch (error) {
      deps.print(`source: refused. ${(error as Error).message} Nothing was changed.`);
      return 1;
    }
    deps.print(`source: ${checkout.repo} at ${short(checkout.head)}.`);
    const results = [await skills(deps, found, checkout.repo, checkout.head)];
    deps.print(results[0]!.line);
    const forms = await supportForms(deps);
    for (const name of found) { results.push(await support(deps, name, forms)); deps.print(results.at(-1)!.line); }
    results.push(runner ? await updateRunner(deps) : await offerRunner(deps).catch((error: Error) => ({ ok: false, line: `runner: not installed (${error.message}).` })));
    deps.print(results.at(-1)!.line);
    for (const name of found) { results.push(await verify(deps, name)); deps.print(results.at(-1)!.line); }
    return results.every((result) => result.ok) ? 0 : 1;
  });
}

/** Runs a command with stdin closed, so agent CLIs never wait for input. */
export const exec: SetupDeps['exec'] = (file, args, timeout) => {
  const pending = promisify(execFile)(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  pending.child.stdin?.end();
  return pending;
};

export const rpc: SetupDeps['rpc'] = (file, args, messages, timeout) => new Promise((done, fail) => {
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const results: any[] = [];
  let sent = 0;
  let buffer = '';
  const timer = setTimeout(() => { child.kill(); fail(new Error(`${file} timed out`)); }, timeout);
  const next = () => {
    while (sent < messages.length) {
      const message = messages[sent++] as { id?: number };
      child.stdin.write(`${JSON.stringify(message)}\n`);
      if (message.id !== undefined) return;
    }
    clearTimeout(timer);
    child.kill();
    done(results);
  };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || message.id !== (messages[sent - 1] as { id?: number }).id) continue;
      if (message.error) { clearTimeout(timer); child.kill(); fail(new Error(message.error.message ?? 'request failed')); return; }
      results.push(message.result);
      next();
    }
  });
  child.on('error', (error) => { clearTimeout(timer); fail(error); });
  child.on('exit', () => { clearTimeout(timer); fail(new Error(`${file} exited early`)); });
  next();
});

/** Reads one answer, then lets go of stdin so commands run with `interact` get the terminal to themselves. */
const ask: NonNullable<SetupDeps['ask']> = async (question, secret = false) => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  try {
    if (!secret) return await terminal.question(question);
    // Never echo a secret: refuse to read it if the terminal can't hide input.
    process.stdout.write(`${question}(input hidden) `);
    if (spawnSync('stty', ['-echo'], { stdio: 'inherit' }).status !== 0) throw new Error('Could not hide input. No secret was read.');
    try { return await terminal.question(''); } finally { spawnSync('stty', ['echo'], { stdio: 'inherit' }); process.stdout.write('\n'); }
  } finally { terminal.close(); }
};

if (process.argv[1] === import.meta.filename) {
  const state = process.env.XDG_STATE_HOME;
  process.exitCode = await setup({
    exec,
    rpc,
    ask: process.stdin.isTTY ? ask : null,
    interact: (file, args) => new Promise((done) => {
      spawn(file, args, { stdio: 'inherit' }).on('error', () => done(false)).on('close', (code) => done(code === 0));
    }),
    agents: process.argv.slice(2),
    platform: process.platform,
    nodeVersion: process.versions.node,
    home: homedir(),
    stateDir: join(state && isAbsolute(state) ? state : join(homedir(), '.local', 'state'), 'factory'),
    root: resolve(import.meta.dirname, '../..'),
    node: process.execPath,
    uid: process.getuid!(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    print: (line) => console.log(line),
  });
}
