import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { orderCourseVideos, PLATFORM_ORIGIN, type PlatformId, type JobStatus } from '@medcourse/shared';
import { Store } from '../src/store.js';

const learningUrl = (platform: PlatformId, project: string) => platform === 'huayi'
  ? `https://cme28.91huayi.com/pages/course.aspx?cid=${project}`
  : `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/${project}`;
const videos = (prefix: string) => [3, 1, 4, 2].map(position => ({ chapterId: `${prefix}-${position}`, chapterTitle: `视频 ${position}`, position, durationText: '', platformStatus: '未学习' }));

for (const platformId of ['henan', 'huayi'] as const) {
  test(`${platformId} 课程同一时间添加、反向读取目录仍逐课学完，页面保留完成视频的原位置`, t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-11T08:00:00Z') });
    const store = new Store(':memory:');
    try {
      const account = store.bindPlatforms(store.createUser('A').id, [platformId])[0]!;
      // 添加顺序与链接字母顺序、目录读取顺序都不同。
      const courses = ['z', 'a', 'm'].map(project => store.createCourse(account.id, project, learningUrl(platformId, project)));
      for (const course of [...courses].reverse()) store.importPlaylist(account.id, course.learningUrl, course.name, videos(course.name), course.id);
      const byChapter = (chapter: string) => store.jobs().find(job => job.chapterId === chapter)!;
      store.updateJob(byChapter('z-1').id, 'completed', '已学完');
      store.updateJob(byChapter('z-3').id, 'excluded', '已排除');
      assert.deepEqual(orderCourseVideos(store.jobs(), store.courses()).map(job => job.chapterId),
        ['z-1', 'z-2', 'z-3', 'z-4', 'a-1', 'a-2', 'a-3', 'a-4', 'm-1', 'm-2', 'm-3', 'm-4']);
      assert.equal(store.enqueueAll(account.id), 10);
      const expected = ['z-2', 'z-4', 'a-1', 'a-2', 'a-3', 'a-4', 'm-1', 'm-2', 'm-3', 'm-4'];
      for (const chapter of expected) {
        const next = store.nextQueued()!;
        assert.equal(next?.chapterId, chapter);
        store.updateJob(next.id, 'running', '播放中');
        assert.equal(store.nextQueued(), undefined, '当前视频未结束时不能开始其他视频或课程');
        store.updateJob(next.id, 'completed', '平台确认学习结束');
      }
      assert.equal(store.nextQueued(), undefined);
      assert.equal(store.enqueueAll(account.id), 0);
    } finally { store.close(); t.mock.timers.reset(); }
  });
}

test('单视频入口和残留队列都不能跳过前面的未完成课程或视频；归档后可进入下一课', () => {
  const store = new Store(':memory:');
  try {
    const account = store.bindPlatforms(store.createUser('A').id, ['huayi'])[0]!;
    const firstCourse = store.createCourse(account.id, '先学', learningUrl('huayi', 'z'));
    const secondCourse = store.createCourse(account.id, '后学', learningUrl('huayi', 'a'));
    for (const course of [secondCourse, firstCourse]) store.importPlaylist(account.id, course.learningUrl, course.name, videos(course.name).slice(1), course.id);
    const first = store.courseJobs(firstCourse.id).find(job => job.position === 1)!;
    const laterVideo = store.courseJobs(firstCourse.id).find(job => job.position === 2)!;
    const laterCourse = store.courseJobs(secondCourse.id).find(job => job.position === 1)!;
    assert.equal(store.enqueue(laterVideo.id), false);
    assert.equal(store.enqueue(laterCourse.id), false);
    store.updateJob(laterCourse.id, 'queued', '模拟旧队列');
    for (const status of ['idle', 'paused', 'stopped', 'interrupted', 'failed', 'needs_attention'] as JobStatus[]) {
      store.updateJob(first.id, status, '当前视频未完成');
      assert.equal(store.nextQueued(), undefined, `${status} 不能跳到下一课程`);
    }
    assert.ok(store.enqueueAll(account.id) > 0);
    assert.equal(store.nextQueued()?.id, first.id);
    store.pauseQueuedAccount(account.id);
    store.archiveCourse(firstCourse.id);
    assert.equal(store.enqueue(laterCourse.id), true);
    assert.equal(store.nextQueued()?.id, laterCourse.id);
  } finally { store.close(); }
});

test('暂停及重启后从当前课程的未完成视频继续，保留进度，再进入下一门课程', () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-course-order-'));
  const path = join(directory, 'order.sqlite');
  let store = new Store(path);
  try {
    const account = store.bindPlatforms(store.createUser('A').id, ['henan'])[0]!;
    const firstCourse = store.createCourse(account.id, '先学', learningUrl('henan', 'z'));
    const secondCourse = store.createCourse(account.id, '后学', learningUrl('henan', 'a'));
    for (const course of [secondCourse, firstCourse]) store.importPlaylist(account.id, course.learningUrl, course.name, videos(course.name), course.id);
    store.enqueueAll(account.id);
    const completed = store.nextQueued()!;
    store.updateJob(completed.id, 'completed', '已学完');
    const current = store.nextQueued()!;
    store.updateJob(current.id, 'running', '播放中');
    store.updateProgress(current.id, { currentTime: 42, duration: 100, playbackState: 'paused', platformStatus: '学习中', sampledAt: '2026-10-11T08:00:00Z' });
    store.pauseQueuedAccount(account.id);
    store.close();
    store = new Store(path);
    store.recoverInterrupted();
    store.enqueueAll(account.id);
    assert.equal(store.nextQueued()?.id, current.id);
    assert.equal(store.job(current.id)?.currentTime, 42);
    for (const position of [2, 3, 4]) {
      const next = store.nextQueued()!;
      assert.equal(next.courseId, firstCourse.id);
      assert.equal(next.position, position);
      store.updateJob(next.id, 'completed', '已学完');
    }
    assert.equal(store.nextQueued()?.courseId, secondCourse.id);
    assert.equal(store.nextQueued()?.position, 1);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
