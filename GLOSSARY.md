# Factory

The toolkit: the workflow skills, contracts and configs that every factory repo shares, plus Delegator and Verifier.

## Delegator

**Claim id**:
The identifier Cloud Inbox issues with each claim attempt; the Runner must send it to record that attempt's outcome, so an expired or superseded claim can't change the job.
_Avoid_: lease id, job id

**Cloud Inbox**:
Delegator's always-on hosted service, a Cloudflare Worker: it installs the one `Delegator` Linear app, alone holds Linear credentials, takes Linear's webhooks and keeps one shared queue that any machine's Runner can claim from.
_Avoid_: relay, proxy, server

**Delegated run**:
An agent session the Runner launched, with nobody watching it. Its prompt says so on a second line, and `do-implement` then makes default calls instead of stopping to ask, listing them under **Questions along the way**.
_Avoid_: unattended run

**Delegator**:
The system that starts work on a machine from a Linear delegation: Cloud Inbox, the Runner, and the code they share. Formerly Dispatch. The generic verb "dispatch" and the Dispatch target labels are separate and keep their names.
_Avoid_: Dispatch, Factory Dispatch

**Job**:
The `{issueId, sessionId}` payload Cloud Inbox queues for whichever machine's Runner claims it first; the Runner reads the issue through Cloud Inbox at pickup.
_Avoid_: task, dispatch payload

**Job state**:
One of `queued`, `claimed`, `launched`, or `failed`, tracked by the queue separately from the job payload.
_Avoid_: job status

**Lease**:
The 10 minutes a claimed job stays with the Runner that claimed it; when it expires, the job goes back on the queue.
_Avoid_: lock, timeout

**Machine**:
The computer that runs jobs, named by its key in Cloud Inbox's `MACHINES` secret, which maps it to its own bearer secret. Every machine shares the one `Delegator` app and queue. Its Runner is the process on it.
_Avoid_: host

**Runner**:
The local process on a machine that claims jobs from Cloud Inbox through its restricted machine-facing API and launches them in Orca. It holds no Linear credentials. Lives in `packages/delegator/runner/`.
_Avoid_: daemon, local client

## Verifier

**Verifier**:
Factory's capability for running the checks a repo declares. It is separate from Delegator. Its canonical source is `packages/verifier`; the setup skill carries a generated delivery copy in `verifier/`. Formerly Verify.
_Avoid_: Verify, Factory Verify, Delegator checks

**Verifier contract**:
A repo's `.factory/verifier.toml`: the one file that declares every check the repo runs.
_Avoid_: verification policy, CI config

**Check**:
A named command that passes or fails, plus the trigger paths that select it. Its name is also its status-check name.
_Avoid_: step, job, gate

**Trigger paths**:
The globs, relative to the repo root, whose change selects a check. They may point into any app in the repo.
_Avoid_: path filters, watch paths

## Setup

**Home repo**:
The repo that holds your tracker doc and where planning sessions run; every other repo's `AGENTS.md` points to it. For McWestling it is this repo; someone building their own uses their fork.
_Avoid_: hub repo, main repo

**Factory-run block**:
The fenced `factory-run` block in an implementation issue's **Next** section. It names the planned target, exact Preferred models name and human-readable reason; see [`docs/issue-format.md`](docs/issue-format.md).

**Machine setup**:
`npm run setup` from a checkout of the home repo. It installs or refreshes the Factory and supporting skills for the chosen agents, updates an existing Runner, and verifies each agent can reach Linear and discover the skills. `do-repo-setup` sets up a repo; machine setup sets up a computer.
_Avoid_: upkeep

**Machine check**:
The check `do-repo-setup` runs first on the computer it's on: it stops if `gh` isn't signed in, and mentions a missing Orca when it finishes.
_Avoid_: preflight, which is Factory Verifier's term

**Adding a repo block**:
The first `toml` code block under an exact `## Adding a repo` heading on a service page linked from a workspace's Tool Stack document. It lists the commands and maintainer steps that set a repo up for that service; `do-repo-setup` runs it through `adopt.py`. Format: `skills/do-repo-setup/adding-a-repo.example.toml`.
_Avoid_: setup script, onboarding steps
