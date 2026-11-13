# Research: which webhook tells Cloud Inbox a PR merged? (DO-1640)

**Date:** 2026-11-13
**Ticket:** [DO-1640](https://linear.app/mcwestling/issue/DO-1640) on the [Automated closeout](https://linear.app/mcwestling/project/automated-closeout-c8289ee3e532) map
**Factory sources read:** `packages/delegator/cloud-inbox/{routes.ts,queue.ts,README.md}` at `636af49`

## Answer

- **Use Linear's `Attachment` data-change webhook on each machine's existing Cloud Inbox app.** Linear's GitHub integration keeps a PR attachment on the issue and updates its `metadata` with the PR's status. An `update` whose `data.sourceType` is `github`, whose `data.url` is the job's PR, and whose `data.metadata.status` changed to merged is the signal. The payload carries `issueId`, so Cloud Inbox can match it to a launched job without calling GitHub.
- **No new scopes and no per-repo setup.** `Attachment` is a resource type an OAuth app's webhook can subscribe to. It arrives at the same URL and is signed with the same secret. Private repos work, because Linear's GitHub integration already sees them. Someone running a fork needs nothing beyond the Linear GitHub integration, which the Runner's PR linking already relies on.
- **Don't use the issue's status.** Moving to Done on merge is a per-team setting. It fires only for *closing* links, waits for every linked PR, and can't be told apart from a person moving the issue by hand.
- **Keep GitHub webhooks as the fallback.** They're precise (`pull_request` `closed` with `merged: true`), but every fork owner has to set them up per repo or per org, or register their own GitHub App. They also need a new secret, and routing from repo to machine, which Cloud Inbox doesn't have today.
- **The route needs a change before the subscription is switched on.** Data-change payloads have no `oauthClientId`, and `handleWebhook` finds the machine by that field. Today it would answer 401, Linear would retry three times, and then [Linear may disable the webhook](https://linear.app/developers/webhooks), Agent session events included.

## Preconditions

1. **Linear's GitHub integration is connected for each repo the Runner launches into.** It's installed by a GitHub org owner, or by a repo admin for repo-level access ([Linear: GitHub](https://linear.app/docs/github-integration)). The PR must link to the issue, by branch name or a magic word. The Runner's branch from `gitBranchName` does this already.
2. **A workspace admin turns on `Attachment` in each machine app's webhook settings** (Settings → API → the app). There is one app per `MACHINES` entry, so each needs it.
3. **No new scopes and no re-authorization for scopes.** Data-change webhooks name no scope beyond the default `read`. The `admin` scope is only for creating webhooks through the API ([Linear: Webhooks](https://linear.app/developers/webhooks)). Cloud Inbox's exact-scope check (`read,write,app:assignable`) is unaffected.
4. **A live check, since the docs don't settle these:**
   - **Existing installs:** whether an existing installation starts receiving the new resource type. The docs say only that the webhook is created "each time a new organization authorizes the given application". If events don't arrive, disconnect and install again through `POST /disconnect/<machine>` then `GET /install/<machine>`. That takes an admin and the same scopes, and keeps the machine key.
   - **Merged value:** the exact `metadata.status` string for a merged PR. The schema says only "pull request status" ([schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql), `Attachment.metadata`). Capture a real payload for the fixtures instead of writing one from guesses.
   - **Team access:** whether events are filtered to the teams the app user can access.
5. **No plan requirement was found.** Linear's docs gate only the GitHub Enterprise Cloud and Server options (Enterprise plan). OAuth apps, webhooks and the GitHub.com integration name no plan.
6. **Ship the route change first** (below), then turn on the resource type.
7. **A backstop for missed deliveries.** Linear retries only 3 times (after 1 minute, 1 hour and 6 hours), then may disable the webhook. One delivery lost for good means a closeout never runs, unless something reconciles. The Runner's existing `watch` poll, run rarely, would do.

## What Cloud Inbox does today

From `routes.ts` `handleWebhook`, in this order:

1. 401 without a 64-hex `Linear-Signature`, before reading the body. 413 past 1 MiB.
2. Finds the machine by `payload.oauthClientId`, or answers 401 `unknown-client`.
3. Checks the HMAC-SHA256 of the raw body with that machine's `webhookSecret`. `webhookTimestamp` must be within 60 s, and `organizationId` must equal `LINEAR_ORG_ID`.
4. Accepts only `type: AgentSessionEvent` with action `created` or `prompted`. Any other event gets 200 `ignored`.

`queue.ts` `watch` already reads the issue's GitHub PR attachment URLs from Linear. It confirms the PR belongs to the launch through GitHub's unauthenticated REST API (`head.ref` against the launch branch). That check can't see private repos.

### Change needed for Attachment events

- **Machine lookup:** when `oauthClientId` is absent, try each machine's `webhookSecret` and take the one whose HMAC matches. `EntityWebhookPayload` has `organizationId`, `webhookId` and `webhookTimestamp`, but no `oauthClientId` ([schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql)). With N machines, Linear sends each event N times, once per app and each signed with that app's secret. Each copy lands in its own machine's Durable Object, which acts only if it launched that issue.
- **Event filter:** keep the signature, timestamp and org checks. Then accept only `type: Attachment`, `action: update`, `data.sourceType: github`, a `data.issueId` that matches a launched job, and a `data.url` that matches that job's PR. The job must not be closed out already, which dedupes redeliveries and the N-app fan-out.
- **Merged test:** `data.metadata.status` is merged and `updatedFrom.metadata.status` wasn't. `updatedFrom` holds "the previous values of all updated properties".
- **Fixtures:** capture them live, as the `metadata` keys "depend on the integration".

## Linear in detail

| Question | Finding | Source |
| --- | --- | --- |
| Can an OAuth app's webhook subscribe to Issue and Attachment? | Yes. The supported `webhook.resourceTypes` include `AgentSessionEvent`, `Attachment` and `Issue`, among others | [OAuth app manifests](https://linear.app/developers/oauth-app-manifests) |
| How is it created? | "Each time a new organization authorizes the given application, a webhook will be created for that organization." Whether settings edits reach existing installs isn't stated | [Webhooks](https://linear.app/developers/webhooks) |
| Who can configure it? | "Only workspace admins, or OAuth applications with the `admin` scope, can create or read webhooks." App settings live under Settings → API, an admin page | [Webhooks](https://linear.app/developers/webhooks), [API and Webhooks](https://linear.app/docs/api-and-webhooks) |
| Scopes | Default `read` is always present. No scope is named for receiving data-change events. Adding scopes would need `update_scopes_on_existing_token=true`, which isn't needed here | [OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication), [OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization) |
| Payload | `action` (`create`, `update` or `remove`), `type`, `actor` (User, OAuth client or Integration), `data`, `updatedFrom`, `url`, `createdAt`, `organizationId`, `webhookId`, `webhookTimestamp`. Headers: `Linear-Delivery`, `Linear-Event`, `Linear-Signature`, `Linear-Timestamp` | [Webhooks](https://linear.app/developers/webhooks) |
| Attachment `data` | `id`, `issueId`, `url`, `title`, `subtitle`, `metadata`, `source`, `sourceType`, `creatorId`, `externalUserCreatorId`, `groupBySource` and timestamps | `AttachmentWebhookPayload` in the [schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql) |
| Attachment `metadata` | "Details supplied by the source, such as ticket messages, named attributes, or pull request status. The available keys depend on the integration." A third party reports `status`, `draft`, `hasConflicts`, `reviews` and `reviewers` on GitHub PR attachments; secondary source, unverified here | `Attachment.metadata` in the schema; [civitaspo/herdr-linear-agent#57](https://github.com/civitaspo/herdr-linear-agent/pull/57) |
| Issue `data` | Includes `state {id, name, type, color}`, `stateId`, `completedAt` and `identifier`. A merge shows as a `stateId` change in `updatedFrom` | `IssueWebhookPayload` in the schema |
| Signature | Hex HMAC-SHA256 of the raw body in `Linear-Signature`. Check `webhookTimestamp` is within a minute. Cloud Inbox does this already | [Webhooks](https://linear.app/developers/webhooks) |
| Retries | No 200 within 5 s means retries after 1 minute, 1 hour and 6 hours. Then "the webhook might be disabled by Linear, and must be re-enabled again manually" | [Webhooks](https://linear.app/developers/webhooks) |
| Agent session events | Only `created` and `prompted`. Adding a PR to the session's `externalUrls` "will unlock additional features related to pull requests in the future". No merge event today | [Agent interaction](https://linear.app/developers/agent-interaction) |

### Why the issue's status is the weaker signal

From [Linear: GitHub](https://linear.app/docs/github-integration):

- **Per-team setting:** the merge automation is configured per team ("Since this is a team setting, it must be configured for each team"). The default is Done on merge, and branch-specific rules can send it elsewhere. Linear's [Releases](https://linear.app/docs/releases) page even suggests a *started* "Merged" status, with a release marking the issue Done.
- **Closing links only:** a *non-closing* magic word "will not apply the *On PR or commit merge* status". Auto-matched PRs use a contributing link, so they don't move the issue either.
- **Waits for every PR:** with several linked PRs, "you'll need [to] merge both PRs before the Linear issue status will change".
- **Can't be told apart:** a person moving the issue to Done looks the same. You'd have to check `actor.type`, which is the Integration actor `{id, service, type}` for automation.

The PR attachment changes on every merge, whatever the team's settings or the link type.

## GitHub in detail

| Question | Finding | Source |
| --- | --- | --- |
| Event | `pull_request`, action `closed`: "If merged is true in the webhook payload, the pull request was merged." Available to repository, organization and app webhooks. An App needs "Pull requests" read permission | [Webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request) |
| Repo webhook | A repo admin creates it, on every repo. At most 20 webhooks per event per repo | [Types of webhooks](https://docs.github.com/en/webhooks/types-of-webhooks) |
| Org webhook | Org owners only. Covers every repo in the org. "You cannot create webhooks for individual user accounts", so personal-account repos need one webhook each | [Types of webhooks](https://docs.github.com/en/webhooks/types-of-webhooks) |
| GitHub App | One webhook per app, with events chosen on the app. Install it on the repos or the org. A fork owner registers their own App and keeps its secret and private key | [Types of webhooks](https://docs.github.com/en/webhooks/types-of-webhooks) |
| Signature | `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the body>`, compared in constant time. `X-Hub-Signature` (SHA-1) is legacy. There's no signed timestamp, so dedupe on `X-GitHub-Delivery` instead of a time window | [Validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) |
| Private repos | Delivery doesn't depend on visibility; the webhook lives on the repo, org or App installation. Cloud Inbox's unauthenticated REST check still can't read private PRs | — |

What it would take in Cloud Inbox:

- **New route and secret:** a new route such as `POST /github`, and a new Worker secret per webhook or App.
- **Machine routing:** GitHub's payload names no machine. Cloud Inbox would ask every machine's Durable Object, or keep an index from repo and PR to machine.
- **Fork setup:** someone running a fork adds a webhook to every repo, or creates an App, and stores its secret. That's the per-repo adoption step the Linear route avoids.

## If the live check fails

- **Events don't reach the existing install:** reinstall once per machine. That costs an admin a browser authorization, with no scope change.
- **Attachment events don't fire on merge, or the status value is unusable:** fall back to `Issue` updates where `state.type` becomes `completed`, `actor.type` is the integration, and the job's PR is among the issue's attachments. Document the closing-link and team-setting limits.
- **Neither works:** use GitHub webhooks, accepting the per-repo setup.
