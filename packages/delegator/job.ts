export type Job = {
  issueId: string;
  sessionId: string;
};

/** A job as handed to one claim attempt; `claimId` must accompany that attempt's outcome. */
export type Claim = Job & { claimId: string };

export type JobState = 'queued' | 'claimed' | 'launched' | 'failed';

/** Repository identity and exact head branch used for the launch, never inferred on recovery. */
export type LaunchEvidence = { repo: string; branch: string };

export function isLaunchEvidence(value: unknown): value is LaunchEvidence {
  if (!value || typeof value !== 'object') return false;
  const { repo, branch } = value as Partial<LaunchEvidence>;
  return typeof repo === 'string' && repo.length <= 200 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    && typeof branch === 'string' && branch.length <= 200
    && /^[A-Za-z0-9][\w.-]*(\/[A-Za-z0-9][\w.-]*)*$/.test(branch) && !branch.includes('..');
}
