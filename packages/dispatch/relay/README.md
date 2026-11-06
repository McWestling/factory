# Dispatch technical reference

For architecture and setup, see the [Dispatch README](../README.md).
Paths below are relative to `packages/dispatch`.

## Shared types and issue parser

`job.ts` exports `Job` (`issueId`, `sessionId`) and `JobState` (`queued`, `claimed`,
`launched`, `failed`). Queue metadata belongs to the queue, not the job payload.

`parse-issue.ts` exports `parseIssue(description, config?)`. It returns either
`{repo, model}` or a refusal `{field, expected}`. Test for `field` to distinguish
a refusal. It reads a fenced `dispatch` block first, falling back to the second
code span of the legacy `**Suggested dispatch:**` line only when no block exists.
A malformed block refuses dispatch even if a legacy line exists. The repo comes
from the required `[repo=owner/name]` tag, including Linear's escaped form.

Without config, the parser checks syntax only. The daemon must pass its config
to enforce the exact model name in `models` (a name-to-settings map) and repo
membership in `repos` (an allowlist). `target` and `reason` do not affect dispatch.

## Relay

`relay/worker.ts` is the Cloudflare Worker, configured in `wrangler.toml`. It holds
one SQLite-backed Durable Object per machine, addressed only by the machine's name.
It refuses every request until three secrets are set (`.dev.vars.example` shows
their shape): `LINEAR_ORG_ID`, `ADMIN_SECRET`, and `MACHINES`, a JSON object of
machine name to its Linear client id, client secret, webhook signing secret and
bearer secret. Adding a machine means updating `MACHINES`.

A `MACHINES` key is a stable storage identifier, not a display name: it selects the
machine's Durable Object. Renaming a key selects a new, empty Durable Object, and
the old installation stays in the old one, along with any jobs queued for it later.
Treat a rename as adding a new machine and installing it again.

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

Point each machine's Linear app webhook (Agent session events, delivery enabled) at
`POST /webhook`.
`relay/routes.ts` handles it before the machine's queue sees anything: it finds the
machine by `oauthClientId`, verifies `Linear-Signature` over the raw body, and requires
`webhookTimestamp` within 60 s and `organizationId` equal to `LINEAR_ORG_ID`. The queue
then requires `appUserId` to match the install. A `created` event queues the job,
deduped on the session id, and posts the queued `thought`; a newer delegation of the
same issue replaces its waiting job and posts "Replaced by a newer dispatch." on the
old session. A `prompted` stop signal posts the stopped `response` and drops a job not
yet claimed; any other prompt gets a `thought` saying replies aren't read. A stopped
or replaced session is remembered as ended for 30 days: a late `created` doesn't queue
it again, a reply gets no thought, and a claimed job of a stopped session isn't
requeued when its lease expires. The relay's code posts activities only and changes
no issue fields, though its grant would allow it. The thought names the app as Linear
shows it, stored at install; installs from before that use the `MACHINES` key.

The webhook is answered once the queue change and the activities it needs are stored
together in the machine's outbox, without waiting on Linear. The Durable Object's
alarm then posts them, one request at a time with a 10 s timeout on each Linear call
(token refresh included). A failed post, or a failed token refresh, stays in the outbox
and is retried with backoff from 10 s up to an hour, surviving restarts; only a success
removes it, and an activity still failing after 30 days is dropped and logged. Each
session's activities go out in the order they were written. Ending a session (replaced
or stopped) cancels its thoughts not yet posted, so a final response is never followed
by a queued thought. Claiming a job hands the session to the daemon and cancels its
queued thought, even mid-retry or mid-refresh, so it never lands after the job has
started; replies and final responses still go out. Delivery is at least once:
a post that Linear applies but whose answer is lost is sent again, and a queued
thought already sent when the claim lands may still appear.

The daemon API authenticates with `Authorization: Bearer <bearerSecret>`, and the
machine comes only from the secret that matched. A job's id is its session id.

- `POST /jobs/claim` returns the oldest waiting job as `{issueId, sessionId}` (204 when
  none) and leases it for 10 minutes. An expired lease goes back on the queue, unless
  a newer job for the same issue is waiting, which replaces it.
- `POST /jobs/<id>/launched` and `POST /jobs/<id>/failed` record a claimed job's
  outcome: 204, or 409 if it isn't claimed.
- There is no token-sharing endpoint; `GET /token` returns 404.

Launched and failed jobs, the dedupe records and the ended sessions are kept 30 days. `relay/queue.ts`
holds the queue and outbox, on the Durable Object's SQLite storage.

`MachineAuth.getAccessToken()`, used only by the relay's own posts, returns the cached access token and
is the only place it is refreshed. It refuses a token whose stored org id or client id
differs from the current config, or whose scopes are unverified or not exactly the
relay's, until an admin reinstall. Refresh grants must also contain exactly
`read,write,app:assignable`. A refresh that finishes after a reinstall is discarded and fails, so it never returns the old
installation's token. `relay/auth.ts`, `relay/queue.ts` and `relay/routes.ts`
hold this logic so `node:test` can run it, with `node:sqlite` standing in for the
Durable Object's SQL and synthetic webhook payloads in `relay/fixtures/` (written from
Linear's documented schema, not captured); check the Worker bundle with `npx wrangler deploy --dry-run`.

### Trust model

The relay is the middleman between Linear and the machines. It alone holds Linear
credentials: its `read,write,app:assignable` grant and the app's client secret.
Machines hold only a bearer secret, and there is no daemon API or Durable Object method
for lending a token. It rejects any other grant at installation and refresh, and refuses
stored tokens with other or missing scopes.

A live check showed Linear refuses both agent activities and issue edits without
`write`, so no narrower grant can acknowledge a task. The boundary is the relay's code,
not Linear's permissions: a compromised relay can edit issues in the workspace.

The relay API for machine status updates and task content isn't built yet. Machines
must treat relay messages and job ids as untrusted, not task instructions.
Per-machine Durable Objects isolate storage, not trust: a compromised Worker can reach all relay credentials, read and edit accessible workspace data and tamper
with jobs.

Installations made with a different grant are refused until an admin reinstalls them.
Refusing an old token locally does not revoke it at Linear, so revoke it there too.
Add `clientSecret` to the machine's `MACHINES` entry first, and preserve the machine key
to keep its queue. See the [setup guide](../README.md) for the remaining operational work.
