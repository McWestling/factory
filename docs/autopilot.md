# Agent PR autopilot

Agents open their PRs as drafts. Autopilot watches those drafts on GitHub and,
once Factory Verifier's checks pass and the PR merges cleanly, marks the PR ready
for review so a person can merge it. If something fails, it keeps the PR a draft
and tells the agent, through the Linear ticket, what to fix.

## Turning it on

Nothing installs autopilot for you yet. The setup skill ships the two files in
`skills/do-factory-setup/verifier/`; copy them by hand.

1. Install [Factory Verifier](../packages/verifier/README.md) in the repo first.
   Autopilot waits on its `verifier` check.
2. Copy `autopilot.mjs` to `scripts/autopilot.mjs` and `autopilot.yml` to
   `.github/workflows/autopilot.yml`, then merge them into the default branch.
   GitHub only runs this kind of workflow from the copy on the default branch.
3. Optional: to get Linear comments, create a Linear OAuth app with client
   credentials enabled and add its ID and secret as the Actions secrets
   `FACTORY_LINEAR_CLIENT_ID` and `FACTORY_LINEAR_CLIENT_SECRET`. Without them,
   everything on the GitHub side still works.
4. Open draft PRs with the ticket ID at the end of the title, like
   `Fix the login redirect (ABC-123)`. If the title has none, autopilot takes it
   from the branch name.

## What happens

The `factory-autopilot` workflow runs when a PR changes (opened, pushed to,
reopened, edited, or labeled) and when any check, commit status or workflow
finishes. It finds the PRs on that commit and looks at each one, using the
script from the default branch so a PR can't change how it is judged.

It only acts on draft PRs from a branch in the same repo, into the default
branch. It waits for the `verifier` check to finish and for GitHub to say whether
the PR can merge. It reports its result as a commit status named `autopilot`:

| `autopilot` status | What it does |
| --- | --- |
| pending: `waiting on ...` | Nothing yet; it looks again on the next event |
| success: `ready to merge` | Marks the PR ready for review, adds the `ready-to-merge` label, comments on the Linear ticket |
| failure: `needs fix: ...` | Keeps the PR a draft and comments on the Linear ticket with links to the failing logs and the next steps: merge the latest main, fix, run `scripts/factory-verifier preflight`, push |
| success: `skipped: no ticket id` | Nothing; there is no ticket to report to |
| success: `skipped: no-autopilot` | Nothing; the PR has the `no-autopilot` label. Remove it to turn autopilot back on |

A new push to a PR removes any old `ready-to-merge` label.

## Limits

- It never merges. A person does.
- It does not check PRs again when main moves on, so a ready PR can fall behind.
- It only reads GitHub's results. It does not see the agent's local test runs;
  Factory Verifier's push hook covers those.
- Marking a PR ready doesn't start any workflows that run on `ready_for_review`.
  GitHub doesn't let one workflow's actions trigger others.
