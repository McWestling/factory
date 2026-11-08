# Delegator

Delegate an issue from Linear. Factory Cloud Inbox holds it until the Factory Runner
on your machine picks it up and starts a coding agent in Orca. Each machine has its
own Linear agent integration, so the agent you delegate to decides the machine.

## Where it runs

- **Cloud Inbox:** you deploy this application to your Cloudflare account. It
  receives tasks from Linear and holds them while your computer is busy or asleep.
  Cloudflare also runs its storage and message retries; no database server to manage.
- **Runner:** a background process on your machine that will pick up tasks from
  Cloud Inbox and start them in Orca. It is not implemented yet; its code will live
  in `packages/delegator/runner/`.

Cloud Inbox is available for controlled testing, and has answered a real delegation
and stop on Cloudflare. It cannot launch Orca by itself.
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

You need a Cloudflare account with Workers and SQLite-backed Durable Objects,
and a Linear workspace admin who can create and install OAuth apps.
Run these commands from `packages/delegator` after testing above.

1. **Deploy to Cloudflare:**

   ```sh
   npx wrangler login
   npx wrangler deploy
   ```

   Save the HTTPS address printed by Wrangler. Below, `<cloud-inbox-origin>` means that
   address followed by `/delegator`, with no trailing slash. Every Cloud Inbox route lives
   under `/delegator`. To serve it from your own domain on Cloudflare, also pass
   `--x-route-zones --route '<hostname>/delegator/*' --zone <zone>`; the hostname needs
   a proxied DNS record, and the Worker's `workers.dev` address turns off. Until secrets
   are set, requests return 503.

2. **Create a Linear app for your computer.** Follow Linear's
   [agent setup guide](https://linear.app/developers/agents). Choose a stable machine
   key such as `example-machine`: lowercase letters, digits and hyphens, starting
   with a letter or digit, at most 63 characters. Set:

   - OAuth callback: `<cloud-inbox-origin>/callback/example-machine`
   - Webhook URL: `<cloud-inbox-origin>/webhook`
   - Webhook category: **Agent session events**
   - Webhook delivery status: **Enabled** (a new app can have it off, and then
     delegations get no reply)

   Keep the app private to your workspace and enable only the authorization-code
   grant. Save its client ID, client secret and webhook signing secret. Delegator
   doesn't need a personal API key.

   Linear supports [prefilled app creation](https://linear.app/developers/oauth-app-manifests)
   with `distribution=private`, `oauth.redirect_uris`, `webhook.url` and
   `webhook.resourceTypes=AgentSessionEvent`. The guided setup follow-up will
   generate that page from your Cloud Inbox address and machine key.

3. **Set production secrets** using Wrangler's interactive prompts:

   ```sh
   npx wrangler secret put LINEAR_ORG_ID
   npx wrangler secret put ADMIN_SECRET
   npx wrangler secret put MACHINES
   ```

   `LINEAR_ORG_ID` is your workspace's organization UUID, obtainable from your
   Linear admin or a Linear MCP connection. For `ADMIN_SECRET` and each machine's
   `bearerSecret`, generate separate random values with `openssl rand -hex 32`.
   `MACHINES` is a JSON object:

   ```json
   {"example-machine":{"clientId":"replace-me","clientSecret":"replace-me","webhookSecret":"replace-me","bearerSecret":"replace-with-random-secret"}}
   ```

   Keep real values in your secret manager. `.dev.vars.example` shows the local
   format; `.dev.vars` is not uploaded by deploy. Each `secret put` takes effect
   immediately ([Cloudflare secrets guide](https://developers.cloudflare.com/workers/configuration/secrets/)).

4. **Install into Linear.** Open `<cloud-inbox-origin>/install/example-machine` as a
   workspace admin, enter `ADMIN_SECRET` as the HTTP Basic password (username is
   ignored), and approve in Linear. This is required even for the first install.
   Expect `Installed example-machine.` Tokens stay inside Cloud Inbox; OAuth uses
   `read,write,app:assignable`, S256 PKCE and the client secret for installation and
   automatic refresh.

5. **Check it.** Run `npx wrangler tail`. Delegate a disposable issue to the app;
   expect a "Queued on ..." reply. Stop the session; expect the stopped reply.
   Stopping in Linear does not stop an agent already running in Orca.

   A real delegation and stop got these replies from a deployed Cloud Inbox. The Runner API's
   full claim flow has only run on the local runtime, as the Runner doesn't exist yet.

## Operate it

- **Update:** test, dry-run, then `npx wrangler deploy`. Stored jobs and tokens
  persist. Clients must send the `claimId` returned by a claim when reporting its
  outcome. Claims made before this field was added cannot report an outcome;
  they become available again after their existing ten-minute lease expires.
  See the [API reference](cloud-inbox/README.md) for request formats and migration behavior.
- **Add a computer:** repeat app registration, add its entry to the complete
  `MACHINES` JSON, upload that secret, then visit its install URL. Preserve existing
  entries and keys: renaming a key selects new, empty storage.
  Each machine needs its own client ID and bearer secret. Duplicates make
  Cloud Inbox return 503 until corrected, without deleting stored jobs or tokens.
- **Reinstall:** revisit the install URL; use `ADMIN_SECRET` as the HTTP Basic
  password when prompted (username is ignored).
- **Runner:** installation instructions will be added with its implementation.
  It will need Cloud Inbox address, its bearer secret and local repo/model settings,
  and no Linear credentials.

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
