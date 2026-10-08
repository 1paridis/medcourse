import type { Page } from 'playwright';
import { VERIFICATION_RESTART_MAX_ATTEMPTS, VERIFICATION_RESTART_WINDOW_MS, type PlaybackProgress } from '@medcourse/shared';
import { isPlatformVideoComplete, VIDEO_SELECTOR, type readPlayback } from './platform.js';

export const PLAYBACK_CHECK_INTERVAL_MS = 5000;

export class VerificationRestartBudget {
  private attempts: number[] = [];
  constructor(private now: () => number = Date.now) {}
  request(): number | null {
    const now = this.now();
    this.attempts = this.attempts.filter(time => now - time < VERIFICATION_RESTART_WINDOW_MS);
    if (this.attempts.length >= VERIFICATION_RESTART_MAX_ATTEMPTS) return null;
    this.attempts.push(now);
    return this.attempts.length;
  }
}

export async function runPlaybackWithRestarts<T>(initial: T, options: {
  play: (page: T) => Promise<'restart' | void>;
  pause: (page: T) => Promise<void>;
  close: () => Promise<void>;
  open: () => Promise<T | undefined>;
  isFinished: () => boolean;
}): Promise<void> {
  let page = initial;
  while (!options.isFinished()) {
    if (await options.play(page) !== 'restart' || options.isFinished()) return;
    await options.pause(page);
    if (options.isFinished()) return;
    await options.close();
    if (options.isFinished()) return;
    const next = await options.open();
    if (next === undefined || options.isFinished()) return;
    page = next;
  }
}

export function isPlaybackVerification(message: string | null): boolean {
  return !!message && /打卡验证|身份验证/.test(message);
}

// 媒体事件可以提前触发采样。关闭页面会立即结束等待。
export async function waitForPlaybackCheck(page: Page, timeoutMs: number, observeMedia: boolean): Promise<void> {
  await page.evaluate(({ selector, timeoutMs, observeMedia }) => new Promise<void>(resolve => {
    // 对象方法避免开发运行器注入只能在 Node 中使用的函数命名辅助变量。
    const handlers = {
      done() {
        clearTimeout(timer);
        document.removeEventListener('ended', handlers.onMedia, true);
        document.removeEventListener('error', handlers.onMedia, true);
        resolve();
      },
      onMedia(event: Event) {
        if (event.target instanceof HTMLVideoElement && event.target.matches(selector)) handlers.done();
      },
    };
    const timer = setTimeout(handlers.done, timeoutMs);
    if (observeMedia) {
      document.addEventListener('ended', handlers.onMedia, true);
      document.addEventListener('error', handlers.onMedia, true);
      // 处理上一次采样与监听安装之间已经结束或出错的情况。
      const video = document.querySelector<HTMLVideoElement>(selector);
      if (video?.ended || video?.error) handlers.done();
    }
  }), { selector: VIDEO_SELECTOR, timeoutMs, observeMedia });
}

type PlaybackObservation = Awaited<ReturnType<typeof readPlayback>>;

export async function monitorPlayback(initial: PlaybackObservation, options: {
  read: () => Promise<PlaybackObservation>;
  wait: (timeoutMs: number, observeMedia: boolean) => Promise<void>;
  progress: (progress: PlaybackProgress) => void;
  finish: (status: 'completed' | 'needs_attention', message: string) => Promise<void>;
  isFinished: () => boolean;
  onAttention?: (message: string, progress: PlaybackProgress) => Promise<'restart' | void>;
  onResume?: () => Promise<void>;
  now?: () => number;
}): Promise<'restart' | void> {
  const now = options.now ?? Date.now;
  let state = initial;
  let previousTime: number | null = null;
  let lastAdvance = now();
  let endedAt: number | undefined;
  let awaitingVerification = false;
  while (!options.isFinished()) {
    if (state.selected && isPlaybackVerification(state.needsAttention) && options.onAttention) {
      options.progress(state.progress);
      if (!awaitingVerification) {
        awaitingVerification = true;
        if (await options.onAttention(state.needsAttention!, state.progress) === 'restart') return 'restart';
      }
      await options.wait(PLAYBACK_CHECK_INTERVAL_MS, false);
      if (options.isFinished()) return;
      state = await options.read();
      continue;
    }
    if (state.needsAttention) { await options.finish('needs_attention', state.needsAttention); return; }
    if (!state.selected) { await options.finish('needs_attention', '网站切换了章节，已停止记录；请确认目标视频'); return; }
    if (awaitingVerification) {
      awaitingVerification = false;
      previousTime = null;
      lastAdvance = now();
      endedAt = undefined;
      await options.onResume?.();
      if (options.isFinished()) return;
      state = await options.read();
      continue;
    }
    options.progress(state.progress);
    if (state.progress.playbackState === 'error') {
      await options.finish('needs_attention', '播放器报告播放错误，进度已保存，请人工处理'); return;
    }
    if (state.ended) {
      endedAt ??= now();
      if (isPlatformVideoComplete(state.progress.platformStatus)) {
        const message = state.progress.platformStatus?.trim() === '待考试'
          ? '视频学习已结束，平台状态为待考试；继续下一视频，考试需人工处理'
          : '视频播放结束，平台已确认本视频学习状态';
        await options.finish('completed', message); return;
      }
      if (now() - endedAt >= 30_000) {
        await options.finish('needs_attention', '视频已结束，平台完成状态未确认；进度已保存'); return;
      }
    } else {
      endedAt = undefined;
      if (state.progress.currentTime !== null
        && (previousTime === null || state.progress.currentTime > previousTime + 0.05)) lastAdvance = now();
      previousTime = state.progress.currentTime;
      if (now() - lastAdvance >= 60_000) {
        await options.finish('needs_attention', '视频进度持续 60 秒未增长，请检查缓冲、播放限制或验证'); return;
      }
    }
    // 正常播放每 5 秒读取本地播放器属性；结束后的平台确认最多再检查两次。
    await options.wait(state.ended ? 15_000 : PLAYBACK_CHECK_INTERVAL_MS, !state.ended);
    if (options.isFinished()) return;
    state = await options.read();
  }
}
