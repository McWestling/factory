# Factory

Factory is the thing that makes our things.  It turns ideas into finished software changes, with coding agents doing the building and a human making the decisions.

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

This repo is McWestling’s own setup and home repo, published openly. It holds the settings file, such as team names, labels and statuses, that every McWestling repo points to, and planning runs from here.

## Who it's for

People who plan their work in Linear and want coding agents to do more of the building without giving up control. You decide what gets built and review every change; the agents do the legwork in between.

## Learn more

- [Build your own](#build-your-own)
- [Delegator architecture and Cloud Inbox setup](packages/delegator/README.md#where-it-runs)
- [McWestling's settings file, a worked example](docs/issue-tracker.md)
- [License](LICENSE)

---

## Skills

| Skill           | What it does                                                                         |
| --------------- | ------------------------------------------------------------------------------------ |
| `do-post-its`   | Turns photos of Post-its, or dictated notes, into Triage issues                      |
| `do-triage`     | Works the Triage queue with you and routes each item                                 |
| `do-refine`     | Charts maps, resolves decision tickets, and slices implementation issues             |
| `do-implement`  | Takes one implementation issue to a verified draft PR                                |
| `do-closeout`   | Checks a thread is good to close and finishes the issue's closeout                   |
| `do-repo-setup` | Points a repo at its home repo's tracker doc, writes its rules, installs dev ports   |

Planning (`do-post-its`, `do-triage`, `do-refine`) runs from your home repo’s checkout and reads the other repos’ code. Build work (`do-implement`, `do-closeout`) runs in each product repo.

## Build your own

Factory is built for McWestling, not as a product: there is no support, and anything may change. To stand up the same thing for yourself, fork it and make the fork your home repo.

1. Fork this repo. GitHub forks of a public repo stay public; copy the repo instead if you want yours private.
2. Replace `docs/issue-tracker.md` with your own values.
3. Install the skills from your fork, selecting your agents when prompted:

   ```sh
   npx skills add <you>/factory --skill '*' -g
   ```

4. Run `/do-repo-setup` in each of your repos. It points the repo’s `AGENTS.md` at your fork’s tracker doc, and offers to install the supporting skills, dev ports and your Tool Stack’s service commands ([example](skills/do-repo-setup/adding-a-repo.example.toml)).
5. Optionally, [deploy your own Cloud Inbox](packages/delegator/README.md#set-up-your-cloud-inbox) to delegate work from Linear.

You need Git, Node.js 22.20+ with npm, the [GitHub CLI](https://cli.github.com) signed in with `gh auth login`, and [Linear’s MCP server](https://linear.app/docs/mcp) connected to your agent. Python 3.11+ enables service setup; a POSIX shell and `nc` enable dev ports. [Orca](https://onorca.dev/download) is recommended for parallel agent workspaces. Delegator development requires Node.js 26.

## Software and where it runs

| Component | Runtime | Setup |
| --- | --- | --- |
| Cloud Inbox | Your Cloudflare account: Worker plus per-machine Durable Object storage and alarms | [Deploy and configure it](packages/delegator/README.md#set-up-your-cloud-inbox). |
| Runner | Your Mac, alongside Orca, as a LaunchAgent with a menu bar app | [Install and control it](packages/delegator/README.md#install-and-control-the-runner). |

Linear sends delegations to Cloud Inbox. The Runner claims them over HTTPS and launches Orca on your machine. Cloud Inbox can queue work while that machine sleeps.

## Upkeep

After merging Factory changes, run `npm run upkeep` with Node.js 26 from a clean checkout of `main`. It refreshes the installed skills and safely updates an existing Runner; see [what it checks](packages/delegator/README.md#update-after-merging-factory-changes). It currently reads McWestling’s repo, so a fork can’t use it yet. To restart the Runner’s menu bar app, run `npm run menubar`.

## Contributing

Contributions are accepted under this repo's [MIT license](LICENSE) (inbound=outbound). [Verifier](packages/verifier/README.md) and [Delegator](packages/delegator/README.md) development notes live in their package READMEs, and [`AGENTS.md`](AGENTS.md) says where things go.
