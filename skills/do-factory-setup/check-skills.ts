import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const lockPath = `${homedir()}/.agents/.skill-lock.json`;

try {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const installed = Object.entries(lock).filter(([, value]: [string, any]) => value.source === 'mcwestling/factory');
  if (!installed.length) process.exit(0);

  const { stdout } = await execFileAsync('gh', ['api', 'repos/mcwestling/factory/contents/skills'], { timeout: 3000 });
  const current = new Map(JSON.parse(stdout).map((skill: { name: string; sha: string }) => [skill.name, skill.sha]));
  const stale = installed.filter(([name, value]: [string, any]) => current.get(name) !== value.skillFolderHash).map(([name]) => name);
  if (stale.length) console.log(`Out of date: ${stale.join(', ')}. Run: npx skills update -g -y ${stale.join(' ')}`);
} catch {
  // Session start must stay quiet when local state or GitHub is unavailable.
}
