export type Job = {
  issueId: string;
  sessionId: string;
};

export type JobState = 'queued' | 'claimed' | 'launched' | 'failed';
