import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { platformById, isLearningUrl, type User, type Course, type PlatformId, type Account, type Job, type JobKind, type JobLog, type JobStatus, type PlaylistItem, type PlaybackProgress } from '@medcourse/shared';
import { courseUrl as henanCourseUrl } from './automation/platform.js';
import { isPlatformVideoComplete } from './automation/platform.js';
import { isHuayiCourseUrl } from './automation/huayi.js';
import { isRequestedCoursePage } from './automation/course-name.js';

export class StoreError extends Error {
  constructor(message: string, public statusCode = 409) { super(message); }
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 3) { this.db.close(); throw new Error('数据库版本高于当前程序，请使用新版程序'); }
    // VACUUM INTO 包含 WAL 中的已提交数据；只备份旧数据库，不修改浏览器资料。
    if (path !== ':memory:' && version < 3 && this.db.prepare("SELECT name FROM sqlite_master WHERE name = 'accounts'").get()) {
      this.db.prepare('VACUUM INTO ?').run(`${path}.pre-v3-${Date.now()}.bak`);
    }
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
      platformStatus: 'TEXT', sampledAt: 'TEXT', courseId: 'TEXT REFERENCES courses(id) ON DELETE SET NULL',
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS courses (
          id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          name TEXT NOT NULL, learningUrl TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, archivedAt TEXT
        );
      `);
      const accountColumns = new Set((this.db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map(column => column.name));
      if (!accountColumns.has('userId')) this.db.exec('ALTER TABLE accounts ADD COLUMN userId TEXT REFERENCES users(id) ON DELETE CASCADE');
      if (!accountColumns.has('platformId')) this.db.exec("ALTER TABLE accounts ADD COLUMN platformId TEXT NOT NULL DEFAULT 'henan'");
      for (const [name, type] of Object.entries(additions)) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
      }
      if (version < 3) this.db.exec('DROP INDEX IF EXISTS one_video_per_course');
      this.db.exec(`
        DROP INDEX IF EXISTS one_active_job_per_account;
        CREATE UNIQUE INDEX IF NOT EXISTS one_running_job_per_account ON jobs(accountId)
          WHERE status IN ('running', 'waiting_user');
        CREATE UNIQUE INDEX IF NOT EXISTS one_video_per_course ON jobs(accountId, courseId, chapterId)
          WHERE kind = 'playback';
        CREATE UNIQUE INDEX IF NOT EXISTS one_account_per_user_platform ON accounts(userId, platformId);
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_course_url ON courses(accountId, learningUrl) WHERE archivedAt IS NULL;
        CREATE INDEX IF NOT EXISTS jobs_course ON jobs(courseId);
      `);
      if (version < 3) {
        for (const account of this.accounts()) {
          if (!account.userId) {
            const user = this.createUser(account.name, account.createdAt);
            this.db.prepare("UPDATE accounts SET userId = ?, platformId = 'henan' WHERE id = ?").run(user.id, account.id);
          }
          const groups = this.db.prepare("SELECT url, MAX(courseTitle) AS name, MIN(createdAt) AS createdAt FROM jobs WHERE accountId = ? AND kind = 'playback' GROUP BY url").all(account.id) as { url: string; name: string | null; createdAt: string }[];
          for (const group of groups) {
            const course = this.insertCourse(account.id, group.name || '已有课程', group.url, group.createdAt);
            this.db.prepare("UPDATE jobs SET courseId = ? WHERE accountId = ? AND kind = 'playback' AND url = ?").run(course.id, account.id, group.url);
          }
          if (henanCourseUrl(account.courseUrl) && !this.courses(account.id).some(course => henanCourseUrl(course.learningUrl) === henanCourseUrl(account.courseUrl))) {
            this.insertCourse(account.id, '已有课程', account.courseUrl, account.createdAt);
          }
        }
        this.db.exec("UPDATE jobs SET status = 'interrupted', detail = '多网站数据升级完成，请手动继续任务' WHERE status IN ('queued', 'running', 'waiting_user')");
      }
      this.db.exec(`
        PRAGMA user_version = 3;
        COMMIT;
      `);
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }

  accounts(): Account[] {
    return this.db.prepare('SELECT * FROM accounts ORDER BY createdAt, id').all() as unknown as Account[];
  }

  account(id: string): Account | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as Account | undefined;
  }

  users(): User[] { return this.db.prepare('SELECT * FROM users ORDER BY createdAt, rowid').all() as unknown as User[]; }

  user(id: string): User | undefined { return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User | undefined; }

  createUser(name: string, createdAt = new Date().toISOString()): User {
    const user = { id: randomUUID(), name, createdAt };
    this.db.prepare('INSERT INTO users(id, name, createdAt) VALUES (?, ?, ?)').run(user.id, name, createdAt);
    return user;
  }

  renameUser(id: string, name: string): User {
    if (!this.user(id)) throw new StoreError('用户不存在', 404);
    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
    return this.user(id)!;
  }

  deleteUser(id: string): void { this.db.prepare('DELETE FROM users WHERE id = ?').run(id); }

  bindPlatforms(userId: string, platformIds: string[]): Account[] {
    const user = this.user(userId);
    if (!user) throw new StoreError('用户不存在', 404);
    if (!platformIds.length || platformIds.some(id => !platformById(id))) throw new StoreError('请选择已提供的学习网站', 400);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const platformId of new Set(platformIds)) {
        if (!this.accounts().some(account => account.userId === userId && account.platformId === platformId)) {
          this.insertAccount(user.name, platformById(platformId)!.entryUrl, userId, platformId as PlatformId);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.accounts().filter(account => account.userId === userId);
  }

  private insertAccount(name: string, courseUrl: string, userId: string, platformId: PlatformId): Account {
    const account: Account = { id: randomUUID(), userId, platformId, name, courseUrl, loginState: 'none', createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO accounts(id, name, courseUrl, loginState, createdAt, userId, platformId) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(account.id, account.name, account.courseUrl, account.loginState, account.createdAt, userId, platformId);
    return account;
  }

  // 保留内部与旧接口的河南账号创建入口；新界面显式创建用户并选择网站。
  createAccount(name: string, courseUrl: string): Account {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const user = this.createUser(name);
      const account = this.insertAccount(name, courseUrl, user.id, 'henan');
      if (henanCourseUrl(courseUrl)) this.insertCourse(account.id, '已有课程', courseUrl);
      this.db.exec('COMMIT');
      return account;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  courses(accountId?: string): Course[] {
    return this.db.prepare(`SELECT * FROM courses ${accountId ? 'WHERE accountId = ?' : ''} ORDER BY createdAt, rowid`)
      .all(...(accountId ? [accountId] : [])) as unknown as Course[];
  }

  course(id: string): Course | undefined { return this.db.prepare('SELECT * FROM courses WHERE id = ?').get(id) as unknown as Course | undefined; }

  private insertCourse(accountId: string, name: string, learningUrl: string, createdAt = new Date().toISOString()): Course {
    const existing = this.courses(accountId).find(course => !course.archivedAt && course.learningUrl === learningUrl);
    if (existing) return existing;
    const id = randomUUID();
    this.db.prepare('INSERT INTO courses(id, accountId, name, learningUrl, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, accountId, name, learningUrl, createdAt, createdAt);
    return this.course(id)!;
  }

  private validateCourse(accountId: string, name: string, url: string, exceptId?: string): void {
    const account = this.account(accountId);
    if (!account) throw new StoreError('网站账号不存在', 404);
    if (!name || name.length > 120 || url.length > 2048 || !isLearningUrl(account.platformId, url)) throw new StoreError('请填写课程名称及所属网站的 HTTPS 学习链接，不要填写网站首页', 400);
    const duplicate = this.courses(accountId).some(course => !course.archivedAt && course.id !== exceptId && course.learningUrl === url);
    if (duplicate) throw new StoreError('该课程已添加');
  }

  createCourse(accountId: string, name: string, url: string): Course {
    name = name.trim(); url = url.trim();
    this.validateCourse(accountId, name, url);
    return this.insertCourse(accountId, name, url);
  }

  courseJobs(id: string): Job[] { return this.db.prepare('SELECT * FROM jobs WHERE courseId = ?').all(id) as unknown as Job[]; }

  updateCourse(id: string, name: string, url: string): { course: Course; created: boolean } {
    const course = this.course(id);
    if (!course) throw new StoreError('课程不存在', 404);
    if (course.archivedAt) throw new StoreError('课程已移除，历史记录保留');
    name = name.trim(); url = url.trim();
    this.validateCourse(course.accountId, name, url, id);
    if (url !== course.learningUrl && this.courseJobs(id).length) {
      return { course: this.insertCourse(course.accountId, name, url), created: true };
    }
    this.db.prepare('UPDATE courses SET name = ?, learningUrl = ?, updatedAt = ? WHERE id = ?').run(name, url, new Date().toISOString(), id);
    return { course: this.course(id)!, created: false };
  }

  archiveCourse(id: string): void {
    const course = this.course(id);
    if (!course) throw new StoreError('课程不存在', 404);
    if (this.courseJobs(id).some(job => ['queued', 'running', 'waiting_user'].includes(job.status))) throw new StoreError('请先停止该课程的活动任务');
    const now = new Date().toISOString();
    this.db.prepare('UPDATE courses SET archivedAt = COALESCE(archivedAt, ?), updatedAt = ? WHERE id = ?').run(now, now, id);
  }

  canExecute(accountId: string, courseId?: string | null, kind: JobKind = 'playback'): boolean {
    const platform = platformById(this.account(accountId)?.platformId ?? '');
    if (!platform || !(kind === 'login' ? platform.capabilities.login : kind === 'playlist' ? platform.capabilities.playlist : platform.capabilities.execution)) return false;
    if (kind === 'login' && courseId) return false;
    if (!courseId) return true;
    const course = this.course(courseId);
    return !!course && !course.archivedAt && course.accountId === accountId;
  }

  saveLogin(id: string, courseUrl?: string): void {
    this.db.prepare('UPDATE accounts SET loginState = ?, courseUrl = COALESCE(?, courseUrl) WHERE id = ?')
      .run('saved', courseUrl ?? null, id);
  }

  deleteAccount(id: string): void {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  jobs(): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE kind = 'playback' OR status IN ('queued', 'running', 'waiting_user') OR id IN (SELECT id FROM jobs WHERE kind != 'playback' ORDER BY createdAt DESC, id DESC LIMIT 100) ORDER BY createdAt DESC, id DESC").all() as unknown as Job[];
  }

  job(id: string): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as Job | undefined;
  }

  activeJob(accountId: string): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE accountId = ? AND status IN ('queued', 'running', 'waiting_user')")
      .get(accountId) as unknown as Job | undefined;
  }

  createJob(accountId: string, kind: JobKind, url: string, courseId: string | null = null): Job {
    if (!this.canExecute(accountId, courseId, kind)) throw new StoreError('该网站学习功能尚未接入，或课程已移除');
    if (this.account(accountId)?.platformId === 'huayi'
      && !(kind === 'login' ? url === platformById('huayi')!.entryUrl : kind === 'playlist' && !!courseId && isHuayiCourseUrl(url))) throw new StoreError('华医网仅支持网站首页登录和指定课程目录读取', 400);
    if (kind === 'playback') throw new Error('视频任务只能从播放列表导入');
    if (this.activeJob(accountId)) throw new Error('该账号已有活动任务');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO jobs(id, accountId, kind, status, url, detail, createdAt, updatedAt, courseId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, accountId, kind, 'queued', url, '等待执行', now, now, courseId);
    return this.job(id)!;
  }

  importPlaylist(accountId: string, url: string, courseTitle: string, items: PlaylistItem[], courseId?: string | null): { added: number; total: number } {
    if (!this.canExecute(accountId, courseId, 'playlist')) throw new StoreError('该网站目录读取尚未接入，或课程已移除');
    const huayi = this.account(accountId)!.platformId === 'huayi';
    if (huayi && (!courseId || !isHuayiCourseUrl(url))) throw new StoreError('华医网读取结果缺少有效课程');
    const selected = courseId ? this.course(courseId)! : undefined;
    if (selected && !(huayi ? isRequestedCoursePage('huayi', selected.learningUrl, url) : henanCourseUrl(url) && henanCourseUrl(selected.learningUrl) === henanCourseUrl(url))) throw new StoreError('读取结果与所选课程不一致，请检查课程链接');
    if (!items.length || items.length > 2000 || new Set(items.map(item => item.chapterId)).size !== items.length
      || items.some(item => !item.chapterId || !item.chapterTitle || !Number.isInteger(item.position) || item.position < 1)) {
      throw new Error('播放列表为空或章节标识不可靠');
    }
    const now = new Date().toISOString();
    let added = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const course = selected ?? this.courses(accountId).find(course => !course.archivedAt && (course.learningUrl === url || (henanCourseUrl(url) && henanCourseUrl(course.learningUrl) === henanCourseUrl(url)))) ?? this.insertCourse(accountId, courseTitle, url);
      for (const item of items) {
        const status: JobStatus = item.excludedReason ? 'excluded' : isPlatformVideoComplete(item.platformStatus) ? 'completed' : 'idle';
        const detail = item.excludedReason || (status === 'completed' ? '平台已确认视频学习结束，考试暂不处理' : '目录已读取，未启动播放');
        const existing = this.db.prepare("SELECT id FROM jobs WHERE accountId = ? AND courseId = ? AND chapterId = ? AND kind = 'playback'")
          .get(accountId, course.id, item.chapterId) as { id: string } | undefined;
        if (existing) {
          this.db.prepare('UPDATE jobs SET chapterTitle = ?, courseTitle = ?, position = ?, durationText = ?, platformStatus = ?, updatedAt = ? WHERE id = ?')
            .run(item.chapterTitle, courseTitle, item.position, item.durationText, item.platformStatus, now, existing.id);
        } else {
          this.db.prepare(`INSERT INTO jobs(id, accountId, kind, status, url, detail, chapterId, chapterTitle, courseTitle, position, durationText, platformStatus, createdAt, updatedAt, courseId)
            VALUES (?, ?, 'playback', 'idle', ?, '已加入播放列表，等待启动', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), accountId, url, item.chapterId, item.chapterTitle, courseTitle, item.position, item.durationText, item.platformStatus, now, now, course.id);
          added++;
        }
        if (huayi) {
          const saved = this.db.prepare("SELECT id FROM jobs WHERE accountId = ? AND courseId = ? AND chapterId = ? AND kind = 'playback'").get(accountId, course.id, item.chapterId) as { id: string };
          this.db.prepare('UPDATE jobs SET status = ?, detail = ? WHERE id = ?').run(status, detail, saved.id);
          if (item.progress) this.updateProgress(saved.id, item.progress);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { added, total: items.length };
  }

  enqueue(id: string): boolean {
    const job = this.job(id);
    if (!job || !this.canExecute(job.accountId, job.courseId) || job.kind !== 'playback' || ['queued', 'running', 'waiting_user', 'excluded'].includes(job.status)) return false;
    if (this.db.prepare("SELECT id FROM jobs WHERE accountId = ? AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.id = jobs.courseId AND c.archivedAt IS NOT NULL) AND ((kind != 'playback' AND status IN ('queued', 'running', 'waiting_user')) OR (status = 'needs_attention' AND id != ?))").get(job.accountId, id)) return false;
    this.updateJob(id, 'queued', '等待播放；从平台当前进度开始');
    return true;
  }

  enqueueAll(accountId: string): number {
    if (!this.canExecute(accountId)) return 0;
    if (this.db.prepare("SELECT id FROM jobs WHERE accountId = ? AND kind != 'playback' AND status IN ('queued', 'running', 'waiting_user')").get(accountId)) return 0;
    // 账号整体开始也负责继续暂停、重试失败及人工处理后的任务，已完成视频保留。
    return Number(this.db.prepare(`UPDATE jobs SET status = 'queued', detail = '等待播放；从平台当前进度开始', updatedAt = ?
      WHERE accountId = ? AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.id = jobs.courseId AND c.archivedAt IS NOT NULL) AND kind = 'playback' AND status IN ('idle', 'paused', 'stopped', 'interrupted', 'failed', 'needs_attention')`)
      .run(new Date().toISOString(), accountId).changes);
  }

  nextQueued(excludedAccounts: string[] = []): Job | undefined {
    const placeholders = excludedAccounts.map(() => '?').join(',');
    return this.db.prepare(`SELECT j.* FROM jobs j JOIN accounts a ON a.id = j.accountId WHERE j.status = 'queued' AND (a.platformId = 'henan' OR (a.platformId = 'huayi' AND ((j.kind = 'login' AND j.courseId IS NULL AND j.url = ?) OR (j.kind IN ('playlist', 'playback') AND j.courseId IS NOT NULL))))
      AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.id = j.courseId AND c.archivedAt IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.accountId = j.accountId AND active.status IN ('running', 'waiting_user'))
      ${excludedAccounts.length ? `AND j.accountId NOT IN (${placeholders})` : ''}
      AND NOT (j.kind = 'playback' AND EXISTS (SELECT 1 FROM jobs blocked WHERE blocked.accountId = j.accountId AND blocked.kind = 'playback' AND blocked.status = 'needs_attention' AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.id = blocked.courseId AND c.archivedAt IS NOT NULL)))
      ORDER BY COALESCE((SELECT c.createdAt FROM courses c WHERE c.id = j.courseId AND j.kind = 'playback'), j.createdAt),
        COALESCE((SELECT c.rowid FROM courses c WHERE c.id = j.courseId AND j.kind = 'playback'), j.rowid),
        COALESCE(j.position, 0), j.rowid LIMIT 1`).get(platformById('huayi')!.entryUrl, ...excludedAccounts) as unknown as Job | undefined;
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
