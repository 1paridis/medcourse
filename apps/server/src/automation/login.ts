import { join } from 'node:path';
import { PLATFORM_ORIGIN, type PlatformId } from '@medcourse/shared';
import type { BrowserContext, Frame, Page } from 'playwright';
import { saveHuayiSession, writeSessionFile } from './course-name.js';
import { courseUrl } from './platform.js';

export function isLoginOrigin(value: string, platformId: PlatformId): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && (platformId === 'henan' ? url.origin === PLATFORM_ORIGIN
        : url.hostname === '91huayi.com' || url.hostname.endsWith('.91huayi.com'));
  } catch { return false; }
}

// 必须有网站显示的登录成功标记；空白页、隐藏的退出菜单和仅有 Cookie 都不能证明已登录。
export async function isAuthenticated(frame: Frame | Page, platformId: PlatformId): Promise<boolean> {
  if (!isLoginOrigin(frame.url(), platformId)) return false;
  return frame.evaluate(id => {
    const url = new URL(location.href);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !(id === 'henan' ? url.origin === 'https://yuancheng.henanyixue.com'
        : url.hostname === '91huayi.com' || url.hostname.endsWith('.91huayi.com'))) return false;
    const visible = (node: Element | null): boolean => !!node && node.getClientRects().length > 0
      && getComputedStyle(node).visibility !== 'hidden';
    if ([...document.querySelectorAll('input[type="password"]')].some(visible)) return false;
    if ([...document.querySelectorAll('a, button, li, [role="button"], .logout')]
      .some(node => visible(node) && /^(?:退出(?:登录|登陆|账号)?|注销(?:登录|登陆|账号)?)$/.test(node.textContent?.trim() ?? ''))) return true;
    // 华医网首页的退出菜单在鼠标悬停前隐藏，登录后显示独立的账号区域。
    return id === 'huayi' && visible(document.querySelector('#ifssologed'))
      && !visible(document.querySelector('#ssologin'));
  }, platformId).catch(() => false); // 跳转时的执行上下文失效，下次再检查。
}

export async function findAuthenticatedPage(context: BrowserContext, platformId: PlatformId): Promise<Page | undefined> {
  for (const page of [...context.pages()].reverse()) {
    if (!isLoginOrigin(page.url(), platformId)) continue;
    for (const frame of page.frames()) if (await isAuthenticated(frame, platformId)) return page;
  }
  return undefined;
}

export async function saveLoginSession(context: BrowserContext, page: Page, profileDir: string, platformId: PlatformId): Promise<string | undefined> {
  if (!isLoginOrigin(page.url(), platformId)) throw new Error('页面已离开目标网站，暂不记录登录');
  if (platformId === 'huayi') { await saveHuayiSession(context, profileDir); return; }
  const storage = await page.evaluate(() => {
    if (location.origin !== 'https://yuancheng.henanyixue.com') throw new Error('页面已离开目标网站');
    return Object.fromEntries(Object.entries(sessionStorage));
  });
  await writeSessionFile(join(profileDir, '_sessionStorage.json'), storage);
  return courseUrl(page.url()) ?? undefined;
}

export class LoginRecorder {
  private previousPage?: Page;
  private previousUrl?: string;

  constructor(private options: {
    find: () => Promise<Page | undefined>;
    save: (page: Page) => Promise<void>;
  }) {}

  async check(): Promise<void> {
    const page = await this.options.find();
    const url = page?.url();
    const stable = page && page === this.previousPage && url === this.previousUrl;
    this.previousPage = page;
    this.previousUrl = url;
    if (stable) await this.options.save(page);
  }
}
