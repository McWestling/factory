---
name: do-triage
description: Work the issue tracker's Triage queue with the user. Survey related work, gather related captures into clusters, and route each cluster to a decline, a duplicate, an existing map, a ready implementation issue, or a new stub map for do-refine.
disable-model-invocation: true
---

Triage holds raw captures nobody has reviewed yet: muses, bugs and follow-ups, often one idea per issue from `do-post-its`. This skill works that queue **with the user**. You survey related work, gather related captures into clusters, propose a route for each, and do the bookkeeping; the user makes every routing call.

Triage **routes**; it doesn't plan. Wanted work leaves in one of two ways: into a **map** (a project, new or existing) or as a ready **implementation issue** with no project. There is no "leave it in Backlog" route. Projects are maps only, so an accepted issue with no project is indistinguishable from an unreviewed muse and comes back next triage. Bugs take the same routes; the Bug label marks an item's type, not an exemption. A cluster that needs real planning leaves as a stub map for a later `do-refine` session. Only an item that one or two questions can settle is refined all the way to ready here.

This skill is one of the factory's `do-` skills and expects its siblings to be installed alongside it. It uses `do-refine`'s [brief-template.md](../do-refine/brief-template.md) and [dispatch-gates.md](../do-refine/dispatch-gates.md), and the map and ticket shapes in its [maps.md](../do-refine/maps.md).

## Workspace values

Workspace values live in the **tracker doc**: the file `AGENTS.md` names, or `docs/issue-tracker.md`. A doc in another repo is read from that repo's checkout, found through `orca repo list --json`. Read it once, before you touch the tracker; "per X" cites a heading in it. If a value you need is missing, ask the user, then offer to add it to the doc or to run `do-repo-setup`. Reach the tracker only through the doc's **Tracker** access; if that is unavailable or unauthorized, stop and say so rather than fall back to a browser, desktop app or raw API.

**Names, not ids.** Refer to issues and maps by title in everything the user reads, with the id or link inside the name. Link projects only with URLs the tracker returns when you create or fetch them; guessed project URLs break.

## 1. Load the queue

- **Triage:** the queue per **Triage**, in the triage status per **Issue statuses**.
- **Maps:** open projects with their summaries, and descriptions where a cluster might fit.
- **Backlog:** every issue in the backlog status (titles, labels, projects), for the survey.

**Scope.** If the user names a subset ("the Post-its from today"), list the other Triage items by name with a one-line gist each and ask which to include. Don't ask an abstract "whole queue or a subset?".

**Loose muses.** A Backlog issue with no project and no triage comment skipped this process, bugs included. List them by name, warn the user, and ask which go back to Triage. Move only the ones picked, post the **Back to Triage** comment per **Comment shape** on each (reason: a loose muse found during triage review), and add them to the queue.

**Parent links.** Issues are flat per **Team**. Sweep for parent links only when the user asks. `list_issues` has no has-parent filter: list the team's issues in each open status per **Issue statuses**, through every page, requesting the `id`, `title` and `parentId` fields, and keep the ones with a `parentId`. If any turn up, list them by name with their parents and ask whether to clear all of them, pick which, or leave them. Clear only the ones the user picks (`parentId: null`).

## 2. Survey

For each item, look for related work and current state:

- **Tracker:** related maps, Backlog issues, other Triage items, and issues in the done and canceled statuses from the look-back per **Triage** (a muse may already have shipped or been declined). Search on the item's key terms and filter by its Product label. Keep the sweep bounded: the look-back window, or the top 10 hits per query.
- **Projects:** search **all** projects by key terms, including finished and abandoned ones and other initiatives. The user may remember a map that never existed, or forget one that did; a distant map can still own the item.
- **Code:** a quick, bounded check of whether the behavior already exists and where it lives (routes, components, schema fields). Survey the item's repo. When that repo per **Repo routing** isn't the current one, find its checkout in `orca repo list --json` (the entry whose remote is that `owner/name`) and read its `AGENTS.md` first. Read only; never edit another repo's checkout. If it has no checkout there, say so and skip the code check. Say where you looked, and note the directories and files involved; ready briefs reuse them. This is for routing, not design.

## 3. Propose clusters

Group items that belong together: the same page or feature, one idea split across several captures, or a muse that is really a step on an existing map. A cluster can be one item. Show the clusters as a compact list: name, members, related existing work, what the code shows, and your recommended route with one line of reasoning. The user may regroup; follow their grouping.

## 4. Route each cluster

Ask the user, recommended route first, marked "(Recommended)", with context in the option descriptions. A multi-item cluster gets its own question; single-item clusters can share a call.

| Route            | When                                                                            | What you do                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Decline**      | Not wanted, or already built                                                    | Set the canceled status. If it's already built, say where it lives.                                                                                                                               |
| **Duplicate**    | An open issue already covers it                                                 | Mark it a duplicate of that issue, and add any new detail to that issue as a comment.                                                                                                             |
| **Existing map** | It's a step toward an open map's Destination                                    | Move it into the project and [rewrite it as a map ticket](#rewrite-a-capture-as-a-map-ticket). Too vague for a ticket: add a line linking it to the map's **Not yet specified**, then cancel it.   |
| **Todo now**     | Clear, one PR, and one or two questions settle it                               | Ask those questions, then [write it as an implementation issue](#write-an-implementation-issue) in the ready status, with no project. If it needs more questions, it needs a map: route it to one. |
| **New map**      | Wanted but not ready: open decisions, several issues, or more than one session | Make a [stub map](#stub-maps) and move the cluster into it. A single item that needs real refinement still gets a map.                                                                            |

**Into a stub map.** When the map an item fits is still a stub (not yet charted), route it as **Existing map** but treat it like a new stub: move it in unchanged in the backlog status and add its line to **Not yet specified** if it isn't there yet. Charting will rewrite it.

**Merging.** When several captures in a cluster are one piece of work, keep the clearest, fold the others' quotes into it, and mark the rest duplicates of it.

**Captures that defer to triage.** Some captures leave their meaning open ("work this out in triage"). Ask the user what they meant before routing, and record the answer in the body as `<User>'s clarification: …`.

**Labels.** A routed issue keeps only its Product label, the Bug label if it describes a concrete defect, and a `wayfinder:<type>` label if it's a decision ticket, per **Labels**. Strip anything else left from older conventions, such as area labels or labels marked retired. Never create labels.

**Repo.** Every routed issue must resolve to one repo per **Repo routing**. If an item has no Product label, or its product doesn't resolve, ask the user and set the label or the repo tag before routing.

### Write an implementation issue

Write the body from [brief-template.md](../do-refine/brief-template.md): the front door, the level tag and reason (plus model pin and target only when needed), the repo tag, acceptance criteria, and the template's **Lifecycle** text. End the Context with the **Touches:** line, listing the directories and files from the code survey. Then check it against [dispatch-gates.md](../do-refine/dispatch-gates.md); if it fails a gate other than open blockers, it isn't ready: route it to a map instead.

**Items that already carry a full brief** (written to an older template): reshape them to the current template, drop dependencies that have since shipped, and keep the old body at the bottom under `## Origin`.

### Rewrite a capture as a map ticket

Keep the issue, so its history and the user's words come with it; change only its body and labels (see the labels rule above). Use the ticket shapes in [maps.md](../do-refine/maps.md):

- **Decision ticket:** one plain sentence, then `## Question`, with a `wayfinder:<type>` label, in the ready status.
- **Implementation issue:** the brief [above](#write-an-implementation-issue), no `wayfinder:` label, in the ready status.

Either way, read the map's current tickets and their order first, then wire `blocks` / `blockedBy` against them where the order is clear; ask when it isn't. Keep the original capture at the bottom under `## Origin`, quoted verbatim.

### Stub maps

Triage makes the map; a separate `do-refine` session charts it. Charting is a whole session, so don't start it here.

- Create the project with a one-sentence summary, an emoji icon that fits the subject, the product's initiative per **Initiatives**, the stub status per **Project statuses** (never a charted one), and the description shape from [maps.md](../do-refine/maps.md), Product line included.
- **Destination:** a one- or two-line draft, marked `Draft — confirm when charting`.
- **Notes:** `Stub from triage on YYYY-MM-DD; chart with do-refine.`, plus anything the user said while routing. Link related maps, and name any map you considered and ruled out, with the reason.
- **Not yet specified:** one line per absorbed capture, linking it.
- Move the cluster's issues into the project in the backlog status, unchanged. Charting turns each into a ticket or folds it into fog.

### Record the decision

On every routed issue, post one **Triage route** comment per **Comment shape**: the route, one line of reasoning, and links to the map, duplicate or related issues.

## 5. Wrap up

When the queue is empty, or the user stops, list Triage again to confirm what's left. Then reply with a table: cluster, route, and the resulting issues and maps (by name, linked). List skipped items by name.

## 6. What you can do next

After the table, print **What you can do next**, grouped by action, with a name and link on every line:

- **Dispatch now:** each ready implementation issue, with its level tag and the **Kickoff prompt** per **Comment shape** (for example `/do-implement ABC-123`), to run on the target named in its tag or the default target. Compare **Touches:** lines, flag pairs that overlap, and say which to run first.
- **Chart next:** each stub map with a one-line why and `/do-refine <map URL>` to paste into a fresh session. Recommend which to chart first.
- **Waiting on you:** skipped items and open questions.
- **Where to see it:** the views per **Views** that now show these items, found by exact name. If an item won't show in any view, say so.

## Boundaries

- Never route without the user's answer, however obvious the recommendation. A quick override is fine: if the user says "decline all three", do it.
- Never chart a map, resolve a decision ticket, or start implementation here.
- Never leave an accepted issue in Backlog without a project.
- Never set priority beyond what **Priority** says, and never create labels.
- Never delete issues; cancel them or mark them duplicates.
- Never clear a parent link without the user's answer.
- The user may be editing the tracker at the same time; re-read an issue before you change it if time has passed.
