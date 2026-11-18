# Cloud Inbox

Cloud Inbox is Delegator's hosted service: one Cloudflare Worker, one
SQLite-backed Durable Object, one Linear app installation and a shared job queue.
The [Delegator guide](../README.md) covers Runner setup, recovery and security.

## Deploy and connect

Use Node.js 26. You need a Cloudflare account with Workers and SQLite-backed
Durable Objects, plus a Linear workspace admin to create and authorize a private
app. From `packages/delegator`:

```sh
npm ci --ignore-scripts
npm run inbox -- login
npm run inbox -- setup
```

Setup asks for the account ID, Worker name, stable machine key and Linear workspace
UUID. It deploys to a `workers.dev` HTTPS address, generates owner and machine
secrets, and opens a prefilled app registration page. Keep Agent session event
webhooks enabled, and tick `Attachment` events too for [closeout jobs](#closeout-jobs). Enter the app credentials when asked; setup uploads the config.
It then opens a prefilled GitHub page for an optional [token](#secrets) that lets the
PR check read private repos.
Custom domains require manual configuration.

Back up `.cloud-inbox.local.json` in your secret manager. It and its generated
`.toml` are gitignored and owner-only. The checkpoint contains app credentials and
machine authority, but no Linear tokens. Rerun setup to resume; restore the original
checkpoint before operating an existing deployment. Setup refuses remote secrets
without it. Keep the Worker name and machine keys stable to preserve stored state
and claim access. Adding machines requires manual `MACHINES` configuration.

These commands require the deployed Cloud Inbox and its saved checkpoint:

```sh
npm run inbox -- connect
npm run inbox -- status
```

Approve `read,write,app:assignable` in the browser, then run status to verify the
workspace and app identity. The Runner receives a machine bearer secret, never
Linear tokens; there is no pairing flow.

## Operate and check

Also requiring the deployed Inbox and checkpoint: `npm run inbox -- update`
deploys code while preserving configuration, tokens and jobs;
`npm run inbox -- credentials` corrects the original app's credentials;
`npm run inbox -- github-token` sets or replaces the [GitHub token](#secrets);
`npm run inbox -- disconnect` blocks token use and verifies revocation at Linear;
`npm run inbox -- reconnect` starts browser approval again;
`npm run inbox -- viewer <name>` issues a read-only [viewer secret](#pool-status).
A failed disconnect leaves credentials blocked for retry. Jobs survive disconnection. These commands
do not remove Cloudflare resources or Linear app registrations.

Delegate a disposable issue to the app and check for its queued thought while the
Runner is off. Stop the session and check for its stopped response. With a configured
Runner on, delegate a valid issue and check that Orca starts it. Local checks and
bundle validation are in [Test locally](../README.md#test-locally); they need no deployment.

## Secrets

[`.dev.vars.example`](../.dev.vars.example) shows the shape. Setup uploads:

- `LINEAR_ORG_ID`: permitted workspace UUID.
- `ADMIN_SECRET`: owner password for HTTP Basic authentication (any username).
- `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`: one app.
- `MACHINES`: JSON map of machine key to unique bearer secret, at least 32 characters.
- `VIEWERS` (optional): JSON map of viewer name to the SHA-256 hex of its secret.

Invalid configuration returns 503 without deleting jobs or installation state.
Only Cloud Inbox stores and refreshes Linear access and refresh tokens.

`GITHUB_TOKEN` (optional) lets the PR check read pull requests in private repos;
without it only public repos' PRs are seen. Use a fine-grained token, not a classic
one, owned by the account or org that owns the repos, with **All repositories** and
**Pull requests: Read-only**, nothing else, so new repos need no change. The token
has no general **Contents** access, but it can read any source code that PR diffs and
patches show, across all of that owner's repos, plus repo metadata. One token covers
one owner. An org that requires approval returns 404 until it approves the token (an
org owner's token is approved automatically). An org that caps token lifetime makes
GitHub ask for an expiry; replace the token before it ends.

Setup asks for the owner and opens GitHub's token page with the name, owner, no
expiry and the permission filled in. GitHub can't preselect repository access, so
choose **All repositories** there, check that **Pull requests: Read-only** is still
listed, generate the token and paste it; setup reads it with hidden input and stores
it only as a Worker secret. An empty owner or token skips it. Replace it, for
example when it expires, with `npm run inbox -- github-token`, which reuses the saved
owner. Cloud Inbox sends it only to `api.github.com` and never logs or returns it.

## Routes

All routes are under `/delegator`. Owner routes require the Basic password;
Runner routes require `Authorization: Bearer <machine secret>`; `GET /pool` also
accepts a viewer secret.

| Method and path | Purpose |
| --- | --- |
| `GET /install` | Owner starts Linear OAuth with PKCE and single-use state. |
| `GET /callback` | Validates state, workspace and exact scopes; stores tokens. |
| `GET /status` | Owner verifies connection; returns `{connected: boolean}`. |
| `POST /disconnect` | Owner blocks and revokes tokens; preserves jobs. |
| `POST /webhook` | Receives signed Linear Agent session events and PR `Attachment` events. |
| `POST /jobs/claim` | Claims oldest eligible delegation for 10 minutes; `?kinds=closeout` claims a [closeout job](#closeout-jobs) instead, `?kinds=delegation,closeout` either; 204 when empty. |
| `GET /jobs/watching` | Recovers this machine's launched jobs. |
| `GET /jobs/<id>/task` | Reads issue and delegation details for the claim. |
| `POST /jobs/<id>/updates` | Queues a thought, response or error (1–2000 characters). |
| `POST /jobs/<id>/launched` or `/jobs/<id>/failed` | Records outcome and queues field writes. |
| `GET /jobs/<id>/watch` | Reads session, issue and verified PR status; a GitHub 401, 403 or 404 that isn't a rate limit posts "Can't read the PR; check the GitHub token." once. |
| `POST /jobs/<id>/pull-request` | Links a verified PR from this launch. |
| `PUT /pool/snapshot` | Stores this machine's latest `status.json` (JSON object, at most 64 KiB). |
| `GET /pool` | Lists every machine's latest snapshot, last-seen time and online state, plus queue depth. |

Per-job routes require `?claimId=<claimId>` and reject another machine's claim.
Expired leases return to the same machine only. Stop or delegate again if that
machine cannot return. Webhook activities and field writes retry through a durable
outbox; delivery is at least once. There is no token-sharing endpoint.

### Closeout jobs

When a PR the Runner launched merges, Cloud Inbox queues a closeout job for the
machine that launched it. It acts only on an `Attachment` update that moves a PR to
`merged`, and only when the issue's newest launch that no newer delegation replaced
recorded that PR's repo (case-insensitive) and head branch. A refine launch records
neither, so it never matches. Each launch queues one closeout at most, so replays and
`closed` → `open` → `merged` flips add nothing. Each `Attachment` event is logged as
`queued`, `no-match`, `duplicate` or `ignored`.

The outbox then creates a new agent session on the issue, beside the launch's thread,
and retries until Linear accepts it; only then is the job queued, with the session id
as its id and pinned to the launch's machine. A claim gets a closeout job only when it
asks with `?kinds=closeout`, so older Runners never see one. A new delegation of the
issue replaces a waiting closeout, and one that arrives first drops it. A merge whose
webhook never arrives, or that comes more than 30 days after its launch, gets no
closeout job; run `do-closeout` by hand.

### Pool status

Each Runner poll sends its `status.json` to `PUT /pool/snapshot`, plus once when a
job's issue is read. Cloud Inbox keeps only each machine's latest snapshot. A machine
is offline after 5 minutes unseen, so a long job can show offline until it ends.
`queueDepth` counts issues waiting to be claimed, expired leases included.

A Runner sends one report at a time and keeps only the newest waiting. Ordering is
best effort within one process: a report the Runner timed out on, or a second Runner
process for the same machine, can leave an older status until the next poll.

`npm run inbox -- viewer <name>` prints a viewer secret once and uploads only its
hash. A viewer secret reads `GET /pool` and gets 403 everywhere else; running the
command again for the same name replaces the secret.
