# Implementation issue brief

Every implementation issue is written to this template, whoever writes it (`do-refine` when slicing, `do-triage` when routing straight to ready). One issue is one PR. Fill the angle brackets from the work. Phrases like "per **Issue statuses**" name headings in the repo's tracker doc.

## Template

````markdown
## What this is

<One plain sentence a newcomer to the project can follow.>

## Status

<Ready for implementation; no open decisions or blockers remain. | Ready for implementation; blocked only by <blocker names>.>

## Next

Implement this ticket in one PR and run the verification below.

See the [issue format contract](../../docs/issue-format.md).

`[level=standard]` `[model=<model>]`
<One plain sentence explaining why this level fits.>

---

## Agent brief

<The repo tag per **Repo routing**, on every issue>

### Context

<Repro or evidence, likely paths, links to decision tickets and decision records.>

**Touches:** `<dir or file>`, `<dir or file>`

### Requirements

<What must be true when it's done, and the boundaries of the change.>

**README:** <one line for the product README's non-developer intro. Only when this issue completes a major feature; otherwise leave the line out.>

**Out of scope:** <explicit limits>

### Acceptance criteria

- [ ] <Testable criterion>
- [ ] Verification: `<the repo's check command>`

### Blocked by

<None, or the blocking issues by name>

### Lifecycle

- **Dispatch:** ready → in progress when the implementing agent starts.
- **While the PR is open:** stay in progress while the PR is a draft. Only the automation named under **Issue statuses** moves it to review; agents never do. Don't set it done or post a completion comment before the merge.
- **Closeout (after merge only):** whoever merges, or the implementing agent, sets it done, links the merged PR, checks off the acceptance criteria, and adds a completion comment with a dateline per **Comment shape**.
````

## Filling it in

- **What this is / Status / Next** form the front door: a reader should understand the issue without knowing the project. When the scope changes, update Status and Next together. History goes in comments, not in new dated sections of the description.
- **Level:** always write `[level=light|standard|deep]`, choosing by difficulty and risk: `light` for mechanical or pattern-following work, `standard` for normal implementation, and `deep` for cross-cutting, ambiguous or hard-debugging work. Write the word, not the digit.
- **Model pin:** add `[model=<name>]` only when the work needs that model's strength, and explain why in the reason sentence. Otherwise omit it.
- **Reason:** after the tags, write one plain sentence explaining why the level fits. The agent, model and effort come from the level mapping and Runner config described in the [issue format contract](../../docs/issue-format.md).
- **Touches:** the directories and files from your code survey. Dispatch compares these lines to batch issues that don't overlap.
- **Verification:** use the repo's own check command, from its `AGENTS.md` or README.
- **Lifecycle:** use the status names from **Issue statuses**. If the repo has no PR automation (see the review rule in its `AGENTS.md`), say who marks the PR ready and merges.

Decision tickets don't use this template; see [maps.md](maps.md).
