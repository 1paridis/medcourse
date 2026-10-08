import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerEvent } from '@medcourse/shared';
import { Store } from './store.js';

interface Running { child: ChildProcess; exited: Promise<void>; }

export class Scheduler {
  private running = new Map<string, Running>();
  private closed = false;
  private pausingAccounts = new Set<string>();

  constructor(private store: Store, private options: {
    dataDir: string; maxConcurrency: number; channel: string; workerFactory?: () => ChildProcess;
  }) {}

  isAccountBusy(accountId: string): boolean {
    return this.pausingAccounts.has(accountId) || !!this.store.activeJob(accountId) || [...this.running.keys()].some(id => this.store.job(id)?.accountId === accountId);
  }

  pump(): void {
    if (this.closed) return;
    while (this.running.size < this.options.maxConcurrency) {
      const occupied = [...this.running.keys()].map(id => this.store.job(id)?.accountId).filter((id): id is string => !!id);
      const job = this.store.nextQueued([...occupied, ...this.pausingAccounts]);
      if (!job) break;
      const profileDir = join(this.options.dataDir, 'profiles', job.accountId);
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      this.store.updateJob(job.id, 'running', '正在启动浏览器');
      let child: ChildProcess;
      try {
        const isSource = import.meta.url.endsWith('.ts');
        child = this.options.workerFactory?.() ?? fork(fileURLToPath(new URL(isSource ? './worker.ts' : './worker.js', import.meta.url)), [], {
          execArgv: isSource ? ['--import', 'tsx'] : [],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
      } catch {
        this.store.updateJob(job.id, 'failed', '无法启动任务进程');
        continue;
      }
      let resolveExit!: () => void;
      const exited = new Promise<void>(resolve => { resolveExit = resolve; });
      this.running.set(job.id, { child, exited });
      child.on('message', (event: WorkerEvent) => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'log') this.store.log(job.id, event.level, event.message);
        if (event.type === 'waiting_user') this.store.updateJob(job.id, 'waiting_user', event.message);
        if (event.type === 'progress' && job.kind === 'playback') this.store.updateProgress(job.id, event.progress);
        if (event.type === 'playlist' && job.kind === 'playlist') {
          try {
            const result = this.store.importPlaylist(job.accountId, event.courseUrl, event.courseTitle, event.items);
            this.store.saveLogin(job.accountId, event.courseUrl);
            this.store.log(job.id, 'info', `播放列表共 ${result.total} 个视频，新加入 ${result.added} 个任务；已有进度保留`);
          } catch {
            this.store.updateJob(job.id, 'failed', '播放列表保存失败，未创建新任务');
            void this.terminate(this.running.get(job.id)!);
          }
        }
        if (event.type === 'done' && this.store.job(job.id)?.status !== 'failed') {
          this.store.updateJob(job.id, event.status, event.message);
          if (job.kind === 'playback' && (event.status === 'needs_attention' || event.status === 'paused')) this.store.pauseQueuedAccount(job.accountId);
          this.store.log(job.id, event.status === 'failed' ? 'error' : 'info', event.message);
          if (job.kind === 'login' && event.status === 'completed') this.store.saveLogin(job.accountId, event.courseUrl);
        }
      });
      child.on('error', () => {
        this.store.updateJob(job.id, 'failed', '任务进程发生错误');
      });
      child.once('close', () => {
        const current = this.store.job(job.id);
        if (current && ['running', 'waiting_user'].includes(current.status)) {
          this.store.updateJob(job.id, 'failed', '任务进程意外退出，请检查浏览器安装和运行环境');
        }
        this.running.delete(job.id);
        resolveExit();
        this.pump();
      });
      child.send({ type: 'start', job, profileDir, channel: this.options.channel }, () => {});
    }
  }

  confirm(id: string): boolean {
    const running = this.running.get(id);
    if (!running || this.store.job(id)?.status !== 'waiting_user') return false;
    running.child.send({ type: 'confirm' }, () => {});
    return true;
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
    if (!job || job.kind !== 'playback' || !['queued', 'running'].includes(job.status)) return false;
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
