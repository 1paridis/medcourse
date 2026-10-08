export const PLATFORM_ORIGIN = 'https://yuancheng.henanyixue.com';

export type JobKind = 'login' | 'inspect' | 'playlist' | 'playback';
export type JobStatus = 'idle' | 'queued' | 'running' | 'waiting_user' | 'paused' | 'needs_attention' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type PlaybackState = 'unknown' | 'ready' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export interface Account {
  id: string;
  name: string;
  courseUrl: string;
  loginState: 'none' | 'saved';
  createdAt: string;
}

export interface PlaylistItem {
  chapterId: string;
  chapterTitle: string;
  position: number;
  durationText: string;
  platformStatus: string | null;
}

export interface PlaybackProgress {
  currentTime: number | null;
  duration: number | null;
  playbackState: PlaybackState;
  platformStatus: string | null;
  sampledAt: string | null;
}

export interface Job extends PlaybackProgress {
  id: string;
  accountId: string;
  kind: JobKind;
  status: JobStatus;
  url: string;
  detail: string;
  chapterId: string | null;
  chapterTitle: string | null;
  courseTitle: string | null;
  position: number | null;
  durationText: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobLog {
  id: number;
  jobId: string;
  level: 'info' | 'error';
  message: string;
  createdAt: string;
}

export interface Overview {
  accounts: Account[];
  jobs: Job[];
  maxConcurrency: number;
}

export type WorkerCommand =
  | { type: 'start'; job: Job; profileDir: string; channel: string }
  | { type: 'confirm' }
  | { type: 'pause' }
  | { type: 'stop' };

export type WorkerEvent =
  | { type: 'log'; level: 'info' | 'error'; message: string }
  | { type: 'waiting_user'; message: string }
  | { type: 'playlist'; courseUrl: string; courseTitle: string; items: PlaylistItem[] }
  | { type: 'progress'; progress: PlaybackProgress }
  | { type: 'done'; status: 'completed' | 'failed' | 'stopped' | 'paused' | 'needs_attention'; message: string; courseUrl?: string };

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'waiting_user'];
export const STARTABLE_JOB_STATUSES: readonly JobStatus[] = ['idle', 'paused', 'needs_attention', 'completed', 'failed', 'stopped', 'interrupted'];
