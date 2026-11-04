# Dispatch

Shared code for the relay and local daemon that carry Linear delegations to Orca.
This package starts with the job payload, queue states, and issue parser.

Use Node.js 26 LTS. From this directory:

```sh
npm ci --ignore-scripts
npm test
```

`npm test` typechecks the package and runs its TypeScript tests directly with
`node:test`, without a build step. Run `npm run typecheck` for the typecheck alone.
There are no runtime dependencies; development tools are pinned in the lockfile.

`job.ts` exports `Job` (`issueId`, `sessionId`) and `JobState` (`queued`, `claimed`,
`launched`, `failed`). Queue metadata belongs to the queue, not the job payload.

`parse-issue.ts` exports `parseIssue(description, config?)`. It returns either
`{repo, model}` or a refusal `{field, expected}`. Test for `field` to distinguish
a refusal. It requires a fenced `dispatch` block with one nonempty model field;
a missing or malformed block refuses dispatch. The repo comes
from the required `[repo=owner/name]` tag, including Linear's escaped form.

Without config, the parser checks syntax only. The daemon must pass its config
to enforce the exact model name in `models` (a name-to-settings map) and repo
membership in `repos` (an allowlist). `target` and `reason` do not affect dispatch.

## Relay

`relay/worker.ts` is the Cloudflare Worker, configured in `wrangler.toml`. It holds
one SQLite-backed Durable Object per machine, addressed only by the machine's name.
It refuses every request until three secrets are set (`.dev.vars.example` shows
their shape): `LINEAR_ORG_ID`, `ADMIN_SECRET`, and `MACHINES`, a JSON object of
machine name to its Linear client id and secret, webhook signing secret and bearer
secret. Adding a machine means updating `MACHINES`.

A `MACHINES` key is a stable storage identifier, not a display name: it selects the
machine's Durable Object. Renaming a key selects a new, empty Durable Object, and
the old installation stays in the old one, along with any jobs queued for it later.
Treat a rename as adding a new machine and installing it again.

- `GET /install/<machine>` redirects to Linear's authorize URL as the app, with
  `read,write,app:assignable` and a single-use state that expires in 10 minutes.
  Once the machine has a token, a reinstall asks for the admin secret as the
  HTTP Basic password.
- `GET /callback/<machine>` checks the state, exchanges the code, and stores the
  tokens and app user id only when the workspace is `LINEAR_ORG_ID`. It stores them
  with the org id and the machine's client id, and only if no other install landed
  while it waited on Linear.

The Durable Object's internal `getAccessToken()` returns the cached access token and
is the only place it is refreshed. It refuses a token whose stored org id or client id
differs from the current config, including tokens stored before those ids were, until
an admin reinstall. Rotating only the client secret keeps the install. A refresh that
finishes after a reinstall is discarded and fails, so it never returns the old
installation's token. `relay/auth.ts` holds this logic so `node:test`
can run it; check the Worker bundle with `npx wrangler deploy --dry-run`.

### Trust model

The relay is trusted to influence what work runs. It holds each machine's Linear
token with `read,write`, so a compromised relay can edit an issue, keep valid repo
and model fields and the delegation, and deliver a genuine issue and session id. The
daemon's checks at pickup (delegated to this app, creator allowlisted, repo and model
allowed) would all pass on the changed task. Those checks stop forged sessions and
out-of-policy work; they do not stop a relay that rewrites the task inside policy.

Per-machine Durable Objects separate storage, not trust: one Worker holds every
machine's secrets and tokens, so compromising it reaches every machine. This risk is
open, not eliminated. It needs an explicit security acceptance, or a separate
decision on a mitigation, before the daemon launches work.
