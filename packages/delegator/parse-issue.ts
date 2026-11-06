export type DelegatorIssue = { repo: string; model: string };
export type Refusal = { field: 'factory-run' | 'model' | 'repo'; expected: string };
export type DelegatorConfig = {
  models: Readonly<Record<string, unknown>>;
  repos: readonly string[];
};

function readModel(description: string): string | undefined {
  const opening = /^ {0,3}(`{3,}|~{3,})[ \t]*factory-run\b[^\n]*$/m.exec(description);
  if (opening) {
    const fence = opening[1];
    if (opening[0].trim().slice(fence.length).trim() !== 'factory-run') return;
    const rest = description.slice(opening.index + opening[0].length);
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`, 'm').exec(rest);
    if (!closing) return;

    const lines = rest.slice(0, closing.index).split('\n').filter(line => line.trim());
    const fields = lines.map(line => /^([a-z]+):[ \t]*(.*)$/.exec(line.trim()));
    if (fields.some(field => !field)) return;
    const models = fields.filter(field => field?.[1] === 'model');
    return models.length === 1 ? models[0]?.[2].trim() : undefined;
  }
}

export function parseIssue(description: string, config?: DelegatorConfig): DelegatorIssue | Refusal {
  const model = readModel(description.replace(/\r\n/g, '\n'));
  if (!model) {
    return {
      field: 'factory-run',
      expected: 'a factory-run block with one nonempty model field',
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
