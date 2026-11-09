# Factory

Factory is the thing that makes our things.  It turns ideas into finished software changes, with coding agents doing the building and a human making the decisions.

## What it does

Factory has two parts:

- **Skills:** written instructions you give a coding agent. They tell it how to turn your notes into tasks, plan a change, and build it for you to review.
- **[Delegator](packages/delegator/README.md):** software for starting work in Orca on your computer from a task in Linear.

You can use the skills without Delegator. They help with four steps:

- **Capture:** turn photos of handwritten sticky notes, or dictated thoughts, into triage tickets in Linear.
- **Triage:** review new tickets in triage with you, the human, and route each one: build it, plan it further, or drop it.
- **Refine:** turn a big goal into a map of the decisions still open, settle them with you, the human, one at a time, then slice the settled work into small, clearly written tickets.
- **Implement:** hand a ticket to an agent, which builds it, checks its own work and opens a pull request for you to review.

Factory connects to and builds upon [Matt Pocock’s skills](https://github.com/mattpocock/skills) for research, design, prototyping and testing.

Each project keeps its settings, such as team names, labels and statuses, in one file in its own repo, so the same skills work in any project.

## Who it's for

People who plan their work in Linear and want coding agents to do more of the building without giving up control. You decide what gets built and review every change; the agents do the legwork in between.

## Learn more

- [Install the skills](#install-the-skills)
- [Adopt Factory in your own project](#adopting)
- [Delegator architecture and Cloud Inbox setup](packages/delegator/README.md#where-it-runs)
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
│   ├── verifier/         # Canonical check core, tests and skill bundle tooling
│   └── delegator/
│       ├── cloud-inbox/  # Application: runs on Cloudflare
│       ├── runner/       # Local process: picks up jobs and launches Orca
│       ├── wrangler.toml # Cloud Inbox deployment and storage configuration
│       └── *.ts          # Shared job types, issue parser and tests
├── skills/
│   └── <name>/            # One folder per skill: SKILL.md, agents/openai.yaml
└── tools/
    └── orca/              # The dev-port convention (script ships with do-factory-setup)
```

Folders describe what the code belongs to; they do not all represent applications.
`skills/` holds agent instructions, `packages/` currently holds both the Delegator
application and shared code, `tools/` holds tool configuration, and `docs/` holds
contracts. The Runner lives in `packages/delegator/runner/` and runs manually;
automatic background startup is not built yet.

## Software and where it runs

| Component | Runtime | Status and setup |
| --- | --- | --- |
| Cloud Inbox | Your Cloudflare account: Worker plus per-machine Durable Object storage and alarms | Implemented. [Deploy and configure it](packages/delegator/README.md#set-up-your-cloud-inbox). |
| Runner | Your machine, alongside Orca | Available to run manually. [Configure and run it](packages/delegator/README.md#run-the-runner). Automatic background startup is not built yet. |
| Shared Delegator code | Imported by the components that use it | Job types and issue parser in `packages/delegator/`; no separate process or deployment. |

Linear sends delegations to Cloud Inbox. The Runner claims them over HTTPS and
launches Orca on your machine. Cloud Inbox can queue work while that machine sleeps.
See the [Delegator runtime and setup guide](packages/delegator/README.md#where-it-runs)
for credentials, testing, deployment and day-to-day operation.

## Skills

| Skill              | What it does                                                                        |
| ------------------ | ----------------------------------------------------------------------------------- |
| `do-post-its`      | Turns photos of Post-its, or dictated notes, into Triage issues                     |
| `do-triage`        | Works the Triage queue with you and routes each item                                |
| `do-refine`        | Charts maps, resolves decision tickets, and slices implementation issues            |
| `do-implement`     | Takes one implementation issue to a verified draft PR                               |
| `do-closeout`      | Checks a thread is good to close and finishes the issue's closeout                  |
| `do-factory-setup` | Writes a repo's tracker doc and scripts rule, runs setup blocks, installs dev ports |

## Install the skills

```sh
npx skills add mcwestling/factory --skill '*' -g
```

Run this in your terminal and select your agents when prompted. Install all the skills; they work together.

You need Git, Node.js 22.20+ with npm, the [GitHub CLI](https://cli.github.com), and [Linear’s MCP server](https://linear.app/docs/mcp) connected to your agent. Run `gh auth login` to sign in to GitHub. Python 3.11+ enables service setup; a POSIX shell and `nc` enable dev ports. [Orca](https://onorca.dev/download) is recommended for parallel agent workspaces.

Delegator development requires Node.js 26.

Delegator is a separate, optional service. It requires deploying Cloud Inbox to your
own Cloudflare account; installing the skills does not deploy it. Cloud Inbox and
the manually run Runner are implemented; pairing and automatic background startup
are not built yet. See [where Delegator runs and how to set up Cloud Inbox](packages/delegator/README.md#where-it-runs)
and [how to configure and run the Runner](packages/delegator/README.md#run-the-runner).

## Adopting

After [installing the skills](#install-the-skills), run this in your agent, in each repo:

```text
/do-factory-setup
```

Setup writes the repo’s tracker settings, links them from `AGENTS.md`, and offers to install missing supporting skills. It prefers [Matt’s plugin](https://github.com/mattpocock/skills#installation-30-second-setup) where supported, with a skills-CLI fallback. Both routes supply the full upstream set, including sibling dependencies.

Use one upstream installation form per agent. The CLI’s shared store can expose skills to other agents too, so resolve duplication with plugin installs before proceeding. If newly installed skills aren’t discovered, start a fresh agent session and rerun setup; setup remains pending until they’re usable.

Setup also adds [dev ports](tools/orca/README.md) for repos with a dev server, fills missing README intro sections, and offers approved service commands from your Tool Stack’s Linear pages. To define those commands, start with the [Adding a repo example](skills/do-factory-setup/adding-a-repo.example.toml).

For manual adoption, copy [McWestling’s tracker settings](docs/issue-tracker.md) and replace the values. See the [setup skill](skills/do-factory-setup/SKILL.md) for the full procedure.

## Verifier development

[Verifier source and tests](packages/verifier/README.md) live in `packages/verifier`.
The setup skill carries a generated, self-contained delivery bundle; regenerate it
with `node packages/verifier/bundle.ts` and verify with
`node packages/verifier/bundle.ts --check`. Run core and isolated delivery tests
with `python3 packages/verifier/factory-verifier.test.py` (Python 3.11+), and bundle
tests with `node --test packages/verifier/bundle.test.ts`. The hosted workflow ships in that bundle; full setup installation remains planned.

## Contributing

Contributions are accepted under this repo's [MIT license](LICENSE) (inbound=outbound).
