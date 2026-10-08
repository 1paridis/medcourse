import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { PLATFORM_ORIGIN } from '@medcourse/shared';

test('账号配置写入 SQLite，关闭后可重新读取', () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-store-'));
  const path = join(directory, 'app.sqlite');
  const first = new Store(path);
  const account = first.createAccount('账号 A', `${PLATFORM_ORIGIN}/course/1`);
  first.saveLogin(account.id);
  first.close();
  const second = new Store(path);
  try { assert.equal(second.account(account.id)?.loginState, 'saved'); assert.equal(second.accounts().length, 1); }
  finally { second.close(); rmSync(directory, { recursive: true }); }
});

test('数据库阻止一个账号同时创建两个活动任务，完成后可再次创建', () => {
  const store = new Store(':memory:');
  try {
    const account = store.createAccount('账号 A', PLATFORM_ORIGIN);
    const first = store.createJob(account.id, 'login', PLATFORM_ORIGIN);
    assert.throws(() => store.createJob(account.id, 'inspect', PLATFORM_ORIGIN));
    store.updateJob(first.id, 'completed', '登录已保存');
    assert.equal(store.createJob(account.id, 'inspect', PLATFORM_ORIGIN).status, 'queued');
  } finally { store.close(); }
});

test('重启将运行和人工等待任务标记为中断，排队任务可以保留', () => {
  const store = new Store(':memory:');
  try {
    const jobs = ['running', 'waiting_user', 'queued'].map((status, index) => {
      const account = store.createAccount(`账号 ${index}`, PLATFORM_ORIGIN);
      const job = store.createJob(account.id, 'login', PLATFORM_ORIGIN);
      if (status !== 'queued') store.updateJob(job.id, status as 'running' | 'waiting_user', '测试');
      return job;
    });
    store.recoverInterrupted();
    assert.deepEqual(jobs.map(job => store.job(job.id)?.status), ['interrupted', 'interrupted', 'queued']);
  } finally { store.close(); }
});

test('播放列表重复导入不重复建任务，保留实际进度，超过 100 个视频仍完整返回', () => {
  const store = new Store(':memory:');
  try {
    const account = store.createAccount('A', PLATFORM_ORIGIN);
    const items = Array.from({ length: 120 }, (_, i) => ({ chapterId: `video-${i}`, chapterTitle: `视频 ${i + 1}`, position: i + 1, durationText: '00:10:00', platformStatus: '未学习' }));
    assert.deepEqual(store.importPlaylist(account.id, PLATFORM_ORIGIN, '课程', items), { added: 120, total: 120 });
    const job = store.jobs().find(job => job.chapterId === 'video-0')!;
    assert.equal(job.currentTime, null);
    assert.equal(job.duration, null);
    store.updateProgress(job.id, { currentTime: 42.5, duration: 600, playbackState: 'playing', platformStatus: '学习中', sampledAt: new Date().toISOString() });
    assert.deepEqual(store.importPlaylist(account.id, PLATFORM_ORIGIN, '课程新名称', items), { added: 0, total: 120 });
    assert.equal(store.jobs().length, 120);
    assert.equal(store.job(job.id)?.currentTime, 42.5);
    assert.equal(store.job(job.id)?.courseTitle, '课程新名称');
    assert.throws(() => store.importPlaylist(account.id, PLATFORM_ORIGIN, '错误列表', [items[0]!, items[0]!]));
    assert.equal(store.jobs().length, 120);
    store.updateProgress(job.id, { currentTime: NaN, duration: 600, playbackState: 'playing', platformStatus: null, sampledAt: null });
    assert.equal(store.job(job.id)?.currentTime, 42.5);
  } finally { store.close(); }
});

test('同账号视频可顺序排队，数据库拒绝同时运行；人工处理阻止继续启动', () => {
  const store = new Store(':memory:');
  try {
    const account = store.createAccount('A', PLATFORM_ORIGIN);
    store.importPlaylist(account.id, PLATFORM_ORIGIN, '课程', [1, 2].map(i => ({ chapterId: `v${i}`, chapterTitle: `视频 ${i}`, position: i, durationText: '', platformStatus: null })));
    assert.equal(store.enqueueAll(account.id), 2);
    const first = store.nextQueued()!;
    assert.equal(first.chapterId, 'v1');
    store.updateJob(first.id, 'running', '测试');
    assert.equal(store.nextQueued(), undefined);
    const second = store.jobs().find(job => job.chapterId === 'v2')!;
    assert.throws(() => store.updateJob(second.id, 'running', '测试'));
    store.updateJob(first.id, 'needs_attention', '平台要求验证');
    assert.equal(store.nextQueued(), undefined);
    store.pauseQueuedAccount(account.id);
    assert.equal(store.job(second.id)?.status, 'paused');
    assert.equal(store.enqueue(first.id), true);
    assert.equal(store.nextQueued()?.id, first.id);
  } finally { store.close(); }
});

test('视频进度写入后在数据库重启恢复中保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-progress-'));
  const path = join(directory, 'progress.sqlite');
  const first = new Store(path);
  const account = first.createAccount('A', PLATFORM_ORIGIN);
  first.importPlaylist(account.id, PLATFORM_ORIGIN, '课程', [{ chapterId: 'v1', chapterTitle: '视频', position: 1, durationText: '', platformStatus: null }]);
  const job = first.jobs()[0]!;
  first.updateJob(job.id, 'running', '播放中');
  first.updateProgress(job.id, { currentTime: 25, duration: 90, playbackState: 'playing', platformStatus: '学习中', sampledAt: '2026-10-08T12:00:00.000Z' });
  first.close();
  const second = new Store(path);
  try {
    second.recoverInterrupted();
    assert.equal(second.job(job.id)?.status, 'interrupted');
    assert.equal(second.job(job.id)?.currentTime, 25);
    assert.equal(second.job(job.id)?.duration, 90);
    assert.equal(second.job(job.id)?.sampledAt, '2026-10-08T12:00:00.000Z');
  } finally { second.close(); rmSync(directory, { recursive: true }); }
});
