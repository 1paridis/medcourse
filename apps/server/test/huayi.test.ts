import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { isHuayiCourseUrl, readHuayiPlaylist } from '../src/automation/huayi.js';
import { openHuayiVideo } from '../src/automation/huayi-playback.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/app.js';

const url = 'https://cme28.91huayi.com/pages/course.aspx?cid=course-a';
const title = '基于证据的妇科中西医协同治疗';

function fakePage(options: { currentUrl?: string; duplicate?: boolean; invalidTime?: boolean; wrongHost?: boolean; navigate?: (url: string) => void } = {}) {
  const nodes: any[] = [];
  const category = (textContent: string) => nodes.push({ textContent, matches: (selector: string) => selector === '.exam_tit', previousElementSibling: nodes.at(-1) });
  const row = (id: string, position: number, status: string, maxtime: string, totaltime: string) => nodes.push({
    matches: () => false, previousElementSibling: nodes.at(-1),
    getAttribute: () => options.wrongHost ? 'https://evil.example/course_ware/course_ware.aspx?cwid=1' : `../course_ware/course_ware.aspx?cwid=${options.duplicate ? 'duplicate' : id}`,
    querySelector: (selector: string) => selector === '.cw-progress-row' ? { dataset: { studystate: status, maxtime: options.invalidTime ? 'NaN' : maxtime, totaltime } }
      : { textContent: selector === '.cw-index' ? `${position}.` : selector === '.cw-status button' ? status : `第${position}节` },
  });
  category('课程学习与考试');
  row('a', 1, '待考试', '3414', '3414');
  row('b', 2, '学习中', '1451', '2938');
  category('互动病例演练');
  row('case', 3, '未学习', '0', '0');
  category('课程学习与考试');
  row('c', 4, '未学习', '0', '3318');
  const document = { querySelector: () => ({ textContent: title }), querySelectorAll: () => nodes.filter(node => node.getAttribute) };
  return { url: () => options.currentUrl ?? url, locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    goto: async (target: string) => options.navigate?.(target),
    evaluate: (fn: Function, input: unknown) => runInNewContext(`(${fn.toString()})(input)`, { document, input, URL, location: { href: url } }) } as never;
}

test('华医播放只打开所属目录的目标视频原始链接，跳过待考试，禁止病例和未知章节', async () => {
  const navigations: string[] = [];
  const page = fakePage({ navigate: url => navigations.push(url) });
  await openHuayiVideo(page, url, 'a');
  assert.equal(navigations.length, 0, '待考试视频不打开、不重播');
  await assert.rejects(openHuayiVideo(page, url, 'case'), /病例/);
  await assert.rejects(openHuayiVideo(page, url, 'missing'), /未找到/);
  await openHuayiVideo(page, url, 'b');
  assert.deepEqual(navigations, ['https://cme28.91huayi.com/course_ware/course_ware.aspx?cwid=b']);
});

test('华医目录读取脚本可独立执行，保留真实时长、待考试和学习中，按分类排除病例而非位置', async () => {
  const result = await readHuayiPlaylist(fakePage(), url);
  assert.equal(result.courseTitle, title);
  assert.equal(result.items.length, 4);
  assert.equal(result.items[0]?.platformStatus, '待考试');
  assert.equal(result.items[0]?.progress?.currentTime, 3414);
  assert.equal(result.items[1]?.progress?.currentTime, 1451);
  assert.equal(result.items[1]?.progress?.duration, 2938);
  assert.equal(result.items[1]?.progress?.playbackState, 'unknown');
  assert.equal(result.items[1]?.durationText, '00:48:58');
  assert.match(result.items[2]?.excludedReason ?? '', /互动病例演练/);
  assert.equal(result.items[2]?.progress?.duration, null);
  assert.equal(result.items[3]?.excludedReason, undefined);
});

test('华医目录拒绝登录跳转、错课、伪造链接、重复章节和无效进度', async () => {
  for (const currentUrl of ['https://91huayi.com/', url.replace('course-a', 'course-b')]) {
    await assert.rejects(readHuayiPlaylist(fakePage({ currentUrl }), url), /登录/);
  }
  await assert.rejects(readHuayiPlaylist(fakePage({ duplicate: true }), url), /重复/);
  await assert.rejects(readHuayiPlaylist(fakePage({ invalidTime: true }), url), /进度无效/);
  await assert.rejects(readHuayiPlaylist(fakePage({ wrongHost: true }), url), /链接或编号/);
  for (const value of ['https://91huayi.com/', url.replace('?cid=course-a', ''), url.replace('course.aspx', 'exam.aspx'), `${url}#other`]) assert.equal(isHuayiCourseUrl(value), false);
});

test('华医目录按课程隔离并可刷新，学习完成和排除不进入播放队列，错课不写入', async () => {
  const store = new Store(':memory:');
  try {
    const user = store.createUser('A');
    const account = store.bindPlatforms(user.id, ['huayi'])[0]!;
    const course = store.createCourse(account.id, title, url);
    const other = store.createCourse(account.id, title, url.replace('course-a', 'course-b'));
    const data = await readHuayiPlaylist(fakePage(), url);
    assert.deepEqual(store.importPlaylist(account.id, url, title, data.items, course.id), { added: 4, total: 4 });
    let rows = store.courseJobs(course.id).sort((a, b) => a.position! - b.position!);
    const ids = rows.map(row => row.id);
    assert.deepEqual(rows.map(row => row.status), ['completed', 'idle', 'excluded', 'idle']);
    assert.equal(rows[1]?.currentTime, 1451);
    assert.match(rows[0]!.detail, /考试暂不处理/);
    assert.equal(store.enqueue(rows[1]!.id), true);
    assert.equal(store.enqueue(rows[2]!.id), false);
    assert.equal(store.enqueueAll(account.id), 1);
    assert.equal(store.nextQueued()?.chapterId, 'b');
    store.pauseQueuedAccount(account.id);
    data.items[1]!.progress!.currentTime = 1600;
    assert.deepEqual(store.importPlaylist(account.id, url, title, data.items, course.id), { added: 0, total: 4 });
    rows = store.courseJobs(course.id).sort((a, b) => a.position! - b.position!);
    assert.deepEqual(rows.map(row => row.id), ids);
    assert.equal(rows[1]?.currentTime, 1600);
    assert.throws(() => store.importPlaylist(account.id, url, title, data.items, other.id), /所选课程不一致/);
    assert.equal(store.courseJobs(other.id).length, 0);
    store.importPlaylist(account.id, other.learningUrl, title, data.items, other.id);
    assert.equal(store.courseJobs(other.id).length, 4);
    store.archiveCourse(other.id);
    assert.throws(() => store.importPlaylist(account.id, other.learningUrl, title, data.items, other.id), /课程已移除/);
  } finally { store.close(); }
});

test('华医目录 API 支持共用网站资料读取；登录和目录互斥，读取后可开始并暂停未完成视频', async () => {
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, { dataDir: '/tmp', maxConcurrency: 1, channel: 'chromium' });
  scheduler.pump = () => {};
  const app = await createApp({ store, scheduler, port: 3000, webPort: 5173, maxConcurrency: 1, webDist: '/not-present', logger: false });
  try {
    const account = store.bindPlatforms(store.createUser('A').id, ['huayi'])[0]!;
    const course = store.createCourse(account.id, title, url);
    const request = (extra: object = {}) => app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account.id, kind: 'playlist', courseId: course.id, ...extra } });
    assert.equal((await request({ url: url.replace('course-a', 'other') })).statusCode, 400);
    assert.equal((await request({ courseId: 'other-account-course' })).statusCode, 404);
    const login = store.createJob(account.id, 'login', 'https://91huayi.com/');
    assert.equal((await request()).statusCode, 409);
    await scheduler.stop(login.id);
    const result = await request();
    assert.equal(result.statusCode, 201);
    assert.equal(result.json().courseId, course.id);
    assert.equal(store.nextQueued()?.id, result.json().id);
    assert.equal((await request()).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/start-all` })).statusCode, 409);
    await scheduler.stop(result.json().id);
    const playlist = await readHuayiPlaylist(fakePage(), url);
    store.importPlaylist(account.id, url, title, playlist.items, course.id);
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/start-all` })).statusCode, 409, '未保存登录不能播放');
    store.saveLogin(account.id);
    const start = await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/start-all` });
    assert.equal(start.statusCode, 200);
    assert.equal(start.json().queued, 2);
    assert.equal(store.nextQueued()?.chapterId, 'b');
    assert.equal((await request()).statusCode, 409, '播放排队时不能读取目录');
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/pause-all` })).statusCode, 200);
    assert.deepEqual(store.courseJobs(course.id).filter(job => job.kind === 'playback').sort((a, b) => a.position! - b.position!).map(job => job.status), ['completed', 'paused', 'excluded', 'paused']);
  } finally { await app.close(); store.close(); }
});
