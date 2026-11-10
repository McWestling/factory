# Delegated Luna claim investigation

The claim wording needs clarification, but the inspected failures do not establish human assignment as the cause. The strongest recent delegated example accepted the human's claim, then stopped because it mistook a missing invocation tool for a missing testing skill. Other inspected runs stopped on tracker discovery, an unsupported tracker reference, missing dependencies, or a stale blocker description. Treat these as separate failure modes.

## Evidence and limits

Research date: 2026-11-10. Source baseline: Factory commit `b8282cae93672052bbbf456a333648bf7b85ff2c` and installed Matt Pocock skills 1.3.2, commit `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`.

Used the installed retrospective guidance: inspect primary session records, identify environment improvements, and rank candidates by severity. The retrospective skill is present in the installed plugin files and Orca's installed-skill inventory, although it was absent from this session's advertised skill catalog. Its plugin manifest explicitly includes it. [Retrospective source](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/retro/SKILL.md), [plugin manifest](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/.claude-plugin/plugin.json).

Searched the current local Orca session index for `assigned`, `already assigned`, `assignee`, `claimed`, `someone else`, and `TDD`, limited to Codex sessions since 2026-11-01. Read the matching source transcripts for the failed cases below and checked model metadata rather than inferring the model from a ticket. Read the investigation issue, linked write-back decision, and relevant closeout comments through Linear MCP. The successful identity probe established tracker access.

This public note omits private transcript text, tracker links, session identifiers, personal names, host names and local paths. The accompanying tracker research record holds the evidence identifiers and timestamps. The labels A–F below are sanitized aliases, not real ticket identifiers. This was a targeted sample from one indexed host, not a census of every Luna run.

| Case | Observed model | Observed behavior | Causal conclusion |
| --- | --- | --- | --- |
| A: skill-prefix implementation, first run | GPT-6 Luna, medium | Tried a forbidden tracker CLI, assumed MCP absent without probing; after a successful identity probe and issue read, accepted the delegated claim, then stopped over testing-skill invocation | Tool discovery and invocation failure; assignment is mentioned, but no isolated claim refusal is demonstrated |
| B: same task, second run | GPT-6 Luna, medium, later GPT-6.1 Sol | Again assumed MCP absent, later changed code, stopped before docs/tests, then stopped at missing compiler; Sol installed dependencies and finished | Multiple recoverable stops; completion comments corroborate the eventual merged PR |
| C: unsupported-model refusal, delegated prompt | GPT-6 Luna, medium | Prompt included the delegated-run marker; explicitly accepted the human claim and dispatch label; stopped because it believed the TDD mechanism absent; after correction read the TDD file, later wrote failing tests, and ended without implementation | Direct counterexample to assignment as the sufficient cause; discovery error followed by premature termination |
| D: same refusal task, replacement run | GPT-6.1 Sol, medium | Accepted human assignment; waited for explicit approval of the two existing test seams; continued after approval and finished | A real interactive TDD requirement can stop a run; this example is not Luna and was invoked interactively |
| E: runtime documentation clarification | GPT-6 Luna, high | A tracker fetch rejected the bare issue reference; supervising guidance supplied the required entity-prefixed reference; Luna accepted the existing assignment and finished | Identifier-format failure, not missing MCP or conflicting ownership |
| F: local database role | GPT-6 Luna, medium, later GPT-6.1 Sol | Stopped because the brief still named a blocker without checking that blocker's current status; on correction acknowledged it was Done; later Sol completed | Stale prose was treated as current blocker state; this was an interactive invocation, not a proven Runner launch |

No inspected transcript cleanly demonstrates a stop solely because an issue was assigned to its delegating human. That limits the original lead; it does not prove that no such run exists.

## What the source confirms

### Human assignment is intentional

After a successful launch, the Runner reports `launched`; Cloud Inbox then queues field write-back. That write-back assigns the session creator, sets a started status when appropriate, and adds the dispatch label. A model is not the assignee. Changing this policy to assign the model would contradict the implemented ownership model. [Runner launch and reporting](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/runner.ts#L447), [Cloud Inbox write-back](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/cloud-inbox/queue.ts#L422), [write-back regression test](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/cloud-inbox/routes.test.ts#L1006).

The agent starts before the write-back completes. Therefore a launch prompt must not promise that the issue has already reached In Progress or that the label is already set. The current marker promises only that nobody is watching. This sequencing is established by source; per-run wall-clock ordering of the write-back was not reconstructed. [Launch then report](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/runner.ts#L564), [current launch prompt](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/runner.ts#L240).

### The claim language leaves the human/model relationship implicit

Read-and-check admits an in-progress issue assigned to “you”; Claim also exempts a claim made by “you or a dispatch integration.” Neither sentence explicitly defines the delegating human's assignment as belonging to the current run. The two passages can be reconciled, and several inspected runs did reconcile them, but the reader must infer it. This is an instruction ambiguity, not an established implementation bug. [Dispatchability and Claim](https://github.com/mcwestling/factory/blob/fe4395b33c2fe98eb28ec6757275366ff96f8a03/skills/do-implement/SKILL.md#L23).

### Skill availability is already broader than invocation-tool availability

Build explicitly permits reading the advertised `SKILL.md` when a Skill tool is unavailable, yet also leads with invoking a named skill or CLI and ends with “If neither is available.” The failed Luna cases acted as if missing Skill/CLI meant missing skill, despite the file-reading alternative. Clarifying the existing alternatives is smaller than adding another tool or installing another framework. [Build step](https://github.com/mcwestling/factory/blob/fe4395b33c2fe98eb28ec6757275366ff96f8a03/skills/do-implement/SKILL.md#L52).

The installed TDD skill separately requires confirming every test seam with the user before writing tests. The delegated-run rule currently covers product and design defaults and says other stops still apply. A test-seam approval is not explicitly covered. The observed Sol pause followed this TDD instruction; the observed Luna claim to lack an invocation mechanism is a different failure. [TDD seam rule](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/tdd/SKILL.md#L19), [delegated defaults and stops](https://github.com/mcwestling/factory/blob/fe4395b33c2fe98eb28ec6757275366ff96f8a03/skills/do-implement/SKILL.md#L41).

### Several prior fixes already address the older sample

The delegated-run marker, mandatory tracker identity probe, and preservation of host-created issue branches landed together after the earliest failures. Orca setup now installs package dependencies. Do not present these older failures as proof those fixes are absent or ineffective today. Case C happened after the marker was added and shows a remaining skill-discovery/persistence problem. [Delegated-run fix](https://github.com/mcwestling/factory/commit/fe4395b33c2fe98eb28ec6757275366ff96f8a03), [dependency setup fix](https://github.com/mcwestling/factory/commit/abff09412411780d3dbb9a3528474e3b9f1bdbcf), [agent-specific skill prefix fix](https://github.com/mcwestling/factory/commit/c1905137a7439c4b0b24c9ee69c8dafddd4d1648).

## Smallest candidate PR slices

1. **Clarify ownership in `do-implement`.** Update Read-and-check and Claim together: in a delegated run for the named issue, assignment to the delegating human is the expected claim for that run; preserve it, verify the dispatch label, and proceed through the remaining gates. Include the ready/unassigned case because write-back may still be pending. Preserve the stop for a genuine unrelated claim. Keep the current Runner prompt and field-write policy. This is a preventive clarification; the sampled evidence does not establish its failure rate.
2. **Make the existing testing-skill fallback explicit.** In Build, choose the advertised skill name, use its invocation tool when present, otherwise read its advertised file and follow it; declare it missing only when no advertised file can be read. Scope this to the testing instruction unless another reader has the same defect. This directly targets cases A and C and can land independently of ownership wording. It overlaps any ongoing work on skill invocation wording, so coordinate edits to the same paragraph rather than create a dependency.
3. **Resolve unattended seam approval explicitly.** If the product intent is fully unattended implementation, say that an existing seam named in the accepted brief is pre-agreed and that a delegated run chooses an existing public seam when the brief leaves it open, recording that choice. Retain interactive confirmation when a person is present. This is a deliberate policy decision because it changes how the upstream TDD instruction is applied; it is not implied by human-assignee clarification.

The three instruction changes can fit one focused PR once the unattended seam policy is approved. They are separate causes and should have separate acceptance checks. No Runner provenance payload, new queue schema, model-specific ownership policy, or dependency is justified by this evidence.

## Meaningful verification

Use synthetic tracker/tool fixtures and the intended Luna model. Inspect actual reads and mutations, not just the final prose. Run each case once as a smoke check and repeat only where the changed instruction produces inconsistent behavior.

| Scenario | Required observable behavior |
| --- | --- |
| Named delegated issue, In Progress, human assignee, dispatch label, all gates pass | Continues implementation; preserves assignee; checks label; creates no second claim or PR |
| Same launch before write-back, ready and unassigned | Claims through the configured tracker workflow and continues; no false ownership conflict |
| Issue claimed by an unrelated run, with no matching delegation evidence | Retains the ownership guard rather than taking over |
| Skill tool and CLI absent, advertised TDD file readable | Reads that file and proceeds to a failing test before implementation |
| TDD file genuinely unavailable | Reports the specific failed lookup and follows the existing stop/release rule |
| Delegated seam omitted / interactive seam omitted | Applies the chosen unattended policy; interactive run asks when required |
| Blocker Done but still named in prose | Reads the blocker's current tracker status before deciding |
| MCP listed tools deferred | Calls the identity probe before declaring access unavailable |
| Wrong repo, live blocker, failed identity probe, or unverifiable check | Preserves the corresponding stop and release behavior |

A prose-only change needs diff and link review plus this behavioral smoke evidence; static wording assertions cannot establish model behavior. Runner prompt changes would additionally require the existing `launchArgs` assertions and Delegator suite, which already test prompt prefixes and markers. [Runner prompt tests](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/runner/runner.test.ts#L198), [package check](https://github.com/mcwestling/factory/blob/b8282cae93672052bbbf456a333648bf7b85ff2c/packages/delegator/package.json).

No implementation changed and no fresh agent replay was run during this investigation. The proposed instruction changes remain unvalidated until the smoke cases run. The sample does not isolate whether unexplained early endings arise from model behavior, runtime turn limits, or other host conditions; transcripts show the endings, not their internal cause.
