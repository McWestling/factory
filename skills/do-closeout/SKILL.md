---
name: do-closeout
description: Check that an agent thread is good to close, and finish what's left. Close out the issue after merge, offer to run unticked after-merge and after-pulling steps (or run the checkable ones unattended in a delegated run), report local git state and loose ends, and give a Good to close or Not yet verdict with a next ticket when good to close.
disable-model-invocation: true
---

Run this at the end of a thread, before the user closes it. It answers one question: **is this closed out, and is the user good to close the thread?** It finishes the issue's closeout, so the user doesn't have to ask for each step.

This skill is one of the factory's `do-` skills and expects its siblings to be installed alongside it. It reads map rules from `do-refine`'s [maps.md](../do-refine/maps.md).

## Workspace values

Workspace values live in the **tracker doc**: the file `AGENTS.md` names, or `docs/issue-tracker.md`. A doc in another repo is read from that repo's checkout, found through `orca repo list --json`. Read it once, before you touch the tracker; "per X" cites a heading in it. Reach the tracker only through the doc's **Tracker** access. If that access is unavailable, say so, skip the tracker check and mark it open in the verdict.

## Delegated runs

A run is **delegated** when its prompt says `Delegated run`. Nobody is in the session, so these rules replace the asking wherever a step names this section. A run without that line follows every step as written, including every **Ask first** rule.

- **No questions.** Never ask. Each item below either runs or stays open.
- **What runs.** Every unticked **After merge** and **After pulling** step in the PR body, and every after-merge item from the repo's `AGENTS.md`, that has an exact command and a clear pass condition, such as a step's `Pass:` line. The merge counts as approval. These stay open for the maintainer: git actions on the branch or worktree, manual checks, steps on another machine, and steps with no clear pass condition.
- **After pulling.** Find the main checkout with `orca repo list --json`, matching the PR's remote. Run `git pull --ff-only` there only when all three guards hold: its working tree is clean, it is on the default branch, and it can fast-forward to the remote's default branch. Then run the **After pulling** steps from it. If any guard fails, the pull and every **After pulling** step stay open: no stash, no branch switch. This fast-forward is the only exception to **Never**, and only in delegated runs.
- **Order and failure.** Run the `AGENTS.md` items, then the **After merge** steps, then the **After pulling** steps, each in checklist order. Stop at the first step that fails its pass condition; that step and every later one stay open. Tick each passed step in the PR body per the [checklist procedure](#pr-after-merge-checklist).
- **Thread loose ends.** Skip [step 4](#4-thread-loose-ends): a fresh agent has no thread history.
- **Report.** Post the completion comment after the steps have run, and list every open step under **Still open** in it. Give the usual [verdict](#6-verdict) in the session.

## 1. Find the issue

One issue per run:

1. The issue the user names, by id or URL.
2. Otherwise, the issue id in the current branch's name (for example `abc-123` in `user/abc-123-fix-login`).
3. Otherwise there is **no issue**: say so, skip [Tracker closeout](#2-tracker-closeout), and run the other checks.

Fetch the issue, its comments, and the PR linked to it or opened from its branch (`gh pr list --head <branch> --state all`). State the issue's title and the PR's state.

## 2. Tracker closeout

**Unmerged PR.** If the PR isn't merged, or there is no PR, change nothing in the tracker. Report what's still open: the PR's state (draft, open, closed), failing checks (`gh pr checks`), and acceptance criteria not yet met. Then skip to [the verdict](#6-verdict); the verdict is **Not yet**.

**Merged PR.** Check each item and fix what's missing yourself:

1. The issue is in the done status per **Issue statuses** (the tracker's automation may already have set it).
2. The merged PR is linked on the issue.
3. The acceptance criteria that the merged change meets are checked off. Read the diff to decide; don't tick a criterion you can't confirm.
4. A completion comment with a dateline per **Comment shape**: what landed, and any follow-ups. Post it even when automation already set the issue done; it's the record that closeout ran. Skip it only if one is already there.
5. If the issue sits on a map, update the map per [maps.md](../do-refine/maps.md). Set the map to its finished status only when its Destination is reached and no open issues remain.

**Partial landing.** If only some criteria landed, don't set the done status. The issue stays in progress, with a comment saying what landed and what remains.

## 3. Local git state

Report, and change nothing:

- Uncommitted changes (`git status --short`).
- Commits not pushed to the branch's upstream, or a branch with no upstream.
- Stash entries made on this branch (`git stash list`, matched by branch name).
- Whether the branch is merged into the default branch (a merged PR counts, since squash merges don't show in `git branch --merged`).

## 4. Thread loose ends

A delegated run skips this step, per [Delegated runs](#delegated-runs).

Read back through this session for:

- Follow-ups promised but not filed ("I'll file a ticket for…", "worth a follow-up").
- Questions the user asked, or you asked, that never got an answer.
- TODOs said aloud and not done.

Check the tracker before listing a follow-up: one already filed isn't loose.

## 5. Doc closeout

Do whatever the repo's `AGENTS.md` (and the docs it links) asks for after a merge. If it asks for nothing, say so.

### PR after-merge checklist

Read the merged PR's current body with `gh pr view <n> --json body`. Under **What you need to do**, find the **After merge** and **After pulling** checklists, each stopping at the next group or section. A missing section or checklist adds nothing. Ticked boxes (`- [x]` or `- [X]`) count as done; leave them out of **Still open** and don't rerun them.

List unticked steps and ask whether to run the runnable commands now. A delegated run doesn't ask; it runs the steps [Delegated runs](#delegated-runs) allows, using the procedure below. After the user approves a step:

1. Check the command and its effects against **Never** below. If it would touch git, branches or worktrees, report it for the maintainer instead of running it. Other approved after-merge commands may run; they aren't git actions on the thread's branch. An **After pulling** step runs only from a checkout of the default branch that already includes the merge. If the only such checkout needs a pull first, leave the pull and the step for the maintainer, unless a delegated run's guards allow the pull, per [Delegated runs](#delegated-runs).
2. Run the command, compare its result with the step's `Pass:` line, and report pass or fail. If the expected result is missing or unclear, ask before treating it as passed; a delegated run leaves the step open instead. Manual checks and steps on another machine stay for the maintainer.
3. When a step passes, re-read the PR body, find that same step in the fresh body, and tick only its box. Save the fresh body to a file and use `gh pr edit <n> --body-file <path>`, preserving every other edit. If the step changed or can't be matched confidently, ask rather than overwriting it; a delegated run leaves it unticked and reports it as unrecorded. If saving fails, report that its completion is still unrecorded.

A failed, unrun (including declined), non-runnable or unrecorded step stays under **Still open** and makes the verdict **Not yet**. If the user explicitly dismisses a step as no longer needed, it isn't open; declining to run it now alone isn't dismissal.

## What you may change

- **Fix by yourself:** tracker closeout items only, from [step 2](#2-tracker-closeout).
- **Ask first:** list the loose ends, doc closeout items and unticked PR after-merge steps, ask about each item with AskUserQuestion where the client has it, otherwise in chat, and do each one only after the user says yes to it. For PR steps, run, verify and record completion per the checklist procedure above. File a follow-up as a new issue in the triage status per **Issue statuses**, linked to this issue as related.
- **Never:** touch git, branches or worktrees. No commits, pushes, stash drops, branch deletes or worktree removal; report them and let the user act.
- **Delegated runs:** nobody is asked. Do what [Delegated runs](#delegated-runs) allows and leave the rest open. Its guarded `git pull --ff-only` on the main checkout is the only exception to **Never**.

## 6. Verdict

Before giving the verdict, ask about any remaining items you can act on per **Ask first**; a delegated run skips the questions, per [Delegated runs](#delegated-runs). After each approved action, recheck what is still open and ask the next questions until nothing actionable remains or the user declines or defers it. Then give the verdict below.

End with a bold verdict line, then two short bullet lists, as plain Markdown. It isn't a code block; don't fence it.

**Verdict:** Good to close

**Fixed:**

- <what this run changed>

**Still open:**

- <what's left, and who acts on it>

The verdict is **Good to close** only when nothing is left under **Still open**. Anything open (an unmerged PR, uncommitted or unpushed work, a loose end the user wants kept) makes it **Not yet**. A loose end the user dismisses isn't open.

## 7. Suggested next ticket

Only on **Good to close**. On **Not yet**, the next step is finishing this thread, so leave this out.

Pick one ticket, read-only; change nothing in the tracker:

1. The next unblocked issue in the ready status per **Issue statuses** on the closed issue's map, if it sits on one.
2. Otherwise, the top issue in the `Factory: Ready` view per **Views** with the same Product label.
3. If neither has one, say so in one line and stop.

Print **Suggested next ticket** with the ticket's name and link, then one line telling the user to start a fresh session for it instead of continuing this thread, then the prompt to paste there, then where to run it:

- **Implementation issue:** the **Kickoff prompt** per **Comment shape**. Under it, the issue's repo (its repo tag, or per **Repo routing**) and its `[level=]` tag, plus `[model=]` when present.
- **Decision ticket** (a `wayfinder:` label): `/do-refine <map URL>` in a fenced `text` block, using the map URL the tracker returns, with the repo it routes to.

The fenced block holds only the command; any explanation goes outside it. It is the one copyable block in the reply.
