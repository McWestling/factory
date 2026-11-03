export type DispatchIssue = { repo: string; model: string };
export type Refusal = { field: 'dispatch' | 'model' | 'repo'; expected: string };
export type DispatchConfig = {
  models: Readonly<Record<string, unknown>>;
  repos: readonly string[];
};

function readModel(description: string): string | undefined {
  const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*dispatch\b[^\n]*$/m.exec(description);
  if (opening) {
    const fence = opening[1];
    if (opening[0].trim().slice(fence.length).trim() !== 'dispatch') return;
    const rest = description.slice(opening.index + opening[0].length);
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`, 'm').exec(rest);
    if (!closing) return;

    const lines = rest.slice(0, closing.index).split('\n').filter(line => line.trim());
    const fields = lines.map(line => /^([a-z]+):[ \t]*(.*)$/.exec(line.trim()));
    if (fields.some(field => !field)) return;
    const models = fields.filter(field => field?.[1] === 'model');
    return models.length === 1 ? models[0]?.[2].trim() : undefined;
  }

  const legacy = /^\*\*Suggested dispatch:\*\*[^\n]*/m.exec(description)?.[0];
  const spans = Array.from(legacy?.matchAll(/`([^`\n]+)`/g) ?? []);
  return spans[0]?.[1].trim() ? spans[1]?.[1].trim() : undefined;
}

export function parseIssue(description: string, config?: DispatchConfig): DispatchIssue | Refusal {
  const model = readModel(description.replace(/\r\n/g, '\n'));
  if (!model) {
    return {
      field: 'dispatch',
      expected: 'a dispatch block with one nonempty model field or a legacy Suggested dispatch line with target and model code spans',
    };
  }
  const tag = /\\\[repo=([^\]\r\n]*)\\\]|\[repo=([^\]\r\n]*)\]/.exec(description);
  const repo = tag?.[1] ?? tag?.[2];
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { field: 'repo', expected: 'a [repo=owner/name] tag matching ^[\\w.-]+/[\\w.-]+$' };
  }
  if (config && !Object.hasOwn(config.models, model)) {
    return { field: 'model', expected: 'an exact model name in the machine config' };
  }
  if (config && !config.repos.includes(repo)) {
    return { field: 'repo', expected: 'a repo on the machine allowlist' };
  }
  return { repo, model };
}
