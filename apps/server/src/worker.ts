import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { PLATFORM_ORIGIN, VERIFICATION_RESTART_MAX_ATTEMPTS, VERIFICATION_RESTART_WINDOW_MS, VERIFICATION_RETRY_LIMIT_MESSAGE, type PlaybackProgress, type WorkerCommand, type WorkerEvent } from '@medcourse/shared';
import { inspectPage, isPlatformUrl, courseUrl, readPlaylist, readPlayback, isPlatformVideoComplete, PLAYLIST_SELECTOR, VIDEO_SELECTOR } from './automation/platform.js';
import { isPlaybackVerification, monitorPlayback, runPlaybackWithRestarts, VerificationRestartBudget, waitForPlaybackCheck } from './automation/playback.js';

let context: BrowserContext | undefined;
let command: Extract<WorkerCommand, { type: 'start' }> | undefined;
let playbackPage: Page | undefined;
let finished = false;
let waiting = false;
const verificationRestarts = new VerificationRestartBudget();
let pendingRestart: { id: string; attempt: number; progress: PlaybackProgress; baseline: number | null } | undefined;

function logVerification(event: string, fields: Record<string, unknown>): void {
  send({ type: 'log', level: 'info', message: `验证事件：${JSON.stringify({
    event, recordedAt: new Date().toISOString(), chapterId: command?.job.chapterId,
    verificationId: pendingRestart?.id, ...fields,
  })}` });
}

function send(event: WorkerEvent): void {
  if (process.connected) process.send?.(event, () => {});
}

async function snapshot(): Promise<void> {
  if (playbackPage && command?.job.chapterId) {
    const state = await readPlayback(playbackPage, command.job.chapterId);
    // 选中其他章节时，不覆盖本任务已记录的时间。
    if (state.selected) send({ type: 'progress', progress: state.progress });
  }
}

async function finish(status: 'completed' | 'failed' | 'stopped' | 'paused' | 'needs_attention', message: string, selectedCourseUrl?: string): Promise<void> {
  if (finished) return;
  finished = true;
  if (pendingRestart) {
    logVerification('restart_interrupted', { attempt: pendingRestart.attempt, status, reason: message });
    pendingRestart = undefined;
  }
  if (playbackPage) {
    await playbackPage.locator(VIDEO_SELECTOR).evaluateAll(videos => videos.forEach(video => (video as HTMLVideoElement).pause())).catch(() => {});
    await snapshot().catch(() => {});
  }
  await context?.close().catch(() => {});
  send({ type: 'done', status, message, courseUrl: selectedCourseUrl });
  if (process.connected) process.disconnect();
}

async function play(page: Page): Promise<'restart' | void> {
  const id = command?.job.chapterId;
  if (!id) throw new Error('视频任务缺少章节标识');
  const playlist = await readPlaylist(page);
  if (!playlist.items.some(item => item.chapterId === id)) throw new Error('播放列表已变化，未找到目标视频；请重新读取列表');
  const item = page.locator(PLAYLIST_SELECTOR).filter({ has: page.locator('.indexLeft.animat') });
  if (await item.getAttribute('id') !== id) {
    // 点击网站列表项，不操作考试按钮，不修改视频时间或授权地址。
    await page.locator(PLAYLIST_SELECTOR).evaluateAll((rows, chapterId) => {
      const row = rows.find(row => row.id === chapterId);
      if (!(row instanceof HTMLElement)) throw new Error('目标视频不存在');
      row.click();
    }, id);
  }
  await page.waitForFunction(({ selector, id }) => [...document.querySelectorAll(selector)]
    .some(row => row.id === id && !!row.querySelector('.indexLeft.animat')), { selector: PLAYLIST_SELECTOR, id }, { timeout: 15_000, polling: 1000 });
  const initial = await readPlayback(page, id);
  if (initial.needsAttention && !isPlaybackVerification(initial.needsAttention)) { await finish('needs_attention', initial.needsAttention); return; }
  if (isPlatformVideoComplete(initial.progress.platformStatus)) {
    // 已学完的视频无需重播；保留已记录的末尾进度，避免初始化时间覆盖它。
    const message = initial.progress.platformStatus?.trim() === '待考试'
      ? '平台已确认本视频学习结束（待考试）；继续下一视频，考试需人工处理'
      : '平台已确认本视频学习结束，无需重播，继续下一视频';
    await finish('completed', message);
    return;
  }
  playbackPage = page;
  try { await page.locator(VIDEO_SELECTOR).first().waitFor({ state: 'visible', timeout: 15_000 }); }
  catch { await finish('needs_attention', '目标视频暂不可播放，请检查前置学习状态或平台验证'); return; }
  if (finished) return;
  async function resumeVideo(): Promise<void> {
    if (finished) return;
    await page.locator(VIDEO_SELECTOR).first().evaluate(async element => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      try { await video.play(); } catch { /* 使用网站播放按钮作为后备。 */ }
    });
    const state = await readPlayback(page, id!);
    if (!finished && !state.needsAttention && state.selected && state.progress.playbackState === 'paused') {
      const button = page.locator('.by-player .by-player__play-btn--center, .by-player .by-player__control-bar button[aria-label="播放"]');
      if (await button.first().isVisible()) await button.first().click();
    }
  }
  if (!initial.needsAttention) await resumeVideo();
  const started = await readPlayback(page, id);
  if (pendingRestart) {
    pendingRestart.baseline = started.progress.currentTime;
    logVerification('restart_opened', { attempt: pendingRestart.attempt, progress: started.progress, reason: started.needsAttention });
  }
  send({ type: 'log', level: 'info', message: '按人工观看节奏静音播放，沿用平台默认速度；每 5 秒读取播放器属性记录进度，结束和报错由媒体事件触发检查' });
  return monitorPlayback(started, {
    read: () => readPlayback(page, id),
    wait: (timeoutMs, observeMedia) => waitForPlaybackCheck(page, timeoutMs, observeMedia),
    progress: progress => {
      send({ type: 'progress', progress });
      if (pendingRestart && progress.playbackState === 'playing' && progress.currentTime !== null
        && pendingRestart.baseline !== null && progress.currentTime > pendingRestart.baseline + 0.05) {
        logVerification('restart_progress_resumed', { attempt: pendingRestart.attempt,
          triggeredAt: pendingRestart.progress.sampledAt, previousTime: pendingRestart.progress.currentTime,
          restoredTime: pendingRestart.baseline, progress });
        pendingRestart = undefined;
      }
    },
    finish,
    isFinished: () => finished,
    onAttention: async (message, progress) => {
      if (finished) return;
      const checkin = message.includes('打卡验证');
      const attempt = checkin ? verificationRestarts.request() : null;
      if (pendingRestart) {
        logVerification('restart_verification_returned', { attempt: pendingRestart.attempt, progress });
        pendingRestart = undefined;
      }
      const verificationId = randomUUID();
      logVerification('verification_detected', { verificationId, kind: checkin ? 'checkin' : 'identity', reason: message,
        progress, action: attempt !== null ? 'pause_and_restart' : 'wait_for_user', attempt });
      if (attempt !== null) {
        pendingRestart = { id: verificationId, attempt, progress, baseline: null };
        send({ type: 'log', level: 'info', message: `检测到打卡提示，保存实际进度后暂停并重新启动当前视频（1 分钟内第 ${attempt}/${VERIFICATION_RESTART_MAX_ATTEMPTS} 次）` });
        return 'restart';
      }
      const detail = checkin ? VERIFICATION_RETRY_LIMIT_MESSAGE : '请先暂停，再通过“人工登录”完成验证，保存登录后点击“开始”';
      if (checkin) logVerification('restart_limit_reached', { verificationId, progress,
        windowMs: VERIFICATION_RESTART_WINDOW_MS, maxAttempts: VERIFICATION_RESTART_MAX_ATTEMPTS });
      send({ type: 'waiting_user', message: `${message}；${detail}` });
      send({ type: 'log', level: 'info', message: `${message}；无头播放正在等待，请先暂停，再通过“人工登录”处理验证` });
    },
    onResume: async () => {
      await resumeVideo();
      logVerification('manual_prompt_cleared', {});
      if (!finished) send({ type: 'playback_resumed', message: '平台验证提示已消失，继续播放并记录实际进度' });
    },
  });
}

async function openPage(input: Extract<WorkerCommand, { type: 'start' }>): Promise<Page | undefined> {
  context = await chromium.launchPersistentContext(input.profileDir, {
    channel: input.channel, headless: input.job.kind !== 'login',
    viewport: { width: 1360, height: 900 }, locale: 'zh-CN',
  });
  if (finished) { await context.close(); return; }
  const openedContext = context;
  context.on('close', () => { if (context === openedContext) void finish('stopped', '浏览器窗口已关闭'); });
  context.setDefaultTimeout(15_000);
  try {
    const storage = JSON.parse(await readFile(join(input.profileDir, '_sessionStorage.json'), 'utf8')) as Record<string, string>;
    await context.addInitScript(({ origin, values }) => {
      if (location.origin === origin) {
        for (const [key, value] of Object.entries(values)) {
          if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
        }
      }
    }, { origin: PLATFORM_ORIGIN, values: storage });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取账号会话文件，请重新人工登录');
  }
  if (input.job.kind === 'playlist' || input.job.kind === 'inspect') {
    await context.addInitScript(() => document.addEventListener('play', event => {
      if (event.target instanceof HTMLMediaElement) event.target.pause();
    }, true));
  }
  const page = context.pages()[0] ?? await context.newPage();
  const baseCourse = courseUrl(input.job.url);
  if (input.job.kind === 'playback' && (!baseCourse || !input.job.chapterId)) throw new Error('视频任务缺少有效课程或章节标识');
  const target = input.job.kind === 'playback'
    ? `${baseCourse}/${encodeURIComponent(input.job.chapterId!)}` : input.job.url;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (finished) return;
  return page;
}

async function start(input: Extract<WorkerCommand, { type: 'start' }>): Promise<void> {
  command = input;
  if (!isPlatformUrl(input.job.url)) throw new Error('任务地址不属于目标平台');
  const page = await openPage(input);
  if (!page || finished) return;
  if (input.job.kind === 'login') {
    waiting = true;
    send({ type: 'waiting_user', message: '请在浏览器中人工登录并进入课程，再点击“保存登录”' });
    return;
  }
  if (input.job.kind === 'playlist') {
    const playlist = await readPlaylist(page);
    if (finished) return;
    send({ type: 'playlist', ...playlist });
    await finish('completed', `播放列表已读取，共 ${playlist.items.length} 个视频；已有任务进度保留`);
    return;
  }
  if (input.job.kind === 'playback') {
    send({ type: 'log', level: 'info', message: '使用无头浏览器在后台播放视频' });
    await runPlaybackWithRestarts(page, {
      play,
      pause: async page => {
        await page.locator(VIDEO_SELECTOR).evaluateAll(videos => videos.forEach(video => (video as HTMLVideoElement).pause()));
        await snapshot();
      },
      close: async () => {
        const previousContext = context;
        context = undefined;
        playbackPage = undefined;
        await previousContext?.close();
        logVerification('restart_browser_closed', { attempt: pendingRestart?.attempt });
      },
      open: () => openPage(input),
      isFinished: () => finished,
    });
    return;
  }
  await delay(2500);
  if (finished) return;
  const info = await inspectPage(page);
  const message = info.loginFormVisible ? '检测到登录表单，请重新人工登录'
    : info.video ? '页面检查完成，检测到视频播放器' : '页面检查完成，未发现视频播放器；请确认课程地址或登录状态';
  send({ type: 'log', level: 'info', message });
  await finish('completed', message);
}

async function confirm(): Promise<void> {
  if (!waiting || !context || !command || finished) return;
  waiting = false;
  const page = context.pages().filter(page => isPlatformUrl(page.url())).at(-1);
  if (!page) throw new Error('没有找到平台页面，请重新打开登录窗口');
  if ((await inspectPage(page)).loginFormVisible) {
    waiting = true;
    send({ type: 'waiting_user', message: '页面仍显示登录表单，请完成登录后再保存' });
    return;
  }
  const storage = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
  await writeFile(join(command.profileDir, '_sessionStorage.json'), JSON.stringify(storage), { mode: 0o600 });
  await finish('completed', '浏览器登录状态已保存；可读取播放列表或检查课程页面', page.url());
}

process.on('message', (input: WorkerCommand) => {
  const action = input.type === 'start' ? start(input) : input.type === 'confirm' ? confirm()
    : input.type === 'pause' ? finish('paused', '已暂停，实际视频进度已保存') : finish('stopped', '任务已停止，进度已保留');
  void action.catch(error => {
    const text = error instanceof Error ? error.message : '未知错误';
    const safeText = text.replace(/https?:\/\/[^\s"'<>]+/g, value => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; }
    });
    void finish('failed', safeText.slice(0, 1000));
  });
});
process.on('SIGTERM', () => { void finish('stopped', '任务已停止，进度已保留'); });
process.on('SIGINT', () => { void finish('stopped', '任务已停止，进度已保留'); });
process.on('disconnect', () => { if (!finished) void finish('stopped', '主服务连接已断开'); });
