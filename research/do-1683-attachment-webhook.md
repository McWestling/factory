# Merged-PR Attachment webhook, captured live (2026-11-17)

Captured from Cloud Inbox with a temporary log line while a throwaway PR was opened, readied and merged. Ids, names and repos are replaced with placeholders. Payloads: [do-1683-attachment-payloads.json](do-1683-attachment-payloads.json).

## Findings

- **No reinstall.** The existing install began receiving `Attachment` events as soon as the event type was ticked in the app's webhook settings.
- **A merge is one `update`.** `action` is `update`, `data.metadata.status` is `merged`, `data.metadata.mergedAt` is set, and `updatedFrom.metadata` holds the whole previous metadata object (`status: "open"`). Opening the PR was a `create` with `status: "draft"`; readying it was an `update` from `draft` to `open`.
- **Status values seen:** `draft`, `open`, `closed`, `merged`.
- **Useful fields:** `data.issueId` (the issue's UUID), `data.url`, and in `data.metadata`: `number`, `branch` (head branch name), `targetBranch`, `repoLogin`, `repoName`, `linkKind`, `mergedAt`. There is no head repo owner, matching DO-1644.
- **Every PR attachment change in the workspace arrives,** not only the Runner's: 9 events in about two minutes, 7 of them from an unrelated PR in another repo. Cloud Inbox must filter on the transition to `merged` and on its own launch evidence.
- **Repeats and churn.** The unrelated PR sent pairs of events per change (`linkKind` flipping between `closes` and `links`) and a `closed` → `open` flip, so matching must be idempotent.
- **Team access:** not testable here. The workspace has one team.
- `actor.type` is `integration` with `service: github`; there is no `oauthClientId`.
