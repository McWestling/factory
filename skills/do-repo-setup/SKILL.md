---
name: do-repo-setup
description: Set up a repo for the factory skills. Points AGENTS.md at the home repo's tracker doc when the values live in another repo, removing any local copy; otherwise writes the repo's values-only tracker doc (`docs/issue-tracker.md`) from Linear and a fixed template, asking only what neither settles, and links it from AGENTS.md. It writes the repo's own Review rule into AGENTS.md, copies the Tool Stack's scripts-language rule into AGENTS.md, offers to run the Adding a repo blocks on the Tool Stack's service pages, fills in any missing parts of the README's non-developer intro, and installs the dev-port convention in a repo with a dev server. Re-running fills gaps and applies template changes from the skill's changelog. It ends by offering a draft PR of what it wrote.
disable-model-invocation: true
---

The other factory skills (`do-post-its`, `do-triage`, `do-refine`, `do-implement`, `do-closeout`) hold all of the procedure and none of the workspace values. Those values live in one short **tracker doc**, kept in one **home repo**; every other repo's `AGENTS.md` points to it. Your job is to set the repo you are in up so the other skills can run here: point it at the home repo's doc, or, when this repo is the home repo or there is no other, write the doc here. If the repo has a dev server, you also install the [dev-port convention](https://github.com/mcwestling/factory/blob/main/tools/orca/README.md), so parallel Orca workspaces each get their own ports.

Setup is opinionated and deterministic: the same Linear workspace always gives the same doc. The doc is the [template](#template) below, copied verbatim, with only its `{{…}}` slots filled from Linear. Never reword, reorder or add to the template's text.

The run asks at most one round of easy questions. It reports whether dependencies are usable, saying "Looks good, we're set up!" only when they are, and offers a draft PR when it wrote files. Never end with a list of notes for the user to parse.

**Asking.** Ask with AskUserQuestion where the client has it (multiSelect when picking several items, up to 4 questions per call), otherwise in chat.

## Linear

Use the Linear MCP server for every read. If it is unavailable or unauthorized, stop and report that; don't fall back to a browser, the app, or the API. Write to Linear only when the user picks that option in a question.

## Machine check

Run this before anything else; it asks nothing, so it doesn't count toward the question round.

- **`gh`:** run `gh auth status`. If `gh` is missing or the command fails, stop and tell the user to install it or run `gh auth login`, then run setup again.
- **Upstream skills:** inspect the current agent's advertised skills for `grilling`, `domain-modeling`, `research`, `prototype`, `tdd`, `codebase-design` and `code-review`, either all prefixed `mattpocock-skills:` or all bare from `mattpocock/skills`. The last two support upstream TDD. Use the agent's existing plugin list and skills-CLI list/lock to distinguish an enabled installation from one merely cached on disk. An installation that this session cannot discover is pending, not usable. Do not invoke a dependency just to check setup: it may start an interview or edit files.
- **Orca:** recommended, never required. It's found if any `ORCA_*` environment variable is set or `orca` is on the `PATH`. If not, carry on and mention it in [Finish](#8-finish).

### Dependency installation

Factory owns the workflow; [Matt's upstream skills](https://github.com/mattpocock/skills#installation-30-second-setup) supply the supporting practices. Install the full upstream set so its sibling calls and references are supplied too. Use one form per agent, and only target the agent running setup. On a Mac, `npm run setup` in the home repo's checkout follows these same rules for the agents it's run for, so mention it when the dependencies are missing.

- **Already usable:** keep the existing form; offer no install. If both forms are present, report the duplication for the maintainer to resolve; do not install or remove anything.
- **Installed but undiscovered:** request a fresh session of the current agent and rerun setup; do not install another form.
- **Missing or partial:** include the dependency question in step 3. Prefer the plugin when the current agent supports it. Keep an existing CLI installation on the CLI route rather than adding a plugin over it. Use the current upstream installation instructions for other plugin-capable agents.

Commands for a missing plugin:

```sh
# Claude Code only
claude plugin install mattpocock-skills@claude-plugins-official
# Codex only
codex plugin marketplace add mattpocock/skills
codex plugin add mattpocock-skills@mattpocock
```

For an agent without plugin support, or to complete an existing CLI installation:

```sh
npx skills add mattpocock/skills --skill '*' -g -a <current-agent> -y
```

Replace `<current-agent>` with that agent's skills-CLI identifier (for example `claude-code`); resolve it from the installer's supported agents, never guess or use `--all`. Never run `-y` without `-a`. This may use the installer's shared canonical store; it must create links only for the selected agent. Never install the CLI form for an agent already using the plugin. Before a CLI install, check whether its shared store would also expose bare skills to another plugin-enabled agent on this machine. If it would, defer the install and report the conflict so the maintainer can choose one form for the affected agents; do not build alternate storage or wrappers.

After the step 3 answer, run only the approved route, then recheck the current agent's discovery. On failure or skipped install, report missing dependencies. When installed but not advertised, say: "Dependencies installed; start a fresh session and rerun do-repo-setup before using do-refine or do-implement." Continue independent repo setup, but keep overall setup pending.

## 1. Find what exists

1. **Tracker doc path:** Find it through `AGENTS.md`, which names either a path in this repo or a doc in another repo (like `docs/issue-tracker.md` in `owner/name`); read another repo's doc from its checkout, found through `orca repo list --json`. If `AGENTS.md` names none, use `docs/issue-tracker.md`.
   - **Pointer repo:** `AGENTS.md` names a doc in another repo, so that repo is the **home repo** and this one is settled: never ask the home repo question, never write a local doc, and never edit the home repo's checkout. Find its checkout in `orca repo list --json` by matching its `origin` remote, and read the doc there. If there is no checkout, no Orca, or no doc at that path, note it for [Finish](#8-finish). If its setup version is older than this skill's, note that setup should run in the home repo; don't apply the [changelog](#changelog) here. Skip the doc's gaps, drift, template and changelog questions below: they belong to the home repo's run.
   - **Otherwise:** list the candidate home repos for [step 3](#3-ask-once): each repo in `orca repo list --json`, other than this one, whose checkout holds a tracker doc and whose `AGENTS.md` doesn't point elsewhere. Without Orca there are none.
2. **Existing doc:** if it exists, read it. Every value already in it is settled: you never overwrite it, only fill gaps and apply [changelog](#changelog) entries. A **gap** is a template heading that is missing or empty, or a line starting `TODO:`.
3. **AGENTS.md:** note whether it links the tracker doc, any other links to a local doc, whether it has a `## Scripts` section, and whether it says how PRs are reviewed (a **Review** line under `## Pull requests`).
4. **README:** read `README.md`, if any, and note which parts of the intro it has, using [step 6](#6-readme-intro)'s check.
5. **Dev server:** read the `dev` script in the root `package.json` (the workspace root's, in a monorepo), `scripts/dev-port`, and `orca.yaml`. No `package.json` or no `dev` script means no dev server: skip [Dev ports](#7-dev-ports).
   When writing or checking `orca.yaml` setup, recommend setting Orca's setup policy to off by default in the repo settings. This lets Linear-only sessions start without installing dependencies; delegated `do-implement` runs still get setup from the Runner when they request it.
6. **Working tree:** note the current branch and which files `git status` already shows as changed, so [Finish](#8-finish) can tell setup's changes from the user's.
7. **Setup version:** the doc's `**Setup version:**` line records which version of this template wrote it; this skill's version is the one in its template. Versions sort by date, then by suffix, and no suffix sorts first (`2026-10-25` < `2026-10-25.2`). The same version means fill gaps only. An older version also means applying each newer [changelog](#changelog) entry. A doc with no such line predates versioning: treat it as `2026-10-25`. A doc with a newer version than the skill means the skill is out of date: stop and tell the user to update the factory skills.

## 2. Read Linear

In a pointer repo, read only the Tool stack and its Adding a repo blocks. Otherwise, read in parallel:

- **Workspace and team:** `get_workspace` for its name; `list_teams`, ignoring retired teams.
- **Issue statuses:** `list_issue_statuses` for the team, in workflow order.
- **Labels:** `list_issue_labels` with groups included, for the team and the workspace.
- **Initiatives:** `list_initiatives`, with each description's first line.
- **Views:** `list_custom_views`.
- **Templates:** `list_templates` for the team, type `issue`.
- **Tool stack:** `list_documents` with query `Tool Stack`, then `get_document` on the one titled exactly `Tool Stack`. Its **Scripts row** is the table row whose first cell is `Scripts`; its rule is that row's second cell.
- **Adding a repo blocks:** `get_document` on each Linear document the Tool Stack links to, one hop only (never follow links from those pages). A page's **block** is the first ```` ```toml ```` code block under a heading that reads exactly `## Adding a repo`. Most pages have none; skip them silently.
- **Models:** on every run, fetch each page under the template's Sources, following redirects, and check every model in the template's table is still listed. Never reuse a check from an earlier run or session, however recent. If a page fails or only partly loads, fetch it once more. If it is still incomplete, each of its models you can't find there is **unconfirmed**: keep it, ask nothing about it, and name it in [Finish](#8-finish) with the page that failed. A model is stale only when a fully loaded page no longer lists it. While any model is unconfirmed, leave the doc's **Checked** date as it is.

## 3. Ask, once

Collect everything below that applies, and ask it all in one AskUserQuestion round (at most 4 questions per call; more calls only if needed). Write each question for someone new to the factory: say what you found in plain words, say what each option will do, and put the recommended one first. If someone new couldn't answer it, don't ask: use the default. Skip anything the existing doc already settles.

- **Home repo:** unless this is a pointer repo, ask once whether this repo's tracker values live in another repo. Ask it first, in its own call, since its answer decides which questions below apply. Offer each candidate from step 1 as `owner/name`, and **This repo holds them**; recommend the first candidate when there is one, otherwise **This repo holds them**. The user can type another `owner/name`. Picking another repo makes it the home repo and this a pointer repo for the rest of the run: check its doc as step 1 does, and skip the doc questions below. Picking this repo, or skipping, writes the doc here as usual.
- **Dependencies:** when the machine check finds missing upstream skills, offer **Install for this agent** (recommended) or **Skip for now**, naming the route and exact commands from [Dependency installation](#dependency-installation). If the current agent cannot be identified, ask which agent to target in this same round before running any installer.
- **Team:** more than one active team. Which one does this repo's work live in?
- **Repo line:** a product initiative whose first description line isn't exactly `Repo: owner/name` or `Repo: none`. Offer the likely repo (this one, if the name fits), `Repo: none`, and leaving it for later. Offer to write the answer to the initiative.
- **Product label:** an initiative with no Product label of the same name, or the reverse. Offer to create the missing label or skip.
- **Unknown names:** an issue status, or a label in the Dispatch target group, that the template doesn't have a row for. Ask what it's for, with your best guess as the first option.
- **Default target:** the Dispatch target group has no `Orca` label. Which tool should do work by default?
- **Missing views:** a `Factory:` view from the template that Linear doesn't have. Say the user needs to create it in Linear (the MCP can't), with the filters from the template; offer "I'll do it" or "Skip for now".
- **Stale models:** a model a fully loaded vendor page no longer lists. Offer to drop its row or keep it. Never ask about an unconfirmed model.
- **Dev command:** the `dev` script doesn't start the server itself (it calls a custom wrapper such as `node infra/scripts/dev-config.mjs`, or a task runner like `turbo dev`), so you can't tell with confidence how the server takes its port. Say in one sentence which file picks the port, then offer to edit that file so each workspace gets its own port, or to skip for now (every workspace keeps the current port). Never guess.
- **Template:** the team has issue templates, but not exactly one whose name or description says "implementation". Which one do agents use to write implementation issues? Offer each template by name, plus "None" (agents write them without a Linear template).
- **Scripts:** `AGENTS.md` has a `## Scripts` section whose text differs from the Scripts row's rule, with its Linear mentions written as links. Offer to replace the section's text with the rule (recommended) or keep it.
- **Adding a repo:** before checking any blocks, run this to find Python. It goes through the absolute `PATH` entries in order, tries each one's `python3` and `python3.<minor>`, and prints the first that runs and reports Python 3.11 or newer. It skips relative entries, so a repo can't supply the interpreter.

  ```sh
  sh -c 'IFS=:
  for dir in $PATH; do
    case $dir in /*) ;; *) continue ;; esac
    for py in "$dir"/python3 "$dir"/python3.[0-9] "$dir"/python3.[0-9][0-9]; do
      [ -x "$py" ] || continue
      version=$("$py" --version 2>&1 </dev/null) || continue
      case $version in "Python 3.1"[1-9].* | "Python 3."[2-9][0-9].*) echo "$py"; exit 0 ;; esac
    done
  done
  exit 1'
  ```

  Use the printed path as `<python>` for every `adopt.py` call in this setup run. If it prints nothing, skip the blocks and name their pages in [Finish](#8-finish). Otherwise pipe each block to `<python> adopt.py check` (the `adopt.py` beside this file), from the repo root. The check only reads: it runs none of the block's commands, so it can't tell whether a service is already set up, and you must not run them yourself to find out. For each page whose check prints `applies: yes`, ask: **Run** (recommended) or **Skip for now**, naming the page, with the check's `done-check:`, `run:` and `maintainer:` lines verbatim in the option's preview. Explain that **Run** approves the `done` command first and the steps only if it does not exit 0. Ask nothing for a page that doesn't apply.
- **Template change:** a newer [changelog](#changelog) entry whose line differs in the doc. Ask: "Factory now recommends <new text> because <why>. Switch, or keep yours?", with **Switch** first.
- **Drift:** on a re-run, a value in the doc that Linear contradicts (a renamed status, a deleted view). Offer to update the doc line or keep it.

Labels Linear has that the template doesn't use (like a `Release` label) are fine: say nothing about them.

If the user skips a question that fills a slot, write `TODO:` and the question in place of the slot's line.

## 4. Write

1. **Tracker doc:** in a pointer repo, write no doc; if a local copy exists, delete it, and repoint every other `AGENTS.md` link to it at the same file in the home repo. Otherwise, fill the gaps from the template, then apply the newer [changelog](#changelog) entries, keeping every other line as it was. Set the `**Setup version:**` line to this skill's version, adding it if it's missing. For a new doc, write the whole template. Keep tables column-aligned.
2. **AGENTS.md:** if it doesn't link the doc, add the line below under an `## Issue tracker` heading, replacing any link to a local copy there, and touch nothing else. Create `AGENTS.md` with just that if the repo has none. In a repo that holds the doc, use the path from step 1:

   ```markdown
   The workspace values the skills read are in [`docs/issue-tracker.md`](docs/issue-tracker.md).
   ```

   In a pointer repo, name the home repo and the doc's path there (the path its own `AGENTS.md` names, or `docs/issue-tracker.md`):

   ```markdown
   The workspace values the skills read are in [`docs/issue-tracker.md`](https://github.com/owner/name/blob/HEAD/docs/issue-tracker.md) in `owner/name`.
   ```

3. **Review rule:** if `AGENTS.md` doesn't say how PRs are reviewed, add a **Review** line under a `## Pull requests` heading, creating the heading if needed. Use the old **Review** line of the local copy you deleted or the doc you updated, when it describes this repo rather than reading `` each repo's `AGENTS.md` holds its own review rule ``. Otherwise write the default:

   ```markdown
   - **Review:** no PR autopilot in this repo. PRs open as drafts; the maintainer marks them ready and merges.
   ```

4. **Scripts:** if the Tool Stack has a Scripts row and `AGENTS.md` has no `## Scripts` section, append one: the heading, then the row's rule verbatim as its only paragraph, writing each Linear mention as a plain Markdown link (`[name](url)`). If the user picked replace in step 3, swap the section's text for the rule. No Tool Stack or no Scripts row: skip this, and say nothing about it.
5. **Linear:** make the changes the user picked in step 3, and nothing else.

Don't commit yet; [Finish](#8-finish) offers that.

## 5. Adding a repo

Skip this step if no page has a block or the user picked Run for none. Otherwise, for each page they picked, in Tool Stack order, pipe its block to `<python> adopt.py run` from the repo root, using the interpreter selected in [the interview](#3-ask-once). It first runs the approved `done` command, if present; exit 0 prints `done: yes` and skips the steps. Otherwise it runs the approved steps in order, stops at the first failure, and prints only `ok:` and `failed:` lines (never the commands' output) and the `maintainer:` steps it didn't run. Keep those lines for [Finish](#8-finish).

A failed page doesn't stop setup: carry on with the next page and the steps below. Never retry, fix or work around a failed step, install a tool a step needs, or fetch a credential for it; the maintainer does that.

The hook is generic: this step, `adopt.py` and the block format in [`adding-a-repo.example.toml`](adding-a-repo.example.toml). The blocks are each workspace's own, written on its own Tool Stack pages in Linear; this repo holds none.

## 6. README intro

The README opens with an intro for non-developers. It has a loose, fixed shape, plain headings and no machine markers:

1. **Name and one-line pitch:** the `#` title, then one sentence on what it is.
2. **What it does:** a `## What it does` section: a short paragraph or a few bullets, in plain words.
3. **Who it's for:** a `## Who it's for` section: one short paragraph.
4. **Links:** a section of links to deeper docs in the repo (setup, contributing, license).

Check each part by structure, never by judging the wording:

- **Title:** the first non-blank line is a `#` heading.
- **Pitch:** the next non-blank block after the title is a plain paragraph, not a heading, list or code.
- **What it does** and **Who it's for:** a `##` heading with that text, ignoring case and straight or curly apostrophes.
- **Links:** a `##` heading, before any setup or code, whose section is only a list of links.

Skip this step if the README has the title, pitch, What it does and Who it's for. Otherwise write the missing parts, Links included if it has none, in the shape's order, above any developer sections. Keep the parts already there as they are, and leave developer sections alone. With no `README.md`, write the whole intro.

Draft it from the repo itself (code, existing docs, the product's initiative description). If you can't tell what the product does or who it's for, ask in step 3.

**Public safety:** say what it does and who it's for. Never include secrets, internal URLs, workspace or machine ids, personal data, or client details, unless the client is already public about it.

## 7. Dev ports

Skip this step if step 1 found no dev server. Otherwise do each part that isn't already in place. Never touch the per-machine registry; the script manages it.

1. **Vendor:** copy the `dev-port` beside this file to `scripts/dev-port`, executable. If `scripts/dev-port` exists and differs (`cmp`), replace it: the skill's copy is the canonical one.
2. **Claim early:** make sure `orca.yaml` `scripts.setup` runs `./scripts/dev-port`, so the worktree claims its ports when Orca creates it. If `orca.yaml` is missing, create it with just:

   ```yaml
   scripts:
     setup: ./scripts/dev-port
   ```

   If `scripts.setup` already has a command, chain after it (`<existing> && ./scripts/dev-port`, or a new last line in a block scalar). Never replace it.

3. **Wrap the dev command:** in place when the `dev` script already mentions `scripts/dev-port`. Otherwise prefix the server command so it starts on the workspace's port, passing it the way the server takes one:

   ```sh
   PORT="${PORT:-$(./scripts/dev-port)}" && export PORT && next dev -p "$PORT"
   ```

   Use `vite --port "$PORT"` for Vite, and no flag for a server that reads `PORT` itself. Keep the rest of the command as it was. If the [questions](#3-ask-once) covered the dev command and the user said edit, change that file to take its port from `PORT` and start the `dev` script with the `PORT=…` prefix above. If they skipped, leave it.

## 8. Finish

If all dependencies are advertised and usable, say "Looks good, we're set up!". Otherwise say "Repo setup finished; supporting skills are still pending", name the missing skills or failed install, and give the fresh-session instruction above when needed. Add a few words if dev ports were skipped for having no dev server, or if you replaced a `scripts/dev-port` that had drifted. If an Adding a repo block ran, failed or was skipped for want of Python, add one line naming the maintainer steps left to do and any page that failed, with its failed step and exit code. If any model is unconfirmed, add one line naming each one with the vendor page that failed to load. In a pointer repo whose home repo doc couldn't be read, add one line saying why (no checkout in `orca repo list`, no Orca, or no doc at that path); if its setup version is older than this skill's, add one line saying to run setup in the home repo. If the [machine check](#machine-check) didn't find Orca, add one line recommending it, with the link <https://onorca.dev/download>. If you wrote nothing, stop there.

If you wrote files, name them in one line, then ask once (AskUserQuestion): **Open a draft PR** (recommended) or **Leave the changes for me**. Leaving them ends the run with the working tree as it is, for the user to review with `git diff`.

To open the PR:

1. **Branch:** if the current branch isn't the default branch, commit there. Otherwise create a branch from it, named per the tracker doc's **Pull requests** heading; when that rule needs an issue (like a Linear branch name), use `repo-setup`. Never commit or push to the default branch.
2. **Commit only setup's files:** stage them by path. A file the user had already changed before the run (step 1) stays out, with its setup edits: say which, so they can commit it themselves. Leave every other uncommitted change as it was, and say so if there were any. If that leaves nothing to commit, say so and stop. Use a plain imperative subject, like `Set up the factory tracker doc`.
3. **Verify and push:** run the repo's full check if `AGENTS.md` names one, and push only if it passes.
4. **Draft PR:** open it as a draft, titled per **Pull requests**; with no issue id, use the commit subject. The body follows the short form of do-implement's [pr-template.md](../do-implement/pr-template.md): a paragraph on what setup wrote, saying so when it deleted a local tracker doc copy in favour of the home repo's, a **Why** line when a choice needs one, and a **Checked** line. Never mark it ready or merge it.

End with the PR link.

## Verifier delivery assets

The installed skill carries `verifier/factory-verifier`, a generated executable
copy of Factory’s canonical `packages/verifier/factory-verifier`. When vendoring
Verifier, copy from this installed skill directory to `scripts/factory-verifier`,
preserving executable permissions and replacing differing copies; repeated copies
leave identical content. The committed consuming-repo copy is the pin. Full
Verifier installation, hooks and workflows are still planned; this section only
identifies the available delivery asset.

For Factory development, edit the canonical source and regenerate with
`node packages/verifier/bundle.ts`; check with
`node packages/verifier/bundle.ts --check`. Run the canonical core and isolated
skill delivery tests with `python3 packages/verifier/factory-verifier.test.py`
(Python 3.11+), and bundle tests with
`node --test packages/verifier/bundle.test.ts`. Ship the generated copy with the
skill; installed skills use their local bundle without sibling packages or downloads.

## Stale skills check

This is per machine, so it isn't part of a setup run. To get warned about out-of-date factory skills, add a `SessionStart` command hook that runs `node ~/.agents/skills/do-repo-setup/check-skills.ts`. It reads the repo the skills were installed from, so it works for forks, and its fix is `npm run setup` in that checkout.

## Template

Slots are `{{…}}`. Fill them from Linear; everything else is copied exactly, including the `<…>` placeholders in the comment shape and pull request lines. Where a slot is a table row or list item, repeat it for each match, in the order given.

- `{{workspace}}`, `{{team}}`, `{{KEY}}`: the workspace name, team name and team key.
- **Issue status rows:** one row per team status, in workflow order, using the meaning from this table. A status not in it gets the meaning the user gave in step 3.

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

- `{{decision labels}}`: the team's `wayfinder:` labels that exist, in this order: `wayfinder:research`, `wayfinder:grilling`, `wayfinder:prototype`, `wayfinder:task`. Each in backticks, comma-separated.
- `{{retired labels}}`: in this order, comma-separated: the retired labels among `ready-for-agent`, `ready-for-human`, `needs-triage`, `needs-info`, `wontfix`, `wayfinder:map` (in that order); then each retired label group as "the `<name>` group"; then retired Dispatch target labels, always including `Linear/Cursor`, alphabetically, as "and the `A`, `B` and `C` dispatch targets".
- `{{template}}`: the one team issue template whose name or description says "implementation", as `` `<name>` (team-scoped) `` or `` `<name>` (workspace) ``. If the team has no issue templates, write `None. Agents write implementation issues without a Linear template` and don't ask. If none matches or several do, use the user's answer from step 3: the template they picked, or the `None` line.
- `{{tool stack}}`: the Linear document titled exactly `Tool Stack`, as `[Tool Stack](<url>)`. If there is none, write `None yet` and don't ask.
- **Dispatch target rows:** one row per active label in the Dispatch target group, in this table's order, then any others with the meaning the user gave in step 3.

  | Label           | Use it when                                                                      |
  | --------------- | -------------------------------------------------------------------------------- |
  | `Orca`          | Dispatched from Orca                                                             |
  | `Claude`        | Claude Code outside Orca                                                         |
  | `Codex`         | Codex outside Orca                                                               |
  
- `{{orca rule}}`: if there is an `Orca` label, ": a session with any `ORCA_*` environment variable set is `Orca`"; otherwise nothing.
- `{{default target}}`: `Orca` if that label exists; otherwise the user's answer in step 3.

The model table and its Checked date are the factory's curated pick. Copy them as they are; step 3 handles models a vendor has dropped.

```markdown
# Issue tracker

This is {{workspace}}'s config. Other repos point to it from their `AGENTS.md` instead of keeping a copy.

**Setup version:** 2026-11-12.2

The skills hold the procedure. This file holds only the values they look up, under the headings below. Keep the headings stable: skills cite them by name.

## Tracker

- **Tool:** Linear, workspace **{{workspace}}**.
- **Access:** Linear MCP only.

## Team

- **Name:** {{team}}
- **Key:** `{{KEY}}` (issue ids look like `{{KEY}}-<number>`)
- **Scope:** the one team holds every product and company issue.
- **Flat issues:** issues have no parents, including follow-ups. Link related work as related instead.

## Issue statuses

| Status        | Meaning                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
{{issue status rows}}

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
- **Decision types:** {{decision labels}}.
- **Retired, never apply:** {{retired labels}}. Any other label with `retiredAt` is retired too.

## Templates

- **Implementation issues:** {{template}}.

## Tool stack

A Linear document lists the services {{workspace}} uses. **(default)** marks the one new products use when a row offers a choice. A linked service has its own page with setup details. Read it before choosing infrastructure for a product.

- **Document:** {{tool stack}}.

## Initiatives

Each product has an initiative with the same name as its Product label. Its description opens with a `Repo:` line; see [Repo routing](#repo-routing). Company work has no product initiative.

## Repo routing

- **Source:** each product initiative's description opens with exactly `Repo: owner/name`, or `Repo: none` for a product with no repo yet. Several products may share a repo. This is the only product-to-repo mapping.
- **On the issue:** a `` `[repo=owner/name]` `` tag in the issue description, written as a code span. Linear escapes bare brackets to `\[repo=…\]`, which also counts. It overrides everything else.
- **Lookup:** Product label → the initiative with the same name → its `Repo:` line. One hop; never inferred from anything else.
- **Cross-check:** PRs already linked to other issues of the same product. A mismatch stops the work.
- **Unresolved:** no tag and `Repo: none` (or no `Repo:` line). There is no default repo.

## Dispatch targets

| Label           | Use it when                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
{{dispatch target rows}}

The label records where the work was dispatched from, not where the session runs or which model ran. Set it when work starts{{orca rule}}. An issue's `[target=]` tag is the plan when it differs from the default; the label records what actually ran.

**Default target:** `{{default target}}`, for every model below. Never suggest a legacy target.

## Preferred models

**Checked:** 2026-11-10, against the vendor pages under Sources. Re-check when this date is over 90 days old or a listed model retires.

| Model            | Level      | Effort         | Use it for                                                                     |
| ---------------- | ---------- | -------------- | ------------------------------------------------------------------------------ |
| Claude Opus 5.5  | `deep`     |                | Judgment-heavy, cross-cutting or ambiguous work; the maintainer in the session |
| Claude Fable 5.2 | `deep`     |                | Long-horizon or hardest work, when Opus 5.5 at higher effort falls short       |
| GPT-6 Astra      | `deep`     |                | Hardest end-to-end work in Codex, when GPT-6.1 Sol falls short                 |
| GPT-6.1 Sol      | `standard` |                | Complex implementation and agentic work                                        |
| GPT-6 Luna       | `light`    | `high` or above | Focused, pattern-following tickets                                             |

A blank effort means the agent's default. See [Runner config](https://github.com/mcwestling/factory/blob/main/docs/issue-format.md#runner-config) for effort variants.

**Sources:**

- Claude: <https://platform.claude.com/docs/en/about-claude/models/overview>
- Codex: <https://learn.chatgpt.com/docs/models.md>

## Views

The factory expects exactly these shared views on the `{{KEY}}` team. Keep them, and find them by exact name with `list_custom_views`.

| View                  | Kind     | Filters                                                                                                                                       |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Factory: Maps`       | Projects | Project status not `Done` or `Won't Do`; grouped by initiative (product), sub-grouped and ordered by project status                           |
| `Factory: Decisions`  | Issues   | Status `Todo`, no assignee, not blocked, a `wayfinder:` label, in a project                                                                   |
| `Factory: Ready`      | Issues   | Status `Todo`, no assignee, not blocked, no `wayfinder:` label; grouped by Product, then project                                              |
| `Factory: Agent Work` | Issues   | Status `In Progress` or `In Review`, and either delegated to an agent or carrying a `Dispatch target` label; grouped by Product, then project |
| `Factory: All Work`   | Issues   | Status `In Progress` or `In Review`                                                                                                           |

## Triage

- **Queue:** every `{{KEY}}` issue in `Triage`, across all products.
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
- **Kickoff prompt:** a fenced `text` block holding only `/do-implement {{KEY}}-<number>`, with no lead-in. Any explanation goes outside the block.

## Pull requests

- **Title:** a plain imperative subject ending with the issue id in parentheses, like `Fix the login redirect bug ({{KEY}}-<number>)`.
- **Branch:** the issue's Linear branch name (`gitBranchName` from `get_issue`), or the branch the host already made for the issue when its name contains the issue id. Linear builds the prefix for whoever asks, and the prefix shows whether a delegated agent or a person did the work, so keep the host's branch rather than renaming it. Never invent or prefix one yourself.
- **Review:** each repo's `AGENTS.md` holds its own review rule: whether it has a PR autopilot, and who marks PRs ready and merges.
```

## Changelog

Every change to the template's text bumps its setup version to the day of the change and adds an entry here, newest last. If two changes land on the same day, the later version gets a suffix, like `2026-10-25.2`.

Apply each entry newer than the doc's version, in order. Compare with slots filled and table padding ignored:

- **The doc has the old text:** switch it to the new text without asking. An entry whose old text is _none_ adds a new line: the doc has the old text when the line's heading has nothing on that subject.
- **The doc already has the new text:** nothing to do.
- **The doc's line differs:** the user changed it on purpose. Ask in [step 3](#3-ask-once), and switch only if they pick **Switch**.

### 2026-11-05

- **Where:** `## Team`, after **Scope**.
- **Old text:** _none_
- **New text:** `- **Flat issues:** issues have no parents, including follow-ups. Link related work as related instead.`
- **Why:** agents following other tools' wording created sub-issues, and the rule wasn't written where every repo's agents read it.

### 2026-11-06

- **Where:** `## Dispatch targets`, the `Linear/Cursor` row.
- **Old text:** `Cursor Cloud, delegated from Linear. Legacy; retired when Factory Dispatch ships`
- **New text:** `Cursor Cloud, delegated from Linear. Legacy; retired when Factory Delegator ships`
- **Why:** Factory Dispatch was renamed Factory Delegator.

- **Where:** `## Dispatch targets`, the paragraph under the table.
- **Old text:** `The issue's dispatch block target is the plan`
- **New text:** `The issue's factory-run block target is the plan`
- **Why:** the fenced `dispatch` block was renamed `factory-run`.

### 2026-11-09

- **Where:** `## Comment shape`, the **Kickoff prompt** dateline.
- **Old text:** `` - **Kickoff prompt:** a fenced `text` block reading `To kick this off, run /do-implement {{KEY}}-<number>` ``
- **New text:** `` - **Kickoff prompt:** a fenced `text` block holding only `/do-implement {{KEY}}-<number>`, with no lead-in. Any explanation goes outside the block. ``
- **Why:** the copy button copied the lead-in sentence along with the command.

- **Where:** `## Dispatch targets`, the **Default target** line.
- **Old text:** `` **Default target:** `{{default target}}`, for every model below. ``
- **New text:** `` **Default target:** `{{default target}}`, for every model below, Cursor models included. Never suggest a legacy target. ``
- **Why:** Cursor models are dispatched from the default target like every other model, and Dispatch now kept suggesting the legacy Linear delegation.

### 2026-11-09.2

- **Where:** `## Tracker`, the **Access** line.
- **Old text:** ``- **Access:** Linear MCP only. In an Orca workspace, the `orca linear` CLI also qualifies.``
- **New text:** `- **Access:** Linear MCP only.`
- **Why:** Linear access must use MCP in every repo.

### 2026-11-09.3

- **Where:** `## Pull requests`, the **Branch** line.
- **Old text:** `` - **Branch:** exactly the issue's Linear branch name (`gitBranchName` from `get_issue`). Never invent or prefix one. ``
- **New text:** `` - **Branch:** the issue's Linear branch name (`gitBranchName` from `get_issue`), or the branch the host already made for the issue when its name contains the issue id. Linear builds the prefix for whoever asks, and the prefix shows whether a delegated agent or a person did the work, so keep the host's branch rather than renaming it. Never invent or prefix one yourself. ``
- **Why:** Linear gives each caller its own branch prefix, so delegated runs renamed the host's branch to the person's and collided with earlier runs' worktrees.


### 2026-11-10

- **Where:** `## Preferred models`, the Claude Fable row.
- **Old text:** `Claude Fable 5.1`
- **New text:** `Claude Fable 5.2`
- **Why:** Anthropic lists Fable 5.2 as current and Fable 5.1 as legacy.

- **Where:** `## Preferred models`, the **Checked** date.
- **Old text:** `2026-10-25`
- **New text:** `2026-11-10`
- **Why:** All listed models were confirmed against the vendor pages.

- **Where:** `## Preferred models`, the Codex Source.
- **Old text:** `https://learn.chatgpt.com/docs/models`
- **New text:** `https://learn.chatgpt.com/docs/models.md`
- **Why:** The markdown page loads fully and lists every Codex model in the table.

### 2026-11-11

- **Where:** `## Pull requests`, the **Review** line.
- **Old text:** `- **Review:** no PR autopilot in this repo. PRs open as drafts; the maintainer marks them ready and merges.`
- **New text:** ``- **Review:** each repo's `AGENTS.md` holds its own review rule: whether it has a PR autopilot, and who marks PRs ready and merges.``
- **Why:** a tracker doc can now serve repos other than its own, and each repo reviews its PRs its own way. On a switch, move the doc's old **Review** text into `AGENTS.md` under `## Pull requests`, unless it already says how PRs are reviewed.

### 2026-11-11.2

- **Where:** the line under the `# Issue tracker` title.
- **Old text:** `This is {{workspace}}'s config; to adopt, copy it and replace the values.`
- **New text:** ``This is {{workspace}}'s config. Other repos point to it from their `AGENTS.md` instead of keeping a copy.``
- **Why:** setup now points other repos at the home repo's doc instead of copying it, so tracker values are edited in one place. A repo still holding a copy gets the home repo question in step 3; picking another repo deletes the copy.

### 2026-11-12

- **Where:** `## Dispatch targets`, the paragraph under the table.
- **Old text:** `The issue's factory-run block target is the plan; the label records what actually ran.`
- **New text:** `An issue's [target=] tag is the plan when it differs from the default; the label records what actually ran.`
- **Why:** issue briefs now use inline tags instead of a fenced metadata block.

- **Where:** `## Preferred models`, the whole table and the paragraph below it.
- **Old text:** the table has **Model**, **Level** and **Use it for** columns; Luna's use text includes `where a good result is clear`.
- **New text:** add an **Effort** column with the current template values, explain that a blank effort means the agent's default, and link to Runner config for effort variants. Luna's effort is `high` or above and its use text is `Focused, pattern-following tickets`.
- **Why:** setup must carry forward the effort defaults now documented in the tracker, including the Luna minimum.

### 2026-11-12.2
- **Why:** Factory no longer supports Cursor: skill installs for it were unreliable, and setup couldn't verify it.

- **Where:** `## Labels`, the **Retired, never apply** line.
- **Old text:** the retired dispatch targets don't include `Linear/Cursor`.
- **New text:** add `Linear/Cursor` to the retired dispatch targets, in alphabetical order.
- **Why:** Factory no longer supports Cursor: skill installs for it were unreliable, and setup couldn't verify it.

- **Where:** `## Repo routing`, the **On the issue** line.
- **Old text:** `It is the same syntax Cursor's Linear integration reads, and it overrides everything else.`
- **New text:** `It overrides everything else.`
- **Why:** Factory no longer supports Cursor: skill installs for it were unreliable, and setup couldn't verify it.

- **Where:** `## Dispatch targets`, the table.
- **Old text:** the `Orca` row reads `Dispatched from Orca, including Cursor Cloud agents it launches`, and a `Linear/Cursor` row follows `Codex`.
- **New text:** the `Orca` row reads `Dispatched from Orca`, and the `Linear/Cursor` row is gone.
- **Why:** Factory no longer supports Cursor: skill installs for it were unreliable, and setup couldn't verify it.

- **Where:** `## Dispatch targets`, the paragraph under the table.
- **Old text:** `` a session with any `ORCA_*` environment variable set is `Orca`, and Orca sets the label itself on the Cursor Cloud agents it launches. ``
- **New text:** `` a session with any `ORCA_*` environment variable set is `Orca`. ``
- **Why:** Factory no longer supports Cursor: skill installs for it were unreliable, and setup couldn't verify it.

- **Where:** `## Dispatch targets`, the **Default target** line.
- **Old text:** `` **Default target:** `{{default target}}`, for every model below, Cursor models included. Never suggest a legacy target. ``
- **New text:** `` **Default target:** `{{default target}}`, for every model below. Never suggest a legacy target. ``
- **Why:** Factory no longer supports Cursor: skill installs for it were unreliable, and setup couldn't verify it.

- **Where:** `## Preferred models`, the table and **Sources**.
- **Old text:** the table has `Composer 2.5` and `Grok 4.7` rows, and **Sources** lists `Cursor: <https://cursor.com/docs/models>`.
- **New text:** both rows and the Cursor source are gone.
- **Why:** Factory no longer supports Cursor: skill installs for it were unreliable, and setup couldn't verify it.
