export const PLATFORM_ORIGIN = 'https://yuancheng.henanyixue.com';
export const VERIFICATION_RESTART_WINDOW_MS = 60_000;
export const VERIFICATION_RESTART_MAX_ATTEMPTS = 5;
export const VERIFICATION_RETRY_LIMIT_MESSAGE = '最近 1 分钟内已自动重启 5 次，已停止重试。请先暂停，再通过“人工登录”完成验证；登录状态自动记录，关闭窗口后点击“开始”。';

export type JobKind = 'login' | 'inspect' | 'playlist' | 'playback';
export type JobStatus = 'idle' | 'queued' | 'running' | 'waiting_user' | 'paused' | 'needs_attention' | 'completed' | 'excluded' | 'failed' | 'stopped' | 'interrupted';
export type PlaybackState = 'unknown' | 'ready' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export type PlatformId = 'henan' | 'huayi';
export interface Platform {
  id: PlatformId;
  name: string;
  entryUrl: string;
  description: string;
  capabilities: { courses: boolean; login: boolean; playlist: boolean; execution: boolean };
}
export const PLATFORMS: readonly Platform[] = [
  { id: 'henan', name: '河南继续医学教育平台', entryUrl: `${PLATFORM_ORIGIN}/`, description: '管理课程、读取视频列表与学习进度', capabilities: { courses: true, login: true, playlist: true, execution: true } },
  { id: 'huayi', name: '华医网', entryUrl: 'https://91huayi.com/', description: '共用网站登录，逐个播放课程视频并记录学习进度', capabilities: { courses: true, login: true, playlist: true, execution: true } },
];
export function platformById(id: string): Platform | undefined { return PLATFORMS.find(platform => platform.id === id); }

// 只进行本地格式及归属检查，不探测网站或验证播放能力。
export function isLearningUrl(platformId: string, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const belongs = platformId === 'henan' ? url.origin === PLATFORM_ORIGIN
      : platformId === 'huayi' && (url.hostname === '91huayi.com' || url.hostname.endsWith('.91huayi.com'));
    const page = `${url.pathname}${url.hash}`;
    return !!belongs && !['/', '/#', '/#/', '/#/home', '/#/index', '/index.html', '/index.htm', '/index', '/home', '/home/', '/cme/index', '/cme/index.html'].includes(page);
  } catch { return false; }
}

export interface User { id: string; name: string; createdAt: string; }
export interface Course {
  id: string;
  accountId: string;
  name: string;
  learningUrl: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Account {
  id: string;
  userId: string;
  platformId: PlatformId;
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
  excludedReason?: string;
  progress?: PlaybackProgress;
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
  courseId: string | null;
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
  users: User[];
  platforms: readonly Platform[];
  courses: Course[];
  accounts: Account[];
  jobs: Job[];
  maxConcurrency: number;
}

export type WorkerCommand =
  | { type: 'start'; job: Job; platformId: PlatformId; profileDir: string; channel: string }
  | { type: 'course_name'; requestId: string; url: string; platformId: PlatformId; profileDir: string; channel: string }
  | { type: 'cancel_course_name'; requestId: string }
  | { type: 'confirm' }
  | { type: 'pause' }
  | { type: 'stop' };

export type WorkerEvent =
  | { type: 'course_name'; requestId: string; name?: string; error?: string }
  | { type: 'log'; level: 'info' | 'error'; message: string }
  | { type: 'waiting_user'; message: string }
  | { type: 'login_saved'; message: string; courseUrl?: string }
  | { type: 'playback_resumed'; message: string }
  | { type: 'playlist'; courseUrl: string; courseTitle: string; items: PlaylistItem[] }
  | { type: 'progress'; progress: PlaybackProgress }
  | { type: 'done'; status: 'completed' | 'failed' | 'stopped' | 'paused' | 'needs_attention'; message: string; courseUrl?: string };

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'waiting_user'];
export const STARTABLE_JOB_STATUSES: readonly JobStatus[] = ['idle', 'paused', 'needs_attention', 'completed', 'failed', 'stopped', 'interrupted'];
