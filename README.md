# Factory

Factory is the thing that makes our things.  It turns ideas into finished software changes, with coding agents doing the building and a human making the decisions.

## What it does

Factory has two parts:

- **Skills:** written instructions you give a coding agent. They tell it how to turn your notes into tasks, plan a change, and build it for you to review.
- **[Dispatch](packages/dispatch/README.md):** software for starting work in Orca on your computer from a task in Linear.

You can use the skills without Dispatch. They help with four steps:

- **Capture:** turn photos of handwritten sticky notes, or dictated thoughts, into triage tickets in Linear.
- **Triage:** review new tickets in triage with you, the human, and route each one: build it, plan it further, or drop it.
- **Refine:** turn a big goal into a map of the decisions still open, settle them with you, the human, one at a time, then slice the settled work into small, clearly written tickets.
- **Implement:** hand a ticket to an agent, which builds it, checks its own work and opens a pull request for you to review.

Each project keeps its settings, such as team names, labels and statuses, in one file in its own repo, so the same skills work in any project.

## Who it's for

People who plan their work in Linear and want coding agents to do more of the building without giving up control. You decide what gets built and review every change; the agents do the legwork in between.

## Learn more

- [Install the skills](#install-the-skills)
- [Adopt Factory in your own project](#adopting)
- [Dispatch architecture and relay setup](packages/dispatch/README.md#where-it-runs)
- [McWestling's settings file, a worked example](docs/issue-tracker.md)
- [License](LICENSE)

---

## Layout

```text
.
├── AGENTS.md              # Rules for agents working in this repo
├── docs/
│   └── issue-tracker.md   # McWestling's tracker values; the worked example
├── packages/
│   └── dispatch/
│       ├── relay/        # Application: runs on Cloudflare
│       ├── wrangler.toml # Relay deployment and storage configuration
│       └── *.ts          # Shared job types, issue parser and tests
├── skills/
│   └── <name>/            # One folder per skill: SKILL.md, agents/openai.yaml
└── tools/
    └── orca/              # The dev-port convention (script ships with do-factory-setup)
```

Folders describe what the code belongs to; they do not all represent applications.
`skills/` holds agent instructions, `packages/` currently holds both the Dispatch
application and shared code, `tools/` holds tool configuration, and `docs/` holds
contracts. There is no local daemon folder or install command yet.

## Software and where it runs

| Component | Runtime | Status and setup |
| --- | --- | --- |
| Dispatch relay | Your Cloudflare account: Worker plus per-machine Durable Object storage and alarms | Implemented. [Deploy and configure it](packages/dispatch/README.md#set-up-your-hosted-relay). |
| Dispatch daemon | Your computer, alongside Orca | Planned. Will pick up relay jobs and launch Orca; not yet installable. |
| Shared Dispatch code | Imported by the components that use it | Job types and issue parser in `packages/dispatch/`; no separate process or deployment. |

Linear sends delegations to the cloud relay. The local daemon will claim them
over HTTPS and launch Orca on your computer. The relay can queue work while that
computer sleeps. See the [Dispatch runtime and setup guide](packages/dispatch/README.md#where-it-runs)
for credentials, testing, deployment and day-to-day operation.

## Skills

`do-` is the factory's verb prefix: each skill is something the factory does.

| Skill              | What it does                                                                        |
| ------------------ | ----------------------------------------------------------------------------------- |
| `do-post-its`      | Turns photos of Post-its, or dictated notes, into Triage issues                     |
| `do-triage`        | Works the Triage queue with you and routes each item                                |
| `do-refine`        | Charts maps, resolves decision tickets, and slices implementation issues            |
| `do-implement`     | Takes one implementation issue to a verified draft PR                               |
| `do-factory-setup` | Writes a repo's tracker doc and scripts rule, runs setup blocks, installs dev ports |

## Install the skills

```sh
npx skills add mcwestling/factory --skill '*' -g
```

The skills link to each other, so install all of them.

Linear-to-Orca dispatch is a separate, optional service. It requires deploying the
relay to your own Cloudflare account; installing the skills does not deploy it.
The relay is implemented, but the local daemon that picks up jobs and launches Orca
is not yet included. See [where Dispatch runs and how to set up the relay](packages/dispatch/README.md#where-it-runs).

## Adopting

To adopt Factory, [install the skills](#install-the-skills), then run this in your coding agent, in your repo:

```text
/do-factory-setup
```

It writes `docs/issue-tracker.md`, the file the other skills read your workspace values from, and points `AGENTS.md` at it. It copies the scripts-language rule from your Tool Stack document, if it has one, into `AGENTS.md`. In a repo with a dev server, it installs the [dev-port convention](tools/orca/README.md) so parallel workspaces don't fight over ports. If your README's plain-language intro is missing any parts, it drafts them for you to approve.

Setup can also set the repo up with the services your Tool Stack lists. Write an **Adding a repo** block on a service's own Linear page, linked from your Tool Stack document: a `toml` code block under a `## Adding a repo` heading that says when the service applies, how to tell it's done, and the commands to run. Setup asks before running each one. Start from [the example block](skills/do-factory-setup/adding-a-repo.example.toml). The hook, its runner and the block format are generic and live here; the blocks are yours, on your own Tool Stack pages. McWestling keeps its own blocks privately in its Linear workspace, so this repo has none to copy.

To set it up by hand instead, copy [McWestling's `docs/issue-tracker.md`](docs/issue-tracker.md) and replace the values.

## Contributing

Contributions are accepted under this repo's [MIT license](LICENSE) (inbound=outbound).
