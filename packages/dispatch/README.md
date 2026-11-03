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
