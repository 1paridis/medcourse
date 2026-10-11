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
  const restored = { addCookies: async (values: any[]) => { cookies = values; }, addInitScript: async (fn: Function, input: unknown) => { script = fn; argument = input; } };
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
      const storage = (map: Map<string, string>) => ({ getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value) });
      runInNewContext(`(${script!.toString()})(argument)`, { argument, location: { protocol: 'https:', hostname, origin: `https://${hostname}` }, localStorage: storage(local), sessionStorage: storage(session) });
      assert.equal(local.get('local'), hostname === 'cme28.91huayi.com' ? 'saved-local' : undefined);
      assert.equal(session.get('session'), hostname === 'cme28.91huayi.com' ? 'saved-session' : undefined);
      local.set('local', 'fresh-value');
      runInNewContext(`(${script!.toString()})(argument)`, { argument, location: { protocol: 'https:', hostname, origin: `https://${hostname}` }, localStorage: storage(local), sessionStorage: storage(session) });
      assert.equal(local.get('local'), 'fresh-value', '不覆盖平台的新会话值');
    }
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
