# Issue format

Factory Delegator reads inline tags from an implementation issue's description. The first tag of each kind wins, anywhere in the description, including inside code spans. Linear's escaped bracket form, such as `\[level=standard\]`, means the same thing.

## Repo tag

Every implementation issue must include `[repo=owner/name]` in its Agent brief. The value must match `^[\w.-]+/[\w.-]+$` and name a repo on the machine's allowlist. Delegator reads this tag directly and does not fall back to Product → initiative routing.

## Level and optional pins

Every brief must give a level. Put the tags in **Next**, followed by a plain sentence explaining why the level fits:

```text
[level=standard]
Normal implementation with clear requirements and existing tests.
```

| Level | Alias | Meaning |
| ----- | ----- | ------- |
| `light` | `1` | Mechanical, pattern-following work |
| `standard` | `2` | Normal implementation |
| `deep` | `3` | Cross-cutting or ambiguous work, or hard debugging |

Level words are case-insensitive. A missing or unknown level is refused even when a model pin exists.

- `[model=astra]` optionally pins a model. Pins are rare: add one only when the work needs that model's strength, and explain why in the sentence after the tags.
- Matching lowercases the pin and configured model names and keeps only letters and digits. An exact normalized match wins; otherwise the pin must be a substring of exactly one name. `GPT-6 Astra`, `gpt6astra` and `astra` all match `GPT-6 Astra`; `gpt6` is ambiguous when both Astra and Luna are configured.
- Pins are never refused. If a pin is unknown or ambiguous, the Runner first posts a thought naming the attempted pin, fallback level and model, then launches the level's model. The started thought names the model actually launched.
- `[target=Claude]` names the planned dispatch tool and appears only when it differs from the tracker doc's default target. The Runner reads it but it does not affect launch selection. The Dispatch target label records what actually ran.
- The parser does not read the retired fenced metadata format or fall back to it.

## Runner config

Each machine keeps a `models` map from model names to agent, model identifier and optional effort settings. A required `levels` map selects a configured model for each level:

```json
{
  "levels": {
    "light": "GPT-6 Luna",
    "standard": "GPT-6.1 Sol",
    "deep": "Claude Opus 5.5"
  }
}
```

All three keys are required, and every value must name a key in `models`. Invalid mappings stop the Runner at config load. Existing configs need this map before running the updated Runner. See `packages/delegator/config.example.json` for a complete example.

The skill is not part of the issue format. Runner config's optional `skill` key selects it and defaults to `do-implement`; its value must match `^[a-z0-9-]+$`. Delegator prompts Codex with `$<skill> <issue id>` and other agents with `/<skill> <issue id>`, followed by the delegated-run line. Orca setup runs only for `do-implement` and is skipped for other skills. The configured skill decides what it accepts; a `wayfinder:` label is not a Delegator gate.

## Refusals

Each refusal names the field and what was expected:

- `level`: expected a `[level=…]` tag with 1/light, 2/standard, 3/deep.
- `repo`: expected a `[repo=owner/name]` tag matching `^[\w.-]+/[\w.-]+$`.
- `repo`: expected the tagged repo to appear on this machine's allowlist.

Runtime and launch failures are handled separately by the Runner.

## Launch

The Runner resolves the repo tag, model pin or level mapping, and configured skill, then launches the Linear branch with Orca:

```text
orca worktree create --name <last segment of the branch> --repo path:<local checkout> --branch <Linear gitBranchName> --agent <agent> --model <model> [--effort <effort>] "--prompt=<agent-specific prefix><skill> <issue id>\nDelegated run: nobody is watching this session." --setup run|skip --linear-issue <issue id> --json
```

Codex uses `$` as the prefix; Claude and other agents use `/`. The prompt's second line, `Delegated run: nobody is watching this session.`, tells the skill to make default calls instead of stopping to ask; `do-implement` lists them under **Questions along the way**.

Orca requires `--name`. The prompt is one argument in `--prompt=` form, and the Runner calls `execFile` with this argv, never a shell. It refuses an issue id or branch name that isn't plain, so neither can look like a flag.

This contract lives here; the parser and its tests live in `packages/delegator/` beside the shared job type.
