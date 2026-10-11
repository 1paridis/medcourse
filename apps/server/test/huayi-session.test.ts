import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { restoreAccountSession, saveHuayiSession } from '../src/automation/course-name.js';

test('华医网保存和恢复会话 Cookie、分域存储，文件仅本人可读且不保存其他网站资料', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'medcourse-huayi-session-'));
  const origin = 'https://cme28.91huayi.com';
  const cookie = (domain: string, expires: number) => ({ name: 'session', value: 'test-session', domain, path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' });
  const context = {
    storageState: async () => ({ cookies: [cookie('.91huayi.com', -1), cookie('cme28.91huayi.com', 1), cookie('other.example', -1)],
      origins: [{ origin, localStorage: [{ name: 'local', value: 'saved-local' }] }, { origin: 'https://other.example', localStorage: [{ name: 'private', value: 'unrelated' }] }] }),
    pages: () => [{ frames: () => [{ url: () => `${origin}/pages/course.aspx`, evaluate: async () => ({ session: 'saved-session' }) }] }],
  };
  let cookies: any[] = [], script: Function | undefined, argument: unknown;
  const restored = { cookies: async () => [], addCookies: async (values: any[]) => { cookies = values; }, addInitScript: async (fn: Function, input: unknown) => { script = fn; argument = input; } };
  try {
    await saveHuayiSession(context as never, directory);
    const path = join(directory, '_huayiSession.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(state.cookies.length, 2);
    assert.equal(state.origins.length, 1);
    assert.deepEqual(state.sessions[origin], { session: 'saved-session' });
    await restoreAccountSession(restored as never, directory, 'huayi');
    assert.equal(cookies.length, 1, '恢复会话 Cookie，但不恢复已过期 Cookie');
    assert.equal(cookies[0].expires, -1);
    for (const hostname of ['cme28.91huayi.com', 'other.example', 'evil91huayi.com']) {
      const local = new Map<string, string>(), session = new Map<string, string>();
      const storage = (map: Map<string, string>) => ({ get length() { return map.size; }, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value) });
      runInNewContext(`(${script!.toString()})(argument)`, { argument, location: { protocol: 'https:', hostname, origin: `https://${hostname}` }, localStorage: storage(local), sessionStorage: storage(session) });
      assert.equal(local.get('local'), hostname === 'cme28.91huayi.com' ? 'saved-local' : undefined);
      assert.equal(session.get('session'), hostname === 'cme28.91huayi.com' ? 'saved-session' : undefined);
      local.set('local', 'fresh-value');
      runInNewContext(`(${script!.toString()})(argument)`, { argument, location: { protocol: 'https:', hostname, origin: `https://${hostname}` }, localStorage: storage(local), sessionStorage: storage(session) });
      assert.equal(local.get('local'), 'fresh-value', '不覆盖平台的新会话值');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('恢复只补缺失 Cookie，不用旧快照覆盖新 Cookie，并区分域、路径和分区', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'medcourse-huayi-cookie-'));
  const base = { name: 'session', value: 'stale', domain: '.91huayi.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' };
  const saved = [base, { ...base, domain: 'cme28.91huayi.com' }, { ...base, path: '/sso' },
    { ...base, partitionKey: 'https://91huayi.com' }, { ...base, name: 'expired', expires: 1 }];
  let added: unknown[] = [];
  try {
    await writeFile(join(directory, '_huayiSession.json'), JSON.stringify({ cookies: saved, origins: [], sessions: {} }));
    const context = { cookies: async () => [{ ...base, value: 'fresh' }],
      addCookies: async (cookies: unknown[]) => { added = cookies; }, addInitScript: async () => {} };
    await restoreAccountSession(context as never, directory, 'huayi');
    assert.deepEqual(added, saved.slice(1, 4), '只导入其他作用域，不导入旧同名 Cookie 或过期 Cookie');
    context.cookies = async () => saved.slice(0, 4).map(cookie => ({ ...cookie, value: 'fresh' }));
    context.addCookies = async () => { assert.fail('所有 Cookie 已存在时不应写入'); };
    await restoreAccountSession(context as never, directory, 'huayi');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('连续保存不同子站保留未访问的 SSO 存储，当前来源的删除保持有效，Cookie 不复活', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'medcourse-huayi-merge-'));
  const root = 'https://www.91huayi.com', cme = 'https://cme28.91huayi.com';
  const cookie = { name: 'session', value: 'test', domain: '.91huayi.com', path: '/', expires: -1 };
  const snapshot = (origin: string, entries: { name: string; value: string }[], session: Record<string, string>, cookies: unknown[]) => ({
    storageState: async () => ({ cookies, origins: [{ origin, localStorage: entries }] }),
    pages: () => [{ frames: () => [{ url: () => `${origin}/`, evaluate: async () => session }] }],
  });
  try {
    await saveHuayiSession(snapshot(root, [{ name: 'sso', value: 'root' }], { auth: 'root-session' }, [cookie]) as never, directory);
    await saveHuayiSession(snapshot(cme, [{ name: 'auth', value: 'course' }], { auth: 'course-session' }, []) as never, directory);
    let state = JSON.parse(await readFile(join(directory, '_huayiSession.json'), 'utf8'));
    assert.equal(state.origins.length, 2);
    assert.deepEqual(state.sessions, { [root]: { auth: 'root-session' }, [cme]: { auth: 'course-session' } });
    assert.deepEqual(state.cookies, [], '不合并已被网站删除的旧 Cookie');
    await saveHuayiSession(snapshot(cme, [], {}, []) as never, directory);
    state = JSON.parse(await readFile(join(directory, '_huayiSession.json'), 'utf8'));
    assert.deepEqual(state.origins.find((entry: { origin: string }) => entry.origin === cme).localStorage, []);
    assert.deepEqual(state.sessions[cme], {});
    assert.deepEqual(state.sessions[root], { auth: 'root-session' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('网页刷新不重新注入已删除的旧存储，已有本地存储优先，恢复标记不写入会话快照', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'medcourse-huayi-once-'));
  const origin = 'https://cme28.91huayi.com';
  let script: Function, argument: unknown;
  try {
    await writeFile(join(directory, '_huayiSession.json'), JSON.stringify({ cookies: [],
      origins: [{ origin, localStorage: [{ name: 'auth', value: 'old-auth' }] }], sessions: { [origin]: { auth: 'old-session' } } }));
    await restoreAccountSession({ cookies: async () => [], addInitScript: async (fn: Function, input: unknown) => { script = fn; argument = input; } } as never, directory, 'huayi');
    const local = new Map([['fresh', 'live']]), session = new Map<string, string>();
    const storage = (map: Map<string, string>) => ({ get length() { return map.size; }, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value) });
    const scope = { argument, location: { protocol: 'https:', hostname: 'cme28.91huayi.com', origin }, localStorage: storage(local), sessionStorage: storage(session) };
    const run = () => runInNewContext(`(${script!.toString()})(argument)`, scope);
    run();
    assert.equal(local.get('auth'), undefined, '不向已有存储补回已删除的认证');
    assert.equal(session.get('auth'), 'old-session');
    session.delete('auth');
    run();
    assert.equal(session.get('auth'), undefined, '刷新时不复活旧 sessionStorage');
    const context = { storageState: async () => ({ cookies: [], origins: [] }), pages: () => [{ frames: () => [{ url: () => origin,
      evaluate: async (fn: Function, marker: string) => runInNewContext(`(${fn.toString()})(marker)`, { marker, sessionStorage: Object.fromEntries(session) }) }] }] };
    await saveHuayiSession(context as never, directory);
    const saved = JSON.parse(await readFile(join(directory, '_huayiSession.json'), 'utf8'));
    assert.deepEqual(saved.sessions[origin], {}, '内部标记不混进网站会话');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('华医网首次登录允许缺少会话文件，损坏会话给出重新登录提示', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'medcourse-huayi-session-empty-'));
  try {
    await restoreAccountSession({} as never, directory, 'huayi');
    await writeFile(join(directory, '_huayiSession.json'), '{bad json');
    await assert.rejects(restoreAccountSession({} as never, directory, 'huayi'), /重新人工登录/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
