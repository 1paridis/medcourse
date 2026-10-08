import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { PLATFORM_ORIGIN } from '@medcourse/shared';

async function until(predicate: () => boolean) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5000) throw new Error('等待任务状态超时');
    await delay(20);
  }
}

test('子进程调度遵守并发上限，停止后启动队列下一项，并保存人工确认', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-scheduler-'));
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, {
    dataDir: directory, maxConcurrency: 1, channel: 'chromium',
    workerFactory: () => fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  });
  const a = store.createAccount('A', PLATFORM_ORIGIN);
  const b = store.createAccount('B', PLATFORM_ORIGIN);
  const first = store.createJob(a.id, 'login', PLATFORM_ORIGIN);
  const second = store.createJob(b.id, 'login', PLATFORM_ORIGIN);
  try {
    scheduler.pump();
    await until(() => store.job(first.id)?.status === 'waiting_user');
    assert.equal(store.job(second.id)?.status, 'queued');
    assert.equal(scheduler.isAccountBusy(a.id), true);
    assert.equal(await scheduler.stop(first.id), true);
    await until(() => store.job(second.id)?.status === 'waiting_user');
    assert.equal(scheduler.confirm(second.id), true);
    await until(() => store.job(second.id)?.status === 'completed');
    assert.equal(store.account(b.id)?.loginState, 'saved');
    assert.equal(store.job(first.id)?.status, 'stopped');
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('多账号并发时同账号视频串行，暂停保留进度并暂停该账号后续队列', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-playback-scheduler-'));
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, {
    dataDir: directory, maxConcurrency: 2, channel: 'chromium',
    workerFactory: () => fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  });
  const a = store.createAccount('A', PLATFORM_ORIGIN);
  const b = store.createAccount('B', PLATFORM_ORIGIN);
  const items = [1, 2].map(i => ({ chapterId: `v${i}`, chapterTitle: `视频 ${i}`, position: i, durationText: '', platformStatus: null }));
  store.importPlaylist(a.id, PLATFORM_ORIGIN, 'A课程', items);
  store.importPlaylist(b.id, PLATFORM_ORIGIN, 'B课程', items);
  store.enqueueAll(a.id);
  store.enqueueAll(b.id);
  const a1 = store.jobs().find(job => job.accountId === a.id && job.chapterId === 'v1')!;
  const a2 = store.jobs().find(job => job.accountId === a.id && job.chapterId === 'v2')!;
  const b1 = store.jobs().find(job => job.accountId === b.id && job.chapterId === 'v1')!;
  try {
    scheduler.pump();
    await until(() => store.job(a1.id)?.currentTime === 12 && store.job(b1.id)?.currentTime === 12);
    assert.equal(store.job(a2.id)?.status, 'queued');
    assert.equal(store.jobs().filter(job => job.status === 'running').length, 2);
    assert.equal(await scheduler.pauseAccount(a.id), true);
    assert.equal(store.job(a1.id)?.status, 'paused');
    assert.equal(store.job(a2.id)?.status, 'paused');
    assert.equal(store.job(a1.id)?.currentTime, 12);
    assert.equal(store.job(a1.id)?.duration, 100);
    assert.equal(store.job(b1.id)?.status, 'running');
    assert.equal(store.enqueueAll(a.id), 2);
    scheduler.pump();
    await until(() => store.job(a1.id)?.status === 'running');
    assert.equal(await scheduler.stop(a1.id), true);
    assert.equal(store.job(a1.id)?.currentTime, 12);
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('等待验证保留账号和后续队列，恢复后回到运行中，等待期间支持暂停', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-verification-'));
  const store = new Store(':memory:');
  let worker: ChildProcess;
  const scheduler = new Scheduler(store, {
    dataDir: directory, maxConcurrency: 1, channel: 'chromium',
    workerFactory: () => {
      worker = fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], {
        execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      return worker;
    },
  });
  const account = store.createAccount('A', PLATFORM_ORIGIN);
  store.importPlaylist(account.id, PLATFORM_ORIGIN, '课程', ['verify', 'next'].map((id, index) => ({
    chapterId: id, chapterTitle: id, position: index + 1, durationText: '', platformStatus: null,
  })));
  store.enqueueAll(account.id);
  const first = store.jobs().find(job => job.chapterId === 'verify')!;
  const second = store.jobs().find(job => job.chapterId === 'next')!;
  try {
    scheduler.pump();
    await until(() => store.job(first.id)?.status === 'waiting_user');
    assert.equal(scheduler.isAccountBusy(account.id), true);
    assert.equal(store.job(second.id)?.status, 'queued');
    assert.equal(scheduler.confirm(first.id), false, '验证任务不能被保存登录接口结束');
    worker!.send({ type: 'confirm' }); // 测试进程模拟用户在平台窗口完成验证。
    await until(() => store.job(first.id)?.status === 'running');
    assert.equal(store.account(account.id)?.loginState, 'none');
    assert.equal(store.job(second.id)?.status, 'queued');
    store.updateJob(first.id, 'waiting_user', '再次等待验证');
    assert.equal(await scheduler.pause(first.id), true);
    assert.equal(store.job(first.id)?.status, 'paused');
    assert.equal(store.job(first.id)?.currentTime, 12);
    assert.equal(store.job(second.id)?.status, 'paused');
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('上一视频结束且待考试时保留平台状态，自动启动同账号下一视频', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-next-video-'));
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, {
    dataDir: directory, maxConcurrency: 1, channel: 'chromium',
    workerFactory: () => fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }),
  });
  const account = store.createAccount('A', PLATFORM_ORIGIN);
  store.importPlaylist(account.id, PLATFORM_ORIGIN, '课程', ['complete-exam', 'next', 'third'].map((id, index) => ({
    chapterId: id, chapterTitle: id, position: index + 1, durationText: '', platformStatus: null,
  })));
  store.enqueueAll(account.id);
  const first = store.jobs().find(job => job.chapterId === 'complete-exam')!;
  const next = store.jobs().find(job => job.chapterId === 'next')!;
  const third = store.jobs().find(job => job.chapterId === 'third')!;
  try {
    scheduler.pump();
    await until(() => store.job(first.id)?.status === 'completed' && store.job(next.id)?.currentTime === 12);
    assert.equal(store.job(first.id)?.platformStatus, '待考试');
    assert.equal(store.job(first.id)?.currentTime, 100);
    assert.equal(store.job(next.id)?.status, 'running');
    assert.equal(store.job(third.id)?.status, 'queued');
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});
