import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { platformById, VERIFICATION_RESTART_MAX_ATTEMPTS, VERIFICATION_RESTART_WINDOW_MS, VERIFICATION_RETRY_LIMIT_MESSAGE, type PlaybackProgress, type WorkerCommand, type WorkerEvent } from '@medcourse/shared';
import { inspectPage, isPlatformUrl, courseUrl, readPlaylist, readPlayback, isPlatformVideoComplete, PLAYLIST_SELECTOR, VIDEO_SELECTOR } from './automation/platform.js';
import { isPlaybackVerification, monitorPlayback, runPlaybackWithRestarts, VerificationRestartBudget, waitForPlaybackCheck } from './automation/playback.js';
import { isHuayiCourseUrl, readHuayiPlaylist } from './automation/huayi.js';
import { HuayiPlayer, openHuayiVideo } from './automation/huayi-playback.js';
import { isRequestedCoursePage, readCourseName, restoreAccountSession, saveHuayiSession } from './automation/course-name.js';
import { findAuthenticatedPage, LoginRecorder, saveLoginSession } from './automation/login.js';

let context: BrowserContext | undefined;
let command: Extract<WorkerCommand, { type: 'start' }> | undefined;
let playbackPage: Page | undefined;
let huayiPlayer: HuayiPlayer | undefined;
let finished = false;
let loginSaved = false;
let browserClosed = false;
let loginRefresh: Promise<void> | undefined;
let loginRecorder: LoginRecorder | undefined;
let savedCourseUrl: string | undefined;
let loginSaveError = false;
const namePages = new Map<string, { page: Page; createdPage: boolean }>();
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
    const state = huayiPlayer ? await huayiPlayer.read() : await readPlayback(playbackPage, command.job.chapterId);
    // 选中其他章节时，不覆盖本任务已记录的时间。
    if (state.selected) send({ type: 'progress', progress: state.progress });
  }
}

async function pausePlayback(page: Page): Promise<void> {
  if (huayiPlayer) await huayiPlayer.pause();
  else await page.locator(VIDEO_SELECTOR).evaluateAll(videos => videos.forEach(video => (video as HTMLVideoElement).pause()));
}

async function finish(status: 'completed' | 'failed' | 'stopped' | 'paused' | 'needs_attention', message: string, selectedCourseUrl?: string): Promise<void> {
  if (finished) return;
  finished = true;
  await loginRefresh?.catch(() => {});
  if (pendingRestart) {
    logVerification('restart_interrupted', { attempt: pendingRestart.attempt, status, reason: message });
    pendingRestart = undefined;
  }
  if (playbackPage) {
    await pausePlayback(playbackPage).catch(() => {});
    await snapshot().catch(() => {});
  }
  if (context && !browserClosed && command?.job.kind === 'login' && loginSaved) {
    const page = await findAuthenticatedPage(context, command.platformId ?? 'henan');
    if (page) await saveLoginSession(context, page, command.profileDir, command.platformId ?? 'henan').catch(() => {
      send({ type: 'log', level: 'error', message: '最新登录状态未能自动记录，请重新登录' });
    });
  } else if (context && !browserClosed && command?.platformId === 'huayi' && command.job.kind !== 'login') await saveHuayiSession(context, command.profileDir).catch(() => {
    send({ type: 'log', level: 'error', message: '华医网会话保存失败，请重新登录' });
  });
  await context?.close().catch(() => {});
  send({ type: 'done', status, message, courseUrl: selectedCourseUrl });
  if (process.connected) process.disconnect();
}

async function play(page: Page): Promise<'restart' | void> {
  const id = command?.job.chapterId;
  if (!id) throw new Error('视频任务缺少章节标识');
  let initial: Awaited<ReturnType<typeof readPlayback>>;
  if (command?.platformId === 'huayi') {
    const item = await openHuayiVideo(page, command.job.url, id);
    if (finished) return;
    if (isPlatformVideoComplete(item.platformStatus)) {
      await finish('completed', '华医网已确认本视频学习结束，无需重播；考试需人工处理，继续下一视频');
      return;
    }
    huayiPlayer = new HuayiPlayer(page, command.job.url, id, item.platformStatus);
    playbackPage = page;
    initial = await huayiPlayer.ready();
    if (!initial.needsAttention && initial.progress.playbackState === 'unknown') {
      await finish('needs_attention', '华医网目标视频暂不可播放，请检查播放器、前置学习或平台验证'); return;
    }
  } else {
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
    initial = await readPlayback(page, id);
  }
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
  if (!huayiPlayer) {
    try { await page.locator(VIDEO_SELECTOR).first().waitFor({ state: 'visible', timeout: 15_000 }); }
    catch { await finish('needs_attention', '目标视频暂不可播放，请检查前置学习状态或平台验证'); return; }
  }
  if (finished) return;
  const readState = () => huayiPlayer ? huayiPlayer.read() : readPlayback(page, id);
  async function resumeVideo(): Promise<void> {
    if (finished) return;
    if (huayiPlayer) { await huayiPlayer.resume(); return; }
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
  const started = await readState();
  if (pendingRestart) {
    pendingRestart.baseline = started.progress.currentTime;
    logVerification('restart_opened', { attempt: pendingRestart.attempt, progress: started.progress, reason: started.needsAttention });
  }
  send({ type: 'log', level: 'info', message: '按人工观看节奏静音播放，沿用平台默认速度；每 5 秒读取播放器属性记录进度，结束和报错由媒体事件触发检查' });
  return monitorPlayback(started, {
    read: () => huayiPlayer ? huayiPlayer.readForMonitor() : readPlayback(page, id),
    wait: (timeoutMs, observeMedia) => huayiPlayer ? huayiPlayer.wait(timeoutMs, observeMedia) : waitForPlaybackCheck(page, timeoutMs, observeMedia),
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
      if (huayiPlayer) await huayiPlayer.pause();
      const attempt = checkin && !huayiPlayer ? verificationRestarts.request() : null;
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
      const detail = checkin && !huayiPlayer ? VERIFICATION_RETRY_LIMIT_MESSAGE : '请先暂停本站学习，再通过“登录本站”完成验证；登录状态自动记录，关闭窗口后点击“开始本站学习”';
      if (checkin && !huayiPlayer) logVerification('restart_limit_reached', { verificationId, progress,
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
    // 保利威会恢复播放器自己的音量；后台播放同时在浏览器层静音。
    args: input.job.kind === 'playback' ? ['--mute-audio'] : [],
    viewport: { width: 1360, height: 900 }, locale: 'zh-CN',
  });
  if (finished) { await context.close(); return; }
  const openedContext = context;
  browserClosed = false;
  context.on('close', () => {
    if (context !== openedContext) return;
    browserClosed = true;
    void finish(input.job.kind === 'login' && loginSaved ? 'completed' : 'stopped',
      input.job.kind === 'login' && loginSaved ? '登录状态已自动记录，浏览器窗口已关闭' : '浏览器窗口已关闭，未确认新的登录状态', savedCourseUrl);
  });
  context.setDefaultTimeout(15_000);
  try { await restoreAccountSession(context, input.profileDir, input.platformId ?? 'henan'); }
  catch (error) {
    if (input.job.kind !== 'login') throw error;
    send({ type: 'log', level: 'info', message: '已有会话文件无法读取，请在当前窗口重新登录；成功后会自动记录' });
  }
  if (input.job.kind === 'playlist' || input.job.kind === 'inspect') {
    await context.addInitScript(() => document.addEventListener('play', event => {
      if (event.target instanceof HTMLMediaElement) event.target.pause();
    }, true));
  }
  const page = context.pages()[0] ?? await context.newPage();
  const baseCourse = courseUrl(input.job.url);
  if (input.job.kind === 'playback' && (!(input.platformId === 'huayi' ? isHuayiCourseUrl(input.job.url) : baseCourse) || !input.job.chapterId)) throw new Error('视频任务缺少有效课程或章节标识');
  const target = input.job.kind === 'playback' && input.platformId !== 'huayi'
    ? `${baseCourse}/${encodeURIComponent(input.job.chapterId!)}` : input.job.url;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (finished) return;
  return page;
}

async function start(input: Extract<WorkerCommand, { type: 'start' }>): Promise<void> {
  command = input;
  // 兼容升级前河南调度进程尚未退出时发出的旧命令。
  const huayiLogin = input.platformId === 'huayi' && input.job.kind === 'login' && !input.job.courseId && input.job.url === platformById('huayi')!.entryUrl;
  const huayiPlaylist = input.platformId === 'huayi' && input.job.kind === 'playlist' && !!input.job.courseId && isHuayiCourseUrl(input.job.url);
  const huayiPlayback = input.platformId === 'huayi' && input.job.kind === 'playback' && !!input.job.courseId && !!input.job.chapterId && isHuayiCourseUrl(input.job.url);
  if (input.platformId && input.platformId !== 'henan' && !huayiLogin && !huayiPlaylist && !huayiPlayback) throw new Error('该网站学习功能尚未接入');
  if (!huayiLogin && !huayiPlaylist && !huayiPlayback && !isPlatformUrl(input.job.url)) throw new Error('任务地址不属于目标平台');
  const page = await openPage(input);
  if (!page || finished) return;
  if (input.job.kind === 'login') {
    send({ type: 'waiting_user', message: '请在网站窗口人工登录，登录成功后自动记录；完成验证后关闭窗口即可。本站所有课程共用登录资料。' });
    loginRecorder = new LoginRecorder({
      find: () => findAuthenticatedPage(context!, input.platformId ?? 'henan'),
      save: async page => {
        const selectedUrl = await saveLoginSession(context!, page, input.profileDir, input.platformId ?? 'henan');
        if (finished) return;
        if (!loginSaved || selectedUrl !== savedCourseUrl) {
          send({ type: 'login_saved', message: '登录状态已自动记录，无需手动保存；可继续处理课程验证，完成后关闭窗口即可', courseUrl: selectedUrl });
        }
        loginSaved = true;
        savedCourseUrl = selectedUrl;
      },
    });
    while (!finished) {
      await refreshLogin();
      if (!finished) await delay(1000);
    }
    return;
  }
  if (input.job.kind === 'playlist') {
    const playlist = huayiPlaylist ? await readHuayiPlaylist(page, input.job.url) : await readPlaylist(page);
    if (finished) return;
    send({ type: 'playlist', ...playlist });
    await finish('completed', huayiPlaylist ? `目录已读取，共 ${playlist.items.length} 节，${playlist.items.filter(item => item.excludedReason).length} 节已排除；未启动播放，考试暂不处理` : `播放列表已读取，共 ${playlist.items.length} 个视频；已有任务进度保留`);
    return;
  }
  if (input.job.kind === 'playback') {
    send({ type: 'log', level: 'info', message: '使用无头浏览器在后台播放视频' });
    await runPlaybackWithRestarts(page, {
      play,
      pause: async page => {
        await pausePlayback(page);
        await snapshot();
      },
      close: async () => {
        const previousContext = context;
        context = undefined;
        playbackPage = undefined;
        huayiPlayer = undefined;
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

async function refreshLogin(): Promise<void> {
  if (!loginRecorder || finished || browserClosed) return;
  if (loginRefresh) return loginRefresh;
  loginRefresh = loginRecorder.check().then(() => { loginSaveError = false; }).catch(() => {
    if (!finished && !browserClosed && !loginSaveError) send({ type: 'log', level: 'error', message: '登录状态暂未能自动记录，将继续重试；请保持窗口打开' });
    loginSaveError = true;
  });
  try { await loginRefresh; } finally { loginRefresh = undefined; }
}

async function extractCourseName(input: Extract<WorkerCommand, { type: 'course_name' }>): Promise<void> {
  const owned = !command;
  let page: Page | undefined;
  let createdPage = false;
  let result: { name?: string; error?: string };
  try {
    if (command && (command.platformId !== input.platformId || command.job.kind !== 'login')) throw new Error('请先停止本站学习任务，再添加课程');
    if (namePages.size) throw new Error('正在读取课程名称，请稍后再试');
    if (!context) {
      context = await chromium.launchPersistentContext(input.profileDir, {
        channel: input.channel, headless: false, viewport: { width: 1360, height: 900 }, locale: 'zh-CN',
      });
      await restoreAccountSession(context, input.profileDir, input.platformId);
    }
    if (finished || !process.connected) throw new Error('课程名称读取已取消');
    page = context.pages().find(candidate => isRequestedCoursePage(input.platformId, input.url, candidate.url()));
    if (!page) {
      const source = input.platformId === 'henan' ? context.pages().find(candidate => isPlatformUrl(candidate.url())) : undefined;
      const liveStorage = source ? await source.evaluate(() => Object.fromEntries(Object.entries(sessionStorage))) : undefined;
      page = await context.newPage();
      createdPage = true;
      if (liveStorage) await page.addInitScript(values => {
        if (location.origin === 'https://yuancheng.henanyixue.com') for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
      }, liveStorage);
    }
    namePages.set(input.requestId, { page, createdPage });
    result = { name: await readCourseName(page, input.platformId, input.url) };
    const authenticated = await findAuthenticatedPage(context, input.platformId);
    if (authenticated) {
      const selectedUrl = await saveLoginSession(context, authenticated, input.profileDir, input.platformId);
      if (owned || !loginSaved || selectedUrl !== savedCourseUrl) {
        send({ type: 'login_saved', message: '登录状态已自动记录', courseUrl: selectedUrl });
      }
      if (!owned) { loginSaved = true; savedCourseUrl = selectedUrl; }
    }
  } catch (error) {
    // Playwright 错误可能含完整鉴权 URL，只返回可操作的中文提示。
    result = { error: error instanceof Error && !/https?:|Call log:|browserType\.|page\./.test(error.message)
      ? error.message : '无法读取课程名称，请检查网络、课程链接或在课程窗口完成人工登录后重试' };
  } finally {
    namePages.delete(input.requestId);
    if (createdPage) await page?.close().catch(() => {});
    if (owned) await context?.close().catch(() => {});
  }
  send({ type: 'course_name', requestId: input.requestId, ...result });
  if (owned && process.connected) process.disconnect();
}

process.on('message', (input: WorkerCommand) => {
  if (input.type === 'course_name') { void extractCourseName(input); return; }
  if (input.type === 'cancel_course_name') {
    const reader = namePages.get(input.requestId);
    if (reader?.createdPage) void reader.page.close().catch(() => {});
    return;
  }
  const action = input.type === 'start' ? start(input) : input.type === 'confirm' ? refreshLogin()
    : input.type === 'pause' ? finish('paused', '已暂停，实际视频进度已保存') : finish('stopped', '任务已停止，进度已保留');
  void action.catch(error => {
    const text = error instanceof Error ? error.message : '未知错误';
    const safeText = text.replace(/https?:\/\/[^\s"'<>]+/g, value => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; }
    });
    void finish(command?.job.kind === 'playback' ? 'needs_attention' : 'failed', safeText.slice(0, 1000));
  });
});
process.on('SIGTERM', () => { void finish('stopped', '任务已停止，进度已保留'); });
process.on('SIGINT', () => { void finish('stopped', '任务已停止，进度已保留'); });
process.on('disconnect', () => { if (!finished) void finish('stopped', '主服务连接已断开'); });
