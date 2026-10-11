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

test('课程名称读取复用登录子进程和账号会话，独立读取受并发及账号锁约束', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-name-'));
  const store = new Store(':memory:');
  let workers = 0;
  let worker: ChildProcess;
  const scheduler = new Scheduler(store, { dataDir: directory, maxConcurrency: 1, channel: 'chromium', workerFactory: () => {
    workers++;
    return worker = fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  } });
  const user = store.createUser('A');
  const [account] = store.bindPlatforms(user.id, ['huayi']);
  const other = store.createAccount('B', PLATFORM_ORIGIN);
  const url = 'https://cme28.91huayi.com/pages/course.aspx?cid=p';
  try {
    const standalone = scheduler.readCourseName(account!.id, url);
    assert.equal(scheduler.isAccountBusy(account!.id), true);
    await assert.rejects(scheduler.readCourseName(account!.id, url), /正在读取/);
    await assert.rejects(scheduler.readCourseName(other.id, `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/p`), /其他任务/);
    assert.equal(await standalone, '自动读取的课程名称');
    assert.equal(scheduler.isAccountBusy(account!.id), false);
    const login = store.createJob(account!.id, 'login', 'https://91huayi.com/');
    scheduler.pump();
    await until(() => store.job(login.id)?.status === 'waiting_user');
    const before = workers;
    assert.equal(await scheduler.readCourseName(account!.id, url), '自动读取的课程名称');
    assert.equal(workers, before);
    assert.equal(store.job(login.id)?.status, 'waiting_user');
    worker!.send({ type: 'test_authenticated' });
    await until(() => store.account(account!.id)?.loginState === 'saved');
    assert.equal(store.job(login.id)?.status, 'waiting_user', '自动记录不会关闭供人工验证使用的窗口');
    worker!.send({ type: 'test_close' });
    await until(() => store.job(login.id)?.status === 'completed');
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('子进程调度遵守并发上限，登录成功自动记录，关闭窗口后释放账号', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-scheduler-'));
  const store = new Store(':memory:');
  let worker: ChildProcess;
  const scheduler = new Scheduler(store, {
    dataDir: directory, maxConcurrency: 1, channel: 'chromium',
    workerFactory: () => worker = fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
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
    worker!.send({ type: 'test_authenticated' });
    await until(() => store.account(b.id)?.loginState === 'saved');
    assert.equal(store.job(second.id)?.status, 'waiting_user');
    worker!.send({ type: 'test_close' });
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

test('读取指定课程的结果关联该课程，保存登录不覆盖其他课程链接', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-course-playlist-'));
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, {
    dataDir: directory, maxConcurrency: 1, channel: 'chromium',
    workerFactory: () => fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  });
  const account = store.createAccount('A', PLATFORM_ORIGIN);
  const a = store.createCourse(account.id, '课程 A', `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/a`);
  const b = store.createCourse(account.id, '课程 B', `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/b`);
  try {
    for (const course of [a, b]) {
      const task = store.createJob(account.id, 'playlist', course.learningUrl, course.id);
      scheduler.pump();
      await until(() => store.job(task.id)?.status === 'completed' && !scheduler.isAccountBusy(account.id));
      assert.equal(store.courseJobs(course.id).filter(job => job.kind === 'playback').length, 1);
    }
    assert.equal(store.course(a.id)?.learningUrl, a.learningUrl);
    assert.equal(store.course(b.id)?.learningUrl, b.learningUrl);
    assert.equal(store.jobs().filter(job => job.kind === 'playback').length, 2);
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('移除正在运行的课程先阻止后续章节启动，保留进度，再继续其他课程', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-course-archive-'));
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, {
    dataDir: directory, maxConcurrency: 1, channel: 'chromium',
    workerFactory: () => fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  });
  const account = store.createAccount('A', PLATFORM_ORIGIN);
  const a = store.createCourse(account.id, '课程 A', `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/a`);
  const b = store.createCourse(account.id, '课程 B', `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/b`);
  const list = ['first', 'next'].map((id, index) => ({ chapterId: id, chapterTitle: id, position: index + 1, durationText: '', platformStatus: null }));
  store.importPlaylist(account.id, a.learningUrl, a.name, list, a.id);
  store.importPlaylist(account.id, b.learningUrl, b.name, list.slice(0, 1), b.id);
  store.enqueueAll(account.id);
  const first = store.courseJobs(a.id).find(job => job.chapterId === 'first')!;
  const next = store.courseJobs(a.id).find(job => job.chapterId === 'next')!;
  const other = store.courseJobs(b.id)[0]!;
  try {
    scheduler.pump();
    await until(() => store.job(first.id)?.currentTime === 12);
    assert.equal(await scheduler.archiveCourse(a.id), true);
    assert.ok(store.course(a.id)?.archivedAt);
    assert.equal(store.job(first.id)?.currentTime, 12);
    assert.equal(store.job(first.id)?.status, 'stopped');
    assert.equal(store.job(next.id)?.status, 'stopped');
    await until(() => store.job(other.id)?.currentTime === 12);
    assert.equal(store.job(other.id)?.status, 'running');
    assert.equal(store.enqueue(first.id), false);
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});


test('华医网首页登录成功后自动记录，关闭窗口释放账号，不生成视频任务', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-huayi-login-'));
  const store = new Store(':memory:');
  let worker: ChildProcess;
  const scheduler = new Scheduler(store, {
    dataDir: directory, maxConcurrency: 1, channel: 'chromium',
    workerFactory: () => worker = fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  });
  const user = store.createUser('A');
  const [account] = store.bindPlatforms(user.id, ['huayi']);
  const job = store.createJob(account!.id, 'login', 'https://91huayi.com/');
  try {
    scheduler.pump();
    await until(() => store.job(job.id)?.status === 'waiting_user');
    assert.equal(store.account(account!.id)?.loginState, 'none', '打开首页不代表登录成功');
    worker!.send({ type: 'test_authenticated' });
    await until(() => store.account(account!.id)?.loginState === 'saved');
    assert.equal(store.job(job.id)?.status, 'waiting_user');
    assert.equal(scheduler.isAccountBusy(account!.id), true, '窗口保留期间不启动后台任务');
    worker!.send({ type: 'test_close' });
    await until(() => store.job(job.id)?.status === 'completed' && !scheduler.isAccountBusy(account!.id));
    assert.equal(store.jobs().filter(job => job.kind === 'playback').length, 0);
    assert.equal(store.account(account!.id)?.courseUrl, 'https://91huayi.com/');
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('华医网目录任务正常调度，复用账号资料并保存章节，读取结束不启动播放', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-huayi-list-'));
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, { dataDir: directory, maxConcurrency: 1, channel: 'chromium',
    workerFactory: () => fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  });
  try {
    const account = store.bindPlatforms(store.createUser('A').id, ['huayi'])[0]!;
    const course = store.createCourse(account.id, '测试课程', 'https://cme28.91huayi.com/pages/course.aspx?cid=p');
    const job = store.createJob(account.id, 'playlist', course.learningUrl, course.id);
    scheduler.pump();
    await until(() => store.job(job.id)?.status === 'completed');
    assert.equal(store.account(account.id)?.loginState, 'saved');
    assert.equal(store.courseJobs(course.id).filter(row => row.kind === 'playback').length, 1);
    assert.equal(store.courseJobs(course.id).find(row => row.kind === 'playback')?.status, 'idle');
    assert.equal(store.nextQueued(), undefined);
    assert.equal(store.enqueueAll(account.id), 1);
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('华医网逐视频播放，待考试后继续下一节，跨课程串行且暂停保留队列和真实进度', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-huayi-playback-'));
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, { dataDir: directory, maxConcurrency: 2, channel: 'chromium',
    workerFactory: () => fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  });
  try {
    const account = store.bindPlatforms(store.createUser('华医用户').id, ['huayi'])[0]!;
    const course = store.createCourse(account.id, '华医课程', 'https://cme28.91huayi.com/pages/course.aspx?cid=a');
    const other = store.createCourse(account.id, '另一门华医课程', 'https://cme28.91huayi.com/pages/course.aspx?cid=b');
    store.importPlaylist(account.id, course.learningUrl, course.name, [
      { chapterId: 'done', chapterTitle: '已学完', position: 1, durationText: '', platformStatus: '待考试' },
      { chapterId: 'complete-exam', chapterTitle: '当前视频', position: 2, durationText: '', platformStatus: '学习中' },
      { chapterId: 'next', chapterTitle: '下一视频', position: 3, durationText: '', platformStatus: '未学习' },
      { chapterId: 'case', chapterTitle: '病例', position: 4, durationText: '', platformStatus: '未学习', excludedReason: '互动病例演练' },
    ], course.id);
    store.importPlaylist(account.id, other.learningUrl, other.name, [
      { chapterId: 'other', chapterTitle: '其他课程视频', position: 1, durationText: '', platformStatus: '未学习' },
    ], other.id);
    assert.equal(store.enqueueAll(account.id), 3);
    scheduler.pump();
    const jobs = store.jobs();
    const first = jobs.find(job => job.chapterId === 'complete-exam')!;
    const next = jobs.find(job => job.chapterId === 'next')!;
    const later = jobs.find(job => job.chapterId === 'other')!;
    await until(() => store.job(first.id)?.status === 'completed' && store.job(next.id)?.currentTime === 12);
    assert.equal(store.job(first.id)?.platformStatus, '待考试');
    assert.equal(store.job(later.id)?.status, 'queued');
    assert.equal(store.jobs().filter(job => job.status === 'running').length, 1, '增加并发也不能同时播放同账号两节视频');
    assert.equal(await scheduler.pauseAccount(account.id), true);
    assert.equal(store.job(next.id)?.status, 'paused');
    assert.equal(store.job(next.id)?.currentTime, 12);
    assert.equal(store.job(later.id)?.status, 'paused');
    assert.equal(store.enqueueAll(account.id), 2, '继续只排未完成视频，排除病例和待考试');
    scheduler.pump();
    await until(() => store.job(next.id)?.status === 'running');
    assert.equal(store.job(later.id)?.status, 'queued');
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('视频进程意外退出会暂停后续队列，不会跳过当前失败视频', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-playback-crash-'));
  const store = new Store(':memory:');
  let worker: ChildProcess;
  const scheduler = new Scheduler(store, { dataDir: directory, maxConcurrency: 2, channel: 'chromium',
    workerFactory: () => worker = fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
  });
  try {
    const account = store.bindPlatforms(store.createUser('A').id, ['huayi'])[0]!;
    const course = store.createCourse(account.id, '课程', 'https://cme28.91huayi.com/pages/course.aspx?cid=a');
    store.importPlaylist(account.id, course.learningUrl, course.name, [1, 2].map(position => ({ chapterId: `v${position}`, chapterTitle: `视频${position}`, position, durationText: '', platformStatus: '未学习' })), course.id);
    store.enqueueAll(account.id);
    const first = store.jobs().find(job => job.chapterId === 'v1')!, next = store.jobs().find(job => job.chapterId === 'v2')!;
    scheduler.pump();
    await until(() => store.job(first.id)?.currentTime === 12);
    worker!.kill('SIGKILL');
    await until(() => store.job(first.id)?.status === 'failed');
    assert.equal(store.job(first.id)?.currentTime, 12);
    assert.equal(store.job(next.id)?.status, 'paused');
    assert.equal(store.nextQueued(), undefined);
    assert.equal(store.enqueueAll(account.id), 2);
    assert.equal(store.nextQueued()?.id, first.id, '人工继续后从失败视频重试');
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});
