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
