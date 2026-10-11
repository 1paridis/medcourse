import type { Frame, Page } from 'playwright';
import type { PlaybackProgress, PlaylistItem } from '@medcourse/shared';
import { isHuayiCourseUrl, readHuayiPlaylist } from './huayi.js';
import { isPlatformVideoComplete, type readPlayback } from './platform.js';
import { waitForPlaybackCheck } from './playback.js';

type Observation = Awaited<ReturnType<typeof readPlayback>>;
const REMINDER_SELECTOR = '.study_diaog .btn_sign, .sign-in-menu .btn_sign';
const REMINDER_MESSAGE = '华医网温馨提示（打卡验证）尚未关闭，请在播放窗口点击“好的，知道了”后继续';

export function isHuayiPlaybackPage(course: string, chapterId: string, current: string): boolean {
  if (!isHuayiCourseUrl(course) || !chapterId) return false;
  try {
    const url = new URL(current);
    return url.origin === new URL(course).origin && !url.username && !url.password && !url.hash
      && ['/course_ware/course_ware.aspx', '/course_ware/course_ware_polyv.aspx'].includes(url.pathname.toLowerCase())
      && url.searchParams.get('cwid') === chapterId;
  } catch { return false; }
}

// 每次开始都从所属课程目录取网站原始链接，避免拼接播放授权地址或误入考试、病例。
export async function openHuayiVideo(page: Page, course: string, chapterId: string): Promise<PlaylistItem> {
  const playlist = await readHuayiPlaylist(page, course);
  const item = playlist.items.find(item => item.chapterId === chapterId);
  if (!item) throw new Error('华医网目录已变化，未找到目标视频；请重新读取视频列表');
  if (item.excludedReason) throw new Error('互动病例演练已排除，不参与视频播放');
  if (isPlatformVideoComplete(item.platformStatus)) return item;
  const href = await page.evaluate(id => [...document.querySelectorAll('.course[data-href]')]
    .map(row => row.getAttribute('data-href') || '')
    .find(href => new URL(href, location.href).searchParams.get('cwid') === id), chapterId);
  const target = href ? new URL(href, course).href : '';
  if (!isHuayiPlaybackPage(course, chapterId, target)) throw new Error('华医网目标章节链接不可靠，请重新读取视频列表');
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return item;
}

export class HuayiPlayer {
  private platformStatus: string | null;
  private lastConfirmation: number | undefined;

  constructor(private page: Page, private course: string, private chapterId: string, status: string | null,
    private hooks: { onReminder?: () => void; isFinished?: () => boolean } = {}) {
    this.platformStatus = status;
  }

  private async sample() {
    const samples = await Promise.all(this.page.frames().map(async frame => {
      try {
        const state = await frame.evaluate(({ reminderSelector, reminderMessage }) => {
          const visibility = {
            visible(element: Element) {
              if (!element.getClientRects().length) return false;
              for (let parent: Element | null = element; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
                  || style.opacity === '0' || parent.getAttribute('aria-hidden') === 'true') return false;
              }
              return true;
            },
          };
          const videos = [...document.querySelectorAll<HTMLVideoElement>('video')].filter(visibility.visible);
          const video = videos.length === 1 ? videos[0] : undefined;
          const active = document.querySelector('.lis-inside-content.current-playing');
          const activeChapter = active?.querySelector<HTMLElement>('.cw-progress-row[data-cwrid]')?.dataset.cwrid ?? null;
          const platformStatus = active?.querySelector('.cw-tag-row > button, .cw-tag-list button')?.textContent?.trim() || null;
          const login = [...document.querySelectorAll('input[type="password"]')].some(visibility.visible);
          const dialogs = [...document.querySelectorAll('[role="dialog"], .layui-layer-dialog, .layui-layer-page, .layer_tips, #div_tip, .modal, .weui-dialog, .el-dialog, .el-message-box, .ui-dialog')]
            .filter(visibility.visible).map(element => element.textContent?.trim() ?? '');
          // 签到使用自定义容器，文案可能只有“温馨提示/注意休息”，没有“签到”字样。
          const signIn = [...document.querySelectorAll(reminderSelector)].some(visibility.visible);
          // 没有播放器的登录/验证拦截页也需明确提示；有播放器时只检查可见对话框。
          const body = document.body?.innerText ?? '';
          if (!videos.length && /请(?:先|重新)?登录|登录已失效|访问被拦截|请.*(?:完成|进行).*(?:人脸|身份验证|打卡)|请依次.*学习/.test(body)) dialogs.push(body);
          const warning = dialogs.find(text => /打卡|签到|人脸|身份验证|验证码|重新登录|请.*登录|请依次|请.*完成.*学习|访问被拦截/.test(text));
          const playerError = [...document.querySelectorAll('.pv-error-msg, .pv-error-wrap, .vjs-error-display, .jw-error-msg, .prism-error-content')].some(visibility.visible);
          return {
            count: videos.length, activeChapter, platformStatus,
            needsAttention: login ? '检测到登录表单，请通过“登录本站”重新人工登录'
              : warning && /人脸|身份验证|验证码/.test(warning) ? '平台要求身份验证，需要人工完成后继续播放'
              : warning && !/打卡|签到/.test(warning) ? '平台要求登录、前置学习或访问受限，请通过“登录本站”人工处理'
              : signIn ? reminderMessage
              : warning ? /打卡|签到/.test(warning) ? '平台弹出打卡验证，需要人工完成后继续播放'
                : /人脸|身份验证|验证码/.test(warning) ? '平台要求身份验证，需要人工完成后继续播放'
                  : '平台要求登录、前置学习或访问受限，请通过“登录本站”人工处理' : null,
            ended: !!video?.ended,
            currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : null,
            duration: video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
            playbackState: playerError || video?.error ? 'error' : !video ? 'unknown' : video.ended ? 'ended'
              : video.paused ? 'paused' : video.readyState < 3 ? 'buffering' : 'playing',
          };
        }, { reminderSelector: REMINDER_SELECTOR, reminderMessage: REMINDER_MESSAGE });
        return { frame, ...state };
      } catch (error) {
        if (frame.isDetached()) return undefined;
        throw error;
      }
    }));
    return samples.filter(sample => sample !== undefined);
  }

  private async mediaFrame(): Promise<Frame | undefined> {
    if (!isHuayiPlaybackPage(this.course, this.chapterId, this.page.url())) return;
    const samples = await this.sample();
    if (samples.some(sample => (sample.needsAttention && (sample.frame === this.page.mainFrame() || sample.count > 0))
      || (sample.activeChapter && sample.activeChapter !== this.chapterId)) || samples.reduce((sum, sample) => sum + sample.count, 0) !== 1) return;
    return samples.find(sample => sample.count === 1)?.frame;
  }

  async read(): Promise<Observation> {
    const samples = await this.sample();
    const active = samples.find(sample => sample.frame === this.page.mainFrame());
    const selected = isHuayiPlaybackPage(this.course, this.chapterId, this.page.url())
      && (!active?.activeChapter || active.activeChapter === this.chapterId);
    const count = samples.reduce((sum, sample) => sum + sample.count, 0);
    const media = selected && count === 1 ? samples.find(sample => sample.count === 1) : undefined;
    const warning = samples.find(sample => sample.needsAttention && (sample.frame === this.page.mainFrame() || sample.count > 0))?.needsAttention;
    // 结束时目录已确认的状态优先于播放页尚未刷新的侧栏，避免最终快照回退为“学习中”。
    if (selected && active?.activeChapter === this.chapterId && active.platformStatus
      && (!isPlatformVideoComplete(this.platformStatus) || isPlatformVideoComplete(active.platformStatus))) this.platformStatus = active.platformStatus;
    return {
      selected, ended: !!media?.ended,
      needsAttention: warning || (!selected ? '华医网播放页已跳转，请重新登录并确认目标章节'
        : count > 1 ? '页面存在多个播放器，无法确认目标视频，请人工检查' : null),
      progress: {
        currentTime: media?.currentTime ?? null, duration: media?.duration ?? null,
        playbackState: (media?.playbackState ?? 'unknown') as PlaybackProgress['playbackState'],
        platformStatus: this.platformStatus, sampledAt: new Date().toISOString(),
      },
    };
  }

  async ready(): Promise<Observation> {
    const deadline = Date.now() + 15_000;
    let state = await this.acknowledgeReminder(await this.read());
    while (!state.needsAttention && state.progress.playbackState === 'unknown' && Date.now() < deadline) {
      await waitForPlaybackCheck(this.page, 500, false, 'video');
      state = await this.acknowledgeReminder(await this.read());
    }
    return state;
  }

  async resume(): Promise<void> {
    if (this.hooks.isFinished?.()) return;
    const frame = await this.mediaFrame();
    if (!frame || this.hooks.isFinished?.()) return;
    await frame.locator('video').evaluateAll(async videos => {
      const video = videos.find(video => video.getClientRects().length > 0) as HTMLVideoElement | undefined;
      if (!video) return;
      video.muted = true;
      await video.play().catch(() => {});
      video.muted = true;
    });
  }

  async pause(): Promise<void> {
    await Promise.all(this.page.frames().map(frame => frame.locator('video')
      .evaluateAll(videos => videos.forEach(video => (video as HTMLVideoElement).pause())).catch(() => {})));
  }

  async wait(timeoutMs: number, observeMedia: boolean): Promise<void> {
    await waitForPlaybackCheck(await this.mediaFrame() ?? this.page, timeoutMs, observeMedia, 'video');
  }

  async readForMonitor(): Promise<Observation> {
    const state = await this.acknowledgeReminder(await this.read());
    if (!state.selected || state.needsAttention || !state.ended) return state;
    // 播放中只读本地媒体属性；自然结束后通过正常课程页确认平台状态，最多每 15 秒一次。
    if (this.lastConfirmation !== undefined && Date.now() - this.lastConfirmation < 15_000) return state;
    this.lastConfirmation = Date.now();
    const directory = await this.page.context().newPage();
    try {
      await directory.addInitScript(() => document.addEventListener('play', event => {
        if (event.target instanceof HTMLMediaElement) event.target.pause();
      }, true));
      await directory.goto(this.course, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      const playlist = await readHuayiPlaylist(directory, this.course);
      const item = playlist.items.find(item => item.chapterId === this.chapterId);
      if (!item || item.excludedReason) state.needsAttention = '华医网目录中的目标章节已变化，请重新读取视频列表';
      else state.progress.platformStatus = this.platformStatus = item.platformStatus;
    } catch {
      state.needsAttention = '视频已结束，无法读取华医网完成状态，请检查登录或重新读取视频列表';
    } finally { await directory.close().catch(() => {}); }
    return state;
  }

  private async acknowledgeReminder(state: Observation): Promise<Observation> {
    if (!state.selected || state.needsAttention !== REMINDER_MESSAGE || this.hooks.isFinished?.()) return state;
    const samples = await this.sample();
    // 仅在目标章节和唯一播放器明确时操作主页面或播放器 iframe 中的提示。
    if (samples.reduce((sum, sample) => sum + sample.count, 0) !== 1
      || samples.some(sample => sample.activeChapter && sample.activeChapter !== this.chapterId)
      || samples.some(sample => sample.needsAttention && sample.needsAttention !== REMINDER_MESSAGE
        && (sample.frame === this.page.mainFrame() || sample.count > 0))) return state;
    for (const sample of samples) {
      if (sample.needsAttention !== REMINDER_MESSAGE || (sample.frame !== this.page.mainFrame() && !sample.count)) continue;
      const buttons = sample.frame.locator(REMINDER_SELECTOR).filter({ hasText: /^\s*好的[，,]\s*知道了\s*$/ });
      for (let index = 0, count = await buttons.count(); index < count; index++) {
        const button = buttons.nth(index);
        if (!await button.isVisible() || this.hooks.isFinished?.()) continue;
        try {
          // 使用网站原有按钮及其事件处理，关闭提示后再正常恢复媒体。
          await button.click({ timeout: 2000 });
          await button.waitFor({ state: 'hidden', timeout: 2000 });
        } catch {
          return this.read();
        }
        this.hooks.onReminder?.();
        const next = await this.read();
        if (!next.needsAttention && next.selected && !next.ended && !this.hooks.isFinished?.()) await this.resume();
        return this.read();
      }
    }
    return state;
  }
}
