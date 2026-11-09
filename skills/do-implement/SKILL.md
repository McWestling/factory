---
name: do-implement
description: Take one implementation issue from the issue tracker to a verified draft PR. Check that it is dispatchable, claim it, build and verify the change, open the draft PR, work the hosted checks, and hand off to `do-closeout` once the PR merges.
disable-model-invocation: true
---

The user hands you one implementation issue: an id like `ABC-123`, or its URL. One run takes it to one verified **draft** PR, then works the hosted checks until the PR is ready for the maintainer. Merging is never yours; closeout waits for the merge and runs through `do-closeout`.

This skill is one of the factory's `do-` skills and expects its siblings to be installed alongside it. It checks issues against `do-refine`'s [dispatch-gates.md](../do-refine/dispatch-gates.md) and reads the lifecycle from its [brief-template.md](../do-refine/brief-template.md). PR bodies follow [pr-template.md](pr-template.md).

## Workspace values

This skill holds the procedure. The tracker values (statuses, labels, repo routing, dispatch targets, comment shape, PR rules) live in the repo's **tracker doc**. Find it through `AGENTS.md`; if `AGENTS.md` doesn't name one, use `docs/issue-tracker.md`. Read it before you touch the tracker. Where this file says "per X", X is a heading in that doc.

Repo commands (typecheck, tests, the full check or preflight, how to run the app and sign in, the PR template) live in the repo's `AGENTS.md` and the docs it links. So do the repo's own rules for the code: playbooks the change must follow, files never to edit.

If a value or command you need is missing, ask the user, use their answer, then offer to add it to the tracker doc or `AGENTS.md`, or to run `do-factory-setup`.

Read and write the tracker only through the access the tracker doc's **Tracker** heading allows. Probe it once before you touch the tracker: call `whoami`, or the tracker's equivalent. The access is unavailable only if that call fails; a tool list that seems to lack the tracker doesn't count, since hosts truncate and defer their tool lists. If the probe fails or the access is unauthorized, stop and say so; don't fall back to a browser, desktop app or raw API.

**Asking.** While the user is in the session, ask in chat (AskUserQuestion where the client has it). In a **delegated run** (the prompt says `Delegated run`) or any run with nobody in the session, don't ask: make the sensible default call and record it; see [step 3](#3-ask-before-guessing).

## 1. Read and check

1. **One issue.** If the user names several, ask which to take first.
2. **Fetch** the issue and its comments, and state its title. Comments can amend the brief; read them all.
3. **Dispatchable.** It must be an implementation issue (no `wayfinder:` label), in the ready status per **Issue statuses**, and pass every gate in [dispatch-gates.md](../do-refine/dispatch-gates.md): in particular, every blocker done and no open human gate. An issue already in progress and assigned to you also counts, whether a dispatch integration or an earlier session claimed it. If it fails, stop and say which gate.

   **Resuming:** if the issue already has your branch or PR, check it out and carry on from where it stands, usually [Build](#4-build) or [the hosted checks](#9-work-the-hosted-checks). Don't open a second PR.
4. **Repo.** Read the repo tag from the description. If it has none, resolve it per **Repo routing** and add the tag before starting, as the first line of the **Agent brief**, where [brief-template.md](../do-refine/brief-template.md) puts it. Check that this checkout's `origin` is that repo, and run the cross-check **Repo routing** gives. If the repo can't be resolved, isn't this checkout, or anything disagrees, stop and say which repo the issue needs. Never guess, and never work in another repo.
5. **Context.** Read the brief's Context, the decisions and specs it links, and the files on its **Touches:** line. Use the repo's domain language if it keeps a glossary.

## 2. Claim

Before any other work: assign the issue to yourself, move it to the in-progress status, and set the dispatch target label per **Dispatch targets**.

Pick the label from the host environment, not from the model you run on. The tracker doc says which signal maps to which label; hosts usually announce themselves through environment variables (for example an Orca or Conductor workspace id). Use a plain CLI label (for example Claude or Codex) only when no orchestrator's signal is set. If the issue is already claimed by you or a dispatch integration, only check the label.

If you can't start after claiming (the repo won't build, access is missing), comment on the issue with what blocks it and what comes next, unassign yourself, and move it back to the ready status.

## 3. Ask before guessing

When the brief leaves a product or design fork open, or its acceptance criteria conflict with the code, don't guess silently.

- **Someone in the session:** ask the user.
- **Delegated run, or nobody in the session:** make the sensible default call and carry on. Pick the option closest to the brief, the decisions it links and the repo's existing patterns; between equals, pick the easiest to reverse. Record each call (the question, what you chose, and why) for the **Questions along the way** list in [step 8](#8-open-the-draft-pr).

A delegated run still stops for a failed dispatch gate and for only three other things: the wrong repo, missing permissions, or a failed tracker probe (see [Workspace values](#workspace-values)). Comment on the issue per **Comment shape** with what stopped it and what comes next, if the tracker still answers. Once claimed, also release the issue as [Claim](#2-claim) says. Then stop.

A small, reversible call inside the brief's requirements is yours to make. Note it in the PR's Summary only if it matters to a reviewer.

## 4. Build

1. **Branch.** If the current branch was made by the host for this issue and its name already contains the issue id, in any case (for example a Runner's `<prefix>/abc-123-…`), keep it: don't rename it or switch away. The prefix shows whether a delegated agent or a person did the work. Otherwise name it per **Pull requests**; if the doc is silent, use the branch name the tracker gives the issue. If that branch already exists, locally or on `origin`, switch to it. Otherwise, if the current branch is a fresh one the host made for this workspace (no commits beyond the default branch), rename it (`git branch -m <name>`); orchestrators often create their own prefixed branches. Otherwise create the branch from the latest default branch. Never rename the default branch, or a branch holding another issue's commits. A host that must choose its own branch name (for example a Cursor Cloud agent) keeps it. If the repo's PR autopilot needs a label for that branch, per **Pull requests**, apply it when you open the PR.
2. **Test first.** Where the change has a testable seam, invoke the advertised `mattpocock-skills:tdd` skill, or bare `tdd` from the skills CLI, and write the failing test before the code. Use the agent's skill mechanism (the Skill tool where available, otherwise read the advertised SKILL.md). If neither is available, stop and ask the user to run `do-factory-setup`.
3. **Check as you go.** Run the repo's typecheck and the test files you touch, per `AGENTS.md`.
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

- **PR autopilot** (per **Pull requests**): it posts a verdict for each head commit. On "ready", stop and report the PR and its verdict. On "needs a fix", follow its hand-back steps in order.
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
- When the brief leaves a product decision open, stop and ask if someone is in the session; in a delegated run, make the default call and list it ([step 3](#3-ask-before-guessing)).
