# Orca thread links and needs-attention signals

Research for "Find how to link to an Orca thread and how Orca flags a session that needs attention". Checked against Orca 1.4.261 (CLI and app bundle), read only. Sources are the `orca` CLI help, `orca agent-context --json`, the app's `Info.plist` and the unpacked `app.asar` (`out/main`, `out/shared`, `out/renderer`). No public docs were needed: the bundle is the source that owns these behaviours.

## 1. Can a URL open a specific worktree, chat or terminal?

**No.** Orca registers the `orca` URL scheme, but its handler only accepts three link kinds, none of which names a worktree, chat or terminal.

- `Info.plist`: `CFBundleURLTypes` declares the scheme `orca`.
- `out/main/index.js`: `app.on('open-url', ...)` calls `preventDefault` and handles the URL only when `qee(url)` is true. `qee` accepts a skill share link (`orca://skills/share/<id>`, or `https://app.orca.dev|share.orca.dev|share.onorca.dev/skills/share/<id>`) or a plugin install link (`orca://plugins/...` or `orca://plugins?...`, from `out/shared/plugins/catalog/plugin-install-link.js`).
- The only other `orca://` strings in the bundle are pairing codes (`orca://pair?code=...`), which the CLI and mobile client parse from pasted text, not from `open-url`.
- A grep of every `orca://` string in `out/` found no worktree, tab, chat, terminal or session route.

So a link in Linear cannot open the session, even on the same Mac.

### Closest alternative: an `orca` command to paste

`orca worktree activate --worktree <selector>` opens a worktree in the app ("Open a worktree on its host"). Selectors include `identity:<identity>`, `id:<repo-id>::<path>`, `branch:<branch>` and `path:<path>`.

From `orca worktree create ... --agent ... --json` (assembled in `out/cli/workspaces/worktree-create-agent-launch.js`):

- `result.launch.worktreeId` (`<repo-id>::<path>`) is always present: `orca worktree activate --worktree id:<worktreeId>`.
- `result.worktree` is the `worktree show` record, included when that lookup succeeds. Its `identity.key` (shape `wt2:local:<instanceId>`) is the most stable selector: `--worktree identity:<key>`.
- `result.launch.outcome.handle` is the agent's handle (`--json` with `--agent`; older hosts put a terminal handle in `result.agentTerminalHandle`). For a terminal launch, `orca terminal switch --terminal <handle>` brings that tab forward. There is no chat equivalent: `orca chat` only has `rename`.

Without any id, `orca reference find <ISSUE-KEY> --json` returns the workspaces and agents linked to a Linear issue, because the Runner passes `--linear-issue`. `orca worktree activate --worktree branch:<branch>` also works, since the Runner chooses the branch.

The Runner can post `orca worktree activate --worktree branch:<branch>` as a code block. It needs the Orca app running on the Mac where it is pasted, and the CLI on `PATH`.

## 2. How does Orca flag an agent that waits for a person?

**Orca raises its own notification, which is shown as a macOS notification, when an agent moves to the `waiting` state.** `AskUserQuestion` in Claude Code and `request_user_input` in Codex both count.

- `out/shared/agent-status/lifecycle/agent-question-answered-intent.js`: `isAskUserQuestionTool` matches `askuserquestion` and `requestuserinput`.
- `out/shared/agent-hook-listener/providers/claude/claude-events.js`: "AskUserQuestion blocks on PreToolUse as well as PermissionRequest; both need human attention" sets the state to `waiting`.
- `out/shared/agent-hook-listener/providers/codex/codex-state.js`: an ask-user tool maps to `waiting`. A `PermissionRequest` also sets `waiting`.
- Chat surface: `out/main/chunks/structured-agent-session-host-assembly-*.js` treats `AskUserQuestion` and `ExitPlanMode` as prompts that need the user, and shows a question card in the chat.
- `out/main/index.js`: a notification of source `agent-task-complete` whose agent state is `blocked`, `waiting` or `needs-input` is classed `needs-input`, and is sent only when `notifications.agentNeedsInput` is on. The renderer dispatches it for agent sessions (`surface: 'agent-session'`) and marks the workspace's attention as unread.

### Preconditions

- **Agent status hooks on** for terminal agents. `orca agent hooks status --json` shows `enabled` and, per agent, `state: installed` with `managedHooksPresent`. Orca writes the hooks into `~/.claude/settings.json` (`PreToolUse`, `PermissionRequest`, `Stop` and more) and `~/.codex/hooks.json`. They only report from panes Orca launched (`ORCA_PANE_KEY`, `ORCA_AGENT_HOOK_PORT`). Turn them on with `orca agent hooks on`, or in Orca settings.
- **Notification settings** (Settings, Notifications): `enabled`, and `agentNeedsInput` (defaults to on, falling back to `agentTaskComplete`).
- **`suppressWhenFocused`** (default on): no banner when Orca is focused on that session.
- **`notifyHiddenWorkspaces`** (default off): hidden workspaces stay silent.
- **macOS permission**: Orca must be allowed to post notifications (System Settings, Notifications, Orca). Orca checks this with `notifications.getPermissionStatus`.
- The Orca app must be running. A headless `orca serve` has no window, so it shows nothing.
