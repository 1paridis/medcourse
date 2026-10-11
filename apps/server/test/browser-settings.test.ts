import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { type WorkerCommand, PLATFORM_ORIGIN } from '@medcourse/shared';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/app.js';
import { readCourseName } from '../src/automation/course-name.js';

test('显示浏览器开关按用户和网站隔离，API 返回布尔值，修改不干扰已有任务', async () => {
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, { dataDir: '/tmp', maxConcurrency: 1, channel: 'chromium' });
  scheduler.pump = () => {};
  const app = await createApp({ store, scheduler, port: 3000, webPort: 5173, maxConcurrency: 1, webDist: '/not-present', logger: false });
  try {
    const a = store.createUser('A'), b = store.createUser('B');
    const accounts = store.bindPlatforms(a.id, ['henan', 'huayi']);
    const henan = accounts.find(account => account.platformId === 'henan');
    const huayi = accounts.find(account => account.platformId === 'huayi');
    const [other] = store.bindPlatforms(b.id, ['huayi']);
    assert.ok(store.accounts().every(account => account.showBrowser === false));
    const update = (id: string, payload: unknown) => app.inject({ method: 'PATCH', url: `/api/accounts/${id}/browser`, payload });
    assert.equal((await update('missing', { showBrowser: true })).statusCode, 404);
    assert.equal((await update(huayi!.id, {})).statusCode, 400);
    assert.equal((await update(huayi!.id, { showBrowser: 'invalid' })).statusCode, 400);
    const login = store.createJob(huayi!.id, 'login', 'https://91huayi.com/');
    const response = await update(huayi!.id, { showBrowser: true });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().showBrowser, true);
    assert.equal(store.job(login.id)?.status, 'queued');
    assert.equal(store.account(henan!.id)?.showBrowser, false);
    assert.equal(store.account(other!.id)?.showBrowser, false);
    const overview = (await app.inject('/api/overview')).json();
    assert.equal(overview.accounts.find((account: { id: string }) => account.id === huayi!.id).showBrowser, true);
    assert.equal((await update(huayi!.id, { showBrowser: false })).json().showBrowser, false);
  } finally { await app.close(); store.close(); }
});

test('v3 数据库升级保留账号、任务和登录；开关默认无头，保存后重启仍生效', () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-browser-migration-'));
  const path = join(directory, 'store.sqlite');
  try {
    let store = new Store(path);
    const account = store.createAccount('A', PLATFORM_ORIGIN);
    store.saveLogin(account.id);
    const job = store.createJob(account.id, 'inspect', PLATFORM_ORIGIN);
    store.close();
    const old = new DatabaseSync(path);
    old.exec('ALTER TABLE accounts DROP COLUMN showBrowser; PRAGMA user_version = 3;');
    old.close();
    store = new Store(path);
    assert.equal(store.account(account.id)?.showBrowser, false);
    assert.equal(store.account(account.id)?.loginState, 'saved');
    assert.equal(store.job(job.id)?.status, 'queued');
    assert.equal(readdirSync(directory).filter(name => name.includes('.pre-v4-')).length, 1);
    store.setShowBrowser(account.id, true);
    store.close();
    store = new Store(path);
    assert.equal(store.account(account.id)?.showBrowser, true);
    assert.equal(store.accounts()[0]?.showBrowser, true);
    assert.equal(readdirSync(directory).filter(name => name.includes('.pre-v4-')).length, 1);
    store.close();
  } finally { rmSync(directory, { recursive: true }); }
});

test('调度将当前网站的浏览器设置传入任务和课程名称读取，不串用其他网站配置', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'medcourse-browser-worker-'));
  const store = new Store(':memory:');
  const commands: WorkerCommand[] = [];
  const scheduler = new Scheduler(store, { dataDir: directory, maxConcurrency: 1, channel: 'chromium', workerFactory: () => {
    const child = fork(fileURLToPath(new URL('./fixtures/worker.mjs', import.meta.url)), [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const send = child.send.bind(child);
    child.send = ((message: WorkerCommand, ...args: unknown[]) => {
      commands.push(message);
      return (send as Function)(message, ...args);
    }) as typeof child.send;
    return child;
  } });
  try {
    const user = store.createUser('A');
    const accounts = store.bindPlatforms(user.id, ['henan', 'huayi']);
    const henan = accounts.find(account => account.platformId === 'henan');
    const huayi = accounts.find(account => account.platformId === 'huayi');
    store.setShowBrowser(huayi!.id, true);
    const url = 'https://cme28.91huayi.com/pages/course.aspx?cid=course';
    await scheduler.readCourseName(huayi!.id, url);
    const name = commands.find(command => command.type === 'course_name');
    assert.equal(name?.showBrowser, true);
    const login = store.createJob(huayi!.id, 'login', 'https://91huayi.com/');
    scheduler.pump();
    assert.equal(commands.find(command => command.type === 'start')?.showBrowser, true);
    store.setShowBrowser(huayi!.id, false);
    assert.equal(commands.find(command => command.type === 'start')?.showBrowser, true, '设置只用于下次启动');
    await scheduler.stop(login.id);
    const next = store.createJob(henan!.id, 'inspect', PLATFORM_ORIGIN);
    scheduler.pump();
    const started = Date.now();
    while (!commands.some(command => command.type === 'start' && command.job.id === next.id)) {
      assert.ok(Date.now() - started < 5000);
      await delay(20);
    }
    const command = commands.find(command => command.type === 'start' && command.job.id === next.id);
    assert.equal(command?.showBrowser, false);
  } finally { await scheduler.close(); store.close(); rmSync(directory, { recursive: true }); }
});

test('无头读取课程遇到登录表单立即提示登录，不等待不可见的人工操作', async () => {
  const url = 'https://cme28.91huayi.com/pages/course.aspx?cid=course';
  const page = { addInitScript: async () => {}, isClosed: () => false, url: () => url,
    evaluate: async () => ({ loginVisible: true, names: ['错误标题'] }) };
  await assert.rejects(readCourseName(page as never, 'huayi', url, 20_000, false), /需要登录.*显示浏览器/);
});
