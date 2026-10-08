import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Account, Job, JobKind, JobLog, JobStatus, PlaylistItem, PlaybackProgress } from '@medcourse/shared';

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, courseUrl TEXT NOT NULL,
        loginState TEXT NOT NULL DEFAULT 'none', createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, status TEXT NOT NULL, url TEXT NOT NULL, detail TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        level TEXT NOT NULL, message TEXT NOT NULL, createdAt TEXT NOT NULL
      );

    `);
    // 兼容已有数据库，保留账号、旧任务和登录资料。
    const columns = new Set((this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map(column => column.name));
    const additions: Record<string, string> = {
      chapterId: 'TEXT', chapterTitle: 'TEXT', courseTitle: 'TEXT', position: 'INTEGER', durationText: 'TEXT',
      currentTime: 'REAL', duration: 'REAL', playbackState: "TEXT NOT NULL DEFAULT 'unknown'",
      platformStatus: 'TEXT', sampledAt: 'TEXT',
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [name, type] of Object.entries(additions)) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
      }
      this.db.exec(`
        DROP INDEX IF EXISTS one_active_job_per_account;
        CREATE UNIQUE INDEX IF NOT EXISTS one_running_job_per_account ON jobs(accountId)
          WHERE status IN ('running', 'waiting_user');
        CREATE UNIQUE INDEX IF NOT EXISTS one_video_per_course ON jobs(accountId, url, chapterId)
          WHERE kind = 'playback';
        PRAGMA user_version = 2;
        COMMIT;
      `);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  accounts(): Account[] {
    return this.db.prepare('SELECT * FROM accounts ORDER BY createdAt, id').all() as unknown as Account[];
  }

  account(id: string): Account | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as Account | undefined;
  }

  createAccount(name: string, courseUrl: string): Account {
    const account: Account = { id: randomUUID(), name, courseUrl, loginState: 'none', createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO accounts(id, name, courseUrl, loginState, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(account.id, account.name, account.courseUrl, account.loginState, account.createdAt);
    return account;
  }

  saveLogin(id: string, courseUrl?: string): void {
    this.db.prepare('UPDATE accounts SET loginState = ?, courseUrl = COALESCE(?, courseUrl) WHERE id = ?')
      .run('saved', courseUrl ?? null, id);
  }

  deleteAccount(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  jobs(): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE kind = 'playback' OR id IN (SELECT id FROM jobs WHERE kind != 'playback' ORDER BY createdAt DESC, id DESC LIMIT 100) ORDER BY createdAt DESC, id DESC").all() as unknown as Job[];
  }

  job(id: string): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as Job | undefined;
  }

  activeJob(accountId: string): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE accountId = ? AND status IN ('queued', 'running', 'waiting_user')")
      .get(accountId) as unknown as Job | undefined;
  }

  createJob(accountId: string, kind: JobKind, url: string): Job {
    if (kind === 'playback') throw new Error('视频任务只能从播放列表导入');
    if (this.activeJob(accountId)) throw new Error('该账号已有活动任务');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO jobs(id, accountId, kind, status, url, detail, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, accountId, kind, 'queued', url, '等待执行', now, now);
    return this.job(id)!;
  }

  importPlaylist(accountId: string, url: string, courseTitle: string, items: PlaylistItem[]): { added: number; total: number } {
    if (!items.length || items.length > 2000 || new Set(items.map(item => item.chapterId)).size !== items.length
      || items.some(item => !item.chapterId || !item.chapterTitle || !Number.isInteger(item.position) || item.position < 1)) {
      throw new Error('播放列表为空或章节标识不可靠');
    }
    const now = new Date().toISOString();
    let added = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        const existing = this.db.prepare("SELECT id FROM jobs WHERE accountId = ? AND url = ? AND chapterId = ? AND kind = 'playback'")
          .get(accountId, url, item.chapterId) as { id: string } | undefined;
        if (existing) {
          this.db.prepare('UPDATE jobs SET chapterTitle = ?, courseTitle = ?, position = ?, durationText = ?, platformStatus = ?, updatedAt = ? WHERE id = ?')
            .run(item.chapterTitle, courseTitle, item.position, item.durationText, item.platformStatus, now, existing.id);
        } else {
          this.db.prepare(`INSERT INTO jobs(id, accountId, kind, status, url, detail, chapterId, chapterTitle, courseTitle, position, durationText, platformStatus, createdAt, updatedAt)
            VALUES (?, ?, 'playback', 'idle', ?, '已加入播放列表，等待启动', ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), accountId, url, item.chapterId, item.chapterTitle, courseTitle, item.position, item.durationText, item.platformStatus, now, now);
          added++;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { added, total: items.length };
  }

  enqueue(id: string): boolean {
    const job = this.job(id);
    if (!job || job.kind !== 'playback' || ['queued', 'running', 'waiting_user'].includes(job.status)) return false;
    if (this.db.prepare("SELECT id FROM jobs WHERE accountId = ? AND ((kind != 'playback' AND status IN ('queued', 'running', 'waiting_user')) OR (status = 'needs_attention' AND id != ?))").get(job.accountId, id)) return false;
    this.updateJob(id, 'queued', '等待播放；从平台当前进度开始');
    return true;
  }

  enqueueAll(accountId: string): number {
    if (this.db.prepare("SELECT id FROM jobs WHERE accountId = ? AND kind != 'playback' AND status IN ('queued', 'running', 'waiting_user')").get(accountId)) return 0;
    // 账号整体开始也负责继续暂停、重试失败及人工处理后的任务，已完成视频保留。
    return Number(this.db.prepare(`UPDATE jobs SET status = 'queued', detail = '等待播放；从平台当前进度开始', updatedAt = ?
      WHERE accountId = ? AND kind = 'playback' AND status IN ('idle', 'paused', 'stopped', 'interrupted', 'failed', 'needs_attention')`)
      .run(new Date().toISOString(), accountId).changes);
  }

  nextQueued(excludedAccounts: string[] = []): Job | undefined {
    const placeholders = excludedAccounts.map(() => '?').join(',');
    return this.db.prepare(`SELECT j.* FROM jobs j WHERE j.status = 'queued'
      AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.accountId = j.accountId AND active.status IN ('running', 'waiting_user'))
      ${excludedAccounts.length ? `AND j.accountId NOT IN (${placeholders})` : ''}
      AND NOT (j.kind = 'playback' AND EXISTS (SELECT 1 FROM jobs blocked WHERE blocked.accountId = j.accountId AND blocked.kind = 'playback' AND blocked.status = 'needs_attention'))
      ORDER BY j.createdAt, COALESCE(j.position, 0), j.rowid LIMIT 1`).get(...excludedAccounts) as unknown as Job | undefined;
  }

  pauseQueuedAccount(accountId: string): number {
    return Number(this.db.prepare("UPDATE jobs SET status = 'paused', detail = '同账号播放已暂停或需要处理，等待手动继续', updatedAt = ? WHERE accountId = ? AND kind = 'playback' AND status = 'queued'")
      .run(new Date().toISOString(), accountId).changes);
  }

  updateProgress(id: string, progress: PlaybackProgress): void {
    const valid = (value: number | null) => value === null || (Number.isFinite(value) && value >= 0);
    if (!valid(progress.currentTime) || !valid(progress.duration) || !['unknown', 'ready', 'playing', 'paused', 'buffering', 'ended', 'error'].includes(progress.playbackState)) return;
    const detail = {
      unknown: '等待目标播放器提供进度', ready: '播放器已就绪', playing: '正在播放并记录实际进度',
      paused: '播放器已暂停', buffering: '视频缓冲中', ended: '视频已结束，等待平台确认', error: '播放器报告错误',
    }[progress.playbackState];
    this.db.prepare(`UPDATE jobs SET currentTime = ?, duration = ?, playbackState = ?, platformStatus = ?, sampledAt = ?, updatedAt = ?,
      detail = CASE WHEN status = 'running' THEN ? ELSE detail END WHERE id = ? AND kind = 'playback'`)
      .run(progress.currentTime, progress.duration, progress.playbackState, progress.platformStatus, progress.sampledAt, new Date().toISOString(), detail, id);
  }

  updateJob(id: string, status: JobStatus, detail: string): void {
    this.db.prepare('UPDATE jobs SET status = ?, detail = ?, updatedAt = ? WHERE id = ?')
      .run(status, detail, new Date().toISOString(), id);
  }

  recoverInterrupted(): void {
    this.db.prepare("UPDATE jobs SET status = 'interrupted', detail = '服务重新启动，任务需要手动重试', updatedAt = ? WHERE status IN ('running', 'waiting_user')")
      .run(new Date().toISOString());
  }

  cancelQueued(): void {
    this.db.prepare("UPDATE jobs SET status = 'stopped', detail = '服务关闭，排队任务已取消', updatedAt = ? WHERE status = 'queued'")
      .run(new Date().toISOString());
  }

  log(jobId: string, level: 'info' | 'error', message: string): void {
    this.db.prepare('INSERT INTO job_logs(jobId, level, message, createdAt) VALUES (?, ?, ?, ?)')
      .run(jobId, level, message, new Date().toISOString());
  }

  logs(jobId: string): JobLog[] {
    return this.db.prepare('SELECT * FROM (SELECT * FROM job_logs WHERE jobId = ? ORDER BY id DESC LIMIT 200) ORDER BY id')
      .all(jobId) as unknown as JobLog[];
  }

  close(): void { this.db.close(); }
}
