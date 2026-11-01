# Factory

Factory is the thing that makes our things.  It turns ideas into finished software changes, with coding agents doing the building and a human making the decisions.

## What it does

Factory is an opinionated set of workflow skills for our coding agents. Together they cover the path from a rough idea to a merged change:

- **Capture:** turn photos of handwritten sticky notes, or dictated thoughts, into triage tickets in Linear.
- **Triage:** review new tickets in triage with you, the human, and route each one: build it, plan it further, or drop it.
- **Refine:** turn a big goal into a map of the decisions still open, settle them with you, the human, one at a time, then slice the settled work into small, clearly written tickets.
- **Implement:** hand a ticket to an agent, which builds it, checks its own work and opens a pull request for you to review.

Each project keeps its settings, such as team names, labels and statuses, in one file in its own repo, so the same skills work in any project.

## Who it's for

People who plan their work in Linear and want coding agents to do more of the building without giving up control. You decide what gets built and review every change; the agents do the legwork in between.

## Learn more

- [Install the skills](#install)
- [Adopt Factory in your own project](#adopting)
- [McWestling's settings file, a worked example](docs/issue-tracker.md)
- [License](LICENSE)

---

## Layout

```text
.
├── AGENTS.md              # Rules for agents working in this repo
├── docs/
│   └── issue-tracker.md   # McWestling's tracker values; the worked example
├── skills/
│   └── <name>/            # One folder per skill: SKILL.md, agents/openai.yaml
└── tools/
    └── orca/              # The dev-port convention (script ships with do-factory-setup)
```

## Skills

`do-` is the factory's verb prefix: each skill is something the factory does.

| Skill              | What it does                                                             |
| ------------------ | ------------------------------------------------------------------------ |
| `do-post-its`      | Turns photos of Post-its, or dictated notes, into Triage issues          |
| `do-triage`        | Works the Triage queue with you and routes each item                     |
| `do-refine`        | Charts maps, resolves decision tickets, and slices implementation issues |
| `do-implement`     | Takes one implementation issue to a verified draft PR                    |
| `do-factory-setup` | Writes a repo's tracker doc and scripts rule, and installs dev ports     |

## Install

```sh
npx skills add mcwestling/factory --skill '*' -g
```

The skills link to each other, so install all of them.

## Adopting

To adopt Factory, [install the skills](#install), then run this in your coding agent, in your repo:

```text
/do-factory-setup
```

It writes `docs/issue-tracker.md`, the file the other skills read your workspace values from, and points `AGENTS.md` at it. It copies the scripts-language rule from your Tool Stack document, if it has one, into `AGENTS.md`. In a repo with a dev server, it installs the [dev-port convention](tools/orca/README.md) so parallel workspaces don't fight over ports. If your README's plain-language intro is missing any parts, it drafts them for you to approve.

To set it up by hand instead, copy [McWestling's `docs/issue-tracker.md`](docs/issue-tracker.md) and replace the values.

## Contributing

Contributions are accepted under this repo's [MIT license](LICENSE) (inbound=outbound).
