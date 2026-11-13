# Research: can Linear's PR attachment metadata prove a private-repo PR belongs to the launch? (DO-1644)

**Date:** 2026-11-13
**Ticket:** [DO-1644](https://linear.app/mcwestling/issue/DO-1644) on the [Automated closeout](https://linear.app/mcwestling/project/automated-closeout-c8289ee3e532) map
**Factory sources read:** `packages/delegator/cloud-inbox/queue.ts` (`watch`) at `04127a6`; [DO-1573](https://linear.app/mcwestling/issue/DO-1573) and its comments; `research/do-1640-merge-webhook.md` on `research/do-1640-merge-webhook`

## Answer

- **No. Linear's data can't enforce the full ownership rule.** The rule is: base repo and head repo equal the launch repo, and head branch equals the launch branch. No Linear source carries the head repo. The attachment `metadata` isn't known to carry the head branch either.
- **Keep [DO-1625](https://linear.app/mcwestling/issue/DO-1625)** (a GitHub token in Cloud Inbox). It's the only route that keeps the DO-1573 guarantee for private repos.
- **Don't drop the branch check to make Linear's data fit.** The DO-1573 bug was a contextual PR *in the same repo* (factory PR #59 on DO-1571). A repo-only check from the attachment URL would let that bug back in.

## What `watch` needs, and where each piece could come from

| Rule part | GitHub REST (today) | Attachment URL | Attachment `metadata` | Linear's internal `PullRequest` |
| --- | --- | --- | --- | --- |
| Base repo | `base.repo.full_name` | Yes, `owner/repo` in the path | Not reported | `fullIdentifier`, `url` |
| Head repo (rules out forks) | `head.repo.full_name` | No | Not reported | **No such field** |
| Head branch | `head.ref` | No | Not reported | `sourceBranch` |
| PR number | `number` | Yes, in the path | Not reported | `number` |
| Status | `state`, `merged` | No | `status` (`open`, `merged`) | `status`, `mergeStatus` |
| Works for private repos | Only with a token | Yes | Yes | Yes |
| Public, stable API | Yes | Yes | Keys undocumented | Removed from the public schema on 2026-11-11 |

## Question 1: which keys are in a GitHub PR attachment's `metadata`?

**Verified from primary sources:**

- **The schema promises nothing.** `Attachment.metadata` is a `JSONObject!`: "Details supplied by the source, such as ticket messages, named attributes, or pull request status. The available keys depend on the integration; treat missing keys as unavailable" ([schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql), `type Attachment`).
- **Linear's docs list no GitHub keys.** The [Attachments guide](https://linear.app/developers/attachments) documents only the rich-display keys an API caller can set (`title`, `messages`, `attributes`, date variables). It says nothing about the keys Linear's own GitHub integration writes.
- **`attachmentLinkGitHubPR` takes only a URL.** It "may fall back to a URL attachment" when no matching GitHub integration exists ([schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql), `Mutation.attachmentLinkGitHubPR`). A fallback attachment has none of the integration's keys.
- **Linear's open-source repos don't read these keys.** `linear/linear`, `linear-release`, `github-webhook-proxy` and `linear-solutions` have no code that reads a GitHub attachment's `metadata`. The one builder found, `linear-solutions/services/ado_repos/src/webhookAdo.ts`, writes its own shape for Azure DevOps (`branch`, `targetBranch`, `isDraft`, `pullRequestId` and more). It is a prototype that mirrors the GitHub integration's *linking*, not its metadata, so it's no evidence for GitHub keys.

**Reported by a third party, from a live read:**

- [civitaspo/herdr-linear-agent#57](https://github.com/civitaspo/herdr-linear-agent/pull/57) read real GitHub PR attachments through GraphQL. It reports `sourceType` `github`, `source` `{"type":"github","pullRequestId":...}`, and `metadata` with `status` (`open`, `merged`), `draft`, `hasConflicts`, `reviews`, `reviewers` and `reviewerDetails`, "but no checks". It lists no branch, repo or number key.
- [stian3555/PSLinear#14](https://github.com/stian3555/PSLinear/pull/14) uses `{ status = 'merged'; reviews = ... }` as its GitHub attachment fixture.

**Inferred, not verified:** there is no head-branch, head-repo, base-repo or PR-number key. The herdr list reads as a complete dump, and it has none of them. This repo has not read a live attachment's `metadata`; see [the live check](#question-5-the-live-check).

### Linear's internal `PullRequest` object

Linear keeps a second, richer record of each PR for its Reviews (Diffs) feature.

- **Read live, through the Linear MCP's `get_diff`, for `McWestling/piumosso#23` (private repo):** `number` 23, `fullIdentifier` `McWestling/piumosso#23`, `sourceBranch` (the launch branch), `targetBranch` `main`, `status` `merged`, `mergeStatus`, `headSha`, `baseSha` and `url`. So Linear does see the head branch of a private-repo PR.
- **It has no head repo.** The last public definition, in [`@linear/sdk@101.0.0`](https://raw.githubusercontent.com/linear/linear/@linear/sdk@101.0.0/packages/sdk/src/schema.graphql) (`type PullRequest`), has `sourceBranch` ("The source (head) branch"), `targetBranch`, `number`, `url`, `headSha` and `status`, and no repository or fork field. The SDK changelog never adds one.
- **It's no longer public.** [`@linear/sdk` 102.0.0](https://github.com/linear/linear/blob/master/packages/sdk/CHANGELOG.md), published 2026-11-11, removed `type PullRequest`, `AgentSession.pullRequest` and `AgentSession.pullRequests`. Cloud Inbox would be reading an undocumented API that changed two days ago.

## Question 2: GraphQL `Attachment.metadata` vs. the webhook's `data.metadata`

- **Same field, same type.** `Attachment.metadata` and `AttachmentWebhookPayload.metadata` are both `JSONObject!`. The webhook's is described as "Custom metadata related to the attachment" ([schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql)).
- **Inferred: the keys are the same.** The webhook payload serializes the stored attachment, field for field (`id`, `issueId`, `url`, `metadata`, `source`, `sourceType`, ...). Nothing documents a difference, and nothing confirms sameness. A captured webhook payload would settle it; DO-1640's fixtures will capture one anyway.

## Question 3: can metadata alone enforce the rule?

**No.** What's missing, part by part:

- **Base repo:** available from the attachment URL path, when `sourceType` is `github`.
- **Head branch:** not in the attachment `metadata`, as far as anyone has reported. It is in Linear's internal `PullRequest.sourceBranch`, but that API is no longer public.
- **Head repo:** in no Linear source.

**Would URL path plus a head-branch key be enough?** Almost. It checks base repo and head branch, but not head repo. The gap is a fork PR whose branch has the same name:

- **Public repos:** anyone can fork and push a branch named like the launch branch. The branch name carries the issue id, so Linear's GitHub integration links that PR to the issue automatically. The watch would report it as the job's PR. That's a false success that anyone on the internet can cause.
- **Private repos:** only people who can read the repo can fork it, and an org can turn private forking off. The risk drops to trusted members making a mistake.
- **Public repos don't need Linear's data anyway.** The unauthenticated REST check works there today, with the full rule.

**A second gap: metadata isn't authoritative.** `AttachmentCreateInput.metadata` lets any API caller set metadata on any URL: "If the same URL is already attached to issueId, that attachment is updated" and "this replaces its metadata" ([schema](https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql)). PSLinear#14 reports changing and clearing metadata on a GitHub link. Any workspace member or app with write access could plant a branch value. GitHub's own record can't be edited that way.

## Question 4: preconditions for the GitHub token (DO-1625)

- **Token type:** a fine-grained personal access token. Not a classic token: its `repo` scope grants write access to every private repo the user can reach.
- **Permission:** Repository permissions → **Pull requests: Read-only**. `GET /repos/{owner}/{repo}/pulls/{pull_number}` accepts either "Contents" read or "Pull requests" read ([permissions list](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)). Pull requests read is the narrower one; Contents read would expose code. GitHub adds Metadata read on its own.
- **Repositories:** "Only select repositories", listing the private repos Delegator launches into (today `McWestling/piumosso` and Opal's repo). Add each new private repo to the token when Delegator starts working in it, or its PRs return 404 again.
- **One owner per token:** "Each token is limited to access resources owned by a single user or organization" ([Managing PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)). DO-1625 stores one `GITHUB_TOKEN`, so it covers one owner. Repos under a second owner would need a second token and a change to DO-1625.
- **Expiry:** the form defaults to 30 days. An org's default maximum lifetime for fine-grained tokens is 366 days, and a "no expiration" token is blocked by that policy ([org PAT policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)). Pick up to 366 days and set a reminder. When it expires, GitHub answers 401, which DO-1625 already reports as "can't read the PR; check the GitHub token".
- **Org approval:** an org's default is "Require administrator approval" for fine-grained tokens that reach its resources. Tokens created by org owners are approved automatically. Until a member's token is approved it's `pending` and reads only public resources, so private PRs still answer 404 ([org PAT policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)). McWestling is an org: create the token as an owner, or have an owner approve it.
- **Plan:** no plan requirement was found in GitHub's docs for fine-grained tokens or their org policies.
- **Someone running a fork of Factory:** creates their own fine-grained token, with their org or user as resource owner, Pull requests read on their private repos. If their org requires approval and they aren't an owner, an owner approves it. Then they enter it in Cloud Inbox setup. With only public repos, they can skip the token.
- **Side benefit:** authenticated requests get 5,000 requests an hour instead of 60, so rate limits stop stalling the watch too.

## Question 5: the live check

The attachment `metadata` keys couldn't be read here. The Linear MCP's `get_issue` and `get_attachment` return `id`, `title`, `subtitle` and `url`, but not `metadata`, `source` or `sourceType`. No API key on this machine was looked for or used.

The answer above doesn't depend on this check. It can only confirm it. Even a branch key wouldn't add the head repo or make the metadata authoritative. Run it if someone wants the keys on record:

1. Open Linear's API explorer, signed in, or use a personal API key from your Linear account's security settings.
2. Run:

   ```graphql
   query {
     issue(id: "DO-1500") {
       attachments { nodes { url sourceType source metadata } }
     }
   }
   ```

   The PR attachment there is `https://github.com/McWestling/piumosso/pull/23`, a merged PR in a private repo.
3. Read the `metadata` keys. If they include both a head-repo key and a head-branch key, reopen this question. Otherwise nothing changes.

## Sources

- Linear GraphQL schema, current: <https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql>
- Linear GraphQL schema, `@linear/sdk@101.0.0`: <https://raw.githubusercontent.com/linear/linear/@linear/sdk@101.0.0/packages/sdk/src/schema.graphql>
- `@linear/sdk` changelog: <https://github.com/linear/linear/blob/master/packages/sdk/CHANGELOG.md>
- Linear attachments guide: <https://linear.app/developers/attachments>
- Linear MCP `get_diff` on `McWestling/piumosso#23`, read 2026-11-13
- civitaspo/herdr-linear-agent#57: <https://github.com/civitaspo/herdr-linear-agent/pull/57>
- stian3555/PSLinear#14: <https://github.com/stian3555/PSLinear/pull/14>
- linear/linear-solutions, `services/ado_repos`: <https://github.com/linear/linear-solutions/tree/main/services/ado_repos>
- GitHub, fine-grained token permissions: <https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens>
- GitHub, managing personal access tokens: <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>
- GitHub, org personal access token policy: <https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization>
