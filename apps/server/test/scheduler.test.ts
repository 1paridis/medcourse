import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
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
