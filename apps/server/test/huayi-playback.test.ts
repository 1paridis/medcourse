import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { HuayiPlayer, isHuayiPlaybackPage } from '../src/automation/huayi-playback.js';

const course = 'https://cme28.91huayi.com/pages/course.aspx?cid=course-a';
const target = 'https://cme28.91huayi.com/course_ware/course_ware.aspx?cwid=video-a';
const visibleStyle = { display: 'block', visibility: 'visible', opacity: '1' };

function frame(options: { video?: any; dialog?: string; hidden?: boolean; login?: boolean; activeChapter?: string } = {}) {
  const element = (text: string) => ({ textContent: text, parentElement: null, getClientRects: () => [{}], getAttribute: () => null,
    style: { ...visibleStyle, ...(options.hidden ? { display: 'none' } : {}) } });
  const document = {
    body: { innerText: '' },
    querySelector: () => options.activeChapter ? { querySelector: (selector: string) => selector.includes('data-cwrid') ? { dataset: { cwrid: options.activeChapter } } : { textContent: '学习中' } } : null,
    querySelectorAll: (selector: string) => selector === 'video' ? options.video ? [options.video] : []
      : selector.includes('password') ? options.login ? [element('')] : []
        : selector.includes('role=') ? options.dialog ? [element(options.dialog)] : [] : [],
  };
  return {
    evaluate: (fn: Function, input: unknown) => runInNewContext(`(${fn.toString()})(input)`, { document, input, getComputedStyle: (element: any) => element.style }),
    locator: () => ({ evaluateAll: async (fn: Function) => fn(options.video ? [options.video] : []) }),
    isDetached: () => false,
  };
}
function video(overrides = {}) {
  return { currentTime: 1451, duration: 2938, paused: false, ended: false, readyState: 4, error: null, muted: false, playbackRate: 1,
    parentElement: null, getClientRects: () => [{}], getAttribute: () => null, style: visibleStyle,
    hasAttribute: () => false, setAttribute: () => {}, addEventListener: () => {},
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, ...overrides };
}
function fixture(options: { current?: string; nested?: boolean; dialog?: string; hidden?: boolean; login?: boolean; multiple?: boolean; ended?: boolean; activeChapter?: string; sideLogin?: boolean } = {}) {
  const media = video({ ended: !!options.ended });
  const main = frame({ ...options, video: options.nested ? undefined : media });
  const frames = options.nested ? [main, frame({ video: media })] : [main];
  if (options.multiple) frames.push(frame({ video: video() }));
  if (options.sideLogin) frames.push(frame({ login: true }));
  let requests = 0, closes = 0;
  const directory = {
    addInitScript: async () => {}, goto: async () => { requests++; }, url: () => course,
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    evaluate: async () => ({ title: '测试课程', rows: [{ href: target, title: '第一节', position: '1.', status: '待考试', currentTime: '2938', duration: '2938', excluded: false }] }),
    close: async () => { closes++; },
  };
  const page = { url: () => options.current ?? target, mainFrame: () => main, frames: () => frames, context: () => ({ newPage: async () => directory }) };
  return { player: new HuayiPlayer(page as never, course, 'video-a', '学习中'), media, requests: () => requests, closes: () => closes };
}

test('华医播放页必须匹配课程域名、章节标识和播放路径', () => {
  assert.equal(isHuayiPlaybackPage(course, 'video-a', target), true);
  assert.equal(isHuayiPlaybackPage(course, 'video-a', target.replace('course_ware.aspx', 'course_ware_polyv.aspx')), true);
  for (const value of [target.replace('video-a', 'other'), target.replace('cme28.', 'cme24.'), target.replace('course_ware.aspx', 'exam.aspx'), `${target}#other`, 'https://evil.example/']) {
    assert.equal(isHuayiPlaybackPage(course, 'video-a', value), false);
  }
});

test('华医主页面和 iframe 媒体均读取实际进度，静音播放不修改进度或速度，暂停能停止媒体', async () => {
  for (const nested of [false, true]) {
    const f = fixture({ nested });
    const state = await f.player.readForMonitor();
    assert.equal(state.selected, true);
    assert.equal(state.needsAttention, null);
    assert.equal(state.progress.currentTime, 1451);
    assert.equal(state.progress.duration, 2938);
    assert.equal(state.progress.playbackState, 'playing');
    assert.equal(f.requests(), 0, '播放中不发起目录确认请求');
    await f.player.pause();
    assert.equal((await f.player.read()).progress.playbackState, 'paused');
    await f.player.resume();
    assert.equal(f.media.muted, true);
    assert.equal(f.media.currentTime, 1451);
    assert.equal(f.media.playbackRate, 1);
    assert.equal(f.media.paused, false);
  }
});

test('华医跳转或多个播放器不会将其他视频进度写入目标章节', async () => {
  for (const options of [{ current: target.replace('video-a', 'other') }, { multiple: true }, { activeChapter: 'other' }]) {
    const f = fixture(options);
    const state = await f.player.read();
    assert.ok(state.needsAttention);
    assert.equal(state.progress.currentTime, null);
    await f.player.pause();
    await f.player.resume();
    assert.equal(f.media.paused, true, '目标不确定时禁止恢复播放');
    assert.equal(f.requests(), 0);
  }
});

test('华医侧栏指南或 AI 的登录表单不打断主播放器', async () => {
  const f = fixture({ activeChapter: 'video-a', sideLogin: true });
  assert.equal((await f.player.read()).needsAttention, null);
  await f.player.pause();
  await f.player.resume();
  assert.equal(f.media.paused, false);
});

test('华医隐藏验证不会中断，可见验证和登录阻止恢复，结束时不确认目录', async () => {
  const hidden = fixture({ dialog: '请完成人脸身份验证', hidden: true });
  assert.equal((await hidden.player.read()).needsAttention, null);
  for (const options of [{ dialog: '请完成打卡签到' }, { dialog: '请完成人脸身份验证' }, { login: true }]) {
    const f = fixture({ ...options, ended: true });
    assert.ok((await f.player.readForMonitor()).needsAttention);
    await f.player.pause();
    await f.player.resume();
    assert.equal(f.media.paused, true);
    assert.equal(f.requests(), 0);
  }
});

test('华医自然结束后单独读取所属课程确认待考试，保留媒体进度并关闭确认页', async () => {
  const f = fixture({ ended: true, nested: true });
  const state = await f.player.readForMonitor();
  assert.equal(state.ended, true);
  assert.equal(state.progress.platformStatus, '待考试');
  assert.equal(state.progress.currentTime, 1451, '目录的累计时间不冒充媒体时间');
  assert.equal(f.requests(), 1);
  assert.equal(f.closes(), 1);
  await f.player.readForMonitor();
  assert.equal(f.requests(), 1, '确认请求有间隔限制');
});
