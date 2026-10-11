import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { WorkerEvent } from '@medcourse/shared';
import { Store, StoreError } from './store.js';
import { isLearningUrl } from '@medcourse/shared';

interface Running { child: ChildProcess; exited: Promise<void>; }

export class Scheduler {
  private running = new Map<string, Running>();
  private closed = false;
  private pausingAccounts = new Set<string>();
  private nameReaders = new Map<string, { running: Running; owned: boolean; requestId: string }>();

  constructor(private store: Store, private options: {
    dataDir: string; maxConcurrency: number; channel: string; workerFactory?: () => ChildProcess;
  }) {}

  isAccountBusy(accountId: string): boolean {
    return this.nameReaders.has(accountId) || this.pausingAccounts.has(accountId) || !!this.store.activeJob(accountId) || [...this.running.keys()].some(id => this.store.job(id)?.accountId === accountId);
  }

  private createWorker(): ChildProcess {
    const isSource = import.meta.url.endsWith('.ts');
    return this.options.workerFactory?.() ?? fork(fileURLToPath(new URL(isSource ? './worker.ts' : './worker.js', import.meta.url)), [], {
      execArgv: isSource ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  }

  private get browserCount(): number { return this.running.size + [...this.nameReaders.values()].filter(reader => reader.owned).length; }

  async readCourseName(accountId: string, url: string): Promise<string> {
    const account = this.store.account(accountId);
    if (!account) throw new StoreError('网站账号不存在', 404);
    if (!isLearningUrl(account.platformId, url)) throw new StoreError('请输入所属网站的 HTTPS 学习链接，不要填写网站首页', 400);
    if (this.closed || this.nameReaders.has(accountId) || this.pausingAccounts.has(accountId)) throw new StoreError('正在读取或处理本站任务，请稍后再添加课程');
    const job = this.store.activeJob(accountId);
    const existing = job ? this.running.get(job.id) : undefined;
    if (job && (job.kind !== 'login' || job.status !== 'waiting_user' || !existing)) throw new StoreError('请先暂停或停止本站活动任务，再添加课程');
    if (!existing && (this.isAccountBusy(accountId) || this.browserCount >= this.options.maxConcurrency)) throw new StoreError('浏览器正在处理其他任务，请稍后再添加课程');
    const profileDir = join(this.options.dataDir, 'profiles', accountId);
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const child = existing?.child ?? this.createWorker();
    const running = existing ?? { child, exited: new Promise<void>(resolve => child.once('close', () => resolve())) };
    const requestId = randomUUID();
    this.nameReaders.set(accountId, { running, owned: !existing, requestId });
    try {
      const name = await new Promise<string>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('close', onClose); child.off('error', onError); };
        const onMessage = (event: WorkerEvent) => {
          if (event?.type === 'login_saved' && !existing) this.store.saveLogin(accountId, event.courseUrl);
          if (event?.type !== 'course_name' || event.requestId !== requestId) return;
          cleanup();
          if (event.error || !event.name?.trim()) reject(new StoreError(event.error || '网页未提供课程名称，未添加课程', 422));
          else resolve(event.name.trim());
        };
        const onClose = () => { cleanup(); reject(new StoreError('课程读取窗口或登录任务已结束，未添加课程', 422)); };
        const onError = () => { cleanup(); reject(new StoreError('无法启动课程名称读取，请检查浏览器安装', 422)); };
        const timer = setTimeout(() => {
          cleanup();
          if (child.connected) child.send({ type: 'cancel_course_name', requestId }, () => {});
          reject(new StoreError('读取课程名称超时，未添加课程，请重试', 422));
        }, 220_000);
        child.on('message', onMessage); child.once('close', onClose); child.once('error', onError);
        child.send({ type: 'course_name', requestId, url, platformId: account.platformId, profileDir, channel: this.options.channel }, error => { if (error) onError(); });
      });
      if (this.closed) throw new StoreError('服务正在关闭，未添加课程');
      return name;
    } finally {
      if (!existing) await this.terminate(running);
      this.nameReaders.delete(accountId);
      this.pump();
    }
  }

  pump(): void {
    if (this.closed) return;
    while (this.browserCount < this.options.maxConcurrency) {
      const occupied = [...this.running.keys()].map(id => this.store.job(id)?.accountId).filter((id): id is string => !!id);
      const job = this.store.nextQueued([...occupied, ...this.pausingAccounts, ...this.nameReaders.keys()]);
      if (!job) break;
      const profileDir = join(this.options.dataDir, 'profiles', job.accountId);
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      this.store.updateJob(job.id, 'running', '正在启动浏览器');
      let child: ChildProcess;
      try {
        child = this.createWorker();
      } catch {
        this.store.updateJob(job.id, 'failed', '无法启动任务进程');
        if (job.kind === 'playback') this.store.pauseQueuedAccount(job.accountId);
        continue;
      }
      let resolveExit!: () => void;
      const exited = new Promise<void>(resolve => { resolveExit = resolve; });
      this.running.set(job.id, { child, exited });
      child.on('message', (event: WorkerEvent) => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'log') this.store.log(job.id, event.level, event.message);
        if (event.type === 'waiting_user') this.store.updateJob(job.id, 'waiting_user', event.message);
        if (event.type === 'login_saved' && job.kind === 'login') {
          this.store.saveLogin(job.accountId, event.courseUrl);
          this.store.updateJob(job.id, 'waiting_user', event.message);
          this.store.log(job.id, 'info', event.message);
        }
        if (event.type === 'playback_resumed' && job.kind === 'playback' && this.store.job(job.id)?.status === 'waiting_user') {
          this.store.updateJob(job.id, 'running', event.message);
          this.store.log(job.id, 'info', event.message);
        }
        if (event.type === 'progress' && job.kind === 'playback') this.store.updateProgress(job.id, event.progress);
        if (event.type === 'playlist' && job.kind === 'playlist') {
          try {
            const result = this.store.importPlaylist(job.accountId, event.courseUrl, event.courseTitle, event.items, job.courseId);
            this.store.saveLogin(job.accountId, event.courseUrl);
            this.store.log(job.id, 'info', this.store.account(job.accountId)?.platformId === 'huayi' ? `目录共 ${result.total} 节，新增 ${result.added} 节，平台状态与目录进度已更新；未启动播放` : `播放列表共 ${result.total} 个视频，新加入 ${result.added} 个任务；已有进度保留`);
          } catch (error) {
            this.store.updateJob(job.id, 'failed', error instanceof StoreError ? error.message : '播放列表保存失败，未创建新任务');
            void this.terminate(this.running.get(job.id)!);
          }
        }
        if (event.type === 'done' && this.store.job(job.id)?.status !== 'failed') {
          this.store.updateJob(job.id, event.status, event.message);
          if (job.kind === 'playback' && ['needs_attention', 'paused', 'failed'].includes(event.status)) this.store.pauseQueuedAccount(job.accountId);
          this.store.log(job.id, event.status === 'failed' ? 'error' : 'info', event.message);
          if (job.kind === 'login' && event.status === 'completed') this.store.saveLogin(job.accountId, event.courseUrl);
        }
      });
      child.on('error', () => {
        this.store.updateJob(job.id, 'failed', '任务进程发生错误');
        if (job.kind === 'playback') this.store.pauseQueuedAccount(job.accountId);
      });
      child.once('close', () => {
        const current = this.store.job(job.id);
        if (current && ['running', 'waiting_user'].includes(current.status)) {
          this.store.updateJob(job.id, 'failed', '任务进程意外退出，请检查浏览器安装和运行环境');
          if (job.kind === 'playback') this.store.pauseQueuedAccount(job.accountId);
        }
        this.running.delete(job.id);
        resolveExit();
        this.pump();
      });
      child.send({ type: 'start', job, platformId: this.store.account(job.accountId)!.platformId, profileDir, channel: this.options.channel }, () => {});
    }
  }

  confirm(id: string): boolean {
    const running = this.running.get(id);
    const job = this.store.job(id);
    if (!running || job?.kind !== 'login' || job.status !== 'waiting_user' || this.nameReaders.has(job.accountId)) return false;
    running.child.send({ type: 'confirm' }, () => {});
    return true;
  }

  async archiveCourse(id: string): Promise<boolean> {
    const course = this.store.course(id);
    if (!course || this.pausingAccounts.has(course.accountId)) return false;
    this.pausingAccounts.add(course.accountId);
    try {
      // 暂停调度该账号，防止停止当前课程时自动启动它的下一视频。
      for (const job of this.store.courseJobs(id)) {
        if (['queued', 'running', 'waiting_user'].includes(job.status)) await this.stop(job.id);
      }
      this.store.archiveCourse(id);
      return true;
    } finally {
      this.pausingAccounts.delete(course.accountId);
      this.pump();
    }
  }

  async pauseAccount(accountId: string): Promise<boolean> {
    if (this.pausingAccounts.has(accountId)) return false;
    const running = [...this.running.entries()].filter(([id]) => {
      const job = this.store.job(id);
      return job?.accountId === accountId && job.kind === 'playback';
    });
    this.pausingAccounts.add(accountId);
    try {
      // 先暂停队列，再关闭当前播放器，防止关闭时自动启动下一视频。
      const paused = this.store.pauseQueuedAccount(accountId);
      await Promise.all(running.map(async ([id, process]) => {
        await this.terminate(process, 'pause');
        if (this.store.job(id)?.status === 'failed') this.store.updateJob(id, 'paused', '浏览器已关闭，播放进度已保留');
      }));
      return paused > 0 || running.length > 0;
    } finally {
      this.pausingAccounts.delete(accountId);
      this.pump();
    }
  }

  async pause(id: string): Promise<boolean> {
    const job = this.store.job(id);
    if (!job || job.kind !== 'playback' || !['queued', 'running', 'waiting_user'].includes(job.status)) return false;
    const running = this.running.get(id);
    this.store.pauseQueuedAccount(job.accountId);
    if (running) await this.terminate(running, 'pause');
    else this.store.updateJob(id, 'paused', '已暂停排队');
    return true;
  }

  async stop(id: string): Promise<boolean> {
    const job = this.store.job(id);
    if (!job || !['queued', 'running', 'waiting_user'].includes(job.status)) return false;
    const running = this.running.get(id);
    if (!running) {
      this.store.updateJob(id, 'stopped', '任务已取消');
      return true;
    }
    await this.terminate(running);
    if (this.store.job(id)?.status === 'failed') this.store.updateJob(id, 'stopped', '任务已停止');
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.store.cancelQueued();
    await Promise.all([...this.nameReaders.values()].filter(reader => reader.owned).map(reader => this.terminate(reader.running)));
    await Promise.all([...this.running.entries()].map(async ([id, running]) => {
      await this.terminate(running);
      if (this.store.job(id)?.status === 'failed') this.store.updateJob(id, 'stopped', '服务关闭，任务已停止');
    }));
  }

  private async terminate(running: Running, command: 'stop' | 'pause' = 'stop'): Promise<void> {
    if (running.child.connected) running.child.send({ type: command }, () => {});
    const timer = setTimeout(() => running.child.kill('SIGKILL'), 8000);
    await running.exited;
    clearTimeout(timer);
  }
}
