# Dispatch gates

An implementation issue may be dispatched only when it passes every gate below. Check them when slicing, when triage routes an issue straight to ready, and again before dispatch.

| Gate                    | Passes when                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Summary**             | One sentence says what's wrong, what's needed, or what to investigate                                                        |
| **Context**             | Repro or background, likely paths, links to decisions, an explicit **Out of scope**, and a **Touches:** line                 |
| **Acceptance criteria** | Checkboxes, each testable, with verification commands wherever they aren't obvious                                           |
| **Blocked by**          | `None`, or every blocker is done. Read each named blocker's current tracker status; Done blockers still named in prose pass. |
| **Human gates**         | No open interview with the user and no unresolved product decision                                                           |
| **Size**                | Fits one PR. Use the repo's size budget if it sets one; otherwise about 400 changed lines of app code is a soft cap          |
| **Repo**                | Resolves to one repo per the tracker doc's **Repo routing**                                                                  |
| **Level**               | A level and reason; a model pin and target only when needed, per [brief-template.md](brief-template.md)                         |

Decision tickets (`wayfinder:<type>`) are never dispatched, whatever gates they pass.

When work fails **Size**, split it into several issues before dispatch. When it fails any other gate besides **Blocked by**, it isn't ready: keep refining it, or turn the gap into a decision ticket.
