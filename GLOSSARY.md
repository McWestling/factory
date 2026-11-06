# Factory

The toolkit: the workflow skills, contracts and configs that every factory repo shares, plus Delegator and Verify.

## Delegator

**Claim id**:
The identifier Cloud Inbox issues with each claim attempt; the Runner must send it to record that attempt's outcome, so an expired or superseded claim can't change the job.
_Avoid_: lease id, job id

**Cloud Inbox**:
Delegator's always-on hosted service, a Cloudflare Worker: it installs each machine's Linear app, alone holds Linear credentials, takes Linear's webhooks and queues jobs for each machine's Runner. Some deployed identifiers keep the old name; see its [technical reference](packages/delegator/cloud-inbox/README.md#legacy-operational-names).
_Avoid_: relay, proxy, server

**Delegator**:
The system that starts work on a machine from a Linear delegation: Cloud Inbox, the Runner, and the code they share. Formerly Dispatch. The generic verb "dispatch" and the Dispatch target labels are separate and keep their names.
_Avoid_: Dispatch, Factory Dispatch

**Job**:
The `{issueId, sessionId}` payload Cloud Inbox queues for a machine's Runner; the Runner reads the issue from Linear at pickup.
_Avoid_: task, dispatch payload

**Job state**:
One of `queued`, `claimed`, `launched`, or `failed`, tracked by the queue separately from the job payload.
_Avoid_: job status

**Lease**:
The 10 minutes a claimed job stays with the Runner that claimed it; when it expires, the job goes back on the queue.
_Avoid_: lock, timeout

**Machine**:
The computer that runs jobs, with its own Linear app and its own Durable Object in Cloud Inbox, named by its key in Cloud Inbox's `MACHINES` secret. Its Runner is the process on it.
_Avoid_: host

**Runner**:
The local process on a machine that claims jobs from Cloud Inbox through its restricted machine-facing API and launches them in Orca. It holds no Linear credentials. Planned, in `packages/delegator/runner/`.
_Avoid_: daemon, local client

## Verify

**Verify**:
Factory's capability for running the checks a repo declares. It is separate from Delegator.
_Avoid_: Delegator checks

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

**Machine check**:
The check `do-factory-setup` runs first on the computer it's on: it stops if `gh` isn't signed in, and mentions a missing Orca when it finishes.
_Avoid_: preflight, which is Factory Verify's term

**Adding a repo block**:
The first `toml` code block under an exact `## Adding a repo` heading on a service page linked from a workspace's Tool Stack document. It lists the commands and maintainer steps that set a repo up for that service; `do-factory-setup` runs it through `adopt.py`. Format: `skills/do-factory-setup/adding-a-repo.example.toml`.
_Avoid_: setup script, onboarding steps
