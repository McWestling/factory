---
name: do-refine
description: Refine a big goal into dispatchable work in the issue tracker. Chart an idea or stub map as a project of decision tickets, settle them one per session, and slice settled build work into one-PR implementation issues.
disable-model-invocation: true
---

<!-- Derived from mattpocock/skills wayfinder (MIT, see LICENSE.upstream). -->

Some goals are too big, and too foggy, for one agent session: you can name where you want to end up, but not the way there. This skill finds the way. It keeps a **map** of the effort in the tracker, settles the map's open **decisions** one at a time with the user, and **slices** the build work those decisions settle into **implementation issues** that someone else can pick up.

Every map points at a **destination**: a feature to ship, a decision to lock in, a migration to finish. Naming it comes first, because it decides what is in scope. Maps fit any kind of work, not only code.

## Supporting skills

For upstream skill names below (`grilling`, `domain-modeling`, `research`, `prototype`), use the advertised `mattpocock-skills:<name>` when available, otherwise the advertised bare `<name>` from the skills CLI. Invoke through the agent's skill mechanism (the Skill tool where available, otherwise read the advertised SKILL.md). Pass the resolved name and this rule to research subagents. If neither form is available, stop and ask the user to run `do-factory-setup`; do not substitute upstream `wayfinder` for this workflow.

## Rules for every session

- **Plan only.** A session settles decisions and writes implementation issues; it never builds the deliverable. When you feel the urge to start building, that is the cue to slice. A map's **Notes** may override this for its own effort. The one exception: when the user asks for it, a resolve session may make a small non-code artifact the decision itself names (a doc, a tracker setting) and link it from the ticket. Code, or anything bigger, is still an implementation issue.
- **Names, not ids.** When you talk about a map or ticket, use its title with the link inside it. Never hand the user a list of bare ids.
- **One decision per session.** Resolve at most one decision ticket per session. Research tickets are the exception: they run in parallel subagents.
- **Others are editing too.** Several sessions may work one map at once. Re-read an issue before you change it if time has passed, and patch descriptions instead of rewriting them.
- **Real references only.** Write cross-references with real ids. A placeholder such as `ABC-<n>` links to some other issue or to nothing.

## Workspace values

This skill holds the procedure. The values (team, statuses, labels, templates, routing, models, views, comment shape) live in the repo's **tracker doc**. Find it through `AGENTS.md`, which names either a path in this repo or a doc in another repo (like `docs/issue-tracker.md` in `owner/name`); read another repo's doc from its checkout, found through `orca repo list --json`. If `AGENTS.md` names none, use `docs/issue-tracker.md`. Read it before you touch the tracker. Where this file says "per X", X is a heading in that doc.

If a value you need is missing, ask the user, use their answer, then offer to add it to the tracker doc or to run `do-factory-setup`.

Read and write the tracker only through the access the tracker doc's **Tracker** heading allows. If that access is unavailable or unauthorized, stop and say so; don't fall back to a browser, desktop app or raw API.

## Maps

A map is a **project** in the tracker. Its tickets are **flat issues** in it: no sub-issues, no parent links. A map for a product sits in that product's initiative, per **Initiatives**.

The map is an index. Each decision lives in one place, the ticket that settled it; the map gives a one-line gist and a link, and never repeats the detail.

### Summary and description

The project **summary** is one plain sentence saying what the map is (the tracker caps it at 255 characters). The project **description** holds the whole map in five sections, small enough to load at the start of every session.

```markdown
## Destination

<One or two lines: what reaching the end of this map looks like. Every session reads this before choosing a ticket.>

## Notes

- **Product:** <name>. <!-- first bullet, when the workspace has Product labels -->
- <Domain, skills every session should call, standing preferences, other maps this one depends on.>

## Decisions so far

- [<closed ticket title>](link): <one-line gist of the answer>

## Not yet specified

<In-scope work you can see coming but can't yet phrase as a ticket. See "Fog".>

## Out of scope

- [<canceled ticket title>](link): <gist>, out because <reason>.
```

Open tickets are not listed in the description. They are the open issues in the project, found by query.

### Project status

Use the statuses under **Project statuses**, by meaning:

- **Stub:** a map made by triage that nobody has charted yet.
- **Charted:** Destination named and decisions ticketed. Pick between the doc's charted statuses by their meanings (for example, whether anything is sliced yet).
- **Started:** set when the first ticket on the map is claimed.
- **Finished:** the destination is reached and no open issues remain.
- **Abandoned:** the effort was dropped.

## Tickets

A map holds two kinds of issue. Both are flat issues in its project, and both start in the ready status per **Issue statuses** (for example `Todo`), blocked or not. The tracker won't move an issue when its blocker closes, so blockers, not status, decide what can be taken. Leave priority as **Priority** says.

### Decision tickets

A decision ticket settles a question; it doesn't deliver build work. It carries exactly one `wayfinder:<type>` label (see [Ticket types](#ticket-types)), plus the labels **Labels** puts on every product issue (for example a Product label). Never a label **Labels** marks as retired, and never a readiness or triage label.

The body is one plain sentence saying what the ticket is, then the question. Size it so one agent session (about 100K tokens) can settle it.

```markdown
<One plain sentence.>

## Question

<The decision or investigation this ticket settles.>
```

The body never states the type; the label does. The answer isn't written into the body: it goes in a comment when the ticket is resolved. Link anything made while resolving a ticket (a prototype, a research branch) from the issue rather than pasting it in.

### Implementation issues

An implementation issue is one PR of build work. It carries no `wayfinder:` label, follows [brief-template.md](brief-template.md) and the implementation template under **Templates**, and passes [dispatch-gates.md](dispatch-gates.md) before anyone dispatches it. A refine session writes implementation issues but never works one.

### Blocking and the frontier

Order tickets with the tracker's native issue relations (`blocks` / `blockedBy`). A ticket is **unblocked** when every ticket blocking it is closed.

- Implementation issues can be blocked by decision tickets and by other implementation issues.
- A decision ticket is never blocked by an implementation issue. If a decision needs something done first, make that a `wayfinder:task` ticket.
- A map that depends on another map links tickets across the two projects with ordinary relations and names the other map in its **Notes**. Don't use project-level dependencies.

The **frontier** is the set of decision tickets that are open, unblocked and unclaimed. To find it:

1. List the project's issues in the ready status with no assignee.
2. Keep those with a `wayfinder:` label.
3. Fetch each with its relations, and drop any that has an open blocker.

To **claim** a ticket, assign it to the person driving the map, move it to the in-progress status and set its dispatch target label per **Dispatch targets**, before any other work, so parallel sessions skip it and the claim shows up as work in progress. The assignee is the claim: an open ticket with no assignee is free.

## Ticket types

Each decision ticket is **HITL** (worked live with a person who answers for themselves) or **AFK** (the agent alone). A HITL ticket resolves only through that exchange: never answer the human's side yourself.

| Label                 | Mode        | Resolve it by                                                                                                                                                                                                                                                                                     |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wayfinder:research`  | AFK         | A subagent that calls the Skill tool with "research", to find a fact outside this checkout: docs, third-party APIs, knowledge bases. The resolution states every precondition the answer hangs on (a paid plan, a license, an account, a cost), not only the research branch.                                                                                                                                                              |
| `wayfinder:prototype` | HITL        | Calling the Skill tool with "prototype" to make something rough and concrete to react to (an outline, a stub, a bit of UI or logic). Use it when the question is how something should look or behave. Link the prototype.                                                                         |
| `wayfinder:grilling`  | HITL        | Conversation, in rounds (see [Grilling](#grilling)). Call the Skill tool for "grilling", and also for "domain-modeling" when the decision introduces or changes domain terms. The default type.                                                                                                                                                              |
| `wayfinder:task`      | HITL or AFK | Doing the manual work a decision is waiting on: sign up for a service, get access, move data so its shape is visible. Do it yourself where you can; otherwise give the user an exact checklist. Record what was done and any facts later tickets need (where credentials live, new URLs, counts). |

Work that delivers the destination is an implementation issue, not a task.

## Grilling

Ask in **rounds**. Each round asks everything that no longer depends on an open answer. Number the questions and lead each with the answer you recommend, phrased so a plain "yes" takes it. The user may be on a phone, so a tap or a few words should answer any of them.

1. Read the ticket or map and what it links: code paths, decision records, earlier comments. Anything you can find out yourself, find out; the user only makes the calls.
2. Ask the round. Use the `AskUserQuestion` tool where the client has it, otherwise ask in chat. Ask in a tracker comment only when nobody is in the session.
3. Record the answers where they belong: the ticket's resolution comment, or the issue description.
4. Work out what can be asked now, and run the next round. Finish when no open forks remain.

Recommend the lightest option that meets the need the user stated, and offer heavier ones only as alternatives. "Don't do this" is always a possible answer: offer it when the cost looks out of proportion to the need.

## Fog

A map is incomplete on purpose. Past the live tickets is **fog**: decisions, investigations and build work you can tell are coming but can't pin down yet, because they hang on open questions. Each resolution clears some fog, and whatever becomes clear turns into new tickets, until the way to the destination is mapped and all of its build work is sliced.

Write the fog into **Not yet specified**, as loosely or as fully as you can see it. Everything there is in scope; it just isn't sharp enough to ticket.

Choose where a piece of work goes by whether you can **state** it precisely now, not whether you can answer it now:

- **Decision ticket:** the question is already sharp, even if it's blocked.
- **Implementation issue:** the build work passes every dispatch gate except open blockers. You could write its acceptance criteria today. See [Slicing](#slicing).
- **Not yet specified:** you can't phrase it that sharply yet. Don't chop fog into ticket-sized pieces in advance; one patch may become several tickets, or none.

**Not yet specified** never holds what's already decided, what's already a ticket, or what's out of scope.

## Out of scope

Fog only gathers on the way to the destination. Work past the destination is **out of scope**, a different thing: you've decided this effort won't do it. It goes in the **Out of scope** section, never in **Not yet specified**, and it never turns into tickets. It comes back only if someone redraws the destination, and then as a new effort.

When an existing ticket turns out to sit past the destination (because charting drew the line wrong, or a later answer moved it), set it to the canceled status and add one line to **Out of scope**: the gist, why it's out, and a link to the ticket. Keep it out of **Decisions so far**, which records the route actually taken.

## Slicing

Slicing turns settled build work into implementation issues, one PR each. Slice as soon as every decision a piece of work hangs on is closed, even while other tickets on the map stay open, so building can start early.

1. **Gather.** Read the map's Destination, Notes and Decisions so far, then the resolution comments of the decisions this work depends on. Survey the code it touches in its repo, briefly: the directories and files, and any prefactoring that would make the change easy. When that repo per **Repo routing** isn't the current one, find its checkout in `orca repo list --json` (the entry whose remote is that `owner/name`) and read its `AGENTS.md` first. Read only; never edit another repo's checkout. Use the repo's own vocabulary and respect its decision records.
2. **Draft.** Cut thin **vertical slices**: each a narrow path through every layer it needs (data, API, UI, tests), checkable on its own and sized to one PR. Prefactoring goes first, as its own slice. A wide mechanical change that no single slice can land green, such as a codebase-wide rename, goes **expand–contract**: add the new form beside the old, move callers over in batches, then delete the old form, each step a slice. Note each slice's blockers: other slices and any open decision tickets.
3. **Check with the user.** Show the slices as a numbered list: title, blocked by, what it delivers, what it touches. Ask whether the size is right, whether each blocker is real, and whether any slice should merge or split. Repeat until the user approves. Never publish a slice the user hasn't seen.
4. **Publish**, blockers first. Create each issue in the map's project, in the ready status, with no parent and with the labels the tracker doc requires. Write the body from [brief-template.md](brief-template.md), including its **README** line when the issue completes a major feature, applying the implementation template under **Templates** when there is one. Resolve its repo per **Repo routing** and write the repo tag into every issue. If routing leaves the product unresolved, ask the user once which repo it uses, write that onto the product's initiative in the form **Repo routing** gives, and publish none of that product's issues until it is set. Then wire `blocks` / `blockedBy` in a second pass, once every issue has a real id. Check each issue against [dispatch-gates.md](dispatch-gates.md). If it fails any gate other than open blockers, it isn't a slice yet: put it back in the fog, or turn the gap into a decision ticket.
5. **Record.** Remove each sliced patch from **Not yet specified**, so it lives only as its issues. Slices aren't decisions, so they stay out of **Decisions so far**. If the map's charted status says nothing is sliced yet, move it to the one that says work is sliced.

## Choosing a mode

The user names an idea or a map (by URL or name), and maybe a ticket. Pick the mode from the map's state, top row first, and tell the user which you picked. If the user asks for a mode outright ("slice this map"), use that.

| Map state                                                                | Mode                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------- |
| No map yet, or a stub map from triage                                    | [Chart a map](#chart-a-map)                    |
| The user named a decision ticket, or the frontier has one                | [Resolve a decision](#resolve-a-decision)      |
| Nothing on the frontier, but settled build work isn't sliced             | [Slice a map](#slice-a-map)                    |
| No open decision tickets, **Not yet specified** empty, everything sliced | Report the map as refined; [Wrap up](#wrap-up) |

### Chart a map

1. **Name the destination.** Call the Skill tool for "grilling" (and for "domain-modeling" when the effort brings new domain terms) to settle what the map is heading for. Do this first; it fixes the scope.
2. **Survey the way.** Grill again, broad rather than deep: cover the whole space to surface the open decisions, the build work and the first steps that can be taken now. If nothing is left open, skip decision tickets: make the map with an empty frontier and go straight to [Slicing](#slicing) in this session.
3. **Make the map.** Create the project with its summary and description: Destination and Notes filled in, Decisions so far empty, fog sketched into **Not yet specified**, in the product's initiative, with a charted status.

   Given a stub map from triage, chart that project instead of making a new one. Keep its summary and links, confirm or rewrite its draft Destination, and turn its **Not yet specified** captures and any issues triage moved into it into decision tickets, implementation issues or fog. When you rewrite a captured issue, keep its original words at the bottom of the body under `## Origin`.

4. **Ticket what you can.** Create the decision tickets you can state now, flat in the project and in the ready status. Then, in a second pass, wire `blocks` / `blockedBy` and write any cross-references with the real ids. Wiring sorts tickets into the frontier and the blocked. Everything else stays fog. Build work that's already settled can be sliced now.
5. **Start the research.** For each `wayfinder:research` ticket you created, start a subagent that calls the Skill tool with "research" and resolves it in parallel. It writes its findings to a throwaway `research/<name>` branch, pushed but never opened as a PR, and links that branch from the ticket.
6. **Stop.** Charting is a whole session. It resolves nothing by hand.

### Resolve a decision

1. **Load the map:** the project summary and description, not every ticket.
2. **Choose and claim.** Take the ticket the user named, or else the first one on the frontier. Claim it before doing anything else. If it's the first claim on the map, set the project to a started status.
3. **Resolve it** the way its `wayfinder:` label says (see [Ticket types](#ticket-types)). Fetch other tickets' full bodies and resolutions only when you need them. Call the skills that **Notes** names; when unsure, call "grilling".
4. **Record it.** Post the answer as the **Decision resolved** comment per **Comment shape**, set the ticket to the done status, and patch one gist line into **Decisions so far**.
5. **Follow through.**
   - Add any new decision tickets the answer surfaced (create, then wire).
   - Turn fog that's now clear into tickets, and remove it from **Not yet specified**.
   - If the answer settles build work, offer to slice it now. If the user declines, leave it in **Not yet specified**, marked ready to slice.
   - If the answer shows a ticket (this one or another) is past the destination, rule it [out of scope](#out-of-scope) instead of resolving it.
   - If the answer makes other tickets wrong, edit them, or cancel them with a one-line comment. Never delete issues.
   - If the answer makes the map's **Notes** wrong, patch them. If it changes the **Destination**, propose the edit and wait for a yes, since the Destination fixes scope.
   - If the answer is "don't do this", rule that work out of scope. If it was the whole destination, propose redrawing the Destination or setting the map to its abandoned status.

### Slice a map

1. Load the map and its open issues: which decision tickets are still open, and which implementation issues exist.
2. Find settled build work: patches in **Not yet specified**, and gaps on the way to the Destination, whose decisions are all closed and that no implementation issue covers yet.
3. Run [Slicing](#slicing) on it.

### Wrap up

End every session by listing what changed, by name: tickets resolved, created or canceled, and issues sliced. Then add **What you can do next**, with a link on every line:

- **Dispatch now:** each unblocked, ready implementation issue on the map, with its factory-run block and the **Kickoff prompt** per **Comment shape** (for example `/do-implement ABC-123`), to run on the target the block names. Compare the issues' **Touches:** lines, flag pairs that overlap, and say which to run first.
- **Refine next:** the next decision ticket on the frontier, with `/do-refine <map URL>` to paste into a fresh session. Name any research tickets still running.
- **Waiting on you:** HITL tickets and open questions.

When the destination is reached and no open issues remain, set the map to its finished status. Open implementation issues keep a map open until their PRs merge; closing those out belongs to whoever merges, not to this skill.
