---
name: do-implement
description: Take one implementation issue from the issue tracker to a verified draft PR. Check that it is dispatchable, claim it, build and verify the change, open the draft PR, work the hosted checks, and hand off to `do-closeout` once the PR merges.
disable-model-invocation: true
---

The user hands you one implementation issue: an id like `ABC-123`, or its URL. One run takes it to one verified **draft** PR, then works the hosted checks until the PR is ready for the maintainer. Merging is never yours; closeout waits for the merge and runs through `do-closeout`.

This skill is one of the factory's `do-` skills and expects its siblings to be installed alongside it. It checks issues against `do-refine`'s [dispatch-gates.md](../do-refine/dispatch-gates.md) and reads the lifecycle from its [brief-template.md](../do-refine/brief-template.md). PR bodies follow [pr-template.md](pr-template.md).

## Workspace values

Workspace values (statuses, labels, repo routing, dispatch targets, comment shape, PR rules) live in the **tracker doc**: the file `AGENTS.md` names, or `docs/issue-tracker.md`. A doc in another repo is read from that repo's checkout, found through `orca repo list --json`. Read it once, before you touch the tracker; "per X" cites a heading in it.

Repo commands (typecheck, tests, the full check or preflight, how to run the app and sign in, the PR template) live in the repo's `AGENTS.md` and the docs it links. So do its review rule (whether it has a PR autopilot) and the repo's own rules for the code: playbooks the change must follow, files never to edit.

If a value or command you need is missing, ask the user, use their answer, then offer to add it to the tracker doc or `AGENTS.md`, or to run `do-repo-setup`.

Reach the tracker only through the doc's **Tracker** access. Probe it once before you touch the tracker: call `whoami`, or the tracker's equivalent. The access is unavailable only if that call fails; a tool list that seems to lack the tracker doesn't count, since hosts truncate and defer their tool lists. If the probe fails or the access is unauthorized, stop and say so; don't fall back to a browser, desktop app or raw API.

## Delegated runs

A run is **delegated** when its prompt says `Delegated run`. Nobody is in the session, so these rules apply wherever a step names this section.

- **Claim check.** It passes only when the issue's delegate is set to an agent app, whatever its assignee and whether it is still ready or already in progress. A delegate that is unset or isn't an agent app is an unrelated active claim: stop.
- **No field writes.** Cloud Inbox's `launched` write-back owns assignee and status. Only check the dispatch label per **Dispatch targets**.
- **Default calls.** Never ask a product or design question. Pick the option closest to the brief, the decisions it links and the repo's existing patterns; between equals, pick the easiest to reverse. The accepted brief's test seams count as agreed; if it names none, pick an existing public seam consistent with the brief. Record each call (the question, what you chose, and why) for the **Questions along the way** list in [step 8](#8-open-the-draft-pr). A run that isn't delegated but has nobody in the session makes default calls the same way.
- **Stops.** Default calls cover only those questions. Every other stop in this skill still holds: a failed dispatch gate, an unrelated active claim, the wrong repo, a failed tracker probe or missing permissions, a testing skill that can't be located or read, verification that won't pass, three failed fix rounds, and the [Boundaries](#boundaries). On any of them, comment per **Comment shape** with what stopped the run, what comes next, and "undelegate to release"; write no fields; then stop. Skip the comment only when the tracker probe itself has failed.
- **Bad calls.** A tracker call that fails on its own arguments is the run's mistake: fix the call and retry it. Only a failed probe means the tracker doesn't answer.

**Before ending a run,** delegated or not, check that you have either a verified draft PR matching the issue or an evidenced stop this skill explicitly permits. If neither is true, take the next available step. An unread comment, a test not yet run, an environment signal not yet checked, or any other prerequisite you haven't attempted is work remaining, not a blocker. Verify a suspected blocker with the available tool before claiming it. In a delegated run, a stop counts only once its stop comment is posted or the probe has failed.

## 1. Read and check

1. **One issue.** If the user names several, ask which to take first.
2. **Fetch** the issue and its comments, and state its title. Comments can amend the brief; read them all.
3. **Dispatchable.** It must be an implementation issue (no `wayfinder:` label), in the ready status (or claimed, as below) per **Issue statuses**, and pass every gate in [dispatch-gates.md](../do-refine/dispatch-gates.md): in particular, every blocker done and no open human gate. A delegated run uses the claim check in [Delegated runs](#delegated-runs). In a non-delegated run, an issue already in progress and assigned to you also counts; an issue assigned to someone else and not delegated is an unrelated active claim. If any gate fails, stop and say which gate.

   **Resuming:** if the issue already has your branch or PR, check it out and carry on from where it stands, usually [Build](#4-build) or [the hosted checks](#9-work-the-hosted-checks). Don't open a second PR.
4. **Repo.** Read the repo tag from the description. If it has none, resolve it per **Repo routing** and add the tag before starting, as the first line of the **Agent brief**, where [brief-template.md](../do-refine/brief-template.md) puts it. Check that this checkout's `origin` is that repo, and run the cross-check **Repo routing** gives. If the repo can't be resolved, isn't this checkout, or anything disagrees, stop and say which repo the issue needs. Never guess, and never work in another repo.
5. **Context.** Read the brief's Context, the decisions and specs it links, and the files on its **Touches:** line. Use the repo's domain language if it keeps a glossary.

## 2. Claim

Before any other work:

- **Delegated run:** run the claim check and write no fields, per [Delegated runs](#delegated-runs).
- **Non-delegated run:** assign the issue to yourself, move it to the in-progress status, and set the dispatch target label per **Dispatch targets**.

Pick the label from the host environment, not from the model you run on. The tracker doc says which signal maps to which label; hosts usually announce themselves through environment variables (for example an Orca workspace id). Use a plain CLI label (for example Claude or Codex) only when no orchestrator's signal is set. In a non-delegated run, if the issue is already in progress and claimed by you or a dispatch integration for this run, only check the label.

If you can't start after claiming (the repo won't build, access is missing), comment per **Comment shape** with what stopped it and what comes next. A non-delegated run then moves the issue back to the ready status and unassigns itself; a delegated run follows its stop rule in [Delegated runs](#delegated-runs).

## 3. Ask before guessing

When the brief leaves a product or design fork open, or its acceptance criteria conflict with the code, don't guess silently.

- **Someone in the session:** ask the user.
- **Nobody in the session:** make the default call per [Delegated runs](#delegated-runs) and carry on.

A small, reversible call inside the brief's requirements is yours to make. Note it in the PR's Summary only if it matters to a reviewer.

## 4. Build

1. **Branch.** If the current branch was made by the host for this issue and its name already contains the issue id, in any case (for example a Runner's `<prefix>/abc-123-…`), keep it: don't rename it or switch away. The prefix shows whether a delegated agent or a person did the work. Otherwise name it per **Pull requests**; if the doc is silent, use the branch name the tracker gives the issue. If that branch already exists, locally or on `origin`, switch to it. Otherwise, if the current branch is a fresh one the host made for this workspace (no commits beyond the default branch), rename it (`git branch -m <name>`); orchestrators often create their own prefixed branches. Otherwise create the branch from the latest default branch. Never rename the default branch, or a branch holding another issue's commits. A host that must choose its own branch name keeps it. If the repo's PR autopilot needs a label for that branch, per its `AGENTS.md`, apply it when you open the PR.
2. **Test first.** Where the change has a testable seam:
   - **Agree the seam.** In an interactive run, confirm seams with the user before writing tests. Otherwise take them per [Delegated runs](#delegated-runs).
   - **Load TDD.** Select advertised `mattpocock-skills:tdd`, otherwise bare `tdd`. Use the Skill tool if present; otherwise read the advertised `SKILL.md`, then search installed-skill locations if needed. Stop only if the skill can't be located or read: report what was tried and failed, stop as [Claim](#2-claim) says, and name `do-repo-setup` as the next step.
   - **Run the loop.** Follow TDD with the seam policy above: run a failing test, implement, then run it to green. A red test starts implementation; it isn't a handoff.
3. **Check as you go.** Run the repo's typecheck and the test files you touch, per `AGENTS.md`.
   If a required dependency is missing, run the repo's `orca.yaml` setup command once, then retry verification. Check the dependencies the verification command needs (for example, the package's `node_modules` directory); do not run setup just because the worktree is new.
4. **Stay in scope.** Build only the brief's requirements, and respect its **Out of scope**. File anything else you find as a new issue in the triage status per **Issue statuses**: a short title, what you saw, this issue's project, and a Product label when the product is obvious. Keep it flat (no parent issue, even if a host tool offers one) and link it to this issue as related. In the PR body, list each filed issue on its own line as `Related to <ID>: [<title>](<URL>)`, using the issue URL returned by the tracker; other phrasings move the filed issue's status.
5. **Follow the repo's rules.** Follow every repo playbook the change touches, and never edit what `AGENTS.md` says not to.

## 5. See it work

For changes a person can see or use (UI, sign-in), run the app per `AGENTS.md` and walk each acceptance criterion by hand, in a browser where there is one. Write the steps you took as a numbered **Test plan** for the PR, in the format the repo's docs set, if any. Changes nobody can see skip this step.

## 6. Review your own diff

Make a careful pass by hand over the diff against the default branch. Fix what it finds, or say in the PR's Summary why a finding stands.

## 7. Verify and push

1. Merge the latest default branch and commit everything. Commits use plain imperative subjects.
2. In repos adopting Factory Verifier, run `scripts/factory-verifier preflight` after incorporating the latest default branch and committing, before **every** push. It runs all local checks and saves evidence for the committed tree. Any later code change needs evidence for its new tree; a message-only amend can reuse evidence. Repos without Verifier run their documented full check per `AGENTS.md`.
3. Push only the commit that passed. Agents need explicit user authorization for that specific push to use `FACTORY_VERIFIER_OVERRIDE="<reason>"`; the reason must be non-empty. Local evidence covers the verified tree; main advancing can change the eventual merge result.

## 8. Open the draft PR

- **Title** per **Pull requests**: a plain imperative subject ending with the issue id in parentheses, like `Fix the login redirect bug (ABC-123)`.
- **Body:** follow [pr-template.md](pr-template.md), unless the repo has its own PR template; then the repo's wins. Add any doc closeout line `AGENTS.md` asks for. Write the body to a file and send it with `gh pr create --body-file <path>` (or `gh pr edit --body-file <path>`), never inline with shell escapes: escaped backticks reach GitHub as literal backslashes.
- **Questions along the way:** when you made calls under [step 3](#3-ask-before-guessing), add a `## Questions along the way` section after the Summary, one bullet per call: the question, what you chose, and why. Leave it out when there were none.
- Open it as a **draft**. Never mark it ready by hand.
- Post the **PR opened** comment per **Comment shape** on the issue, followed by the same **Questions along the way** list when there is one. The issue stays in progress; only the automation named under **Issue statuses** moves it to review. If a host tool offers to change the status when the PR opens, skip that.

## 9. Work the hosted checks

Wait for the checks with the host's PR monitor if it has one, otherwise `gh pr checks <number> --watch`.

- **PR autopilot** (per the repo's review rule in `AGENTS.md`): it posts a verdict for each head commit. On "ready", stop and report the PR and its verdict. On "needs a fix", follow its hand-back steps in order.
- **No PR autopilot:** when every check passes, stop and report the PR. The maintainer reviews, marks it ready and merges.
- **A failure:** reproduce it locally, fix its cause, then repeat step 7 and push. If the PR's Summary, Evidence or Merge Danger no longer match the change, update them.
- After **three** fix rounds that still fail, stop. Comment on the PR and the issue with what is still failing and what you tried.

A cloud session that ends before the checks finish is fine; a later session picks up from the PR.

## After the merge

Closeout happens only once the PR has merged: in a later session the user starts, or in this one if the user merges while you're still here. An unmerged PR never makes the issue done, however green its checks.

To close out, run the sibling [`do-closeout`](../do-closeout/SKILL.md) skill on the issue. It owns the post-merge steps.

## Boundaries

- One issue, one PR.
- Never merge the PR or mark it ready.
- Never set the review or done status, or post a completion comment, before the merge.
- Never set priority beyond what **Priority** says.
- Never push unverified work without the maintainer's say-so for that push.
- When the brief leaves a product decision open, ask if someone is in the session; otherwise make the default call and list it ([Delegated runs](#delegated-runs)).
- Never end a run without a verified draft PR or a permitted stop; see the check under [Delegated runs](#delegated-runs).
