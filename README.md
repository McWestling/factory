# Factory

Factory is the thing that makes our things.  It turns ideas into finished software changes, with coding agents doing the building and a human making the decisions.

## What it does

Factory builds on selected skills from [mattpocock/skills](https://github.com/mattpocock/skills) for research, design, prototyping and testing. It connects those practices into a workflow for Linear users, from a rough idea to a merged change:

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

## New machine

This sets up the machine; [Adopting](#adopting) sets up each repo. Install these tools first:

- Git, Node.js 22.20+ (26 LTS recommended, with npm and `npx`), and the GitHub CLI (`gh`).
- A coding agent and access to a Linear workspace.
- Python 3.11+ for service setup blocks; setup skips them and reports it when unavailable.
- A POSIX shell and `nc` for dev ports (both included with macOS).

1. **Install Factory for your agent.** Install all five workflow skills, targeting only the agent you use. Replace `codex` with its [skills-CLI identifier](https://skills.sh/docs/cli) (for example `claude-code` or `cursor`). Always include `-a` in an unattended run; without it the installer can create directories for every agent.

   ```sh
   npx skills add mcwestling/factory --skill '*' -g -a codex -y
   ```

   **Install Matt's supporting skills once per agent.** Prefer his plugin where supported; keep an existing upstream CLI installation rather than installing both forms. For Codex:

   ```sh
   codex plugin marketplace add mattpocock/skills
   codex plugin add mattpocock-skills@mattpocock
   ```

   For Claude Code:

   ```sh
   claude plugin install mattpocock-skills@claude-plugins-official
   ```

   For agents without plugin support, use the skills CLI instead, targeting that agent only:

   ```sh
   npx skills add mattpocock/skills --skill '*' -g -a cursor -y
   ```

   The full upstream set supplies sibling dependencies too. Factory directly uses `grilling`, `domain-modeling`, `research`, `prototype` and `tdd`; upstream TDD also calls `codebase-design` and refers to `code-review`. Plugin names have the `mattpocock-skills:` prefix; CLI names are bare. Factory keeps its own `do-refine` workflow and `do-implement`'s manual review.

   The CLI uses a shared skill store, which can also be discovered by other agents. If a CLI install would duplicate skills in an agent already using the plugin, settle on one form for those agents before installing.

   Follow [Matt's installation instructions](https://github.com/mattpocock/skills#installation-30-second-setup) for other supported plugins. Start a fresh agent session after installation if the new skills aren't discovered. Setup also recognizes existing dependencies and offers to install missing ones in its question round; installation alone does not mean they are usable.

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
