# Delegator technical reference

For architecture and setup, see the [Delegator README](../README.md).
Paths below are relative to `packages/delegator`.

## Shared types and issue parser

`job.ts` exports `Job` (`issueId`, `sessionId`), `Claim` (a `Job` plus `claimId`) and
`JobState` (`queued`, `claimed`, `launched`, `failed`). Queue metadata belongs to the
queue, not the job payload.

`parse-issue.ts` exports `parseIssue(description, config?)`. It returns either
`{repo, model}` or a refusal `{field, expected}`. Test for `field` to distinguish
a refusal. It requires a fenced `factory-run` block with one nonempty model field;
a missing or malformed block refuses dispatch. The repo comes
from the required `[repo=owner/name]` tag, including Linear's escaped form.

Without config, the parser checks syntax only. The Runner must pass its config
to enforce the exact model name in `models` (a name-to-settings map) and repo
membership in `repos` (an allowlist). `target` and `reason` do not affect dispatch.

## Cloud Inbox

`cloud-inbox/worker.ts` is the Cloudflare Worker, configured in `wrangler.toml`. It holds
one SQLite-backed Durable Object per machine, addressed only by the machine's name.
It refuses every request until three secrets are set (`.dev.vars.example` shows
their shape): `LINEAR_ORG_ID`, `ADMIN_SECRET`, and `MACHINES`, a JSON object of
machine name to its Linear client id, client secret, webhook signing secret and
bearer secret. Adding a machine means updating `MACHINES`.
Each machine must have a distinct client id and bearer secret. Duplicate values
make Cloud Inbox return 503 until the configuration is corrected; stored jobs and
installations are preserved.

A `MACHINES` key is a stable storage identifier, not a display name: it selects the
machine's Durable Object. Renaming a key selects a new, empty Durable Object, and
the old installation stays in the old one, along with any jobs queued for it later.
Treat a rename as adding a new machine and installing it again.

Every route below lives under `/delegator`, so a hostname can be shared with other
Workers by routing `<hostname>/delegator/*` here. Paths are shown without that prefix.

- `GET /install/<machine>` redirects to Linear's authorize URL as the app, with
  `read,write,app:assignable`, S256 PKCE and a single-use state that expires in 10 minutes.
  Every install requires the admin secret as the HTTP Basic password. The PKCE
  verifier stays in storage until the callback. Linear also requires the client secret
  for app-actor tokens, so the exchange and every refresh send both.
- `GET /callback/<machine>` checks the state, exchanges the code, and stores the
  tokens and app user id only when the workspace is `LINEAR_ORG_ID` and the grant
  contains exactly the requested scopes. It stores them
  with the org id and the machine's client id, and only if no other install landed
  while it waited on Linear.

Owner-only operations use the same HTTP Basic password as install:

- `GET /status/<machine>` verifies the stored app identity and workspace against
  Linear and returns only `{connected: boolean}`; provider failure returns 502.
- `POST /disconnect/<machine>` blocks token use and new installs, drains any in-flight
  install/refresh, revokes access and refresh credentials, and verifies API 401 plus
  refresh `invalid_grant`. Only then are credentials removed and reconnect allowed.
  On failure, credentials stay blocked and saved for a retry; jobs/outbox are untouched.
  The response contains no tokens. A GET cannot disconnect.

The operator commands in `cloud-inbox/setup.ts` checkpoint deployment/configuration
separately from browser authorization. See the [command guide](../README.md).

Point each machine's Linear app webhook (Agent session events, delivery enabled) at
`POST /webhook`.
`cloud-inbox/routes.ts` handles it before the machine's queue sees anything: it answers 401
to a missing or malformed `Linear-Signature` without reading the body, answers 413 once
the body passes 1 MiB, counting as it reads whether or not `Content-Length` is sent,
then finds the machine by `oauthClientId`, verifies `Linear-Signature` over the raw
body, and requires
`webhookTimestamp` within 60 s and `organizationId` equal to `LINEAR_ORG_ID`. The queue
then requires `appUserId` to match the install. A `created` event queues the job,
deduped on the session id, and posts the queued `thought`; a newer delegation of the
same issue replaces its waiting job and posts "Replaced by a newer delegation." on the
old session. A `prompted` stop signal posts the stopped `response` and drops a job not
yet claimed; any other prompt gets a `thought` saying replies aren't read, once per
`agentActivity.id` (kept 30 days), so a redelivered prompt is ignored and a new prompt
in the same session gets its own thought. A prompt without that id gets 400. A stopped
or replaced session is remembered as ended for 30 days: a late `created` doesn't queue
it again, a reply gets no thought, a repeated stop gets no second final response, and
a claimed job of a stopped session isn't requeued when its lease expires. Expired
stopped claims are removed before their ended markers, including after more than
30 days offline. Webhooks only post activities; issue fields change only through
the Runner API's `launched` and `failed` write-backs below. The thought names the app as Linear
shows it, stored at install; installs from before that use the `MACHINES` key.

The webhook is answered once the queue change and the activities it needs are stored
together in the machine's outbox, without waiting on Linear. The Durable Object's
alarm then posts them, one request at a time with a 10 s timeout on each Linear call
(token refresh included). A failed post, or a failed token refresh, stays in the outbox
and is retried with backoff from 10 s up to an hour, surviving restarts; only a success
removes it, and the alarm drops and logs an activity still failing after 30 days,
even with no claims or new webhooks. Each session's activities go out in the order
they were written. Ending a session (replaced
or stopped) cancels its thoughts not yet posted, so a final response is never followed
by a queued thought. Claiming a job hands the session to the Runner and cancels its
queued thought, even mid-retry or mid-refresh, so it never lands after the job has
started; replies and final responses still go out. Every status update the Runner
posts is written after its claim, so it sits behind anything left in the session's
order, and a queued thought already in flight at claim is sent before it, as
delivery is one request at a time. So the queued thought never lands after an update. Delivery is at least once:
a post that Linear applies but whose answer is lost is sent again, and a queued
thought already sent when the claim lands may still appear.

The Runner API authenticates with `Authorization: Bearer <bearerSecret>`, and the
machine comes only from the secret that matched. A job's id is its session id.
Every operation below except claim and watch recovery takes `?claimId=<claimId>` (400 without it) and
answers 409 unless that claim holds the job: it's the job's current claim with an
unexpired lease, or the claim that launched it. Each machine's jobs live in its own
Durable Object, so another machine's job id is simply unknown. The issue and session
always come from the job; nothing in the request can name another one, and each
operation sends a fixed Linear query or mutation. A Linear failure on a read answers 502.

- `POST /jobs/claim` returns the oldest waiting job as `{issueId, sessionId, claimId}`
  (204 when none) and leases it for 10 minutes. `claimId` is new for every claim attempt.
  An expired lease goes back on the queue, unless a newer job for the same issue is
  waiting, which replaces it.
- `GET /jobs/watching` returns this machine's launched jobs as
  `[{issueId, sessionId, claimId, at}]`, excluding sessions already ended or superseded.
  `at` is the launch-report timestamp. This lets an upgraded Runner recover completion
  watches without creating worktrees again. The bearer secret selects the machine;
  no request parameter can select another machine or issue. Keep the response private.
- `POST /jobs/<id>/launched?claimId=<claimId>` and
  `POST /jobs/<id>/failed?claimId=<claimId>` record that claim's outcome: 204, 400 if
  `claimId` is missing, or 409 unless it's the job's current claim with an unexpired
  lease. So a Runner whose lease expired can't change the outcome of a later claim, and
  must report before its lease ends. A second report of the same claim also gets 409.
- A job claimed before `claimId` existed has no id, so it can't report an outcome: its
  report gets 400 or 409. It keeps its stored lease, then goes back on the queue like
  any expired lease, and its next claim gets an id. The column is added on the first
  request after deploying; queued jobs are untouched.
- `POST /jobs/<id>/launched` also queues the launch's field changes: the status
  becomes the team's first `started` status unless the issue is already started,
  completed or canceled; the `Orca` label (workspace or the issue's team) is added,
  replacing any other label in its group; and the session creator becomes the
  assignee. `POST /jobs/<id>/failed` queues clearing the delegate, only while it's
  still this app, so a refused job that was already undelegated keeps its new delegate.
  The launch's changes apply only while the delegate is still this app. Both go out
  through the outbox like activities, so they retry and keep the session's order:
  post a status update first, then report. The first `created` webhook of a newer
  delegation marks every older job of the issue as superseded, even when that session
  was stopped before the webhook arrived (it still isn't queued); a redelivered
  `created` marks nothing. A superseded job's write-backs
  are dropped, even if the newer job is later stopped or deleted. The mark is stored,
  so it survives restarts, and is kept while the job has a write-back pending. A newer
  delegation whose webhook hasn't arrived yet can't be told apart from the old one in
  Linear, so a retry in that gap still applies.
- `GET /jobs/<id>/task` returns what the Runner checks before launch:
  `{delegated, creatorId, identifier, description, branchName, statusType}`.
  `delegated` is whether the issue's delegate is still this app; `creatorId` is the
  session creator's user id, or null.
- `POST /jobs/<id>/updates` with `{"type": "thought"|"response"|"error", "body": "..."}`
  queues that activity on the job's session and answers 202. Other fields are
  ignored. The body must be 1–2000 characters (400 otherwise) and the request at
  most 16 KiB (413). A `response` or `error` ends the session, cancelling its thoughts
  not yet sent; once a session has ended, including by a stop, updates get 409.
- `GET /jobs/<id>/watch` returns `{sessionStatus, pullRequests}`: Linear's session
  status and the issue's attachment URLs that are GitHub pull requests
  (`https://github.com/<owner>/<repo>/pull/<n>`), oldest first.
- `POST /jobs/<id>/pull-request` adds the first of those to the session as the
  "Pull request" link, waiting on Linear, and returns `{url}`; 409 when the issue has
  none. It takes no input. The Runner then posts the "Opened" `response` itself.
- A failed job takes no further operations.
- There is no token-sharing endpoint; `GET /token` returns 404.

Launched and failed jobs, the dedupe records and the ended sessions are kept 30 days. `cloud-inbox/queue.ts`
holds the queue and outbox, on the Durable Object's SQLite storage.

`MachineAuth.getAccessToken()`, used only by Cloud Inbox's own posts, returns the cached access token and
is the only place it is refreshed. It refuses a token whose stored org id or client id
differs from the current config, or whose scopes are unverified or not exactly
Cloud Inbox's, until an admin reinstall. Refresh grants must also contain exactly
`read,write,app:assignable`. A refresh that finishes after a reinstall is discarded and fails, so it never returns the old
installation's token. `cloud-inbox/auth.ts`, `cloud-inbox/queue.ts` and `cloud-inbox/routes.ts`
hold this logic so `node:test` can run it, with `node:sqlite` standing in for the
Durable Object's SQL and synthetic webhook payloads in `cloud-inbox/fixtures/` (written from
Linear's documented schema, not captured); check the Worker bundle with `npx wrangler deploy --dry-run`.

### Trust model

Cloud Inbox is the middleman between Linear and the machines. It alone holds Linear
credentials: its `read,write,app:assignable` grant and the app's client secret.
Machines hold only a bearer secret, and there is no Runner API or Durable Object method
for lending a token. It rejects any other grant at installation and refresh, and refuses
stored tokens with other or missing scopes.

A live check showed Linear refuses both agent activities and issue edits without
`write`, so no narrower grant can acknowledge a task. The boundary is Cloud Inbox's code,
not Linear's permissions: a compromised Cloud Inbox can edit issues in the workspace.

A machine's bearer secret allows only the named operations above, on jobs its own
claims hold. It can't send GraphQL, pick an issue or session, or set a field outside an
operation; the most it can do is post activities on its own sessions and trigger its
jobs' documented write-backs. Logs carry ids, operations and outcomes, never task
content, activity bodies or tokens. Machines must treat Cloud Inbox messages, job ids
and task content as untrusted, not task instructions.
Per-machine Durable Objects isolate storage, not trust: a compromised Worker can reach all Cloud Inbox credentials, read and edit accessible workspace data and tamper
with jobs.

Installations made with a different grant are refused until an admin reinstalls them.
Refusing an old token locally does not revoke it at Linear, so revoke it there too.
Add `clientSecret` to the machine's `MACHINES` entry first, and preserve the machine key
to keep its queue. See the [setup guide](../README.md) for the remaining operational work.
