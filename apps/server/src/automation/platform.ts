import { PLATFORM_ORIGIN, type PlaylistItem, type PlaybackProgress } from '@medcourse/shared';
import type { Page } from 'playwright';

export const PLAYLIST_SELECTOR = '.ycxmDetBox .listRight > ul > li[id]';
export const VIDEO_SELECTOR = '.by-player__video-layer video, .by-player video, .videoLeft video';

export function isPlatformUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === PLATFORM_ORIGIN && !url.username && !url.password;
  } catch { return false; }
}

export function courseUrl(value: string): string | null {
  if (!isPlatformUrl(value)) return null;
  const match = new URL(value).hash.match(/^#\/remoteProject\/studyInterface\/([^/?#]+)(?:\/[^/?#]+)?\/?(?:\?.*)?$/);
  return match ? `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/${match[1]}` : null;
}

export async function inspectPage(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('.by-player__video-layer video')
      ?? document.querySelector<HTMLVideoElement>('.by-player video')
      ?? document.querySelector<HTMLVideoElement>('video');
    const visiblePassword = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')]
      .some(input => input.getClientRects().length > 0);
    return {
      title: document.title,
      loginFormVisible: visiblePassword,
      video: video ? {
        paused: video.paused, ended: video.ended, readyState: video.readyState,
        currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : null,
      } : null,
    };
  });
}

export async function readPlaylist(page: Page): Promise<{ courseUrl: string; courseTitle: string; items: PlaylistItem[] }> {
  await page.locator(PLAYLIST_SELECTOR).first().waitFor({ state: 'visible', timeout: 20_000 });
  const url = courseUrl(page.url());
  if (!url) throw new Error('请先进入平台播放页，再读取播放列表');
  const result = await page.evaluate(selector => {
    const items = [...document.querySelectorAll(selector)].map((row, index) => ({
      chapterId: row.id,
      chapterTitle: row.querySelector('.xxjmRight h4')?.textContent?.trim() ?? '',
      position: index + 1,
      durationText: row.querySelector('.xxjmRight p > span')?.textContent?.trim() ?? '',
      platformStatus: row.querySelector('.image .wxx')?.textContent?.trim() || null,
    }));
    return {
      courseTitle: document.querySelector('.ycxmDetBox > .flexbtw > h3')?.textContent?.trim() || document.title,
      items,
    };
  }, PLAYLIST_SELECTOR);
  if (!result.items.length || result.items.length > 2000 || result.items.some(item => !item.chapterId || !item.chapterTitle)
    || new Set(result.items.map(item => item.chapterId)).size !== result.items.length) {
    throw new Error('播放列表的标题或视频标识不完整，请人工检查');
  }
  return { courseUrl: url, ...result };
}

export async function readPlayback(page: Page, chapterId: string): Promise<{ progress: PlaybackProgress; selected: boolean; ended: boolean; needsAttention: string | null }> {
  return page.evaluate(({ selector, videoSelector, id }) => {
    const rows = [...document.querySelectorAll(selector)];
    const row = rows.find(row => row.id === id);
    const selected = !!row?.querySelector('.indexLeft.animat');
    const video = selected ? document.querySelector<HTMLVideoElement>(videoSelector) : null;
    const login = [...document.querySelectorAll('input[type="password"]')].some(element => element.getClientRects().length > 0);
    // 只检查可见播放器告警及验证对话框，避免读取全页面完成文字。
    const playerError = [...document.querySelectorAll('.by-player .by-player__error-overlay')].some(element => element.getClientRects().length > 0);
    const warning = [...document.querySelectorAll('.videoLeft .jinggaoCard, .el-dialog, .el-message-box')]
      .filter(element => element.getClientRects().length > 0).map(element => element.textContent?.trim() ?? '')
      .find(text => /打卡|人脸|身份验证|验证码|重新登录|请.*登录|请依次|请.*完成.*学习|考试|签到/.test(text));
    return {
      selected,
      ended: !!video?.ended,
      needsAttention: login ? '检测到登录表单，请重新人工登录' : warning ? '平台要求人工验证、考试或前置课程处理，请打开人工登录窗口处理' : null,
      progress: {
        currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : null,
        duration: video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
        playbackState: playerError || video?.error ? 'error' : !video ? 'unknown' : video.ended ? 'ended' : video.paused ? 'paused' : video.readyState < 3 ? 'buffering' : 'playing',
        platformStatus: row?.querySelector('.image .wxx')?.textContent?.trim() || null,
        sampledAt: new Date().toISOString(),
      } as PlaybackProgress,
    };
  }, { selector: PLAYLIST_SELECTOR, videoSelector: VIDEO_SELECTOR, id: chapterId });
}

export function isPlatformVideoComplete(label: string | null): boolean {
  return !!label && /^(已完成|已学完|学习完成|已学习|已考试)$/.test(label.trim());
}
