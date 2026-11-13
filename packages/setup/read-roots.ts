// Read roots: folders setup lets the chosen agents read, repos added beneath them later included. Claude gets scoped
// `Read(//root/**)` allow rules in its user settings; Codex already reads anywhere. With --verify, each agent is then
// proven with a fresh read of a new probe file. Nothing here grants edit, write or shell access.
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Result } from '../delegator/upkeep.ts';
import type { SetupDeps } from './setup.ts';

const events = (stdout: string): any[] => stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
const within = (path: string, root: string) => path === root || root === '/' || path.startsWith(`${root}/`);
const GLOB = /[\\*?[\]{}]/g;

/** The Claude rule that lets it read everything under an absolute root, with literal glob characters escaped. */
export const readRule = (root: string) => `Read(/${root.replace(GLOB, (char) => `\\${char}`)}/**)`;

/** True when a Read rule, or a bare Read, covers all of root: `Read(//dir/**)` or `Read(~/dir/**)` for dir at or above root, `Read(//**)` and `Read(~/**)` too. */
function covers(rule: string, root: string, home: string) {
  if (rule === 'Read') return true;
  const spec = /^Read\((\/\/|~\/)(.*\/)?\*\*\)$/.exec(rule);
  const raw = spec?.[2] ?? '';
  if (!spec || /(?<!\\)[*?[\]{}]/.test(raw)) return false;
  const dir = raw.replace(/\\(.)/g, '$1').replace(/\/$/, '');
  return within(root, spec[1] === '//' ? `/${dir}` : join(home, dir));
}

const strings = (value: unknown) => value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));

/** Merges read rules for the roots into Claude's user settings, writing nothing on malformed data or a conflicting restriction. checkOnly reports existing coverage without writing. */
export function grantClaudeReads(path: string, roots: string[], home: string, checkOnly = false): Result {
  const failed = (why: string) => ({ ok: false, line: `read roots (claude): not granted. ${why} Nothing was changed.` });
  let linked = false;
  try { linked = lstatSync(path).isSymbolicLink(); } catch {}
  if (linked && !existsSync(path)) return failed(`${path} is a link to a missing file. Restore its target, then rerun.`);
  // Writing to the link's target keeps the link, and whoever manages it, such as a dotfiles repo, keeps it too.
  const target = linked ? realpathSync(path) : path;
  let settings: any = {};
  if (existsSync(target)) {
    try { settings = JSON.parse(readFileSync(target, 'utf8')); } catch (error) { return failed(`${target} isn't valid JSON (${(error as Error).message}). Fix it, then rerun.`); }
  }
  const permissions = settings?.permissions ?? {};
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings) || typeof permissions !== 'object' || Array.isArray(permissions)
    || !['allow', 'deny', 'ask', 'additionalDirectories'].every((key) => strings(permissions[key]))) {
    return failed(`${target} doesn't have the shape Claude settings use (an object whose permissions lists hold strings). Fix it, then rerun.`);
  }
  if (permissions.blockReadsOutsideWorkingDirectories === true) {
    return failed(`permissions.blockReadsOutsideWorkingDirectories in ${target} blocks these reads. Setup won't weaken it; turn it off yourself if you want read roots.`);
  }
  const conflicts = roots.flatMap((root) => ['deny', 'ask'].flatMap((list) =>
    (permissions[list] ?? []).filter((rule: string) => covers(rule, root, home)).map((rule: string) => `${list} ${rule} covers ${root}`)));
  if (conflicts.length) return failed(`Existing rules in ${target} are stricter: ${conflicts.join('; ')}. Setup won't weaken them; remove them or drop those roots.`);
  const allow: string[] = permissions.allow ?? [];
  const dirs = (permissions.additionalDirectories ?? []).map((dir: string) => resolve(dir.replace(/^~(?=\/|$)/, home)));
  const added = roots.filter((root) => !allow.some((rule) => covers(rule, root, home)) && !dirs.some((dir: string) => within(root, dir))).map(readRule);
  const where = linked ? `${path} (a link to ${target})` : path;
  if (!added.length) return { ok: true, line: `read roots (claude): ${where} already grants them.` };
  if (checkOnly) return failed('The suggested root is not covered by existing grants.');
  settings.permissions = { ...permissions, allow: [...allow, ...added] };
  const temp = `${target}.factory-setup.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  rmSync(temp, { force: true });
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: existsSync(target) ? statSync(target).mode & 0o777 : 0o600, flag: 'wx' });
  renameSync(temp, target);
  return { ok: true, line: `read roots (claude): added ${added.join(', ')} to ${where}.` };
}

type Probe = { path: string; nonce: string };

/** Reads Claude's stream-json: Read calls only, each probe read with its nonce in a successful result. */
export function claudeReadVerdict(stdout: string, probes: Probe[]): string | null {
  let all: any[];
  try { all = events(stdout); } catch { return 'malformed output from claude.'; }
  const result = all.find((event) => event.type === 'result');
  if (!result) return 'claude ended without a complete run.';
  if (result.is_error) return `claude failed: ${String(result.result).slice(0, 200)}`;
  const content = all.filter((event) => event.type === 'assistant' || event.type === 'user').flatMap((event) => event.message?.content ?? []);
  const uses = content.filter((part: any) => part.type === 'tool_use');
  const stray = uses.find((use: any) => use.name !== 'Read');
  if (stray) return `claude called a tool other than Read (${stray.name}).`;
  const unread = probes.filter((probe) => !content.some((part: any) => part.type === 'tool_result' && !part.is_error
    && uses.some((use: any) => use.id === part.tool_use_id && use.input?.file_path === probe.path) && JSON.stringify(part.content).includes(probe.nonce)));
  if (!unread.length) return null;
  const denied = (result.permission_denials ?? []).length ? ' It was denied permission; check deny and ask rules in your Claude settings and any managed settings.' : '';
  return `claude couldn't read ${unread.map((probe) => probe.path).join(', ')}.${denied}`;
}

/** Reads Codex's exec --json: shell commands and messages only, each nonce in a completed command's output. */
export function codexReadVerdict(stdout: string, probes: Probe[]): string | null {
  let all: any[];
  try { all = events(stdout); } catch { return 'malformed output from codex.'; }
  if (!all.some((event) => event.type === 'turn.completed')) return 'codex ended without a complete turn.';
  const items = all.filter((event) => event.type === 'item.completed').map((event) => event.item);
  const stray = items.find((item) => !['agent_message', 'reasoning', 'command_execution'].includes(item.type));
  if (stray) return `codex did something other than read (${stray.type}).`;
  const outputs = items.filter((item) => item.type === 'command_execution' && item.status === 'completed').map((item) => String(item.aggregated_output));
  const unread = probes.filter((probe) => !outputs.some((output) => output.includes(probe.nonce)));
  return unread.length ? `codex couldn't read ${unread.map((probe) => probe.path).join(', ')}. Check the sandbox and permissions settings in ~/.codex/config.toml.` : null;
}

/** The suggested root: the folder holding the main checkout, so a worktree's own parent is never assumed. */
async function suggestion(deps: SetupDeps) {
  const common = await deps.exec('git', ['-C', deps.root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], 30_000)
    .then(({ stdout }) => stdout.trim(), () => '');
  return realpathSync(dirname(common.endsWith('/.git') ? dirname(common) : deps.root));
}

/** Asks which roots to grant: the suggestion, edited, removed or added to. Returns absolute, real directories. */
// ponytail: rules name the real path only, so reads through a symlinked path to a root still prompt; grant the link path too if that bites.
async function choose(deps: SetupDeps, ask: NonNullable<SetupDeps['ask']>, root: string): Promise<string[]> {
  const roots = [root];
  deps.print('read roots: the chosen agents can read every file under these folders, including repos you add there later. '
    + 'Setup grants no write or shell access. Add other places your checkouts live, such as Orca worktrees.');
  for (;;) {
    roots.forEach((root, index) => deps.print(`  ${index + 1}. ${root}`));
    const answer = (await ask('Press Enter to grant these, type a folder to add it, a number to remove one, or none to skip: ')).trim();
    if (!answer) return roots;
    if (answer === 'none') return [];
    if (/^\d+$/.test(answer)) { roots.splice(Number(answer) - 1, 1); continue; }
    const path = resolve(answer.replace(/^~(?=\/|$)/, deps.home));
    let real: string;
    try { real = realpathSync(path); } catch { deps.print(`read roots: ${path} doesn't exist.`); continue; }
    if (!statSync(real).isDirectory()) { deps.print(`read roots: ${real} isn't a folder.`); continue; }
    if (!roots.includes(real)) roots.push(real);
  }
}

const CODEX = ' Codex already reads anywhere, so nothing was added.';

/** Grants read access to the chosen roots for each agent, and with --verify proves it; at a terminal only. */
export async function readRoots(deps: SetupDeps, agents: string[]): Promise<Result[]> {
  if (!deps.ask) return [{ ok: true, line: 'read roots: not changed. Run npm run setup at a terminal to choose them.' }];
  const root = await suggestion(deps);
  const granted = !deps.readRoots && agents.includes('claude')
    && grantClaudeReads(join(deps.home, '.claude/settings.json'), [root], deps.home, true).ok;
  if (granted) deps.print('read roots: already granted. Run npm run setup -- --read-roots to choose them again.');
  const roots = granted ? [root] : await choose(deps, deps.ask, root);
  if (!roots.length) return [{ ok: true, line: 'read roots: none chosen, nothing changed.' }];
  if (!deps.verify) {
    return agents.map((name) => name === 'claude' ? grantClaudeReads(join(deps.home, '.claude/settings.json'), roots, deps.home)
      : { ok: true, line: `read roots (${name}):${CODEX}` });
  }
  const probes: (Probe & { dir: string })[] = [];
  try {
    // A new folder under each root, made after any grant, shows future repos are covered too.
    for (const root of roots) {
      const dir = mkdtempSync(join(root, '.factory-read-probe-'));
      const nonce = `factory-read-${randomBytes(8).toString('hex')}`;
      writeFileSync(join(dir, 'probe.txt'), `${nonce}\n`);
      probes.push({ dir, path: join(dir, 'probe.txt'), nonce });
    }
  } catch (error) {
    probes.forEach((probe) => rmSync(probe.dir, { recursive: true, force: true }));
    return [{ ok: false, line: `read roots: couldn't write a probe file to check them (${(error as Error).message}).` }];
  }
  const list = probes.map((probe) => probe.path).join('\n');
  const output = (file: string, args: string[]) => deps.exec(file, args, 180_000).then(({ stdout }) => stdout,
    (error) => { if ((error as { killed?: boolean }).killed) throw new Error(`${file} timed out`); return String((error as { stdout?: unknown }).stdout ?? ''); });
  const results: Result[] = [];
  try {
    for (const name of agents) {
      const line = (verdict: string | null, granted = '') => ({ ok: !verdict, line: `read roots (${name}): ${verdict ?? `verified. A fresh ${name} read a new file under each root.${granted}`}` });
      try {
        if (name === 'claude') {
          const grant = grantClaudeReads(join(deps.home, '.claude/settings.json'), roots, deps.home);
          if (!grant.ok) { results.push(grant); continue; }
          deps.print(grant.line);
          // Default mode and only the Read tool, so the settings alone decide, and nothing can be edited or run.
          results.push(line(claudeReadVerdict(await output('claude', ['-p', `Use the Read tool to read each of these files, then reply with the word done. Do not call any other tool.\n${list}`,
            '--output-format', 'stream-json', '--verbose', '--tools', 'Read', '--permission-mode', 'default', '--no-session-persistence']), probes)));
        } else {
          results.push(line(codexReadVerdict(await output('codex', ['exec', '--sandbox', 'read-only', '--ephemeral', '--json', '--skip-git-repo-check',
            `Print each of these files with cat, then reply with the word done. Do not change any file.\n${list}`]), probes), CODEX));
        }
      } catch (error) {
        results.push(line(`couldn't run the check (${(error as Error).message}).`));
      }
    }
  } finally {
    probes.forEach((probe) => rmSync(probe.dir, { recursive: true, force: true }));
  }
  return results;
}
