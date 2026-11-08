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
name, used in messages. Each `repos` path is a local checkout Orca knows, and each
`models` key is an exact Preferred models name.

```sh
npm run runner
```

Every 15 s it claims one job and checks it with what Cloud Inbox returns. Delegation
by a user on `allowedCreatorIds` is the approval to launch. It drops a job whose issue
is no longer delegated to the app, and refuses an unlisted or missing creator, an issue
that fails the [issue format](../../docs/issue-format.md), or a model or repo not in
its config. Otherwise it runs `orca open --json` and the documented
`orca worktree create`, retrying once if Orca's runtime is unavailable, then posts
"Started …" and reports `launched`; Cloud Inbox sets the status, `Orca` label and
assignee. Any failure posts one `error` and reports `failed`, which clears the delegate.
It never requeues. A launch is recorded in `launches.json` beside the config before
it's reported, so if the report is lost, Cloud Inbox hands the session back after its
10-minute lease and the Runner, even restarted, reports `launched` without starting Orca
again. A Runner killed while `orca worktree create` runs has no record, so the retry fails
on the existing worktree. It logs ids and outcomes only. Running it in the background and
watching for the PR are not built yet.

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
