# Factory

Factory is the thing that makes our things.  It turns ideas into finished software changes, with coding agents doing the building and a human making the decisions.

## What it does

Factory connects [Matt Pocock’s skills](https://github.com/mattpocock/skills) into a workflow for Linear users:

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

## Skills

| Skill              | What it does                                                                        |
| ------------------ | ----------------------------------------------------------------------------------- |
| `do-post-its`      | Turns photos of Post-its, or dictated notes, into Triage issues                     |
| `do-triage`        | Works the Triage queue with you and routes each item                                |
| `do-refine`        | Charts maps, resolves decision tickets, and slices implementation issues            |
| `do-implement`     | Takes one implementation issue to a verified draft PR                               |
| `do-factory-setup` | Writes a repo's tracker doc and scripts rule, runs setup blocks, installs dev ports |

## New machine

You need Git, Node.js 22.20+ with npm, the [GitHub CLI](https://cli.github.com), a coding agent and a Linear workspace. Python 3.11+ enables service setup; a POSIX shell and `nc` enable dev ports.

1. **Install Factory.** Replace `codex` with your [agent’s identifier](https://skills.sh/docs/cli), such as `claude-code` or `cursor`. Keep `-a` to avoid installing for every agent.

   ```sh
   npx skills add mcwestling/factory --skill '*' -g -a codex -y
   ```

2. **Connect Linear and GitHub.** Add [Linear’s MCP server](https://linear.app/docs/mcp) to your agent and sign in, then run `gh auth login`.
3. **Consider Orca.** [Orca](https://onorca.dev/download) manages parallel agent workspaces. It’s recommended, not required.

## Adopting

In each repo, run:

```text
/do-factory-setup
```

Setup writes the repo’s tracker settings, links them from `AGENTS.md`, and offers to install missing supporting skills. It prefers [Matt’s plugin](https://github.com/mattpocock/skills#installation-30-second-setup) where supported, with a skills-CLI fallback. Both routes supply the full upstream set, including sibling dependencies.

Use one upstream installation form per agent. The CLI’s shared store can expose skills to other agents too, so resolve duplication with plugin installs before proceeding. If newly installed skills aren’t discovered, start a fresh agent session and rerun setup; setup remains pending until they’re usable.

Setup also adds [dev ports](tools/orca/README.md) for repos with a dev server, fills missing README intro sections, and offers approved service commands from your Tool Stack’s Linear pages. To define those commands, start with the [Adding a repo example](skills/do-factory-setup/adding-a-repo.example.toml).

For manual adoption, copy [McWestling’s tracker settings](docs/issue-tracker.md) and replace the values. See the [setup skill](skills/do-factory-setup/SKILL.md) for the full procedure.

## Contributing

Contributions are accepted under this repo's [MIT license](LICENSE) (inbound=outbound).
