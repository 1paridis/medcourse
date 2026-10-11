import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLearningUrl, PLATFORM_ORIGIN } from '@medcourse/shared';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/app.js';

const henanUrl = (id: string) => `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/${id}`;
const huayiUrl = 'https://cme28.91huayi.com/course/detail?id=1#/lesson/2';
const items = [{ chapterId: 'shared-video-id', chapterTitle: '第一节', position: 1, durationText: '10:00', platformStatus: '未学习' }];

async function fixture() {
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, { dataDir: '/tmp', maxConcurrency: 1, channel: 'chromium' });
  scheduler.pump = () => {};
  scheduler.readCourseName = async () => '网页课程名称';
  const app = await createApp({ store, scheduler, port: 3000, webPort: 5173, maxConcurrency: 1, webDist: '/not-present', logger: false });
  return { store, scheduler, app, close: async () => { await app.close(); store.close(); } };
}

test('网站链接仅做本地检查，保留查询与 hash，拒绝首页、伪造域名及其他协议', () => {
  assert.equal(isLearningUrl('huayi', huayiUrl), true);
  assert.equal(isLearningUrl('henan', henanUrl('p')), true);
  for (const url of ['https://91huayi.com/', 'https://www.91huayi.com/index.html', 'http://cme28.91huayi.com/course/1', 'https://91huayi.com.example.com/course/1', 'https://evil91huayi.com/course/1', 'https://user:password@cme28.91huayi.com/course/1', 'https://cme28.91huayi.com:444/course/1', 'javascript:alert(1)', henanUrl('p')]) {
    assert.equal(isLearningUrl('huayi', url), false, url);
  }
  assert.equal(isLearningUrl('unknown', huayiUrl), false);
});

test('绑定网站不要求课程；可重复提交，未知网站不会导致部分绑定', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/users', payload: { name: '  ' } })).statusCode, 400);
    const response = await f.app.inject({ method: 'POST', url: '/api/users', payload: { name: '张医生' } });
    const id = response.json().id;
    assert.equal(f.store.accounts().length, 0);
    const invalid = await f.app.inject({ method: 'POST', url: `/api/users/${id}/accounts`, payload: { platformIds: ['henan', 'invalid'] } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(f.store.accounts().length, 0);
    const bind = () => f.app.inject({ method: 'POST', url: `/api/users/${id}/accounts`, payload: { platformIds: ['henan', 'huayi'] } });
    assert.equal((await bind()).statusCode, 201);
    const ids = f.store.accounts().map(account => account.id);
    await bind();
    assert.deepEqual(f.store.accounts().map(account => account.id), ids);
    assert.equal(f.store.courses().length, 0);
    const overview = (await f.app.inject('/api/overview')).json();
    assert.equal(overview.users.length, 1);
    assert.equal(overview.platforms.length, 2);
  } finally { await f.close(); }
});

test('同一网站可保存多门课，同名和不同用户不混用，精确重复链接被拒绝', async () => {
  const f = await fixture();
  try {
    const a = f.store.createUser('A'), b = f.store.createUser('B');
    const [aa] = f.store.bindPlatforms(a.id, ['huayi']);
    const [bb] = f.store.bindPlatforms(b.id, ['huayi']);
    const add = (accountId: string, learningUrl = huayiUrl) => f.app.inject({ method: 'POST', url: `/api/accounts/${accountId}/courses`, payload: { learningUrl } });
    const first = await add(aa!.id);
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().learningUrl, huayiUrl);
    assert.equal((await add(aa!.id, `${huayiUrl}3`)).statusCode, 201);
    assert.equal((await add(aa!.id)).statusCode, 409);
    assert.equal((await add(bb!.id)).statusCode, 201);
    assert.equal((await add(aa!.id, henanUrl('p'))).statusCode, 400);
    assert.equal((await add(aa!.id, 'https://91huayi.com/')).statusCode, 400);
    assert.equal(first.json().name, '网页课程名称');
    assert.equal((await f.app.inject(`/api/accounts/${aa!.id}/courses`)).json().length, 2);
    assert.equal((await f.app.inject(`/api/accounts/${bb!.id}/courses`)).json().length, 1);
    const edited = await f.app.inject({ method: 'PATCH', url: `/api/courses/${first.json().id}`, payload: { name: '已修改', learningUrl: `${huayiUrl}4` } });
    assert.equal(edited.json().created, false);
    assert.equal(edited.json().course.id, first.json().id);
  } finally { await f.close(); }
});

test('华医网检查入口被拒绝，目录读取仅接受具体项目链接，无视频时不能开始学习', async () => {
  const f = await fixture();
  try {
    const user = f.store.createUser('A');
    const [account] = f.store.bindPlatforms(user.id, ['huayi']);
    const course = f.store.createCourse(account!.id, '课程', huayiUrl);
    f.store.saveLogin(account!.id); // 即使伪造已保存登录，也不能绕过能力限制。
    for (const kind of ['inspect']) {
      const result = await f.app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account!.id, courseId: course.id, kind, url: henanUrl('p') } });
      assert.equal(result.statusCode, 409);
      assert.match(result.json().message, /尚未接入/);
    }
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account!.id, courseId: course.id, kind: 'playlist' } })).statusCode, 400);
    for (const action of ['start-all', 'pause-all']) assert.equal((await f.app.inject({ method: 'POST', url: `/api/accounts/${account!.id}/${action}` })).statusCode, 409);
    assert.throws(() => f.store.createJob(account!.id, 'login', henanUrl('p')));
    assert.throws(() => f.store.importPlaylist(account!.id, henanUrl('p'), '课程', items));
    assert.equal(f.store.enqueueAll(account!.id), 0);
    assert.equal(f.store.jobs().length, 0);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/courses/${course.id}/archive` })).statusCode, 200);
    assert.ok(f.store.course(course.id)?.archivedAt);
  } finally { await f.close(); }
});

test('华医网仅开放首页人工登录，不能借登录入口执行课程或换网址', async () => {
  const f = await fixture();
  try {
    const user = f.store.createUser('A');
    const [account] = f.store.bindPlatforms(user.id, ['huayi']);
    const course = f.store.createCourse(account!.id, '课程', huayiUrl);
    const login = (extra: object = {}) => f.app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account!.id, kind: 'login', ...extra } });
    assert.equal((await login({ courseId: course.id })).statusCode, 400);
    assert.equal((await login({ url: henanUrl('other') })).statusCode, 400);
    const result = await login();
    assert.equal(result.statusCode, 201);
    assert.equal(result.json().url, 'https://91huayi.com/');
    assert.equal(result.json().courseId, null);
    assert.equal(f.store.nextQueued()?.id, result.json().id);
    assert.equal((await login()).statusCode, 409);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/jobs/${result.json().id}/stop` })).statusCode, 200);
    assert.equal(f.store.job(result.json().id)?.status, 'stopped');
  } finally { await f.close(); }
});

test('河南执行按课程取链接，拒绝跨账号课程和覆盖 URL，保存登录不更改课程', async () => {
  const f = await fixture();
  try {
    const user = f.store.createUser('A');
    const [account] = f.store.bindPlatforms(user.id, ['henan']);
    const other = f.store.createAccount('B', PLATFORM_ORIGIN);
    const course = f.store.createCourse(account!.id, '我的课程', henanUrl('p'));
    const foreign = f.store.createCourse(other.id, '其他用户课程', henanUrl('other'));
    f.store.saveLogin(account!.id);
    const request = (extra: object) => f.app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account!.id, kind: 'playlist', ...extra } });
    assert.equal((await request({ courseId: foreign.id })).statusCode, 404);
    assert.equal((await request({ courseId: course.id, url: henanUrl('wrong') })).statusCode, 400);
    const result = await request({ courseId: course.id });
    assert.equal(result.statusCode, 201);
    assert.equal(result.json().url, course.learningUrl);
    assert.equal(result.json().courseId, course.id);
    f.store.saveLogin(account!.id, `${PLATFORM_ORIGIN}/`);
    assert.equal(f.store.course(course.id)?.learningUrl, henanUrl('p'));
    assert.throws(() => f.store.createJob(other.id, 'login', foreign.learningUrl, course.id));
  } finally { await f.close(); }
});

test('登录由网站统一管理，固定打开首页并拒绝课程级登录', async () => {
  const f = await fixture();
  try {
    const account = f.store.createAccount('A', PLATFORM_ORIGIN);
    const course = f.store.createCourse(account.id, '目标课程', henanUrl('target'));
    f.store.saveLogin(account.id, henanUrl('last-visited'));
    const login = (courseId?: string) => f.app.inject({ method: 'POST', url: '/api/jobs', payload: {
      accountId: account.id, kind: 'login', ...(courseId ? { courseId } : {}),
    } });
    const homepage = await login();
    assert.equal(homepage.statusCode, 201);
    assert.equal(homepage.json().url, `${PLATFORM_ORIGIN}/`);
    assert.equal(homepage.json().courseId, null);
    await f.scheduler.stop(homepage.json().id);
    const courseLogin = await login(course.id);
    assert.equal(courseLogin.statusCode, 400);
    assert.match(courseLogin.json().message, /网站统一管理/);
    assert.equal(f.store.course(course.id)?.learningUrl, course.learningUrl);
  } finally { await f.close(); }
});

test('不同课程共享章节 ID 也各自保留进度，重复读取不新增，错课结果整体拒绝', () => {
  const store = new Store(':memory:');
  try {
    const account = store.createAccount('A', PLATFORM_ORIGIN);
    const a = store.createCourse(account.id, '课程 A', henanUrl('a'));
    const b = store.createCourse(account.id, '课程 B', henanUrl('b'));
    store.importPlaylist(account.id, henanUrl('a'), '课程 A', items, a.id);
    const first = store.jobs()[0]!;
    store.updateProgress(first.id, { currentTime: 42, duration: 100, playbackState: 'paused', platformStatus: '学习中', sampledAt: '2026-10-11T00:00:00Z' });
    store.importPlaylist(account.id, henanUrl('b'), '课程 B', items, b.id);
    assert.deepEqual(store.importPlaylist(account.id, henanUrl('a'), '课程 A', items, a.id), { added: 0, total: 1 });
    assert.equal(store.jobs().length, 2);
    assert.equal(store.job(first.id)?.currentTime, 42);
    assert.equal(store.courseJobs(b.id)[0]?.currentTime, null);
    assert.throws(() => store.importPlaylist(account.id, henanUrl('b'), '课程 B', items, a.id), /所选课程不一致/);
    assert.equal(store.jobs().length, 2);
  } finally { store.close(); }
});

test('有历史任务时修改链接保存为新课程；改名、归档不篡改历史且排除后续启动', async () => {
  const f = await fixture();
  try {
    const account = f.store.createAccount('A', PLATFORM_ORIGIN);
    const course = f.store.createCourse(account.id, '原课程', henanUrl('old'));
    f.store.importPlaylist(account.id, course.learningUrl, '原课程', items, course.id);
    const original = f.store.courseJobs(course.id)[0]!;
    const rename = f.store.updateCourse(course.id, '新名字', course.learningUrl);
    assert.equal(rename.created, false);
    const changed = f.store.updateCourse(course.id, '新内容', henanUrl('new'));
    assert.equal(changed.created, true);
    assert.notEqual(changed.course.id, course.id);
    assert.equal(f.store.course(course.id)?.learningUrl, course.learningUrl);
    assert.equal(f.store.job(original.id)?.url, course.learningUrl);
    f.store.enqueueAll(account.id);
    assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/courses/${course.id}`, payload: { name: '忙时改链接', learningUrl: henanUrl('busy') } })).statusCode, 409);
    const archive = await f.app.inject({ method: 'POST', url: `/api/courses/${course.id}/archive` });
    assert.equal(archive.statusCode, 200);
    assert.equal(f.store.job(original.id)?.status, 'stopped');
    assert.equal(f.store.job(original.id)?.courseId, course.id);
    assert.equal(f.store.enqueueAll(account.id), 0);
    assert.equal(f.store.enqueue(original.id), false);
    assert.throws(() => f.store.updateCourse(course.id, '改名', course.learningUrl));
    assert.equal(f.store.courseJobs(course.id).length, 1);
  } finally { await f.close(); }
});

test('v2 多课程迁移保留标识进度和日志，旧队列不自动开始，备份与迁移可重复启动', () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-v2-'));
  const path = join(directory, 'old.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, courseUrl TEXT NOT NULL, loginState TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id), kind TEXT NOT NULL, status TEXT NOT NULL, url TEXT NOT NULL, detail TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, chapterId TEXT, courseTitle TEXT, currentTime REAL);
    CREATE TABLE job_logs (id INTEGER PRIMARY KEY, jobId TEXT NOT NULL REFERENCES jobs(id), level TEXT NOT NULL, message TEXT NOT NULL, createdAt TEXT NOT NULL);
    PRAGMA user_version = 2;
  `);
  for (const [id, url] of [['a', henanUrl('one')], ['b', PLATFORM_ORIGIN]]) db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?)').run(id!, '同名用户', url!, 'saved', '2026-10-08');
  for (const [id, url] of [['j1', henanUrl('one')], ['j2', henanUrl('two')]]) db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id!, 'a', 'playback', 'queued', url!, '旧任务', '2026-10-08', '2026-10-08', 'v1', id!, 42);
  db.prepare('INSERT INTO job_logs VALUES (?, ?, ?, ?, ?)').run(1, 'j1', 'info', '旧日志', '2026-10-08');
  db.close();
  try {
    let store = new Store(path);
    assert.equal(store.users().length, 2);
    assert.notEqual(store.account('a')?.userId, store.account('b')?.userId);
    assert.equal(store.account('a')?.loginState, 'saved');
    assert.equal(store.courses('a').length, 2);
    assert.equal(store.courses('b').length, 0);
    assert.notEqual(store.job('j1')?.courseId, store.job('j2')?.courseId);
    assert.equal(store.job('j1')?.currentTime, 42);
    assert.equal(store.job('j1')?.status, 'interrupted');
    assert.equal(store.logs('j1')[0]?.message, '旧日志');
    assert.equal(store.nextQueued(), undefined);
    const ids = store.courses().map(course => course.id);
    store.close();
    const backups = readdirSync(directory).filter(name => name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(directory, backups[0]!));
    assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
    assert.equal(backup.prepare('SELECT currentTime FROM jobs WHERE id = ?').get('j1')?.currentTime, 42);
    backup.close();
    store = new Store(path);
    assert.equal(store.users().length, 2);
    assert.deepEqual(store.courses().map(course => course.id), ids);
    assert.equal(readdirSync(directory).filter(name => name.endsWith('.bak')).length, 1);
    store.close();
  } finally { rmSync(directory, { recursive: true }); }
});

test('多用户多网站的课程及归档状态重启后保留，删除用户只清理所属资料', () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-multi-persist-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  try {
    const a = store.createUser('A'), b = store.createUser('B');
    const accounts = store.bindPlatforms(a.id, ['henan', 'huayi']);
    const henan = accounts.find(account => account.platformId === 'henan')!;
    const huayi = accounts.find(account => account.platformId === 'huayi')!;
    const [other] = store.bindPlatforms(b.id, ['huayi']);
    const first = store.createCourse(henan.id, '河南课', henanUrl('a'));
    const second = store.createCourse(huayi.id, '华医课', huayiUrl);
    store.createCourse(huayi.id, '另一门课', `${huayiUrl}3`);
    const foreign = store.createCourse(other!.id, 'B 的课', huayiUrl);
    store.importPlaylist(henan.id, first.learningUrl, first.name, items, first.id);
    const job = store.courseJobs(first.id)[0]!;
    store.log(job.id, 'info', '课程历史日志');
    store.archiveCourse(second.id);
    store.renameUser(a.id, '已改名的 A');
    const courses = store.courses(), users = store.users(), bindings = store.accounts();
    store.close();
    store = new Store(path);
    assert.deepEqual(store.courses(), courses);
    assert.deepEqual(store.users(), users);
    assert.deepEqual(store.accounts(), bindings);
    store.deleteUser(a.id);
    assert.equal(store.users().length, 1);
    assert.equal(store.account(henan.id), undefined);
    assert.equal(store.course(first.id), undefined);
    assert.equal(store.job(job.id), undefined);
    assert.deepEqual(store.logs(job.id), []);
    assert.equal(store.course(foreign.id)?.accountId, other!.id);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('归档的人工处理任务不再阻塞同账号其他课程启动', () => {
  const store = new Store(':memory:');
  try {
    const account = store.createAccount('A', PLATFORM_ORIGIN);
    const a = store.createCourse(account.id, 'A', henanUrl('a'));
    const b = store.createCourse(account.id, 'B', henanUrl('b'));
    store.importPlaylist(account.id, a.learningUrl, a.name, items, a.id);
    store.importPlaylist(account.id, b.learningUrl, b.name, items, b.id);
    const blocked = store.courseJobs(a.id)[0]!, ready = store.courseJobs(b.id)[0]!;
    store.updateJob(blocked.id, 'needs_attention', '需要处理');
    store.archiveCourse(a.id);
    assert.equal(store.enqueue(ready.id), true);
    assert.equal(store.nextQueued()?.id, ready.id);
    assert.equal(store.job(blocked.id)?.status, 'needs_attention');
  } finally { store.close(); }
});
