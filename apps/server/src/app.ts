import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { JobKind } from '@medcourse/shared';
import { PLATFORM_ORIGIN } from '@medcourse/shared';
import type { Store } from './store.js';
import type { Scheduler } from './scheduler.js';
import { isPlatformUrl, courseUrl } from './automation/platform.js';

export async function createApp(options: {
  store: Store; scheduler: Scheduler; port: number; webPort: number; maxConcurrency: number; webDist: string; logger?: boolean;
}) {
  const { store, scheduler } = options;
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 16 * 1024 });
  const allowedOrigins = new Set([
    `http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`,
    `http://127.0.0.1:${options.webPort}`, `http://localhost:${options.webPort}`,
  ]);
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
      return reply.code(403).send({ message: '仅允许本机管理界面访问' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error && typeof error === 'object' && 'validation' in error) return reply.code(400).send({ message: '请求参数格式不正确' });
    app.log.error(error);
    return reply.code(500).send({ message: '服务处理失败，请检查终端日志' });
  });

  app.get('/api/health', async () => ({ ok: true, service: 'medcourse', version: '0.1.0' }));
  app.get('/api/overview', async () => ({ accounts: store.accounts(), jobs: store.jobs(), maxConcurrency: options.maxConcurrency }));

  app.post<{ Body: { name: string; courseUrl?: string } }>('/api/accounts', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 }, courseUrl: { type: 'string', maxLength: 2048 },
    } } },
  }, async (request, reply) => {
    const name = request.body.name.trim();
    const url = request.body.courseUrl?.trim() || `${PLATFORM_ORIGIN}/`;
    if (!name || !isPlatformUrl(url)) return reply.code(400).send({ message: '请输入账号名称和平台内的 HTTPS 地址' });
    return reply.code(201).send(store.createAccount(name, url));
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (request, reply) => {
    if (!store.account(request.params.id)) return reply.code(404).send({ message: '账号不存在' });
    if (scheduler.isAccountBusy(request.params.id)) return reply.code(409).send({ message: '请先停止这个账号的任务' });
    store.deleteAccount(request.params.id);
    // 删除元数据不递归删除浏览器目录，避免误删登录资料。
    return reply.code(204).send();
  });

  app.post<{ Body: { accountId: string; kind: JobKind; url?: string } }>('/api/jobs', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['accountId', 'kind'], properties: {
      accountId: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['login', 'inspect', 'playlist'] },
      url: { type: 'string', maxLength: 2048 },
    } } },
  }, async (request, reply) => {
    const account = store.account(request.body.accountId);
    if (!account) return reply.code(404).send({ message: '账号不存在' });
    const url = request.body.url?.trim() || account.courseUrl;
    if (!isPlatformUrl(url)) return reply.code(400).send({ message: '任务地址必须属于目标平台' });
    if (request.body.kind === 'playlist' && (!courseUrl(url) || account.loginState !== 'saved')) return reply.code(400).send({ message: '请先保存登录并进入目标课程播放页' });
    if (scheduler.isAccountBusy(account.id)) return reply.code(409).send({ message: '该账号已有任务，不能同时登录或检查' });
    const job = store.createJob(account.id, request.body.kind, url);
    store.log(job.id, 'info', request.body.kind === 'login' ? '人工登录任务已创建' : request.body.kind === 'playlist' ? '播放列表读取任务已创建' : '无头页面检查任务已创建');
    scheduler.pump();
    return reply.code(201).send(job);
  });


  app.post<{ Params: { id: string } }>('/api/accounts/:id/start-all', async (request, reply) => {
    const account = store.account(request.params.id);
    if (!account) return reply.code(404).send({ message: '账号不存在' });
    if (account.loginState !== 'saved') return reply.code(409).send({ message: '请先完成并保存人工登录' });
    if (scheduler.isAccountBusy(account.id)) return reply.code(409).send({ message: '账号正在运行或排队，请先暂停后再开始' });
    const queued = store.enqueueAll(account.id);
    if (!queued) return reply.code(409).send({ message: '没有可排队的视频任务，或账号正在登录、读取列表或检查页面' });
    scheduler.pump();
    return { queued };
  });

  app.post<{ Params: { id: string } }>('/api/accounts/:id/pause-all', async (request, reply) => {
    if (!store.account(request.params.id)) return reply.code(404).send({ message: '账号不存在' });
    if (!await scheduler.pauseAccount(request.params.id)) return reply.code(409).send({ message: '这个账号没有正在播放或排队的视频，或正在暂停' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/start', async (request, reply) => {
    const job = store.job(request.params.id);
    if (!job) return reply.code(404).send({ message: '任务不存在' });
    if (store.account(job.accountId)?.loginState !== 'saved') return reply.code(409).send({ message: '请先完成并保存人工登录' });
    if (!store.enqueue(job.id)) return reply.code(409).send({ message: '视频任务当前不可启动，或账号正在进行登录、读取或检查' });
    store.log(job.id, 'info', '视频已排队，从平台当前进度播放，不根据本地记录跳转视频时间');
    scheduler.pump();
    return reply.code(202).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/pause', async (request, reply) => {
    if (!await scheduler.pause(request.params.id)) return reply.code(409).send({ message: '任务当前不可暂停' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/confirm', async (request, reply) => {
    if (!scheduler.confirm(request.params.id)) return reply.code(409).send({ message: '任务当前未等待人工确认' });
    return reply.code(202).send({ ok: true });
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/stop', async (request, reply) => {
    if (!await scheduler.stop(request.params.id)) return reply.code(409).send({ message: '任务不存在或已经结束' });
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id/logs', async (request, reply) => {
    if (!store.job(request.params.id)) return reply.code(404).send({ message: '任务不存在' });
    return store.logs(request.params.id);
  });

  if (existsSync(options.webDist)) {
    await app.register(fastifyStatic, { root: options.webDist });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET') return reply.code(404).send({ message: '接口不存在' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
