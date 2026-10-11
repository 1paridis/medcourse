import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isAuthenticated, isLoginOrigin, findAuthenticatedPage, LoginRecorder, saveLoginSession } from '../src/automation/login.js';
import { writeSessionFile } from '../src/automation/course-name.js';

function page(url: string, state: { password?: boolean; logout?: string; hiddenLogout?: boolean; account?: boolean; login?: boolean } = {}) {
  const node = (text: string, visible = true) => ({ textContent: text, getClientRects: () => visible ? [{}] : [] });
  const document = {
    querySelectorAll: (selector: string) => selector.includes('password')
      ? state.password ? [node('')] : [] : state.logout ? [node(state.logout, !state.hiddenLogout)] : [],
    querySelector: (selector: string) => selector === '#ifssologed' ? state.account ? node('Hi') : null
      : state.login ? node('登录') : null,
  };
  const result = { url: () => url, evaluate: async (fn: Function, id: string) => runInNewContext(`(${fn.toString()})(id)`, {
    id, document, location: { href: url }, URL, __name: (value: unknown) => value, getComputedStyle: () => ({ visibility: 'visible' }),
  }), frames: () => [result] };
  return result;
}

test('自动识别只接受所属网站 HTTPS 页面，不接受相似域名和带凭据地址', () => {
  for (const value of ['https://91huayi.com/', 'https://cme28.91huayi.com/pages/course.aspx']) assert.equal(isLoginOrigin(value, 'huayi'), true);
  for (const value of ['http://91huayi.com/', 'https://evil91huayi.com/', 'https://91huayi.com.evil.test/', 'https://91huayi.com:444/', 'https://user@91huayi.com/', 'about:blank']) assert.equal(isLoginOrigin(value, 'huayi'), false);
  assert.equal(isLoginOrigin('https://yuancheng.henanyixue.com/#/', 'henan'), true);
  assert.equal(isLoginOrigin('https://cme28.91huayi.com/', 'henan'), false);
});

test('首页无密码框也不能证明登录；隐藏退出模板、未登录账号区均不触发自动记录', async () => {
  for (const state of [{}, { logout: '退出登录', hiddenLogout: true }, { account: true, login: true }, { logout: '退出登录', password: true }]) {
    assert.equal(await isAuthenticated(page('https://91huayi.com/', state) as never, 'huayi'), false);
  }
  assert.equal(await isAuthenticated(page('https://91huayi.com/', { account: true }) as never, 'huayi'), true);
  assert.equal(await isAuthenticated(page('https://cme28.91huayi.com/pages/course.aspx', { logout: '退出登录' }) as never, 'huayi'), true);
  assert.equal(await isAuthenticated(page('https://yuancheng.henanyixue.com/#/', { logout: '退出' }) as never, 'henan'), true);
  assert.equal(await isAuthenticated(page('https://foreign.example/', { logout: '退出' }) as never, 'henan'), false);
});

test('跳转期间读取失败继续等待，检测全部本站页面及内嵌框架', async () => {
  const broken = { url: () => 'https://91huayi.com/', evaluate: async () => { throw new Error('navigation'); } };
  assert.equal(await isAuthenticated(broken as never, 'huayi'), false);
  const login = page('https://91huayi.com/', { password: true });
  const course = page('https://cme28.91huayi.com/pages/course.aspx', { logout: '退出登录' });
  const untrusted = page('https://other.example/', { logout: '退出登录' });
  const context = { pages: () => [login, course, untrusted] };
  assert.equal(await findAuthenticatedPage(context as never, 'huayi'), course);
  const embedded = { url: () => 'https://91huayi.com/', frames: () => [broken, course] };
  assert.equal(await findAuthenticatedPage({ pages: () => [embedded] } as never, 'huayi'), embedded);
});

test('连续两次识别同一页面才自动记录，之后持续更新；跳转及登录消失重置检查', async () => {
  let current: ReturnType<typeof page> | undefined;
  let saves = 0;
  const recorder = new LoginRecorder({ find: async () => current as never, save: async () => { saves++; } });
  await recorder.check();
  current = page('https://91huayi.com/', { account: true });
  await recorder.check(); assert.equal(saves, 0);
  await recorder.check(); assert.equal(saves, 1);
  await recorder.check(); assert.equal(saves, 2);
  current = undefined;
  await recorder.check(); assert.equal(saves, 2);
  current = page('https://cme28.91huayi.com/pages/course.aspx', { logout: '退出登录' });
  await recorder.check(); assert.equal(saves, 2);
  await recorder.check(); assert.equal(saves, 3);
  current.url = () => 'https://cme28.91huayi.com/pages/new.aspx';
  await recorder.check(); assert.equal(saves, 3);
  await recorder.check(); assert.equal(saves, 4);
});

test('自动记录写入失败不会报告成功，下一次检查可重试', async () => {
  const authenticated = page('https://91huayi.com/', { account: true });
  let attempts = 0, saved = false;
  const recorder = new LoginRecorder({ find: async () => authenticated as never, save: async () => {
    if (++attempts === 1) throw new Error('disk full');
    saved = true;
  } });
  await recorder.check();
  await assert.rejects(recorder.check(), /disk full/);
  assert.equal(saved, false);
  await recorder.check();
  assert.equal(saved, true);
});

test('河南自动记录当前会话和课程地址，替换旧快照时仍仅本人可读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'medcourse-auto-login-'));
  const url = 'https://yuancheng.henanyixue.com/#/remoteProject/studyInterface/course/chapter';
  const source = { url: () => url, evaluate: async () => ({ auth: 'fixture-session' }) };
  try {
    const path = join(dir, '_sessionStorage.json');
    await writeFile(path, '{}', { mode: 0o644 });
    assert.equal(await saveLoginSession({} as never, source as never, dir, 'henan'), url.replace('/chapter', ''));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { auth: 'fixture-session' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const bad = { toJSON: () => { throw new Error('serialize failed'); } };
    await assert.rejects(writeSessionFile(path, bad), /serialize failed/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { auth: 'fixture-session' }, '写入失败不破坏已有会话');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
