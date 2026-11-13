export const LEVELS = ['light', 'standard', 'deep'] as const;
export type Level = typeof LEVELS[number];
export type DelegatorIssue = { repo: string; level: Level; model?: string };
export type Refusal = { field: 'level' | 'repo'; expected: string };

function readTag(description: string, key: string, valid: (value: string) => boolean = value => !!value): string | undefined {
  const tags = new RegExp(String.raw`\\\[${key}=([^\]\r\n]*)\\\]|\[${key}=([^\]\r\n]*)\]`, 'g');
  for (const tag of description.matchAll(tags)) {
    const value = tag[1] ?? tag[2];
    if (valid(value)) return value;
  }
}

export function parseIssue(description: string): DelegatorIssue | Refusal {
  const raw = readTag(description, 'level', value => LEVELS.some(name => value.toLowerCase() === name))?.toLowerCase();
  const level = LEVELS.find(name => name === raw);
  if (!level) return { field: 'level', expected: 'a [level=…] tag with light, standard or deep' };
  const repo = readTag(description, 'repo', value => /^[\w.-]+\/[\w.-]+$/.test(value));
  if (!repo) return { field: 'repo', expected: 'a [repo=owner/name] tag matching ^[\\w.-]+/[\\w.-]+$' };
  const model = readTag(description, 'model');
  return { repo, level, model };
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
