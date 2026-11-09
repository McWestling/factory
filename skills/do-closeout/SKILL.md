---
name: do-closeout
description: Check that an agent thread is good to close, and finish what's left. Close out the thread's issue once its PR has merged, report local git state, list loose ends from the session and any doc closeout, end with a verdict of Good to close or Not yet, and on Good to close suggest the next ticket to pick up.
disable-model-invocation: true
---

Run this at the end of a thread, before the user closes it. It answers one question: **is this closed out, and is the user good to close the thread?** It finishes the issue's closeout, so the user doesn't have to ask for each step.

This skill is one of the factory's `do-` skills and expects its siblings to be installed alongside it. It reads map rules from `do-refine`'s [Maps section](../do-refine/SKILL.md#maps).

## Workspace values

This skill holds the procedure. The tracker values (statuses, views, repo routing, comment shape, PR rules) live in the repo's **tracker doc**. Find it through `AGENTS.md`; if `AGENTS.md` doesn't name one, use `docs/issue-tracker.md`. Read it before you touch the tracker. Where this file says "per X", X is a heading in that doc.

Read and write the tracker only through the access the tracker doc's **Tracker** heading allows. If that access is unavailable, say so, skip the tracker check and mark it open in the verdict.

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
5. If the issue sits on a map, update the map per do-refine's Maps section. Set the map to its finished status only when its Destination is reached and no open issues remain.

**Partial landing.** If only some criteria landed, don't set the done status. The issue stays in progress, with a comment saying what landed and what remains.

## 3. Local git state

Report, and change nothing:

- Uncommitted changes (`git status --short`).
- Commits not pushed to the branch's upstream, or a branch with no upstream.
- Stash entries made on this branch (`git stash list`, matched by branch name).
- Whether the branch is merged into the default branch (a merged PR counts, since squash merges don't show in `git branch --merged`).

## 4. Thread loose ends

Read back through this session for:

- Follow-ups promised but not filed ("I'll file a ticket for…", "worth a follow-up").
- Questions the user asked, or you asked, that never got an answer.
- TODOs said aloud and not done.

Check the tracker before listing a follow-up: one already filed isn't loose.

## 5. Doc closeout

Do whatever the repo's `AGENTS.md` (and the docs it links) asks for after a merge. If it asks for nothing, say so.

## What you may change

- **Fix by yourself:** tracker closeout items only, from [step 2](#2-tracker-closeout).
- **Ask first:** list the loose ends and doc closeout items, then do each one only after the user says yes to it. File a follow-up as a new issue in the triage status per **Issue statuses**, linked to this issue as related.
- **Never:** touch git, branches or worktrees. No commits, pushes, stash drops, branch deletes or worktree removal; report them and let the user act.

## 6. Verdict

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

Print **Suggested next ticket** with the ticket's name and link, then the prompt to paste into a fresh session, then where to run it:

- **Implementation issue:** the **Kickoff prompt** per **Comment shape**. Under it, the issue's repo (its repo tag, or per **Repo routing**) and its factory-run block's `target` and `model`.
- **Decision ticket** (a `wayfinder:` label): `/do-refine <map URL>` in a fenced `text` block, using the map URL the tracker returns, with the repo it routes to.

The fenced block holds only the command; any explanation goes outside it. It is the one copyable block in the reply.
