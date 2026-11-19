---
name: do-review
description: Review a draft PR with an independent, read-only reviewer agent and work through its findings until it is happy or three rounds pass. Start the reviewer, triage and fix its findings on the same draft PR, have it re-review the fixes and rerun the full check, then post one report on the issue and the PR.
disable-model-invocation: true
---

`/do-review [<PR or issue>] [<reviewer>]`

Run it in the checkout that holds the PR's branch, once the draft PR is up. The session running this skill is the **fixer**: it starts a **reviewer**, fixes what the reviewer finds, and asks it to look again until it says `happy` or three rounds pass. The skill doesn't care who starts it: a person typing it, another skill or a later job gets the same behaviour.

This skill is one of the factory's `do-` skills and expects its siblings to be installed alongside it. It borrows `do-implement`'s verify-and-push rule and its way of filing out-of-scope finds. The reviewer's instructions are in [reviewer-brief.md](reviewer-brief.md).

## Workspace values

Workspace values (statuses, comment shape, PR rules) live in the **tracker doc**: the file `AGENTS.md` names, or `docs/issue-tracker.md`. A doc in another repo is read from that repo's checkout, found through `orca repo list --json`. Read it once, before you touch the tracker; "per X" cites a heading in it. Repo commands (typecheck, tests, the full check or preflight) live in the repo's `AGENTS.md` and the docs it links.

Reach the tracker only through the doc's **Tracker** access, and probe it once with `whoami` or its equivalent before the first tracker call. If the probe fails, carry on without the tracker: the brief comes from the PR body, work that would have been filed is listed under **Follow-ups** as not filed, and the report goes on the PR and in the session and says the issue comment wasn't posted.

## Default reviewer

This is the one place that names it; a fork changes it here.

- **Agent:** `claude`
- **Model:** `fable`
- **Effort:** `medium`

A reviewer in the arguments overrides it: an agent, a model, an effort, or any of them together, such as `codex gpt-6.1-sol high`. A part it leaves out keeps the default when the agent is the same, and otherwise uses that agent's own default. Orca takes an effort only with a model, so an effort named without a model for another agent is dropped, and the report says so.

## Who is in the session

Nobody is in the session when the prompt says `Delegated run`, or when the caller says so. Otherwise a person is. It changes only who settles a **Needs you** item: see [the report](#5-report).

## 1. Find the PR

- **A PR** (number or URL): review it.
- **An issue id:** review the open PR linked to it or opened from its branch (`gh pr list --head <branch>`).
- **Nothing:** review the current branch's PR (`gh pr view`).

The PR's head branch must be the branch checked out here, with nothing uncommitted. If it isn't, stop and say which branch the review needs; never switch branches or work in another checkout. If the PR isn't a draft, say so and stop: the review runs before anyone marks it ready.

Find the issue from the argument, the PR body or the branch name. With no issue, there is **no ticket**: the brief comes from the PR body, and the report goes on the PR and in the session only.

## 2. Brief the reviewer

Read the issue and its comments, or the PR body when there is no ticket, and the diff against the default branch. Write a brief file in a scratch directory from [reviewer-brief.md](reviewer-brief.md), filling in:

- the issue's goal and acceptance criteria;
- what the change does;
- what is out of scope;
- the riskiest places to look;
- the repo's full check: `scripts/factory-verifier preflight` where the repo adopts Factory Verifier, otherwise the full check its `AGENTS.md` documents;
- the commit under review (`git rev-parse HEAD`).

## 3. Start the reviewer

**In Orca** (any `ORCA_*` environment variable is set), the reviewer is an Orca orchestration worker on this worktree, so it can be any provider. Load the version-matched guide first (`orca skills get orchestration`), then start it:

```sh
orca orchestration worker-start --spec-file <brief> --worktree current \
  --agent <agent> --model <model> --effort <effort> --task-title "Review PR #<n>"
```

Leave out `--model` or `--effort` when the reviewer has no value for it. Keep the dispatch id from the receipt (each later receipt's id replaces it), end your turn, and let Orca wake you. Don't poll. The findings and verdict arrive in the worker's `worker_done` body; if it is cut short, read the rest with `orca orchestration worker-read --dispatch <id>`.

**Outside Orca**, the reviewer is the host's own subagent, given the brief file's text as its prompt, with the reviewer's model and effort where the host lets you choose. If the host can't run that model, use its default and say so in the report.

## 4. The loop

A **round** is one review by the reviewer. The first review is round 1. The loop stops when the reviewer's verdict is `happy`, or after round 3's verdict.

After round 1 or 2, when the verdict isn't `happy`:

1. **Triage first.** Check that the reviewer stayed read-only: `git status --porcelain` is empty and `git rev-parse HEAD` is still the reviewed commit. Then, before changing any code, say which findings you agree with, one line per finding.
2. **Fix** each finding you agree with by the smallest complete change, on the same branch and PR. Add a regression test for each fixed finding where there is a testable seam. Keep the PR a draft. If the fixes make the PR's Summary or Evidence wrong, update them.
3. **Push back** on a `should-fix` or `nit` you won't fix, with a reason. A `blocker` you won't fix, and a finding about the PR's merge-risk rating, are **left to the person**: ask now if someone is in the session, otherwise they go under **Needs you**. Keep fixing the rest either way.
4. **File** work a finding surfaces that is outside the PR's scope as a new issue in the triage status per **Issue statuses**, as `do-implement`'s Build step files out-of-scope finds. Tell the reviewer it was filed, not fixed.
5. **Verify and push** as `do-implement`'s step 7 says: merge the latest default branch, commit, run the repo's full check or preflight, and push only the commit that passed.
6. **Ask for a re-review.** Send the reviewer the last reviewed commit, the new head commit, and what happened to each open finding: fixed (with the commit and test), pushed back (with the reason), filed (with the issue) or left to the person. In Orca, run `orca orchestration send --to dispatch:<id> --subject "Re-review PR #<n>" --body "$(cat <path>)"` and end your turn; it reopens a worker that has closed. Outside Orca, continue the same subagent if the host can; otherwise start a new one with the brief and the earlier findings.

After round 3, change nothing more and go to the report.

If a reply doesn't fit [reviewer-brief.md](reviewer-brief.md)'s findings shape or has no verdict line, ask it once to restate; a second miss counts as `not happy` for that round.

## 5. Report

When the loop ends, write one report. It goes in two places: a comment on the issue per **Comment shape**, and a comment on the PR (`gh pr comment <n> --body-file <path>`). With no ticket, it goes on the PR and in the session. Write it to a file, never inline with shell escapes.

```markdown
YYYY-MM-DD — Review: <the last verdict, such as happy, or not happy until 2 are fixed><, N left to you, when there is a Needs you heading>

**Reviewer:** <agent, model, effort, and Orca worker or host subagent>. <N> rounds, last reviewed `<sha>`.

**Findings:**

1. `<severity>` `<file:line>` <the finding in a few words>. <Fixed in `<sha>`, test `<name>` / Fixed in `<sha>`, not re-reviewed / Pushed back: <reason>; the reviewer <dropped it / kept it> / Filed as <ID> / Left to you / Still open>.

**Checks:** <the full check the reviewer ran on the last reviewed commit, and its result; when the head is past that commit, also your own full check on the head>.

**Follow-ups:** <each filed issue on its own line, or None>.

**Needs you:**

- <each finding left to the person, and each finding still in the verdict after round 3, with what is left to decide>
```

Leave out **Needs you** when nothing is listed under it. A `happy` review has no findings list when the first round found nothing; say "None" there.

When there is a **Needs you** heading:

- **Someone in the session:** ask them about each item first, act on their answers (more fixes go through the loop's verify-and-push rule, and get one more re-review only if the round cap allows), then post the report with what is still left.
- **Nobody in the session:** post the report and end. The PR stays a draft, the issue's status and assignee don't change, and this is not a stop or a failed run.

End the session with the verdict and the report's links.

## Boundaries

- Never mark the PR ready, merge it, or change the issue's status or assignee.
- Never write or change the PR's merge-risk rating (its **Merge Danger** section). The reviewer may raise a wrong one as an ordinary finding; it is left to the person, per [the loop](#4-the-loop).
- One PR, its own branch, and this checkout only.
- The reviewer stays read-only. If it edits, commits, pushes or comments anyway, stop the loop and put what it did under **Needs you**.
