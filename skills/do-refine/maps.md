# Maps and tickets

The shapes `do-refine`, `do-triage` and `do-closeout` share. "Per X" cites a heading in the tracker doc.

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

<In-scope work you can see coming but can't yet phrase as a ticket. See "Fog" in SKILL.md.>

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

A decision ticket settles a question; it doesn't deliver build work. It carries exactly one `wayfinder:<type>` label (see [Ticket types](SKILL.md#ticket-types)), plus the labels **Labels** puts on every product issue (for example a Product label). Never a label **Labels** marks as retired, and never a readiness or triage label.

The body is one plain sentence saying what the ticket is, then the question. Size it so one agent session (about 100K tokens) can settle it.

```markdown
<One plain sentence.>

## Question

<The decision or investigation this ticket settles.>
```

The body never states the type; the label does. The answer isn't written into the body: it goes in a comment when the ticket is resolved. Link anything made while resolving a ticket (a prototype, a research branch) from the issue rather than pasting it in.

### Implementation issues

An implementation issue is one PR of build work. It carries no `wayfinder:` label, follows [brief-template.md](brief-template.md), and passes [dispatch-gates.md](dispatch-gates.md) before anyone dispatches it. A refine session writes implementation issues but never works one.
