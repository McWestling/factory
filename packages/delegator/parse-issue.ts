export type Level = 'light' | 'standard' | 'deep';
export type DelegatorIssue = { repo: string; level: Level; model?: string; target?: string };
export type Refusal = { field: 'level' | 'repo'; expected: string };
export type DelegatorConfig = { repos: readonly string[] };

function readTag(description: string, key: string): string | undefined {
  const tag = new RegExp(String.raw`\\\[${key}=([^\]\r\n]*)\\\]|\[${key}=([^\]\r\n]*)\]`).exec(description);
  return tag?.[1] ?? tag?.[2];
}

export function parseIssue(description: string, config?: DelegatorConfig): DelegatorIssue | Refusal {
  const rawLevel = readTag(description, 'level')?.toLowerCase();
  const level = rawLevel === '1' ? 'light' : rawLevel === '2' ? 'standard' : rawLevel === '3' ? 'deep' : rawLevel;
  if (level !== 'light' && level !== 'standard' && level !== 'deep') {
    return { field: 'level', expected: 'a [level=…] tag with 1/light, 2/standard, 3/deep' };
  }
  const repo = readTag(description, 'repo');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { field: 'repo', expected: 'a [repo=owner/name] tag matching ^[\\w.-]+/[\\w.-]+$' };
  }
  if (config && !config.repos.includes(repo)) {
    return { field: 'repo', expected: 'a repo on the machine allowlist' };
  }
  const model = readTag(description, 'model');
  const target = readTag(description, 'target');
  return { repo, level, ...(model !== undefined ? { model } : {}), ...(target !== undefined ? { target } : {}) };
}

export function matchModel(pin: string, names: readonly string[]): string | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = normalize(pin);
  if (!key) return;
  const exact = names.find(name => normalize(name) === key);
  if (exact !== undefined) return exact;
  const matches = names.filter(name => normalize(name).includes(key));
  return matches.length === 1 ? matches[0] : undefined;
}
