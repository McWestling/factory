# Can an Orca agent in home work in another repo's worktree?

Research notes, 2026-11-11. Checked against Orca 1.4.256, Claude Code 2.1.319 and Codex CLI 0.166.0.

## Short answer

Yes, but only one of the two ways works well.

- **Hand off (works):** the home agent runs `orca worktree create --repo id:<targetRepoId> --agent <agent> --prompt "<brief>"`. Orca creates the worktree in the target repo and starts a new agent there. That agent runs inside the target worktree, so it loads the target repo's instructions and skills and edits, tests, commits and pushes in its own folder. Nothing crosses a folder boundary.
- **Reach across (fragile):** the home agent creates the worktree and then edits it from its own session. The edits fall outside the session's folder. Claude Code and Codex then prompt, use a classifier, or refuse. The target repo's CLAUDE.md, AGENTS.md and skills do not load. The work shows in Orca only as the home agent's activity.

## 1. Orca: creating a worktree in another repo

- `orca worktree create` takes `--repo <selector>` (`id:`, `name:` or `path:`) to target any registered repo. Without `--repo`, Orca uses the caller's repo. Source: `orca worktree create --help`.
- The `orca-cli` guide says a parent can be in a different project from its child, for example `worktree create --repo id:<otherRepoId> --name related-task --parent-worktree id:<parentRepoId>::<parentPath>`. Parent and child must use the same execution host. Source: `orca skills get orca-cli`, "Lineage rules".
- From inside an Orca worktree, Orca records the caller as the parent when it can infer it. `--no-parent` turns that off. Source: `orca worktree create --help`, Notes.
- A worktree's id is `<repoId>::<path>`, and `worktree ps --json` rows carry `repoId` plus `parentWorktreeId` and `workspaceLineage`. So the new worktree belongs to the **target repo**. With a parent recorded, Orca links it to the home worktree as a child. Source: `orca worktree ps --json` fields.
- With `--agent`, the launch goes through the same path as a new agent tab in the app. It opens as a chat or a terminal, and the result returns a handle (`result.launch.outcome.handle`). That agent is visible and steerable like any other Orca agent (`orca terminal send`, the chat tab, `orca orchestration` mail). Source: `orca-cli` guide, "Starting agents".
- Orca's mobile app pairs with the desktop runtime (`orca serve --mobile-pairing`). It shows that runtime's workspaces, so a handed-off agent shows on mobile like any other. *Inferred:* not tested on a phone for this note.
- For supervised work, `orca orchestration worker-start --worktree new-top-level --repo id:<repoId>` does the same and reports back with `worker_done`. Source: `orca skills get orchestration`.
- The Factory Runner already uses this form: `orca worktree create --repo path:<checkout> --agent ... --prompt=...` (`packages/delegator/runner/runner.ts`, `launchArgs`; `docs/issue-format.md`).

If the home agent edits the worktree itself, Orca shows the worktree under the target repo, but with no agent of its own. The edits come from the home agent's terminal or chat, under home.

## 2. Editing outside the session folder

### Claude Code

- **Access:** By default, Claude can only touch the folder it started in. `--add-dir`, `/add-dir` or `permissions.additionalDirectories` extend this. Files in an added directory follow the current permission mode. Source: [Permissions, Working directories](https://code.claude.com/docs/en/permissions#working-directories).
- **Prompts:** `acceptEdits` auto-accepts edits only in the working directory or added directories. In `auto` mode, anything not otherwise resolved goes to the classifier. The first Read, Grep or Glob outside the working directories asks, except in `-p` and background sessions. `.git` is a protected path: `default` and `acceptEdits` prompt, `auto` asks the classifier, `dontAsk` denies, `bypassPermissions` allows. Running `cd <other dir> && git ...` prompts, because git there can run that repo's hooks. Sources: [Permissions](https://code.claude.com/docs/en/permissions), [Permission modes](https://code.claude.com/docs/en/permission-modes).
- **Sandbox:** When the sandbox is on, it can write to the working directory, a temp directory and `--add-dir` directories. Other paths need `sandbox.filesystem.allowWrite`. Network goes through an allowlist that starts empty, and on macOS `git push` over SSH fails inside the sandbox. Source: [Sandboxing](https://code.claude.com/docs/en/sandboxing).
- **Instructions:** CLAUDE.md and AGENTS.md load from the working directory and its parents at launch. Subdirectories load on demand. A directory added with `--add-dir` does **not** load its CLAUDE.md, `.claude/rules/` or AGENTS.md unless `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` is set. A directory that is neither under the working directory nor added gets nothing. Source: [Memory](https://code.claude.com/docs/en/memory).
- **Skills:** `--add-dir` and `/add-dir` load the added directory's `.claude/skills/`, commands and agents. Names that clash get a `<dir>:` prefix. `permissions.additionalDirectories` loads none of these. Source: [Skills](https://code.claude.com/docs/en/skills); [Permissions, additional directories](https://code.claude.com/docs/en/permissions#additional-directories-grant-file-access-not-configuration).
- **Moving:** `/cd <path>` moves the session and loads the new folder's CLAUDE.md, settings and skills. It asks for workspace trust if the folder is new. That is interactive. Source: [Permissions](https://code.claude.com/docs/en/permissions).

### Codex

- **Access:** In `workspace-write`, the workspace is the current directory plus temp directories like `/tmp`. `--add-dir <DIR>` (on `codex` and `codex exec`) adds writable directories. `sandbox_workspace_write.writable_roots` does the same in config. Sources: `codex --help`; [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security); [Sandboxing](https://learn.chatgpt.com/docs/sandboxing).
- **Protected paths:** `<writable_root>/.git` is read-only whether it is a directory or a file. So are `.agents`, `.codex` and `.aws`. Network is off by default and needs `sandbox_workspace_write.network_access = true`. So in `workspace-write`, `git commit` and `git push` need approval even in Codex's own folder. Source: [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).
- **Prompts:** With `on-request`, Codex asks to go past the sandbox. `never` never asks and works within the limits. `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) removes both. Codex may start read-only until the folder is trusted (`projects.<path>.trust_level`). Same source.
- **Instructions:** Codex builds the AGENTS.md chain once at startup, from the project root (usually the Git root) down to the current directory. The docs say nothing about AGENTS.md in added directories or in folders it edits later. Source: [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
- **Skills:** Codex scans `.agents/skills` from the current directory up to the repo root, plus `~/.agents/skills`, `/etc/codex/skills` and built-in skills. The docs name no other place. Source: [Build skills](https://learn.chatgpt.com/docs/build-skills).

**So:** an agent only follows a repo's own instructions and skills if it starts inside that repo's worktree. Reaching across gets the home repo's rules applied to the target repo's code.

## 3. What a delegated launch needs

For the hand-off way:

1. Orca running on the same host, with the target repo registered. Check with `orca repo list --json`. Its `repoId` comes from there.
2. The home agent can run `orca`. In a sandbox, the Orca socket can fail with `runtime_access_denied`. Codex then needs escalation (a prompt) unless `orca` is pre-approved or the sandbox allows it. Claude in `auto` mode sends the call to the classifier.
3. The brief passed in `--prompt` must say the run is delegated, as the Runner's prompt does ("Delegated run: nobody is watching this session."), so the new agent's skill makes default calls instead of asking.
4. The new agent's own launch has to run without prompts in the target worktree. This is the same as any Runner launch today: Claude in `auto` mode (or `bypassPermissions`), Codex with an approval policy and sandbox that allow commit and push. Orca's chat surface starts Claude with `--permission-prompt-tool=stdio`, so any prompt that does come up waits in Orca's chat with nobody to answer it.
5. Pick `--setup run` or `--setup skip` on purpose. The default `inherit` follows the target repo's setup policy.

For the reach-across way, also:

- Claude would need `--add-dir <target worktree>` at launch, plus `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` for its instructions, or `bypassPermissions`. Codex would need `--add-dir`/`writable_roots`, network access and permission to write `.git`, or `--yolo`. `orca worktree create` and `orca agent launch` have no flag to pass extra agent arguments, and the worktree path is only known after the session has started. `/add-dir` and `/cd` mid-session are interactive.

## Preconditions

- Orca 1.4.256 or later (cross-project parent lineage, `--repo`, `--model`/`--effort` on create, `result.launch`), and the Orca app running.
- Target repo registered in Orca on the same execution host as home.
- Claude Code 2.1.283 or later for `auto` as the default mode. Auto mode needs a supported model and must not be disabled by an admin. Reading AGENTS.md directly needs 2.1.277 or later.
- Codex settings that allow commit and push without asking, because `.git` is read-only and network is off in `workspace-write`.
- HTTPS git remotes if Claude's sandbox is on (macOS SSH push fails inside it).
- Mobile visibility assumes the phone is paired with the same desktop runtime. Not tested for this note.

## Signs that starting from home is impractical

- Reaching across loses the target repo's instructions and skills and runs into prompts in every mode short of full bypass. Only the hand-off way is worth using.
- A hand-off gives two agents per job: home's and the target's. The Runner already launches straight into the target repo with `--repo path:<checkout>`, so starting from home adds a hop without adding anything, unless home has to decide which repo the job goes to.
- Orca only confirms that the worktree exists, not that the agent started or is still running (`packages/delegator/README.md`). A home agent that hands off and exits leaves that gap unwatched, unless it uses `orca orchestration worker-start` and waits for `worker_done`.
