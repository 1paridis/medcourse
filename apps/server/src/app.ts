import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { JobKind } from '@medcourse/shared';
import { PLATFORM_ORIGIN, PLATFORMS, platformById, isLearningUrl } from '@medcourse/shared';
import { StoreError, type Store } from './store.js';
import type { Scheduler } from './scheduler.js';
import { isPlatformUrl, courseUrl } from './automation/platform.js';
import { isHuayiCourseUrl } from './automation/huayi.js';

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
    if (error instanceof StoreError) return reply.code(error.statusCode).send({ message: error.message });
    app.log.error(error);
    return reply.code(500).send({ message: '服务处理失败，请检查终端日志' });
  });

  app.get('/api/health', async () => ({ ok: true, service: 'medcourse', version: '0.1.0' }));
  app.get('/api/overview', async () => ({ users: store.users(), platforms: PLATFORMS, accounts: store.accounts(), courses: store.courses(), jobs: store.jobs(), maxConcurrency: options.maxConcurrency }));
  app.get('/api/platforms', async () => PLATFORMS);
  const nameSchema = { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 } } };
  app.post<{ Body: { name: string } }>('/api/users', { schema: { body: nameSchema } }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name) return reply.code(400).send({ message: '请输入用户名称' });
    return reply.code(201).send(store.createUser(name));
  });
  app.patch<{ Params: { id: string }; Body: { name: string } }>('/api/users/:id', { schema: { body: nameSchema } }, async (request, reply) => {
    const name = request.body.name.trim();
    if (!name) return reply.code(400).send({ message: '请输入用户名称' });
    return store.renameUser(request.params.id, name);
  });
  app.delete<{ Params: { id: string } }>('/api/users/:id', async (request, reply) => {
    if (!store.user(request.params.id)) return reply.code(404).send({ message: '用户不存在' });
    if (store.accounts().some(account => account.userId === request.params.id && scheduler.isAccountBusy(account.id))) return reply.code(409).send({ message: '请先停止该用户所有网站的活动任务' });
    store.deleteUser(request.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { platformIds: string[] } }>('/api/users/:id/accounts', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['platformIds'], properties: {
      platformIds: { type: 'array', minItems: 1, maxItems: PLATFORMS.length, items: { type: 'string' } },
    } } },
  }, async (request, reply) => reply.code(201).send(store.bindPlatforms(request.params.id, request.body.platformIds)));

  const courseSchema = { type: 'object', additionalProperties: false, required: ['name', 'learningUrl'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 }, learningUrl: { type: 'string', minLength: 1, maxLength: 2048 },
  } };
  app.get<{ Params: { id: string } }>('/api/accounts/:id/courses', async (request, reply) => {
    if (!store.account(request.params.id)) return reply.code(404).send({ message: '网站账号不存在' });
    return store.courses(request.params.id);
  });
  app.post<{ Params: { id: string }; Body: { learningUrl: string } }>('/api/accounts/:id/courses', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['learningUrl'], properties: { learningUrl: courseSchema.properties.learningUrl } } },
  }, async (request, reply) => {
    const account = store.account(request.params.id);
    if (!account) return reply.code(404).send({ message: '网站账号不存在' });
    const url = request.body.learningUrl.trim();
    if (!isLearningUrl(account.platformId, url)) return reply.code(400).send({ message: '请输入所属网站的 HTTPS 学习链接，不要填写网站首页' });
    if (store.courses(account.id).some(course => !course.archivedAt && course.learningUrl === url)) return reply.code(409).send({ message: '该课程已添加' });
    const name = await scheduler.readCourseName(account.id, url);
    return reply.code(201).send(store.createCourse(account.id, name, url));
  });
  app.patch<{ Params: { id: string }; Body: { name: string; learningUrl: string } }>('/api/courses/:id', { schema: { body: courseSchema } }, async (request, reply) => {
    const course = store.course(request.params.id);
    if (!course) return reply.code(404).send({ message: '课程不存在' });
    if (course.learningUrl !== request.body.learningUrl.trim() && scheduler.isAccountBusy(course.accountId)) return reply.code(409).send({ message: '请先暂停或停止本站活动任务，再修改学习链接' });
    return store.updateCourse(course.id, request.body.name, request.body.learningUrl);
  });
  app.post<{ Params: { id: string } }>('/api/courses/:id/archive', async (request, reply) => {
    if (!store.course(request.params.id)) return reply.code(404).send({ message: '课程不存在' });
    if (!await scheduler.archiveCourse(request.params.id)) return reply.code(409).send({ message: '本站正在暂停或移除课程，请稍后重试' });
    return { ok: true };
  });

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

  app.post<{ Body: { accountId: string; kind: JobKind; url?: string; courseId?: string } }>('/api/jobs', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['accountId', 'kind'], properties: {
      accountId: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['login', 'inspect', 'playlist'] },
      url: { type: 'string', maxLength: 2048 }, courseId: { type: 'string', minLength: 1 },
    } } },
  }, async (request, reply) => {
    const account = store.account(request.body.accountId);
    if (!account) return reply.code(404).send({ message: '账号不存在' });
    if (!store.canExecute(account.id, null, request.body.kind)) return reply.code(409).send({ message: '该网站学习功能尚未接入' });
    if (account.platformId === 'huayi' && request.body.kind === 'inspect') return reply.code(409).send({ message: '华医网页面检查尚未接入，请使用读取视频列表或开始本站学习' });
    if (request.body.kind === 'login' && (request.body.courseId || (request.body.url && request.body.url.trim() !== platformById(account.platformId)!.entryUrl))) return reply.code(400).send({ message: '登录由网站统一管理，请使用登录本站进入首页' });
    const course = request.body.courseId ? store.course(request.body.courseId) : undefined;
    if (request.body.courseId && (!course || course.accountId !== account.id)) return reply.code(404).send({ message: '该网站账号下不存在此课程' });
    if (course?.archivedAt) return reply.code(409).send({ message: '课程已移除，历史记录保留' });
    if (course && request.body.url && request.body.url.trim() !== course.learningUrl) return reply.code(400).send({ message: '任务地址与所选课程不一致' });
    const defaultUrl = request.body.kind === 'login' ? platformById(account.platformId)!.entryUrl : account.courseUrl;
    const url = course?.learningUrl || request.body.url?.trim() || defaultUrl;
    if (!(account.platformId === 'huayi' ? (request.body.kind === 'login' ? url === platformById('huayi')!.entryUrl : !!course && isHuayiCourseUrl(url)) : isPlatformUrl(url))) return reply.code(400).send({ message: '任务地址必须属于目标平台' });
    if (request.body.kind === 'playlist' && account.platformId === 'henan' && (!courseUrl(url) || account.loginState !== 'saved')) return reply.code(400).send({ message: '请先完成人工登录，状态会自动记录，再进入目标课程播放页' });
    if (scheduler.isAccountBusy(account.id)) return reply.code(409).send({ message: '该账号已有任务，不能同时登录或检查' });
    const job = store.createJob(account.id, request.body.kind, url, course?.id);
    store.log(job.id, 'info', request.body.kind === 'login' ? '人工登录任务已创建' : request.body.kind === 'playlist' ? '播放列表读取任务已创建' : '无头页面检查任务已创建');
    scheduler.pump();
    return reply.code(201).send(job);
  });


  app.post<{ Params: { id: string } }>('/api/accounts/:id/start-all', async (request, reply) => {
    const account = store.account(request.params.id);
    if (!account) return reply.code(404).send({ message: '账号不存在' });
    if (!store.canExecute(account.id)) return reply.code(409).send({ message: '该网站学习功能尚未接入' });
    if (account.loginState !== 'saved') return reply.code(409).send({ message: '请先完成人工登录，登录成功后会自动记录' });
    if (scheduler.isAccountBusy(account.id)) return reply.code(409).send({ message: '账号正在运行或排队，请先暂停后再开始' });
    const queued = store.enqueueAll(account.id);
    if (!queued) return reply.code(409).send({ message: '没有可排队的视频任务，或账号正在登录、读取列表或检查页面' });
    scheduler.pump();
    return { queued };
  });

  app.post<{ Params: { id: string } }>('/api/accounts/:id/pause-all', async (request, reply) => {
    if (!store.account(request.params.id)) return reply.code(404).send({ message: '账号不存在' });
    if (!store.canExecute(request.params.id)) return reply.code(409).send({ message: '该网站学习功能尚未接入' });
    if (!await scheduler.pauseAccount(request.params.id)) return reply.code(409).send({ message: '这个账号没有正在播放或排队的视频，或正在暂停' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/start', async (request, reply) => {
    const job = store.job(request.params.id);
    if (!job) return reply.code(404).send({ message: '任务不存在' });
    if (!store.canExecute(job.accountId, job.courseId)) return reply.code(409).send({ message: '该网站学习功能尚未接入，或课程已移除' });
    if (store.account(job.accountId)?.loginState !== 'saved') return reply.code(409).send({ message: '请先完成人工登录，登录成功后会自动记录' });
    if (!store.enqueue(job.id)) return reply.code(409).send({ message: '请按课程及视频顺序学习；前面的内容尚未完成，任务已结束，或账号正在处理其他任务' });
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
