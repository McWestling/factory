import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const lockPath = `${homedir()}/.agents/.skill-lock.json`;

try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  // This skill's own lock entry names the Factory repo or fork this machine installed from.
  const source = String(lock.skills['do-repo-setup'].source);
  const installed = Object.entries(lock.skills as Record<string, { source?: string; skillFolderHash?: string }>)
    .filter(([, value]) => String(value.source).toLowerCase() === source.toLowerCase());
  const stdout = execFileSync('gh', ['api', `repos/${source}/contents/skills`], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const current = new Map(JSON.parse(stdout).map((skill: { name: string; sha: string }) => [skill.name, skill.sha]));
  const stale = installed.filter(([name, value]) => current.get(name) !== value.skillFolderHash).map(([name]) => name);
  if (stale.length) console.log(`Out of date: ${stale.join(', ')}. Run npm run setup in your Factory checkout.`);
} catch {
  // Session start must stay quiet when local state or GitHub is unavailable.
}
