import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PLATFORM_ORIGIN, isLearningUrl, type PlatformId } from '@medcourse/shared';
import type { BrowserContext, Page } from 'playwright';
import { courseUrl } from './platform.js';

type HuayiSession = Awaited<ReturnType<BrowserContext['storageState']>> & { sessions: Record<string, Record<string, string>> };
function huayiHost(host: string): boolean { return host === '91huayi.com' || host.endsWith('.91huayi.com'); }

export async function writeSessionFile(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function saveHuayiSession(context: BrowserContext, profileDir: string): Promise<void> {
  const state = await context.storageState();
  const sessions: HuayiSession['sessions'] = {};
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      try {
        const url = new URL(frame.url());
        if (url.protocol === 'https:' && huayiHost(url.hostname)) sessions[url.origin] = await frame.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
      } catch { /* 跳过正在跳转或已经关闭的页面。 */ }
    }
  }
  await writeSessionFile(join(profileDir, '_huayiSession.json'), {
    cookies: state.cookies.filter(cookie => huayiHost(cookie.domain.replace(/^\./, ''))),
    origins: state.origins.filter(origin => { const url = new URL(origin.origin); return url.protocol === 'https:' && huayiHost(url.hostname); }),
    sessions,
  } satisfies HuayiSession);
}

export async function restoreAccountSession(context: BrowserContext, profileDir: string, platformId: PlatformId): Promise<void> {
  try {
    if (platformId === 'huayi') {
      const state = JSON.parse(await readFile(join(profileDir, '_huayiSession.json'), 'utf8')) as HuayiSession;
      await context.addCookies(state.cookies.filter(cookie => huayiHost(cookie.domain.replace(/^\./, '')) && (cookie.expires === -1 || cookie.expires > Date.now() / 1000)));
      await context.addInitScript(({ origins, sessions }) => {
        if (location.protocol !== 'https:' || !(location.hostname === '91huayi.com' || location.hostname.endsWith('.91huayi.com'))) return;
        for (const entry of origins.find(origin => origin.origin === location.origin)?.localStorage ?? []) {
          if (localStorage.getItem(entry.name) === null) localStorage.setItem(entry.name, entry.value);
        }
        for (const [key, value] of Object.entries(sessions[location.origin] ?? {})) {
          if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
        }
      }, { origins: state.origins, sessions: state.sessions });
      return;
    }
    const storage = JSON.parse(await readFile(join(profileDir, '_sessionStorage.json'), 'utf8')) as Record<string, string>;
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
}

export function isRequestedCoursePage(platformId: PlatformId, requested: string, actual: string): boolean {
  if (!isLearningUrl(platformId, actual)) return false;
  if (platformId === 'henan' && courseUrl(requested)) return courseUrl(requested) === courseUrl(actual);
  const target = new URL(requested), current = new URL(actual);
  return target.origin === current.origin && target.pathname === current.pathname && target.hash === current.hash
    && [...target.searchParams].every(([key, value]) => current.searchParams.get(key) === value);
}

export function chooseCourseName(values: string[]): string | null {
  for (const value of values) {
    const name = value.replace(/\s+/g, ' ').trim()
      .replace(/\s*[-—|_]\s*(?:华医网.*|河南.*继续.*教育.*)$/, '').trim();
    if (!name || name.length > 120 || /^(?:登录|用户登录|账号登录|微信登录|注册|首页|项目详情|课程详情|课程学习与考试|互动病例演练|继续教育|继续医学教育|华医网.*|河南.*继续.*教育平台|访问被拦截.*|Error.*|Access Denied.*|\d{3})$/i.test(name)) continue;
    return name;
  }
  return null;
}

// 只读页面标题；不点击视频、考试或病例入口。登录页只能由用户人工完成。
export async function readCourseName(page: Page, platformId: PlatformId, requested: string, timeoutMs = 180_000): Promise<string> {
  if (!isLearningUrl(platformId, requested)) throw new Error('请输入所属网站的 HTTPS 学习链接，不要填写网站首页');
  await page.addInitScript(() => document.addEventListener('play', event => {
    if (event.target instanceof HTMLMediaElement) event.target.pause();
  }, true));
  if (!isRequestedCoursePage(platformId, requested, page.url())) await page.goto(requested, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const deadline = Date.now() + timeoutMs;
  let courseVisibleSince: number | undefined;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('课程读取窗口已关闭，未添加课程');
    if (isRequestedCoursePage(platformId, requested, page.url())) {
      const state = await page.evaluate(id => {
        const visibility = { visible(node: Element) { return node.getClientRects().length > 0; } };
        const loginVisible = [...document.querySelectorAll('input[type="password"]')].some(visibility.visible);
        const primary = id === 'henan'
          ? [...document.querySelectorAll('.ycxmDetBox > .flexbtw > h3')]
          : [...document.querySelectorAll('h3 > strong.f14blue, .header-left .course-name'),
            ...document.querySelectorAll('h1, h2')];
        return {
          loginVisible,
          names: [...primary.filter(visibility.visible).map(node => node.textContent ?? ''),
            ...(id === 'huayi' ? [document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '', document.title] : [])],
        };
      }, platformId);
      if (!state.loginVisible) {
        const name = chooseCourseName(state.names);
        if (name) return name;
        courseVisibleSince ??= Date.now();
        if (Date.now() - courseVisibleSince >= 20_000) throw new Error('网页未提供可识别的课程名称，请确认链接指向具体课程');
      } else courseVisibleSince = undefined;
    } else courseVisibleSince = undefined;
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }
  throw new Error('读取课程名称超时；如需登录，请在打开的课程窗口完成人工登录后重新添加');
}
