import { isLearningUrl, type PlaylistItem, type PlaybackProgress } from '@medcourse/shared';
import type { Page } from 'playwright';
import { chooseCourseName, isRequestedCoursePage } from './course-name.js';

export function isHuayiCourseUrl(value: string): boolean {
  if (!isLearningUrl('huayi', value)) return false;
  const url = new URL(value);
  return url.pathname.toLowerCase() === '/pages/course.aspx' && !!url.searchParams.get('cid') && !url.hash;
}

export async function readHuayiPlaylist(page: Page, requested: string): Promise<{ courseUrl: string; courseTitle: string; items: PlaylistItem[] }> {
  if (!isHuayiCourseUrl(requested)) throw new Error('华医网请填写项目详情页链接（pages/course.aspx?cid=…）');
  if (!isRequestedCoursePage('huayi', requested, page.url())) throw new Error('请先通过网站设置的“登录本站”完成华医网登录，再读取视频列表');
  await page.locator('.course[data-href] .cw-title-link').first().waitFor({ state: 'visible', timeout: 20_000 });
  if (!isRequestedCoursePage('huayi', requested, page.url())) throw new Error('课程页面已跳转，请重新通过“登录本站”登录');
  const raw = await page.evaluate(() => ({
    title: document.querySelector('h3 > strong.f14blue')?.textContent ?? '',
    rows: [...document.querySelectorAll<HTMLElement>('.course[data-href]')].map(row => {
      let category = '';
      for (let previous = row.previousElementSibling; previous; previous = previous.previousElementSibling) {
        if (previous.matches('.exam_tit')) { category = previous.textContent?.trim() ?? ''; break; }
      }
      const progress = row.querySelector<HTMLElement>('.cw-progress-row');
      return {
        href: row.getAttribute('data-href') ?? '',
        title: row.querySelector('.cw-title-link strong, .cw-title-link')?.textContent?.trim() ?? '',
        position: row.querySelector('.cw-index')?.textContent ?? '',
        status: progress?.dataset.studystate?.trim() || row.querySelector('.cw-status button')?.textContent?.trim() || null,
        currentTime: progress?.dataset.maxtime,
        duration: progress?.dataset.totaltime,
        excluded: category.replace(/\s+/g, '') === '互动病例演练',
      };
    }),
  }));
  const courseTitle = chooseCourseName([raw.title]);
  if (!courseTitle || !raw.rows.length || raw.rows.length > 2000) throw new Error('课程目录或标题不完整，未导入视频列表');
  const sampledAt = new Date().toISOString();
  const items = raw.rows.map((row): PlaylistItem => {
    const url = new URL(row.href, requested);
    const id = url.searchParams.get('cwid');
    const position = Number(row.position.replace(/\s|\./g, ''));
    if (!isLearningUrl('huayi', url.href) || url.origin !== new URL(requested).origin
      || url.pathname.toLowerCase() !== '/course_ware/course_ware.aspx' || !id || !row.title || !Number.isInteger(position) || position < 1) {
      throw new Error('章节链接或编号不可靠，未导入视频列表');
    }
    const current = row.currentTime === undefined || row.currentTime === '' ? null : Number(row.currentTime);
    const total = row.duration === undefined || row.duration === '' ? null : Number(row.duration);
    if ((current !== null && (!Number.isFinite(current) || current < 0)) || (total !== null && (!Number.isFinite(total) || total < 0))) throw new Error('平台目录进度无效，未导入视频列表');
    const duration = total && total > 0 ? total : null;
    const seconds = duration === null ? null : Math.floor(duration);
    const durationText = seconds === null ? '' : `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    const progress: PlaybackProgress = { currentTime: current, duration, playbackState: 'unknown', platformStatus: row.status, sampledAt };
    return { chapterId: id, chapterTitle: row.title, position, durationText, platformStatus: row.status, progress,
      ...(row.excluded ? { excludedReason: '互动病例演练，按设置排除，不参与学习' } : {}) };
  });
  if (new Set(items.map(item => item.chapterId)).size !== items.length) throw new Error('章节编号重复，未导入视频列表');
  return { courseUrl: requested, courseTitle, items };
}
