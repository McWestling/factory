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
machine name to its Linear client id and secret, webhook signing secret and bearer
secret. Adding a machine means updating `MACHINES`.

- `GET /install/<machine>` redirects to Linear's authorize URL as the app, with
  `read,write,app:assignable` and a single-use state that expires in 10 minutes.
  Once the machine has a token, a reinstall asks for the admin secret as the
  HTTP Basic password.
- `GET /callback/<machine>` checks the state, exchanges the code, and stores the
  tokens and app user id only when the workspace is `LINEAR_ORG_ID`.

The Durable Object's internal `getAccessToken()` returns the cached access token and
is the only place it is refreshed. `relay/auth.ts` holds this logic so `node:test`
can run it; check the Worker bundle with `npx wrangler deploy --dry-run`.
