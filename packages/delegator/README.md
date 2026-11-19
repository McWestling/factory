# Delegator

Delegate a Linear issue to `Delegator`. Cloud Inbox queues the job until a Runner
on one of your machines claims it and starts a coding agent in Orca.

## Where it runs

- **Cloud Inbox:** a Cloudflare Worker with one SQLite-backed Durable Object,
  one Linear app installation and one shared queue.
- **Runner:** a local process that claims jobs and launches Orca worktrees.
  On macOS, a menu bar app controls its LaunchAgent.

One deployment serves one Linear workspace and several machines. Each machine
has its own bearer secret; only Cloud Inbox holds Linear tokens. Installing
Factory's skills does not deploy Cloud Inbox.

## Set up your Cloud Inbox

Follow the [Cloud Inbox guide](cloud-inbox/README.md) to deploy, connect and check
it. That guide also covers secrets, routes, updates and disconnection.

## Install with setup

Use Node.js 26, Orca and the Swift compiler on macOS. From the repo root, install
the Cloud Inbox tooling if you want setup to deploy an Inbox:

```sh
npm --prefix packages/delegator ci --ignore-scripts
npm run setup
```

At a terminal, setup offers to install the Runner. It can connect to an existing
Inbox using its URL and this machine's bearer secret, or guide you through a new
Inbox's deployment and browser approvals. It asks for your Linear user id and
model ids. An existing valid Runner config is reused; an invalid one is refused.
Setup prints no secrets. Installation succeeds only after the Runner reaches
Cloud Inbox and the menu bar app is registered to open at login. Rerun setup to
finish an interrupted installation.

### Watch the pool from a Mac without a Runner

Decline the Runner and setup offers to install the menu bar app alone. It asks
for the Cloud Inbox URL and a [viewer secret](cloud-inbox/README.md#pool-status)
from `npm run inbox -- viewer <name>`, with hidden input, and stores both in the
macOS Keychain as the `com.mcwestling.factory-delegator.pool` item. The secret never
touches a file or a log. The menu then shows the Pool section and no Runner controls.

### Update after merging Factory changes

From a clean checkout of `main` that matches GitHub, run `npm run setup` again.
It updates the skills and an installed Runner without another installation prompt.
A running Runner first drains in-flight operations; saved PR watches survive.
Setup checks the new bundle against the config before replacement and restores
the previous bundle if the new Runner fails to return. A stopped Runner stays
stopped. Config, the Runner switch and **Start at login** are preserved.
Setup relaunches the menu bar app after a successful install or update.

## Run the Runner

For manual configuration, copy [config.example.json](config.example.json) to
`~/.config/factory-delegator/config.json`, fill every placeholder and set mode
`600`. The config contains:

| Key | Meaning |
| --- | --- |
| `inboxUrl` | Deployed Cloud Inbox URL, including `/delegator`. |
| `bearerSecret` | This machine's secret from Cloud Inbox's `MACHINES`. |
| `machine` | Machine name used in Runner error messages. |
| `allowedCreatorIds` | Linear user ids allowed to delegate to this Runner. |
| `models` | Model names mapped to Orca `agent`, `model` and optional `effort`. |
| `levels` | A configured model name for each of `light`, `standard` and `deep`. |
| `skill` | Skill to launch; defaults to `do-implement`. |
| `refineRepo` | Optional `owner/name` planning repo for decision tickets, which launch `do-refine`; remove it to refuse them. |

Model names are local config keys, selected by a level or an issue's `[model=]`
pin. Pins match without case or punctuation: exact match first, then a unique
substring. Unknown or ambiguous pins fall back to the level's model with a thought
in Linear. See the [issue format](../../docs/issue-format.md).

Model routing can be changed from the menu bar: its **Models** section has a
submenu for each level listing the configured models. Picking one changes only
that level's value in `config.json`, though the file is rewritten with sorted keys.
Closeouts use the standard level and Refinement the deep one. The Runner rereads
the config before each claim, so any config edit applies to the next launch without
a restart. If a reread finds the config invalid, it keeps the last good one and
logs `config` / `invalid`.

From `packages/delegator`, run the configured Runner in the foreground:

```sh
npm run runner
```

Every 15 seconds it claims one job. It checks the delegate, allowed creator,
issue tags and branch before launching. Register one checkout per GitHub repo in
Orca first: the Runner matches the issue's repo tag against Orca's registered
GitHub identity. Missing or duplicate registrations refuse the job. Every
registered GitHub repo is eligible for an allowed creator; there is no separate
repo allowlist. After fixing a refusal, delegate again to retry.

A successful launch posts a thought and reports `launched`; Cloud Inbox queues
the in-progress status, `Orca` label and session creator as assignee. A failed
job clears the delegate only if it is still this app. Field writes retry through
Cloud Inbox's outbox.

### Automated closeout

When a PR the Runner launched merges, the Runner starts a fresh agent in the
issue's worktree to run `do-closeout`, so the after-merge steps run without you.
Cloud Inbox queues the [closeout job](cloud-inbox/README.md#closeout-jobs) for the
machine that launched the PR. The Runner starts the standard level's model with
`orca agent launch` in that worktree, posts a thought and a response, and doesn't
watch it; `do-closeout`'s completion comment lists anything still open.

Nothing launches when the issue was canceled, the merged PR can't be verified as
the launch's, or the worktree is gone from this machine. The response says which;
run `do-closeout` by hand if it's still needed. A failed launch isn't requeued.

### Install and control the Runner

From the repo root, with the config ready and `node`, `orca` and `swiftc` on PATH:

```sh
sh packages/delegator/runner/launchd/install.sh
```

This installs the app at `~/Applications/Factory Runner.app` and separate per-user
LaunchAgents for the Runner and menu bar app. To install only the app, add
`--app-only`, then choose **Install Runner** in its menu once the config is ready.
The installer also accepts `--install-runner` (app already installed),
`--uninstall-runner`, or `--uninstall` to remove both.
Logs are in `~/Library/Logs/factory-delegator/`.

The **Runner** switch stops new claims while allowing current work and PR checks
to finish. Its setting survives restarts. Turning it on starts the Runner if needed.
**Start at login** controls the menu bar app's LaunchAgent. The menu also opens
logs and config. Status shows readiness, current work, PR watches, connection
failures or the last failed job; **Off** can also mean the Runner is not running.
These lines and the Runner controls appear only when a Runner is installed on this Mac;
**Install Runner** appears only once its config exists.

The **Pool** section lists every machine as working (with its job), idle, off or
offline, then the number of jobs waiting. The app reads Cloud Inbox's `GET /pool`
when the menu opens and at most once a minute otherwise, using the Keychain item
setup stored, or on a Runner Mac the Runner's own config. When a fetch fails, the
menu keeps the last result and adds the time it was fetched.

### Recovery and PR checks

Before creating a worktree, the Runner saves launch intent in `launches.json`
beside its config. Lost launch reports can be recovered on this machine without
creating another worktree. Recovery checks an interrupted intent against the
exact local Orca checkout and branch. A matching worktree proves neither agent
startup nor that the agent is still running. Keep launch state private and backed
up: corrupt state is treated as empty, losing recovery. A lost response can cause
a repeated thought; delivery is at least once.

PR watches run every 45 seconds and survive restarts in
`watching.json` under `${XDG_STATE_HOME:-~/.local/state}/factory/` (relative
`XDG_STATE_HOME` is ignored). Cloud Inbox can recover this machine's open watches.
It verifies attached PRs against the recorded repository and exact branch before
the Runner posts the final PR response. This ends Linear's working state; it
neither merges the PR nor marks the issue Done. Linear's GitHub integration must
attach the PR to the issue. GitHub checks use its public API, unauthenticated
unless the optional [GitHub token](cloud-inbox/README.md#secrets) is set; without it
private PRs can't be confirmed, and with a token that can't read the PR the Runner
says so once. Rate limits and outages also prevent confirmation. When `orca worktree ps`
shows the watch's agent stopped (every agent `done`, or none left) for 10 minutes
without a PR, the Runner replies that the agent stopped and ends the watch. It
counts only the one worktree on this Mac in the repo's one registered checkout, at
the watch's exact branch; anything else waits for the 24 h reply. The
stopped time is kept in memory, so a restart starts it over. Otherwise, after 24 hours without
a confirmed PR, the Runner asks you to check the Orca worktree. Terminal sessions
are dropped without another response.

The same state directory holds disposable `status.json` for the menu and a
`paused` flag for the Runner switch. Creating that flag pauses new claims;
removing it resumes them. Keep `watching.json` private: it contains claim authority.

## Test locally

Use Node.js 26. From `packages/delegator`:

```sh
npm ci --ignore-scripts
npm test
npx wrangler deploy --dry-run
```

Tests use fake Linear responses and in-memory SQLite without credentials. The dry
run checks the Worker bundle without deploying. For local Cloudflare development,
copy [.dev.vars.example](.dev.vars.example) to `.dev.vars`, fill it in and run
`npx wrangler dev`. Local storage is separate; Linear cannot deliver to localhost.

## Security

Cloud Inbox alone holds the Linear app credentials and its
`read,write,app:assignable` grant. A machine's bearer secret permits only the
named API operations on its own claims. Machines must treat job content as
untrusted input. A compromised Worker can read and edit accessible workspace data
and tamper with the shared queue: the boundary is its code, not narrower Linear
permissions. You own deployment, credentials and usage charges.
