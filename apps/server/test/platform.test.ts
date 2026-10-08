import test from 'node:test';
import assert from 'node:assert/strict';
import { courseUrl, isPlatformVideoComplete } from '../src/automation/platform.js';
import { PLATFORM_ORIGIN } from '@medcourse/shared';

test('课程身份归一化保留项目，移除当前视频；拒绝首页、考试及其他域名', () => {
  const base = `${PLATFORM_ORIGIN}/#/remoteProject/studyInterface/project1`;
  assert.equal(courseUrl(`${base}/video2`), base);
  assert.equal(courseUrl(base), base);
  assert.equal(courseUrl(`${base}?source=page`), base);
  assert.equal(courseUrl(`${PLATFORM_ORIGIN}/#/`), null);
  assert.equal(courseUrl(`${PLATFORM_ORIGIN}/#/remoteProject/examine/id`), null);
  assert.equal(courseUrl(`https://example.com/#/remoteProject/studyInterface/project1`), null);
});

test('视频完成仅接受明确平台状态，不将百分比或未学习误判为完成', () => {
  assert.equal(isPlatformVideoComplete('已完成'), true);
  assert.equal(isPlatformVideoComplete('待考试'), true);
  assert.equal(isPlatformVideoComplete(' 待考试 '), true);
  assert.equal(isPlatformVideoComplete('暂无法考试'), false);
  assert.equal(isPlatformVideoComplete('未学习'), false);
  assert.equal(isPlatformVideoComplete('未完成'), false);
  assert.equal(isPlatformVideoComplete('学习中'), false);
  assert.equal(isPlatformVideoComplete('100%'), false);
  assert.equal(isPlatformVideoComplete(null), false);
});

test('进度采样脚本可在浏览器独立作用域执行，且只读取目标视频状态', async () => {
  const { runInNewContext } = await import('node:vm');
  const { readPlayback, PLAYLIST_SELECTOR } = await import('../src/automation/platform.js');
  const video = { currentTime: 35, duration: 100, readyState: 4, paused: false, ended: false, error: null };
  const rows = [
    { id: 'target', querySelector: (selector: string) => selector === '.indexLeft.animat' ? {} : { textContent: '学习中' } },
    { id: 'other', querySelector: (selector: string) => selector === '.indexLeft.animat' ? null : { textContent: '已完成' } },
  ];
  const document = {
    querySelectorAll: (selector: string) => selector === PLAYLIST_SELECTOR ? rows : [],
    querySelector: () => video,
  };
  // 模拟 Playwright 序列化函数后在独立页面执行；不能依赖 Node/tsx 的 __name 等辅助变量。
  const page = { evaluate: (fn: Function, input: unknown) => runInNewContext(`(${fn.toString()})(input)`, { document, input }) };
  const state = await readPlayback(page as never, 'target');
  assert.equal(state.selected, true);
  assert.equal(state.progress.currentTime, 35);
  assert.equal(state.progress.duration, 100);
  assert.equal(state.progress.playbackState, 'playing');
  assert.equal(state.progress.platformStatus, '学习中');
  assert.equal(isPlatformVideoComplete(state.progress.platformStatus), false);
  const other = await readPlayback(page as never, 'other');
  assert.equal(other.selected, false);
  assert.equal(other.progress.currentTime, null);
  assert.equal(other.progress.duration, null);
});

test('隐藏但占位的验证弹窗不打断播放，可见打卡提示给出具体原因', async () => {
  const { runInNewContext } = await import('node:vm');
  const { readPlayback, PLAYLIST_SELECTOR } = await import('../src/automation/platform.js');
  const style = { display: 'block', visibility: 'visible', opacity: '1' };
  const wrapper = { style: { ...style }, parentElement: null, getAttribute: () => null };
  const dialog = {
    textContent: '打卡 根据继续医学教育的最新要求，请您在观看课件过程中打卡',
    getClientRects: () => [{}], parentElement: wrapper, style: { ...style },
    getAttribute: () => null,
  };
  const video = { currentTime: 35, duration: 100, readyState: 4, paused: false, ended: false, error: null };
  const row = { id: 'target', querySelector: () => ({ textContent: '学习中' }) };
  const document = {
    querySelectorAll: (selector: string) => selector === PLAYLIST_SELECTOR ? [row]
      : selector.includes('.jinggaoCard') ? [dialog] : [],
    querySelector: () => video,
  };
  const page = { evaluate: (fn: Function, input: unknown) => runInNewContext(`(${fn.toString()})(input)`, {
    document, input, getComputedStyle: (element: typeof dialog) => element.style,
  }) };
  for (const hidden of [{ visibility: 'hidden' }, { opacity: '0' }, { display: 'none' }]) {
    wrapper.style = { ...style, ...hidden };
    assert.equal((await readPlayback(page as never, 'target')).needsAttention, null);
  }
  wrapper.style = { ...style };
  assert.match((await readPlayback(page as never, 'target')).needsAttention!, /打卡验证/);
});
