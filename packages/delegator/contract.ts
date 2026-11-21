// What the Runner and Cloud Inbox agree on. Both import it, so a change here reaches both sides.

import type { Claim, LaunchEvidence } from './job.ts';

/** Bump it when anything below changes on the wire. */
export const CONTRACT_VERSION = 1;

/** Linear agent session statuses: an ended session gets no more activities. */
export const ENDED_STATUSES: readonly string[] = ['complete', 'error', 'stopped'];
export const LIVE_STATUSES: readonly string[] = ['pending', 'active', 'awaitingInput', 'stale'];

/**
 * `delegation` jobs come from Linear's `created` event, or from its delegation notification when
 * no `created` comes with it; Cloud Inbox queues a `closeout` job itself when a launch's PR merges.
 */
export type JobKind = 'delegation' | 'closeout';
export const JOB_KINDS: readonly JobKind[] = ['delegation', 'closeout'];

/** A GitHub pull request URL, the only kind a watch reports or a link adds. */
export const PULL_REQUEST = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/;

export type Outcome = 'launched' | 'failed';
export type UpdateType = 'thought' | 'response' | 'error';

/** What the Runner checks before launch. */
export type Task = {
  /** Set only for a closeout job, with the launch it closes out and, when it has nothing to close, why. */
  kind?: 'closeout';
  launch?: LaunchEvidence;
  /**
   * `canceled`: the issue was canceled. `unreadable`: no attached PR is the launch's, merged, and
   * GitHub refused one for a token problem. `unverified`: no attached PR is the launch's, merged.
   */
  skip?: 'canceled' | 'unreadable' | 'unverified';
  delegated: boolean;
  creatorId: string | null;
  identifier: string;
  description: string;
  branchName: string;
  statusType: string;
  /** Label names; a `wayfinder:` one makes the launch a refine launch. */
  labels: string[];
};

/** A launch's completion state: its session, its issue's state, and the launch's own PRs. */
export type Watch = { sessionStatus: string; issueState?: string; pullRequests: string[] };

/** Each asked issue identifier's Linear state type, or `unknown` for one Linear doesn't know. */
export type IssueStates = Record<string, string>;

/** A launched job the Runner watches, as Cloud Inbox lists it for recovery. */
export type Watching = Claim & { at: number; launch?: LaunchEvidence };
