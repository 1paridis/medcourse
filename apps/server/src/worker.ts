import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { PLATFORM_ORIGIN, type WorkerCommand, type WorkerEvent } from '@medcourse/shared';
import { inspectPage, isPlatformUrl, courseUrl, readPlaylist, readPlayback, isPlatformVideoComplete, PLAYLIST_SELECTOR, VIDEO_SELECTOR } from './automation/platform.js';

let context: BrowserContext | undefined;
let command: Extract<WorkerCommand, { type: 'start' }> | undefined;
let playbackPage: Page | undefined;
let finished = false;
let waiting = false;

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
  if (playbackPage) {
    await playbackPage.locator(VIDEO_SELECTOR).evaluateAll(videos => videos.forEach(video => (video as HTMLVideoElement).pause())).catch(() => {});
    await snapshot().catch(() => {});
  }
  await context?.close().catch(() => {});
  send({ type: 'done', status, message, courseUrl: selectedCourseUrl });
  if (process.connected) process.disconnect();
}

async function play(page: Page): Promise<void> {
  const id = command?.job.chapterId;
  if (!id) throw new Error('视频任务缺少章节标识');
  playbackPage = page;
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
    .some(row => row.id === id && !!row.querySelector('.indexLeft.animat')), { selector: PLAYLIST_SELECTOR, id }, { timeout: 15_000 });
  const initial = await readPlayback(page, id);
  if (initial.needsAttention) { await finish('needs_attention', initial.needsAttention); return; }
  try { await page.locator(VIDEO_SELECTOR).first().waitFor({ state: 'visible', timeout: 15_000 }); }
  catch { await finish('needs_attention', '目标视频暂不可播放，请检查前置学习状态或平台验证'); return; }
  if (finished) return;
  await page.locator(VIDEO_SELECTOR).first().evaluate(async element => {
    const video = element as HTMLVideoElement;
    video.muted = true;
    try { await video.play(); } catch { /* 使用网站播放按钮作为后备。 */ }
  });
  if ((await readPlayback(page, id)).progress.playbackState === 'paused') {
    const button = page.locator('.by-player .by-player__play-btn--center, .by-player .by-player__control-bar button[aria-label="播放"]');
    if (await button.first().isVisible()) await button.first().click();
  }
  send({ type: 'log', level: 'info', message: '开始记录目标视频的实际进度；静音播放，沿用平台默认速度' });
  let previousTime: number | null = null;
  let lastAdvance = Date.now();
  let endedAt: number | undefined;
  while (!finished) {
    const state = await readPlayback(page, id);
    if (finished) return;
    if (state.needsAttention) { await finish('needs_attention', state.needsAttention); return; }
    if (!state.selected) { await finish('needs_attention', '网站切换了章节，已停止记录；请确认目标视频'); return; }
    send({ type: 'progress', progress: state.progress });
    if (state.progress.playbackState === 'error') { await finish('needs_attention', '播放器报告播放错误，进度已保存，请人工处理'); return; }
    if (state.ended) {
      endedAt ??= Date.now();
      if (isPlatformVideoComplete(state.progress.platformStatus)) {
        await finish('completed', '视频播放结束，平台已确认本视频学习状态'); return;
      }
      if (Date.now() - endedAt >= 30_000) {
        await finish('needs_attention', '视频已结束，平台完成状态未确认；进度已保存'); return;
      }
    } else {
      if (state.progress.currentTime !== null && previousTime !== null && state.progress.currentTime > previousTime + 0.05) lastAdvance = Date.now();
      previousTime = state.progress.currentTime;
      if (Date.now() - lastAdvance > 60_000) {
        await finish('needs_attention', '视频进度超过 60 秒未增长，请检查缓冲、播放限制或验证'); return;
      }
    }
    await delay(1000);
  }
}

async function start(input: Extract<WorkerCommand, { type: 'start' }>): Promise<void> {
  command = input;
  if (!isPlatformUrl(input.job.url)) throw new Error('任务地址不属于目标平台');
  context = await chromium.launchPersistentContext(input.profileDir, {
    channel: input.channel, headless: input.job.kind !== 'login',
    viewport: { width: 1360, height: 900 }, locale: 'zh-CN',
  });
  if (finished) { await context.close(); return; }
  context.on('close', () => { void finish('stopped', '浏览器窗口已关闭'); });
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
  if (input.job.kind === 'playback') { await play(page); return; }
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
