import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PLATFORM_ORIGIN, isLearningUrl, type PlatformId } from '@medcourse/shared';
import type { BrowserContext, Page } from 'playwright';
import { courseUrl } from './platform.js';

type HuayiSession = Awaited<ReturnType<BrowserContext['storageState']>> & { sessions: Record<string, Record<string, string>> };
const SESSION_RESTORE_MARKER = '__medcourse_session_restore__';
function huayiHost(host: string): boolean { return host === '91huayi.com' || host.endsWith('.91huayi.com'); }
function huayiOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && huayiHost(url.hostname); }
  catch { return false; }
}

async function readHuayiSession(profileDir: string): Promise<HuayiSession | undefined> {
  try {
    const state = JSON.parse(await readFile(join(profileDir, '_huayiSession.json'), 'utf8')) as HuayiSession;
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins) || !state.sessions || typeof state.sessions !== 'object') throw new Error('会话文件格式无效');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export async function writeSessionFile(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function saveHuayiSession(context: BrowserContext, profileDir: string): Promise<void> {
  const state = await context.storageState();
  const previous = await readHuayiSession(profileDir).catch(() => undefined);
  // storageState 只包含当前浏览器已访问的来源；保留这次没有打开的 SSO/其他课程子站。
  const origins = new Map((previous?.origins ?? []).filter(entry => huayiOrigin(entry.origin)).map(entry => [entry.origin, entry]));
  for (const entry of state.origins) if (huayiOrigin(entry.origin)) origins.set(entry.origin, entry);
  const sessions: HuayiSession['sessions'] = Object.fromEntries(Object.entries(previous?.sessions ?? {}).filter(([origin]) => huayiOrigin(origin)));
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      try {
        const url = new URL(frame.url());
        if (huayiOrigin(url.origin)) sessions[url.origin] = await frame.evaluate(marker =>
          Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key !== marker)), SESSION_RESTORE_MARKER);
      } catch { /* 跳过正在跳转或已经关闭的页面。 */ }
    }
  }
  await writeSessionFile(join(profileDir, '_huayiSession.json'), {
    cookies: state.cookies.filter(cookie => huayiHost(cookie.domain.replace(/^\./, ''))),
    origins: [...origins.values()],
    sessions,
  } satisfies HuayiSession);
}

export async function restoreAccountSession(context: BrowserContext, profileDir: string, platformId: PlatformId): Promise<void> {
  try {
    if (platformId === 'huayi') {
      const state = await readHuayiSession(profileDir);
      if (!state) return;
      const key = (cookie: HuayiSession['cookies'][number] & { partitionKey?: string }) => JSON.stringify([cookie.domain, cookie.path, cookie.name, cookie.partitionKey ?? null]);
      const current = new Set((await context.cookies()).map(key));
      const missing = state.cookies.filter(cookie => huayiHost(cookie.domain.replace(/^\./, ''))
        && (cookie.expires === -1 || cookie.expires > Date.now() / 1000) && !current.has(key(cookie)));
      // 持久化目录里的 Cookie 优先，只补回浏览器重启后缺失的会话 Cookie。
      if (missing.length) await context.addCookies(missing);
      await context.addInitScript(({ origins, sessions, marker, restoreId }) => {
        if (location.protocol !== 'https:' || !(location.hostname === '91huayi.com' || location.hostname.endsWith('.91huayi.com'))) return;
        // 每个标签页、每个来源只恢复一次，避免刷新时把网站已经删除的旧认证字段重新填回。
        if (sessionStorage.getItem(marker) === restoreId) return;
        sessionStorage.setItem(marker, restoreId);
        if (localStorage.length === 0) {
          for (const entry of origins.find(origin => origin.origin === location.origin)?.localStorage ?? []) localStorage.setItem(entry.name, entry.value);
        }
        for (const [key, value] of Object.entries(sessions[location.origin] ?? {})) {
          if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
        }
      }, { origins: state.origins, sessions: state.sessions, marker: SESSION_RESTORE_MARKER, restoreId: randomUUID() });
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
export async function readCourseName(page: Page, platformId: PlatformId, requested: string, timeoutMs = 180_000, allowManualLogin = true): Promise<string> {
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
      } else {
        if (!allowManualLogin) throw new Error('读取课程名称需要登录，请先通过“登录”完成登录，或开启“显示浏览器”后重试');
        courseVisibleSince = undefined;
      }
    } else courseVisibleSince = undefined;
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }
  throw new Error(allowManualLogin ? '读取课程名称超时；如需登录，请在打开的课程窗口完成人工登录后重新添加'
    : '读取课程名称超时，请先通过“登录”完成登录，或开启“显示浏览器”后重试');
}
