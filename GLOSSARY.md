# Factory

The workflow skills, contracts and configs that every factory repo shares.

## Dispatch

**Job**:
The `{issueId, sessionId}` payload the relay queues for a machine's daemon; the daemon reads the issue from Linear at pickup.
_Avoid_: task, dispatch payload

**Job state**:
One of `queued`, `claimed`, `launched`, or `failed`, tracked by the queue separately from the job payload.
_Avoid_: job status

**Lease**:
The 10 minutes a claimed job stays with the daemon that claimed it; when it expires, the job goes back on the queue.
_Avoid_: lock, timeout

**Machine**:
A computer that runs jobs, with its own Linear app and its own Durable Object in the relay, named by its key in the relay's `MACHINES` secret.
_Avoid_: host, runner

**Relay**:
The always-on Cloudflare Worker that installs each machine's Linear app, holds its token, takes Linear's webhooks and queues jobs for each machine's daemon.
_Avoid_: proxy, server

## Verify

**Verify contract**:
A repo's `.factory/verify.toml`: the one file that declares every check the repo runs.
_Avoid_: verification policy, CI config

**Check**:
A named command that passes or fails, plus the trigger paths that select it. Its name is also its status-check name.
_Avoid_: step, job, gate

**Trigger paths**:
The globs, relative to the repo root, whose change selects a check. They may point into any app in the repo.
_Avoid_: path filters, watch paths

## Setup

**Dispatch block**:
The fenced `dispatch` block in an implementation issue's **Next** section. It names the planned target, exact Preferred models name and human-readable reason; see [`docs/issue-format.md`](docs/issue-format.md).

**Adding a repo block**:
The first `toml` code block under an exact `## Adding a repo` heading on a service page linked from a workspace's Tool Stack document. It lists the commands and maintainer steps that set a repo up for that service; `do-factory-setup` runs it through `adopt.py`. Format: `skills/do-factory-setup/adding-a-repo.example.toml`.
_Avoid_: setup script, onboarding steps
