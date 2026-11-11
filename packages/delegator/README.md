# Delegator

Delegate an issue from Linear. Factory Cloud Inbox holds it until the Factory Runner
on your machine picks it up and starts a coding agent in Orca. Each machine has its
own Linear agent integration, so the agent you delegate to decides the machine.

## Where it runs

- **Cloud Inbox:** you deploy this application to your Cloudflare account. It
  receives tasks from Linear and holds them while your computer is busy or asleep.
  Cloudflare also runs its storage and message retries; no database server to manage.
- **Runner:** a process on your machine that picks up tasks from Cloud Inbox and
  starts them in Orca. See [Run the Runner](#run-the-runner).

Cloud Inbox is available for controlled testing. On Cloudflare it has answered a real
delegation and stop, and served the Runner API's task, update and write-back operations
against real Linear. It cannot launch Orca by itself.
One deployment supports one Linear workspace and several computers, each with its
own Linear app. Installing Factory's skills does not deploy Delegator.

## Test locally

Use Node.js 26. From `packages/delegator`:

```sh
npm ci --ignore-scripts
npm test
npx wrangler deploy --dry-run
```

Tests use fake Linear responses and in-memory SQLite; no accounts or credentials
are needed. The dry run checks the cloud bundle without deploying it.
For the local Cloudflare runtime, copy [.dev.vars.example](.dev.vars.example) to
`.dev.vars`, fill it in, and run `npx wrangler dev`. Local storage is separate from
production; Linear cannot deliver webhooks to localhost.

## Set up your Cloud Inbox

Use Node.js 26 and run from `packages/delegator` after `npm ci --ignore-scripts`.
You need a Cloudflare account with Workers and SQLite-backed Durable Objects,
and a Linear workspace admin who can create and authorize a private app.

```sh
npm run inbox -- login
npm run inbox -- setup
```

These are the two deployment entry actions. Cloudflare login/approval and the
one-time Linear app registration are required human steps within the guide, not
an automatic installation. Setup asks for the Cloudflare account ID, Worker name,
stable machine key and Linear organization UUID (from your admin or Linear MCP).
It deploys storage, generates owner and machine secrets, opens a prefilled private
app-registration page, asks for the app's three credentials with hidden input,
uploads configuration and returns the permanent setup URL. Keep webhook delivery
enabled. No personal Linear API key or JSON editing is needed.

The supported guided path uses the Worker's `workers.dev` HTTPS address. Custom
routes remain an advanced manual deployment; don't use setup to change their identity.

Setup checkpoints each answer in `.cloud-inbox.local.json`, with owner-only file
permissions; the generated `.cloud-inbox.local.json.toml` uses the same Worker,
account, binding and migrations. Both are gitignored. Back up the checkpoint in
your secret manager: it contains app credentials and machine connection authority,
but never Linear access or refresh tokens. Rerun setup after an interruption;
it preserves credentials and machine keys and doesn't redeploy a completed setup.
Never rename the Worker or a machine key: they select the stored installation/jobs.

For an existing installation, restore its checkpoint, or import its **complete,
original** secrets before setup:

```sh
npm run inbox -- import /path/to/private/.dev.vars
npm run inbox -- setup
```

Use its original account, Worker name and machine key. Import preserves every
machine entry. Setup refuses existing remote secrets without a checkpoint/import;
Wrangler cannot download secret values for recovery. Don't generate replacements.

## Connect and check

```sh
npm run inbox -- connect
npm run inbox -- status
```

Connect uses the saved owner credential to open Cloud Inbox's Linear authorization
flow in your browser. Approve the exact `read,write,app:assignable` grant. You can
also visit the setup URL and use the saved `config.adminSecret` as the HTTP Basic
password (any username). Status checks the workspace and app identity against Linear
without returning a token. If access is missing or revoked, check the app and workspace,
then reconnect; don't add scopes to bypass a failure. Correct a pasted app credential
with `npm run inbox -- credentials`, then reconnect. This preserves owner/machine
secrets and jobs; use the same app, not a replacement installation.

Deployment is separate from the intended everyday two-step connection: visit Cloud
Inbox and authorize with Linear, then open the running Mac Runner and redeem a
short-lived, single-use pairing code or app link. **Pairing and the background Runner are not built
yet**, so that end-to-end experience is not available. Pairing will
transfer only machine authority for the restricted API, never a Linear token.

For a live smoke test, delegate a disposable issue to your app and expect its queued
reply in Linear; stop the session and expect the stopped reply. This doesn't launch
Orca. Cloud Inbox's token refresh, delivery retries and Cloudflare process lifecycle
are automatic; normal use needs no refresh, restart or retry command.

## Operate it

```sh
npm test && npx wrangler deploy --dry-run
npm run inbox -- update
npm run inbox -- disconnect
npm run inbox -- reconnect
npm run inbox -- status
```

Update deploys code deliberately, retaining configuration, installation identity
and jobs. Disconnect blocks local credential use immediately, revokes both tokens
at Linear, and confirms API access returns 401 and refresh returns `invalid_grant`.
It preserves queued jobs. Revocation can take time: if confirmation fails, retry
`disconnect`; credentials remain blocked and retained only for retry. Reconnect
requires owner authentication and browser approval again. If the app was deleted,
restore/register its credentials separately rather than overwriting the checkpoint.
Commands never export a Linear token to the Runner.

The command does not delete Cloudflare resources or Linear app registrations.
Keep the private app for reconnect; delete a disposable test app in Linear settings
when testing is finished. Adding computers remains a manual configuration task.

## Run the Runner

Copy [config.example.json](config.example.json) to
`~/.config/factory-delegator/config.json`, fill it in and `chmod 600` it. The Runner
refuses to start without it, with a looser mode, or with any key missing or empty;
nothing has a default except `skill` (`do-implement`). `machine` is the Linear app's
name, used in messages. Each `models` key is an exact Preferred models name.
Repos come from Orca at pickup; an old `repos` config key is ignored and can be removed.

```sh
npm run runner
```

Every 15 s it claims one job and checks it with what Cloud Inbox returns. Delegation
by a user on `allowedCreatorIds` is the approval to launch. It drops a job whose issue
is no longer delegated to the app, and refuses an unlisted or missing creator, an issue
that fails the [issue format](../../docs/issue-format.md), or a model not in
its config. It runs `orca open --json`, resolves the repo using `orca repo list --json`,
then runs the documented
`orca worktree create`, retrying once if Orca's runtime is unavailable, then posts
"Started …" and reports `launched`; Cloud Inbox sets the status, `Orca` label and
assignee. Any failure posts one `error` and reports `failed`, which clears the delegate.
It never requeues explicitly. Before create, the Runner saves an intent in
`launches.json` beside the config; it refuses to launch if that write fails. It records
a successful create and whether Cloud Inbox accepted the "Started …" thought. If either
the thought or launch report fails, the lease expires and Cloud Inbox hands the session
back. A restarted Runner reports the saved launch without creating another worktree,
and posts the thought only if its saved flag says it wasn't accepted.

If the Runner dies during create or before recording its result, the saved intent lets
it check `orca repo show` and `orca worktree list` with `--json`. Recovery requires the
exact discovered checkout path, repo ID and branch on the local host. Without that
match (including unreadable or incomplete listing results with no match), it follows
the normal create and failure path; `worktree_conflict` alone never proves a launch.
Orca confirms a worktree, not that its agent started, received the prompt or is still
running. A pre-existing matching worktree can also satisfy an intent left before create.

State files are replaced atomically and old entries are pruned on writes after 30 days.
The previous numeric launch records still recover, but have no thought metadata to retry.
A missing file is normal; unreadable or corrupt state logs `launches-unreadable` once
per read, without ids, and is treated as empty. Losing that state loses recovery.
A thought accepted just before a crash, lost response or failed flag write may be posted
again on recovery: the updates API has no deduplication key. A timed-out create still
fails and can leave a worktree; recovery applies to reclaimed claims, not terminal failures.
Logs contain ids and outcomes only.

### Repos come from Orca

Clone a repo and add its checkout in Orca before delegating. At each pickup the
Runner reads `orca repo list --json` and matches the issue's `[repo=owner/name]`
tag to `gitRemoteIdentity.canonicalKey` (`github.com/owner/name`, ignoring case).
It uses that registration's absolute checkout path. There is no separate repo
allowlist or Runner restart when registering another repo.

Every registered GitHub repo is eligible for delegation by an allowed creator,
including personal repos. Folder projects and repos without a matching GitHub
identity are not eligible. No match, multiple matches, or an unreadable repo list
refuses the job before creating a worktree. Keep one Orca registration per GitHub
repo; the Runner never picks arbitrarily between checkouts or clones from issue text.
After correcting a registration, delegate again to retry a failed job.

### Install and control the Runner

On macOS, the menu bar app can be installed before the Runner. To install just the
app, run:

```sh
sh packages/delegator/runner/launchd/install.sh --app-only
```

Open **Factory Runner** in the menu bar. Choose **Install Runner** after configuring
`~/.config/factory-delegator/config.json`; the app checks that the config has mode
`600`, and that `node` and `orca` are available in the login shell. The Runner and
menu bar app run as separate per-user LaunchAgents. The Runner starts at login and
restarts if it exits; the app's **Start at login** toggle controls its own agent.
Runner logs are in `~/Library/Logs/factory-delegator/`.

The menu shows **Runner ready** when it can accept work, **Working on …** while it
handles a job, **Waiting for a PR** while it watches a completed session, **Paused**
when new work is paused, **Can't reach Cloud Inbox** when its last request failed,
and **Last job failed** after a failed job. **Runner stopped** means its LaunchAgent
is not loaded and its status file is missing or stale. The menu can pause pickups,
open the logs or config, start or stop the Runner, and install or remove its agent.

The same operations remain available from the CLI. With `node` and `orca` on your
shell's `PATH`, use the default command to install both the app and Runner, or use
the Runner-specific commands:

```sh
sh packages/delegator/runner/launchd/install.sh
sh packages/delegator/runner/launchd/install.sh --install-runner
sh packages/delegator/runner/launchd/install.sh --uninstall-runner
```

Add `--uninstall` to remove both the app and Runner. The Runner installer requires
the config to have mode `600`. Both installation paths run the copy bundled in
`~/Applications/Factory Runner.app`; `--install-runner` requires the app to be installed first.
The default command builds the app before updating the Runner LaunchAgent.

After launch, the Runner checks for completion every 45 seconds, independently of
new job pickup. Cloud Inbox checks attached PRs against GitHub metadata and accepts
only a PR whose base repository, head repository and exact head branch match the
recorded launch. Attachment order does not establish ownership; an already-existing
matching PR is valid for resumed work. The Runner adds the verified PR link to the
agent session and posts "Opened <PR URL>." This final response
ends Linear's "Working…" state; it does not mark the issue Done or merge the PR.
If there is no PR after 24 hours, it replies "No PR after 24 h; check the Orca worktree."
Completed, errored and stopped sessions are dropped without another reply.

Open watches are saved in `${XDG_STATE_HOME:-~/.local/state}/factory/watching.json`
with owner-only permissions and atomic replacement. Keep this file private: it holds
claim authority, not Linear credentials. The Runner also recovers this machine's
still-open launched jobs and their repository/branch evidence from Cloud Inbox.
Legacy launches without that evidence remain watched but cannot report PR success.
Network failures are retried; an accepted final response is
not queued twice. Deploy Cloud Inbox before upgrading the Runner so its recovery
endpoint is available. PR detection requires Linear's GitHub integration to attach
the PR to the issue. Cloud Inbox rechecks ownership before linking and accepting an
"Opened" response. Missing or failed metadata never establishes ownership; the
existing 24-hour timeout and terminal-session handling still apply.

GitHub metadata reads currently use the unauthenticated public REST API, with no
GitHub CLI fallback. Private PRs, rate limits and API outages leave watches retryable
until the timeout. Deploy Cloud Inbox first, then upgrade the Runner to record launch
evidence; old launches are never backfilled from the issue's current branch.

The menu bar app's contract is `status.json` beside `watching.json`, in
`${XDG_STATE_HOME:-~/.local/state}/factory/` (a relative `XDG_STATE_HOME` is ignored).
The Runner replaces it atomically with mode `600` at startup, on each poll, after
claim attempts, while handling a job, and after each job, recovery or watch check.
An independent 10-second heartbeat keeps status fresh during pending operations;
the menu discards status older than 30 seconds when the Runner stops.
Status is disposable: a failed write logs `status-write-failed` once per process,
keeps the Runner running, and is retried on the next update.

| Field | Meaning |
| --- | --- |
| `version` | `1`; readers should check this before interpreting the file. |
| `updatedAt`, `pid` | ISO timestamp of this snapshot and the Runner process ID; readers can detect a stopped or stale Runner. |
| `inbox` | `{status: "ok" \| "unreachable", lastOkAt}`; last request result and last successful HTTP contact's ISO time, or `null` before contact. Startup is `unreachable` until contact succeeds. |
| `paused` | Whether the `paused` flag file exists. |
| `current` | `{identifier, sessionId}` while handling a job, otherwise `null`. |
| `watching` | Open watches as `{identifier, since}`, with an ISO launch time. |
| `lastError` | Last failed job or claim as `{identifier, outcome, time}`, otherwise `null`; claims have a `null` identifier. |
| `recent` | Last ten job outcomes as `{identifier, outcome, time}`, oldest first. |

Identifiers are validated issue identifiers such as `ABC-123` when known, falling
back to the issue ID before task lookup or for recovered launches without a saved
identifier (`unknown` for an invalid ID). Status contains no URLs, credentials,
claim authority, issue text or paths. History and the last error reset on restart;
open watches recover independently. A successful job does not clear the last error.

Create an empty `paused` file in that directory to pause new claims; remove it to
resume on the next poll. In-flight work continues, as do watch recovery and PR
checks. Pausing leaves jobs queued in Cloud Inbox. The menu bar app reads status
and toggles this flag; it needs no Cloud Inbox access.

## Security

Cloud Inbox is the middleman between Linear and your machines. It requests
`read,write,app:assignable`, checks the granted permissions at installation and refresh,
and never returns Linear tokens to machines, whose credential authorizes only Cloud Inbox's
named operations on that machine's own claimed jobs: reading the task, posting status
updates, and the launch and failure write-backs.

Linear requires `write` to post agent activities, and `write` also allows issue edits.
So a compromised Cloud Inbox can read and edit workspace data and tamper with queue delivery.
Per-machine storage does not isolate machines from a compromised Worker. Machines must
treat Cloud Inbox messages and job ids as untrusted inputs.

**Existing installations:** add `clientSecret` to the machine's `MACHINES` entry, upload
it, then reinstall. Tokens with a different grant are refused until then, but deploying
new code does not revoke them at Linear, so revoke the old authorization there. Preserve
machine keys and queued jobs.

You own the deployment, credentials and usage charges. Traffic/storage limits,
recovery drills and safe automatic launches remain separate work.

For the API, queue behavior, issue parser and full trust model, see the
[technical reference](cloud-inbox/README.md). The issue format is defined in
[the issue-format contract](../../docs/issue-format.md).
