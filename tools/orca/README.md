# Orca dev ports

Orca doesn't assign ports, so dev servers in parallel workspaces fight over the same one. [`dev-port`](../../skills/do-repo-setup/dev-port) gives each worktree its own block of 10 ports. The script lives in the `do-repo-setup` skill folder, so installed skills can copy it into any repo offline.

## The convention

- **Blocks:** base ports run 55000, 55010, … 55990, so 100 workspaces fit. `PORT` is the base port; extra services in the workspace use `PORT+1` to `PORT+9`.
- **Registry:** `${XDG_STATE_HOME:-$HOME/.local/state}/factory/dev-ports`, one `<worktree path> <base port>` line per worktree. `…/state/factory/` is factory's home for per-machine state; the script creates it on demand.
- **Sticky:** a worktree keeps its block until its path is removed. The next allocation prunes the entry and frees the block.
- **Allocation:** an unregistered worktree takes the lowest block that is neither registered nor has its base port listening. A `mkdir` lock stops concurrent runs claiming the same block.
- **Full:** if all 100 blocks are taken, `dev-port` exits non-zero and leaves the registry alone.
- **Precedence:** an explicit `PORT` wins; otherwise `dev-port`. Nothing reads `CONDUCTOR_PORT`.

## Adopting it

`do-repo-setup` does these steps for any repo with a `dev` script in `package.json`. By hand:

1. Copy `dev-port` into the repo, for example to `scripts/dev-port`. Vendor it; never fetch it at runtime.
2. Add it to `orca.yaml` `scripts.setup` to claim a block when the worktree is created. Chain it after any setup command already there:

   ```yaml
   scripts:
     setup: pnpm bootstrap && ./scripts/dev-port
   ```

3. Wrap the dev command, passing the port the way the server takes one (`next dev -p "$PORT"`, `vite --port "$PORT"`, or nothing for a server that reads `PORT`):

   ```sh
   PORT="${PORT:-$(./scripts/dev-port)}" && export PORT && <server>
   ```

A worktree that never ran the setup hook gets its block on its first dev start.

## Checking it

```sh
sh skills/do-repo-setup/dev-port.test.sh
shellcheck skills/do-repo-setup/dev-port skills/do-repo-setup/dev-port.test.sh
```
