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

- [Set up a new machine](#new-machine)
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

| Skill              | What it does                                                                        |
| ------------------ | ----------------------------------------------------------------------------------- |
| `do-post-its`      | Turns photos of Post-its, or dictated notes, into Triage issues                     |
| `do-triage`        | Works the Triage queue with you and routes each item                                |
| `do-refine`        | Charts maps, resolves decision tickets, and slices implementation issues            |
| `do-implement`     | Takes one implementation issue to a verified draft PR                               |
| `do-factory-setup` | Writes a repo's tracker doc and scripts rule, runs setup blocks, installs dev ports |
| `do-grill`         | Interviews you in rounds to stress-test a plan or decision                          |
| `do-model`         | Sharpens a project's domain language, glossary and decision records                 |
| `do-research`      | Researches a question against primary sources and writes up the findings            |
| `do-prototype`     | Builds a throwaway prototype to answer a design question                            |
| `do-tdd`           | Builds test-first, in a red-green loop                                              |

## New machine

This sets up the machine; [Adopting](#adopting) sets up each repo. You need a coding agent and a Linear workspace first.

1. **Install the skills.** The skills link to each other, so install all of them, and pick your agents when prompted. Don't add `-y` without `-a`: on its own, it creates dot-directories for every agent the installer knows.

   ```sh
   npx skills add mcwestling/factory --skill '*' -g
   ```

2. **Sign in to Linear.** Add Linear's MCP server to your coding agent and sign in, following [Linear's MCP guide](https://linear.app/docs/mcp).
3. **Sign in to GitHub.** Install the [GitHub CLI](https://cli.github.com), then run `gh auth login`.
4. **Install Orca (recommended).** [Orca](https://onorca.dev/download) runs your coding agents in parallel workspaces, on macOS, Windows and Linux. Factory works without it.

## Adopting

To adopt Factory, [set up your machine](#new-machine), then run this in your coding agent, in your repo:

```text
/do-factory-setup
```

It writes `docs/issue-tracker.md`, the file the other skills read your workspace values from, and points `AGENTS.md` at it. It copies the scripts-language rule from your Tool Stack document, if it has one, into `AGENTS.md`. In a repo with a dev server, it installs the [dev-port convention](tools/orca/README.md) so parallel workspaces don't fight over ports. If your README's plain-language intro is missing any parts, it drafts them for you to approve.

Setup can also set the repo up with the services your Tool Stack lists. Write an **Adding a repo** block on a service's own Linear page, linked from your Tool Stack document: a `toml` code block under a `## Adding a repo` heading that says when the service applies, how to tell it's done, and the commands to run. Setup asks before running each one. Start from [the example block](skills/do-factory-setup/adding-a-repo.example.toml). The hook, its runner and the block format are generic and live here; the blocks are yours, on your own Tool Stack pages. McWestling keeps its own blocks privately in its Linear workspace, so this repo has none to copy.

To set it up by hand instead, copy [McWestling's `docs/issue-tracker.md`](docs/issue-tracker.md) and replace the values.

## Contributing

Contributions are accepted under this repo's [MIT license](LICENSE) (inbound=outbound).
