# Can do-closeout close its Orca thread? (DO-1706)

Researched 2026-11-18 against Orca 1.4.262 on macOS. Sources are Orca's own CLI output and the code it ships in `Orca.app/Contents/Resources/app.asar.unpacked/out`.

## Answer

Not through anything Orca supports today. Factory's agent threads are chats, and the Orca CLI has no command that closes or sleeps a chat. The runtime can do both, but only the app's own UI calls those methods.

## What hides a worktree from the sidebar

The sidebar has a "Toggle Sleeping Workspaces" filter (`sidebar.sleepingWorkspaces.toggle`, setting `showSleepingWorkspaces`). With sleeping workspaces hidden, a worktree drops out when it has no live terminal, no live agent and no awake chat. The renderer's filter takes `tabsByWorktree`, `ptyIdsByTabId`, `worktreeIdsWithLiveAgent`, `worktreeIdsWithStructuredChat` and `structuredChatSleptAtByPaneKey` as inputs (`out/renderer`, the `hideSleepingWorkspaces` call).

So closing the last thread works, and so would sleeping the workspace. Neither deletes the worktree.

## What the CLI offers

From `orca --help` and `orca agent-context --json` (338 commands):

- `orca agent`: `launch`, `list`, `show`, `read`, `hooks`. No close, stop or sleep.
- `orca chat`: `rename` only.
- `orca terminal close ([--terminal <handle>] [--tab] | --worktree <selector> --all)`: closes terminals. Its notes say `--all` "stops every terminal process owned by that workspace and durably removes its terminal tabs, layouts, and resume records". Nothing says it touches chats. Not tested against a chat.
- `orca worktree set --workspace-status <id>`: sets the board column (`todo`, `in-progress`, `in-review`, `completed`). The sidebar filter above doesn't read it.
- `orca worktree rm` and `orca workspace cleanup run`: remove worktrees, which is ruled out.
- `orca repo hide`: hides a whole project, not one worktree.

## Factory's threads are chats

`orca agent list --worktree current --json` in a Runner-launched session reports `"kind": "chat"`, and the session has `ORCA_STRUCTURED_SESSION=1`. The Runner calls `orca agent launch` with no `--surface` (`packages/delegator/runner/runner.ts`), so the surface follows the Mac's Chat | CLI setting, which is Chat.

## What the runtime has but the CLI doesn't expose

`out/main` registers these RPC methods, both with `permission: workspace`:

- `agentSession.close`, params `{ sessionId, workspaceId }`. Closes a chat with reason `user-close`.
- `agentSession.sleepWorkspace`, params include `workspaceId` and `markAsleep`.

`out/cli` references neither. The only `agentSession.*` method the CLI calls is `agentSession.rename`. Calling the runtime socket directly would be an undocumented interface that can change in any Orca update.

## Other routes checked

- **Plugins:** the typings from `orca plugin types` (694 lines) expose workspace and agent events, but no call that closes or sleeps a session.
- **Auto-sleep:** no idle or auto-sleep setting exists in the shipped code.
- **Terminal surface:** launching with `--surface terminal` would make the closeout agent closable with `orca terminal close`, but the implementing thread in the same worktree is still a chat, so the worktree stays visible.
- **Computer use:** `orca computer` could click Orca's own close button. It depends on the window layout and is fragile.

## Preconditions the answer hangs on

- Orca 1.4.262. A later version may add a close or sleep command; recheck `orca agent --help` and `orca chat --help`.
- The sidebar's sleeping-workspaces filter is set to hide them.
- Agents launch as chats (the Chat | CLI setting is Chat).
