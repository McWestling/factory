# Issue tracker

This is McWestling's config; to adopt, copy it and replace the values.

**Setup version:** 2026-11-11

The skills hold the procedure. This file holds only the values they look up, under the headings below. Keep the headings stable: skills cite them by name.

## Tracker

- **Tool:** Linear, workspace **McWestling**.
- **Access:** Linear MCP only.

## Team

- **Name:** McWestling
- **Key:** `DO` (issue ids look like `DO-<number>`)
- **Scope:** the one team holds every product and company issue.
- **Flat issues:** issues have no parents, including follow-ups. Link related work as related instead.

## Issue statuses

| Status        | Meaning                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Triage`      | Captured, not yet reviewed. Default for new issues.                                                                          |
| `Backlog`     | In a map but not ready yet.                                                                                                  |
| `Todo`        | Ready. Blockers still decide whether work can start.                                                                         |
| `In Progress` | Claimed, including draft PRs.                                                                                                |
| `In Review`   | PR out of draft and ready to merge. A draft PR stays `In Progress`. Set only by Linear's GitHub automation, never by agents. |
| `Done`        | Decision resolved, or PR merged.                                                                                             |
| `Canceled`    | Declined or won't do.                                                                                                        |
| `Duplicate`   | Duplicate of another issue.                                                                                                  |

## Project statuses

| Status      | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `Uncharted` | Stub map from triage, not yet charted                                         |
| `Idea`      | Charted with a Destination; decisions still open, nothing sliced              |
| `Planned`   | Enough decisions made that implementation issues are sliced or ready to slice |
| `Ongoing`   | Work has started                                                              |
| `Done`      | Destination reached                                                           |
| `Won't Do`  | Abandoned                                                                     |

## Priority

Not used. Leave every issue at **No priority**.

## Labels

- **Product** (group, single-select): the product an issue belongs to; matches its initiative.
- **Dispatch target** (group, single-select): the tool doing the work. See [Dispatch targets](#dispatch-targets).
- **Bug:** a concrete defect. A Triage item without it is a muse.
- **Decision types:** `wayfinder:research`, `wayfinder:grilling`, `wayfinder:prototype`, `wayfinder:task`.
- **Retired, never apply:** `ready-for-agent`, `ready-for-human`, `needs-triage`, `needs-info`, `wontfix`, `wayfinder:map`, the `Repo` group, and the `Conductor`, `Linear/Codex` and `Orca/Cursor` dispatch targets. Any other label with `retiredAt` is retired too.

## Templates

- **Implementation issues:** `Clear issue` (team-scoped).

## Tool stack

A Linear document lists the services McWestling uses. **(default)** marks the one new products use when a row offers a choice. A linked service has its own page with setup details. Read it before choosing infrastructure for a product.

- **Document:** [Tool Stack](https://linear.app/mcwestling/document/tool-stack-aefb0d3bca48).

## Initiatives

Each product has an initiative with the same name as its Product label. Its description opens with a `Repo:` line; see [Repo routing](#repo-routing). Company work has no product initiative.

## Repo routing

- **Source:** each product initiative's description opens with exactly `Repo: owner/name`, or `Repo: none` for a product with no repo yet. Several products may share a repo. This is the only product-to-repo mapping.
- **On the issue:** a `` `[repo=owner/name]` `` tag in the issue description, written as a code span. Linear escapes bare brackets to `\[repo=…\]`, which also counts. It is the same syntax Cursor's Linear integration reads, and it overrides everything else.
- **Lookup:** Product label → the initiative with the same name → its `Repo:` line. One hop; never inferred from anything else.
- **Cross-check:** PRs already linked to other issues of the same product. A mismatch stops the work.
- **Unresolved:** no tag and `Repo: none` (or no `Repo:` line). There is no default repo.

## Dispatch targets

| Label           | Use it when                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
| `Orca`          | Dispatched from Orca, including Cursor Cloud agents it launches                  |
| `Claude`        | Claude Code outside Orca                                                         |
| `Codex`         | Codex outside Orca                                                               |
| `Linear/Cursor` | Cursor Cloud, delegated from Linear. Legacy; retired when Factory Delegator ships |

The label records where the work was dispatched from, not where the session runs or which model ran. Set it when work starts: a session with any `ORCA_*` environment variable set is `Orca`, and Orca sets the label itself on the Cursor Cloud agents it launches. The issue's factory-run block target is the plan; the label records what actually ran.

**Default target:** `Orca`, for every model below, Cursor models included. Never suggest a legacy target.

## Preferred models

**Checked:** 2026-11-10, against the vendor pages under Sources. Re-check when this date is over 90 days old or a listed model retires.

| Model            | Use it for                                                                     |
| ---------------- | ------------------------------------------------------------------------------ |
| Claude Opus 5.5  | Judgment-heavy, cross-cutting or ambiguous work; the maintainer in the session |
| Claude Fable 5.2 | Long-horizon or hardest work, when Opus 5.5 at higher effort falls short       |
| GPT-6 Astra      | Hardest end-to-end work in Codex, when GPT-6.1 Sol falls short                 |
| GPT-6.1 Sol      | Complex implementation and agentic work                                        |
| GPT-6 Luna       | Focused, pattern-following tickets where a good result is clear                |
| Composer 2.5     | Mechanical changes, as a Cursor Cloud agent                                    |
| Grok 4.7         | Mechanical changes, as a Cursor Cloud agent                                    |

**Sources:**

- Claude: <https://platform.claude.com/docs/en/about-claude/models/overview>
- Codex: <https://learn.chatgpt.com/docs/models.md>
- Cursor: <https://cursor.com/docs/models>

## Views

The factory expects exactly these shared views on the `DO` team. Keep them, and find them by exact name with `list_custom_views`.

| View                  | Kind     | Filters                                                                                                                                       |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Factory: Maps`       | Projects | Project status not `Done` or `Won't Do`; grouped by initiative (product), sub-grouped and ordered by project status                           |
| `Factory: Decisions`  | Issues   | Status `Todo`, no assignee, not blocked, a `wayfinder:` label, in a project                                                                   |
| `Factory: Ready`      | Issues   | Status `Todo`, no assignee, not blocked, no `wayfinder:` label; grouped by Product, then project                                              |
| `Factory: Agent Work` | Issues   | Status `In Progress` or `In Review`, and either delegated to an agent or carrying a `Dispatch target` label; grouped by Product, then project |
| `Factory: All Work`   | Issues   | Status `In Progress` or `In Review`                                                                                                           |

## Triage

- **Queue:** every `DO` issue in `Triage`, across all products.
- **Look-back:** survey Done and Canceled issues from the last 90 days.

## Comment shape

| Element            | Markdown                 | Notes                   |
| ------------------ | ------------------------ | ----------------------- |
| Dateline           | `YYYY-MM-DD —` summary   | First line of a comment |
| Section label      | `**Label:**` text        | Bold label inline       |
| Paths, keys, enums | `` `like-this` ``        | Monospace               |
| Bullets            | `- item` on its own line | Standard list           |
| Steps              | `1. item`                | Numbered line           |

Datelines in use:

- **Triage route:** `YYYY-MM-DD — Triage: <Route>. <reason>. <links>`
- **PR opened:** `YYYY-MM-DD — PR opened: <link>`
- **Back to Triage:** `YYYY-MM-DD — Back to Triage: <reason>.`
- **Decision resolved:** a `## Resolution (YYYY-MM-DD)` heading
- **Kickoff prompt:** a fenced `text` block holding only `/do-implement DO-<number>`, with no lead-in. Any explanation goes outside the block.

## Pull requests

- **Title:** a plain imperative subject ending with the issue id in parentheses, like `Fix the login redirect bug (DO-<number>)`.
- **Branch:** the issue's Linear branch name (`gitBranchName` from `get_issue`), or the branch the host already made for the issue when its name contains the issue id. Linear builds the prefix for whoever asks, and the prefix shows whether a delegated agent or a person did the work, so keep the host's branch rather than renaming it. Never invent or prefix one yourself.
- **Review:** each repo's `AGENTS.md` holds its own review rule: whether it has a PR autopilot, and who marks PRs ready and merges.
