# Factory upkeep research

Research date: 2026-11-10. Source snapshot: [`b8282ca`](https://github.com/mcwestling/factory/commit/b8282cae93672052bbbf456a333648bf7b85ff2c).

## Recommendation

Add one explicitly invoked upkeep command that reuses the existing skills installer and Runner bundle installer. Let closeout offer that command through its existing checklist procedure. Keep automatic closeout execution and Runner self-updates out of the first version. Keep pool migration separate from ordinary upkeep.

The command must refuse Runner replacement until the Runner has acknowledged a safe drain. A fresh idle-looking status file alone cannot prove this. If safe draining cannot fit in the first change, ship the drain prerequisite first rather than quietly weakening that requirement. This recommendation follows the claim/status race and installer behavior described below.

## Evidence and its limits

The investigation read the Done Factory issues completed since 2026-10-25, their comments, linked merged PR bodies, and the source snapshot above. The structured issue query returned 79 issues with no next page. The detailed issue-to-PR-to-command ledger stays in the tracker: it contains operational context that does not belong in this public repository. The public note retains source-level findings and generic commands only. No claim here treats a checked PR box as a shell transcript.

Three kinds of evidence must stay distinct:

- A closeout says an action completed and records the exact command.
- A closeout confirms completion, while the PR body supplies a prescribed command; this does not prove every argument was executed exactly as written.
- A PR body has a checked box, without an independent closeout execution record.

The recent records include repeated global skill installation, a default Runner installation, and a later manual replacement of bundled Runner source followed by a restart. They also include Runner changes whose closeouts contain no deployment evidence. Those absences establish a reporting gap, not proof that nobody updated the installation. Detailed historical evidence is recorded separately in the tracker.

No `retro` skill was advertised to the research session. A cached file is insufficient to establish a usable installation; Factory's own setup procedure distinguishes enabled discovery from cached files. The investigation therefore used the authorized direct PR/comment/source route. [Setup discovery rule](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/skills/do-factory-setup/SKILL.md#machine-check).

## What already exists

The PR template already requires the README's skill reinstall command as the first after-merge step when installed skills change:

```sh
npx skills add mcwestling/factory --skill '*' -g
```

It also recognizes a separate **After pulling** checklist group. The command above is a generic existing installation command, not a new updater contract. [PR template](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/skills/do-implement/pr-template.md#L73-L96).

The stale-skills check reads the installer lock, compares Factory skill-folder hashes with the source repository, and prints a targeted `npx skills update -g -y <skill names>` suggestion. Errors are deliberately silent because this runs at session start. It does not update anything. Reuse this check's source/hash knowledge where appropriate; do not turn the session hook into an installer. [Checker](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/skills/do-factory-setup/check-skills.ts).

Closeout already offers unticked runnable steps, verifies their pass condition, rereads the PR body, and marks only the successful matching step complete. It parses **After merge** only and stops at the next group. Consequently it does not cover the **After pulling** group allowed by the PR template. It also prohibits git/worktree mutations, so an upkeep command used here should not pull, switch branches, or clean a checkout. [Closeout procedure](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/skills/do-closeout/SKILL.md#L64-L80).

Runner installation already has one command:

```sh
sh packages/delegator/runner/launchd/install.sh
```

It builds the menu app and bundles `runner.ts`, `job.ts`, `parse-issue.ts`, the installer and launchd templates. It then enables, unloads and reloads both agents. The Runner executes bundled source rather than the checkout. Pulling source alone therefore does not update the installed Runner; restarting alone reloads whatever is already bundled. [Installer bundle](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/launchd/install.sh#L20-L54), [default installation](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/launchd/install.sh#L112-L121).

`--install-runner` installs the LaunchAgent against the existing bundle; it does not refresh source from the checkout. A file-by-file copy of only `runner.ts` is not an adequate general updater because parser or shared job changes can be part of the same release. [Installer modes](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/launchd/install.sh#L40-L48), [Runner-only path](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/launchd/install.sh#L82-L87).

## Why a naive wrapper is incomplete

**An idle snapshot is not a drain acknowledgment.** `poll()` checks pause, awaits a claim, and only later enters `handleJob()`, where `current` is set. An independent heartbeat can publish fresh status while the claim is outstanding. `writeStatus()` reads the pause flag independently, so even `paused: true` does not acknowledge that the existing claim loop has reached a safe boundary. This is a source-level race analysis, not an observed production incident. [Claim sequence](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/runner.ts#L584-L601), [current job tracking](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/runner.ts#L482-L495), [heartbeat and pause projection](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/runner.ts#L81-L107).

**Pause does not stop existing work.** New claims pause, while in-flight work, watch recovery and PR checks continue. The completion watcher runs independently. A safe restart must account for an active claim/launch and watcher operations, not just an empty `current`. The conservative first version should refuse an update while open watches remain. [Documented pause semantics](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/README.md#L229-L258), [watch loop](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/runner.ts#L626-L638).

**The default installer changes lifecycle state.** It enables and restarts both agents unconditionally. An updater must preserve existing stopped/paused/login choices, or explicitly refuse unsupported states before writing. It must serialize concurrent upkeep attempts and avoid replacing live bundle files before the old process is safely stopped. The existing build writes directly into the installed bundle before the restart; it is not an atomic staged update. [Build](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/launchd/install.sh#L40-L48), [restart](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/launchd/install.sh#L112-L121).

**Recovery does not authorize interruption.** Persisted launch/watch state supports restart recovery, but the documented limitations include an ambiguous crash during create, duplicate thoughts in a narrow crash window, and state loss. Preserve configuration, launch records and watch records; never print their secret values. [Recovery limits](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/README.md#run-the-runner).

## Options

| Option | Benefit | Cost or limitation | Recommendation |
| --- | --- | --- | --- |
| One explicit upkeep command | One entry point and one result; reuses existing installers | Needs trustworthy source, safe drain/refusal, lifecycle preservation and partial-failure reporting | Choose this |
| Automatically run it in closeout | Removes the final invocation | Closeout may run on the wrong machine; it currently offers steps and preserves checked work | Keep closeout as an offer/recording caller |
| Runner self-update | No human invocation | A new runtime download/install/restart path plus compatibility and recovery work | Defer |
| Change nothing | No implementation | Keeps repeated manual installation and inconsistent deployment evidence | Insufficient for the stated goal |

Closeout already contains the execution-and-recording mechanism, so duplicating that logic inside an updater adds no value. A checked item means that item was completed; it should not trigger an installation on every thread close. [Existing checklist mechanism](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/skills/do-closeout/SKILL.md#L64-L74).

## Smallest complete scope

Proposed contract, not implemented here:

1. Run from an existing trusted clean checkout containing the intended merged source. Verify the source identity/revision before mutation, report it in the result, and refuse an unmerged/dirty/unknown source. Do not pull or change git state.
2. Reuse the Factory skills installation route. Respect the existing agent selection and installation form; do not install upstream plugin duplicates. Match verification to the intended source rather than accepting mere skill presence as freshness. [Existing dependency policy](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/skills/do-factory-setup/SKILL.md#dependency-installation).
3. Refresh an existing local Runner installation only after explicit safe-drain acknowledgment, including outstanding claims and watcher work. Refuse if busy, unknown or unsupported; no forced restart. Skip absent Runner installations and say so rather than provisioning them.
4. Reuse the complete bundle build/install path, preserving private config, state, identity and lifecycle choices. Build/stage successfully before replacement; failure must leave a usable prior installation or give a clear recovery result.
5. Verify bundled source/revision, new process identity when a running Runner was restarted, fresh status and successful Cloud Inbox contact. Report skills and Runner outcomes separately; never tick a combined checklist step when only one succeeded. Existing installer checks cover config mode and command availability, but not this entire update contract. [Installer checks](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/launchd/install.sh#L20-L31), [existing installer self-check](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/launchd/install.test.sh).

No need for component flags, a scheduler, a second installer framework, background downloads, a new dependency, or a generic deployment engine in the first proposal. Unsupported runtime states can fail clearly. A new TypeScript command follows the repository's scripts-language rule. [Repository rules](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/AGENTS.md#scripts).

## Pool cutover boundary

The reviewed snapshot still documents one Linear app per machine and a model-based config. It is therefore not evidence that a pool-capable runtime is deployed. Ordinary upkeep must not infer a credential/config migration from new source files. [Current architecture](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/README.md#L1-L20), [current config](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/config.example.json).

Keep app registration/removal, cloud deployment, secret changes, capability/level configuration and disposable live cutover checks in the separately authorized operational cutover. Routine upkeep should never run setup, regenerate machine authority, rewrite allowlists or migrate queued jobs. The existing setup documentation already requires preserving original machine identity/credentials and deploy order; the updater must not bypass those boundaries. [Setup preservation](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/README.md#set-up-your-cloud-inbox), [Cloud Inbox before Runner](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/README.md#L220-L227).

The private cutover brief adds stricter prerequisites: drain queued and leased jobs, finish old-app delegations, install the shared pool app and machine configuration, retire old app credentials, and record the required live checks without exposing secrets. These are cutover requirements, not maintenance commands. Their issue references and current dependencies remain in the tracker ledger.

## Candidate one-PR slices

- **Closeout coverage:** recognize **After pulling** alongside **After merge**, and require deployment instructions when bundled Runner runtime files change. Verify checked boxes are not rerun, unrelated groups are preserved, and a missing installation record stays open. This is independently useful before pool deployment.
- **Preferred upkeep slice:** one command plus the smallest necessary drain coordination and installer changes, documentation and focused tests. Touch the Runner lifecycle only enough to meet the safe-update contract. Test a claim already in flight, open watches, stale/missing acknowledgment, failed build, concurrent invocation, preserved config/state, supported stopped/paused choices, absent Runner and partial failure.
- **Fallback split if that PR grows:** establish safe drain acknowledgment and installation lifecycle preservation first; add the one-command entry point and closeout checklist wording in the next PR. Do not ship a wrapper that claims safety from the current heartbeat.

Implement the Runner-facing slice against the pool runtime/config that will actually be deployed, or explicitly gate incompatible source/config combinations before any install. Keep the operational pool cutover separate.

## What was not checked

No code was implemented, installers run, agents restarted, cloud services changed or Linear issues resolved. This was a read-only source/PR/comment investigation followed by publication of this note on a throwaway research branch. No shell history or full historical session transcripts were available; exact commands were not reconstructed where the primary records omitted them. No production restart/drain test was performed.
