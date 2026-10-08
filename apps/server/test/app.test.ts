import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { PLATFORM_ORIGIN } from '@medcourse/shared';

test('HTTP 接口验证地址、参数、账号互斥以及来源', async () => {
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, { dataDir: '/tmp', maxConcurrency: 1, channel: 'chromium' });
  // API 测试不启动真实浏览器；任务保留在队列中验证互斥。
  scheduler.pump = () => {};
  const app = await createApp({ store, scheduler, port: 3000, webPort: 5173, maxConcurrency: 1, webDist: '/not-present', logger: false });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).json().ok, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: '   ' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'A', courseUrl: 'https://example.com' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'A', courseUrl: `${PLATFORM_ORIGIN}.example.com/` } })).statusCode, 400);
    const response = await app.inject({ method: 'POST', url: '/api/accounts', payload: { name: 'A' } });
    assert.equal(response.statusCode, 201);
    const accountId = response.json().id as string;
    const job = await app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId, kind: 'login' } });
    assert.equal(job.statusCode, 201);
    assert.equal((await app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId, kind: 'inspect' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/accounts/${accountId}` })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/api/jobs/${job.json().id}/stop` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId, kind: 'study' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/overview', headers: { origin: 'https://external.example' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/accounts/${accountId}` })).statusCode, 204);
  } finally { await app.close(); store.close(); }
});

test('账号整体开始和暂停保留进度，继续未完成任务，拒绝重复开始及绕过导入', async () => {
  const store = new Store(':memory:');
  const scheduler = new Scheduler(store, { dataDir: '/tmp', maxConcurrency: 1, channel: 'chromium' });
  scheduler.pump = () => {};
  const app = await createApp({ store, scheduler, port: 3000, webPort: 5173, maxConcurrency: 1, webDist: '/not-present', logger: false });
  const url = `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/project1`;
  const account = store.createAccount('A', url);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account.id, kind: 'playlist' } })).statusCode, 400);
    store.saveLogin(account.id);
    assert.equal((await app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account.id, kind: 'playlist', url: `${PLATFORM_ORIGIN}/#/` } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account.id, kind: 'playback' } })).statusCode, 400);
    store.importPlaylist(account.id, url, '课程', [1, 2].map(i => ({ chapterId: `v${i}`, chapterTitle: `视频 ${i}`, position: i, durationText: '', platformStatus: null })));
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/start-all` })).json().queued, 2);
    assert.equal(store.jobs().filter(job => job.status === 'queued').length, 2);
    assert.equal((await app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account.id, kind: 'login' } })).statusCode, 409);
    const first = store.nextQueued()!;
    store.updateProgress(first.id, { currentTime: 42, duration: 100, playbackState: 'paused', platformStatus: '学习中', sampledAt: new Date().toISOString() });
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts/not-found/pause-all' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/pause-all` })).statusCode, 200);
    assert.equal(store.jobs().filter(job => job.status === 'paused').length, 2);
    assert.equal(store.job(first.id)?.currentTime, 42);
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/pause-all` })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/start-all` })).json().queued, 2);
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/start-all` })).statusCode, 409);
    store.updateJob(first.id, 'needs_attention', '需要验证');
    store.pauseQueuedAccount(account.id);
    const second = store.jobs().find(job => job.id !== first.id)!;
    store.updateJob(second.id, 'completed', '平台已确认');
    assert.equal((await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/start-all` })).json().queued, 1);
    assert.equal(store.job(first.id)?.status, 'queued');
    assert.equal(store.job(first.id)?.currentTime, 42);
    assert.equal(store.job(second.id)?.status, 'completed');
  } finally { await app.close(); store.close(); }
});
