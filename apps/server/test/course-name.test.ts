import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { chooseCourseName, isRequestedCoursePage, readCourseName } from '../src/automation/course-name.js';
import { PLATFORM_ORIGIN } from '@medcourse/shared';
import { createApp } from '../src/app.js';
import { Store, StoreError } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';

const huayiUrl = 'https://cme28.91huayi.com/pages/course.aspx?cid=433235f5-6cf7-4da3-9000-8760b6c4a1d7';

test('只接受课程名称，拒绝登录和通用网站标题，去除网站后缀', () => {
  assert.equal(chooseCourseName(['登录', '华医网—继续医学教育•用教育推动医疗发展']), null);
  assert.equal(chooseCourseName(['河南省继续医学教育平台', '访问被拦截！']), null);
  assert.equal(chooseCourseName(['', '  基于证据的妇科\n中西医协同治疗  ']), '基于证据的妇科 中西医协同治疗');
  assert.equal(chooseCourseName(['课程名称 - 华医网']), '课程名称');
  assert.equal(chooseCourseName(['x'.repeat(121)]), null);
});

test('登录或跳转至其他课程时不读取标题，河南同课程章节路由可以匹配', () => {
  assert.equal(isRequestedCoursePage('huayi', huayiUrl, 'https://cme28.91huayi.com/secure/login.aspx'), false);
  assert.equal(isRequestedCoursePage('huayi', huayiUrl, huayiUrl.replace('433235f5', 'other')), false);
  assert.equal(isRequestedCoursePage('huayi', huayiUrl, huayiUrl.replace('cme28.', 'cme7.')), false);
  assert.equal(isRequestedCoursePage('huayi', huayiUrl, `${huayiUrl}&source=menu`), true);
  const henan = `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/p`;
  assert.equal(isRequestedCoursePage('henan', henan, `${henan}/v1`), true);
  assert.equal(isRequestedCoursePage('henan', henan, `${PLATFORM_ORIGIN}/#/login`), false);
});

test('读取脚本在独立网页作用域执行，复用已经打开的课程页且不导航、不点击', async () => {
  for (const platformId of ['henan', 'huayi'] as const) {
    const url = platformId === 'henan' ? `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/p` : huayiUrl;
    const title = platformId === 'henan' ? '2026年继续教育公需课' : '基于证据的妇科中西医协同治疗';
    const heading = { textContent: title, getClientRects: () => [{}] };
    const document = {
      title: '通用网站标题', querySelector: () => null,
      querySelectorAll: (selector: string) => selector.includes('password') ? []
        : platformId === 'huayi' ? selector.includes('strong.f14blue') ? [heading] : [] : [heading],
    };
    const page = {
      isClosed: () => false, url: () => url, addInitScript: async () => {},
      goto: () => { throw new Error('现有课程页不应重新导航'); },
      evaluate: (fn: Function, input: unknown) => runInNewContext(`(${fn.toString()})(input)`, { document, input }),
    };
    assert.equal(await readCourseName(page as never, platformId, url), title);
  }
});

test('添加课程只提交链接；名称来自网页，非法和重复链接不启动读取，失败不创建半成品', async () => {
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, { dataDir: '/tmp', maxConcurrency: 1, channel: 'chromium' });
  const user = store.createUser('A');
  const [account] = store.bindPlatforms(user.id, ['huayi']);
  const calls: unknown[] = [];
  scheduler.readCourseName = async (id, url) => { calls.push([id, url]); return '基于证据的妇科中西医协同治疗'; };
  const app = await createApp({ store, scheduler, port: 3000, webPort: 5173, maxConcurrency: 1, webDist: '/not-present', logger: false });
  const add = (learningUrl: string) => app.inject({ method: 'POST', url: `/api/accounts/${account!.id}/courses`, payload: { learningUrl } });
  try {
    assert.equal((await add('https://91huayi.com/')).statusCode, 400);
    assert.equal((await add('https://evil.example/course')).statusCode, 400);
    assert.equal(calls.length, 0);
    const result = await add(` ${huayiUrl} `);
    assert.equal(result.statusCode, 201);
    assert.equal(result.json().name, '基于证据的妇科中西医协同治疗');
    assert.deepEqual(calls, [[account!.id, huayiUrl]]);
    assert.equal((await add(huayiUrl)).statusCode, 409);
    assert.equal(calls.length, 1);
    scheduler.readCourseName = async () => { throw new StoreError('网页要求登录，未添加课程', 422); };
    const failed = await add(huayiUrl.replace('433235f5', 'different'));
    assert.equal(failed.statusCode, 422);
    assert.match(failed.json().message, /要求登录/);
    assert.equal(store.courses(account!.id).length, 1);
    assert.equal(store.jobs().length, 0);
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/missing/courses', payload: { learningUrl: huayiUrl } })).statusCode, 404);
  } finally { await app.close(); store.close(); }
});
