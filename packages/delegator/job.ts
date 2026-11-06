export type Job = {
  issueId: string;
  sessionId: string;
};

/** A job as handed to one claim attempt; `claimId` must accompany that attempt's outcome. */
export type Claim = Job & { claimId: string };

export type JobState = 'queued' | 'claimed' | 'launched' | 'failed';
