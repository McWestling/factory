export const LEVELS = ['light', 'standard', 'deep'] as const;
export type Level = typeof LEVELS[number];
export type DelegatorIssue = { repo: string; level: Level; model?: string; target?: string };
export type Refusal = { field: 'level' | 'repo'; expected: string };

function readTag(description: string, key: string): string | undefined {
  const tag = new RegExp(String.raw`\\\[${key}=([^\]\r\n]*)\\\]|\[${key}=([^\]\r\n]*)\]`).exec(description);
  return tag?.[1] ?? tag?.[2];
}

export function parseIssue(description: string): DelegatorIssue | Refusal {
  const raw = readTag(description, 'level')?.toLowerCase();
  const level = LEVELS.find((name, i) => raw === name || raw === String(i + 1));
  if (!level) return { field: 'level', expected: 'a [level=…] tag with 1/light, 2/standard, 3/deep' };
  const repo = readTag(description, 'repo');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { field: 'repo', expected: 'a [repo=owner/name] tag matching ^[\\w.-]+/[\\w.-]+$' };
  }
  const model = readTag(description, 'model') || undefined;
  const target = readTag(description, 'target') || undefined;
  return { repo, level, model, target };
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
