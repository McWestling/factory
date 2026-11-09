# Issue format

Factory Delegator reads the repo tag and run instructions from an implementation issue's description. Every brief must use the factory-run block.

## Repo tag

Every implementation issue must include a repo tag in its Agent brief, outside the factory-run block:

```text
[repo=owner/name]
```

Linear may escape the brackets in its rendered description as `\[repo=owner/name\]`; that form means the same thing. The value must match `^[\w.-]+/[\w.-]+$` and name a repo on the machine's allowlist. Delegator reads this tag directly and does not fall back to Product → initiative routing. Keeping the tag outside the block also lets Cursor's Linear integration read it.

## Factory-run block

Put one fenced `factory-run` block in the brief's **Next** section:

```factory-run
target: Orca
model: GPT-6 Luna
reason: <one clause explaining why this model fits>
```

- `target` names the intended dispatch tool. It is a plan only; Delegator ignores it. The Dispatch target label records what actually ran.
- `model` is required and must exactly match a name in the tracker's **Preferred models** table. The machine's `models` config maps that name to its agent, model identifier and effort. A model absent from the machine's config is refused.
- `reason` is a human-readable clause explaining why the selected model fits.
- The agent is determined by the configured model mapping, so the block has no `agent` field.
- The skill is not part of the issue format. Runner config's optional `skill` key selects it and defaults to `do-implement`; its value must match `^[a-z0-9-]+$`. Delegator prompts Codex with `$<skill> <issue id>` and other agents with `/<skill> <issue id>`. Orca setup runs only for `do-implement` and is skipped for other skills. The configured skill decides what it accepts; a `wayfinder:` label is not a Delegator gate.

## Refusals

Each refusal names the field and what was expected:

- `factory-run`: expected a parseable fenced `factory-run` block with one nonempty model field.
- `model`: expected a model name configured on this machine and listed under **Preferred models**.
- `repo`: expected a `[repo=owner/name]` tag matching `^[\w.-]+/[\w.-]+$`.
- `repo`: expected the tagged repo to appear on this machine's allowlist.

These are format and configuration refusals. Runtime and launch failures are handled separately by the Runner.

## Launch

The Runner resolves the repo tag, model mapping and configured skill, then launches the Linear branch with Orca:

```text
orca worktree create --name <last segment of the branch> --repo path:<local checkout> --branch <Linear gitBranchName> --agent <agent> --model <model> [--effort <effort>] "--prompt=<agent-specific prefix><skill> <issue id>" --setup run|skip --linear-issue <issue id> --json
```

Codex uses `$` as the prefix; Claude and other agents use `/`.

Orca requires `--name`. The prompt is one argument in `--prompt=` form, and the Runner calls `execFile` with this argv, never a shell. It refuses an issue id or branch name that isn't plain, so neither can look like a flag.

This contract lives here; the parser and its tests live in `packages/delegator/` beside the shared job type.
