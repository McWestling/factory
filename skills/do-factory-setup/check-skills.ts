import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const lockPath = `${homedir()}/.agents/.skill-lock.json`;

try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const installed = Object.entries(lock.skills).filter(([, value]) => value.source === 'mcwestling/factory');
  const stdout = execFileSync('gh', ['api', 'repos/mcwestling/factory/contents/skills'], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const current = new Map(JSON.parse(stdout).map((skill: { name: string; sha: string }) => [skill.name, skill.sha]));
  const stale = installed.filter(([name, value]) => current.get(name) !== value.skillFolderHash).map(([name]) => name);
  if (stale.length) console.log(`Out of date: ${stale.join(', ')}. Run: npx skills update -g -y ${stale.join(' ')}`);
} catch {
  // Session start must stay quiet when local state or GitHub is unavailable.
}
