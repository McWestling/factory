# Factory Verifier

Verifier selects and runs checks declared in `.factory/verifier.toml`. The core
requires Python 3.11+ and Git and uses only the Python standard library.

Edit `factory-verifier` and its tests here. The setup skill carries a generated
bundle at `skills/do-factory-setup/verifier/` so an installed skill
can deliver the executable and hosted workflow without a Factory checkout. Never
edit those generated copies.

From the Factory root:

```sh
node packages/verifier/bundle.ts
node packages/verifier/bundle.ts --check
node --test packages/verifier/bundle.test.ts
python3 packages/verifier/factory-verifier.test.py
actionlint packages/verifier/factory-verifier.yml
```

Regenerate and commit the bundle whenever the core or workflow changes. The consistency check
compares content and permissions; the Python suite tests delivery from an isolated
installed skill, including repeated copies and replacement of an old version.

The core supports `plan --base <sha> --head <sha>`, `plan --all`, `run <check>`
and `run --all`. With no command, it runs `preflight`: all checks except those with
`local = false`, regardless of trigger paths. Preflight installs the shared pre-push
hook and saves passing checks by tree SHA under the common Git directory, only
while the worktree is clean and HEAD is unchanged. Repeated runs reuse that proof.
Checks run one at a time on each machine, across every repo and worktree, so each check must fit the machine by itself.
Failures print a log path and its last 20 lines before continuing.

`install-hook` preserves foreign hooks. The hook requires proof for all local
checks in each pushed branch commit’s contract; tags and deletes are ignored.
`FACTORY_VERIFIER_OVERRIDE="<reason>" git push` logs and allows an unverified push;
agents need explicit user authorization to use it. Local proof does not test a
later merge result or replace hosted checks.

Full setup installation and autopilot are still planned. The future
installer copies from the installed skill's `verifier/` directory to the consuming
repo's `scripts/factory-verifier`, preserving executable permissions. The committed
copy remains the version pin; setup updates produce reviewable diffs.

## Hosted checks

The canonical `factory-verifier.yml` ships in the bundle for installation at
`.github/workflows/factory-verifier.yml` in a consuming repo. It expects
`scripts/factory-verifier` and that repo's `.factory/verifier.toml`. Installation
and ruleset configuration are separate work; this repo does not run the workflow.

PRs into main, including drafts, run triggered checks against GitHub's merge
commit. Pushes to main run every check. Each matrix job uses the check's name, and
the final `verifier` gate fails if planning or any check fails or is cancelled.
An empty plan passes. New PR runs cancel older runs for that PR; main runs never
cancel each other. Checks can use an optional repo-owned composite action at
`.github/actions/factory-verifier-setup` to install tools before running.


## Main-run reporting

`report --before <sha> --after <sha> --failed <name>[,<name>…]` files main
failures in Linear Triage. An empty or omitted failure list does nothing. A
failure selected by the push plan is broken (`Bug` plus the repo's Product
label); another failure is a miss (`Factory`). Missing or all-zero before SHAs
classify every failure as broken. Open marker matches get a comment; closed
matches stay closed and the newest is linked to a new issue.

The report job reads failed check runs for this workflow run with `checks: read`.
It needs `FACTORY_LINEAR_CLIENT_ID` and `FACTORY_LINEAR_CLIENT_SECRET` secrets,
and `FACTORY_VERIFIER_LINEAR_TEAM` and `FACTORY_VERIFIER_PRODUCT_LABEL` repo
variables. `FACTORY_VERIFIER_REPO` defaults to `GITHUB_REPOSITORY`. Outside GitHub,
set `GITHUB_RUN_URL` for the CI run link. Reporter errors fail only the report job.

The Linear app must have client-credentials tokens enabled. The reporter requests
`read,write` scopes because it reads team metadata and issues, creates issues and
comments, and creates related-issue links. It exchanges credentials at
`https://api.linear.app/oauth/token` once per report and uses the returned token
only in memory. Client-credentials tokens act as the app, last 30 days, and have
no refresh token; no separate `actor` parameter is required for this grant.
See [Linear's OAuth documentation](https://linear.app/developers/oauth-2-0-authentication#client-credentials-tokens).
Creating the app, installing this workflow, and setting secrets remain rollout work.
