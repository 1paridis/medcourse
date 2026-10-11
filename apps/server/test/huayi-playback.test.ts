import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { HuayiPlayer, isHuayiPlaybackPage } from '../src/automation/huayi-playback.js';

const course = 'https://cme28.91huayi.com/pages/course.aspx?cid=course-a';
const target = 'https://cme28.91huayi.com/course_ware/course_ware.aspx?cwid=video-a';
const visibleStyle = { display: 'block', visibility: 'visible', opacity: '1' };

type FrameOptions = { video?: any; dialog?: string; hidden?: boolean; login?: boolean; activeChapter?: string;
  signIn?: boolean; signText?: string; clickFails?: boolean; stickyReminder?: boolean };
function frame(options: FrameOptions = {}) {
  let reminderVisible = !!options.signIn, clicks = 0;
  const element = (text: string) => ({ textContent: text, parentElement: null, getClientRects: () => [{}], getAttribute: () => null,
    style: { ...visibleStyle, ...(options.hidden ? { display: 'none' } : {}) } });
  const document = {
    body: { innerText: '' },
    querySelector: () => options.activeChapter ? { querySelector: (selector: string) => selector.includes('data-cwrid') ? { dataset: { cwrid: options.activeChapter } } : { textContent: '学习中' } } : null,
    querySelectorAll: (selector: string) => selector === 'video' ? options.video ? [options.video] : []
      : selector.includes('btn_sign') ? reminderVisible ? [element(options.signText ?? '好的，知道了')] : []
      : selector.includes('password') ? options.login ? [element('')] : []
        : selector.includes('role=') ? options.dialog ? [element(options.dialog)] : [] : [],
  };
  return {
    evaluate: (fn: Function, input: unknown) => runInNewContext(`(${fn.toString()})(input)`, { document, input, getComputedStyle: (element: any) => element.style }),
    locator: () => ({ evaluateAll: async (fn: Function) => fn(options.video ? [options.video] : []),
      filter: ({ hasText }: { hasText: RegExp }) => ({
        count: async () => reminderVisible && hasText.test(options.signText ?? '好的，知道了') ? 1 : 0,
        nth: () => ({ isVisible: async () => reminderVisible && !options.hidden,
          click: async () => { clicks++; if (options.clickFails) throw new Error('click failed'); if (!options.stickyReminder) reminderVisible = false; },
          waitFor: async () => { if (reminderVisible) throw new Error('still visible'); },
        }),
      }),
    }),
    clicks: () => clicks,
    isDetached: () => false,
  };
}
function video(overrides = {}) {
  return { currentTime: 1451, duration: 2938, paused: false, ended: false, readyState: 4, error: null, muted: false, playbackRate: 1,
    parentElement: null, getClientRects: () => [{}], getAttribute: () => null, style: visibleStyle,
    hasAttribute: () => false, setAttribute: () => {}, addEventListener: () => {},
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, ...overrides };
}
function fixture(options: FrameOptions & { current?: string; nested?: boolean; multiple?: boolean; ended?: boolean;
  sideLogin?: boolean; nestedReminder?: boolean; sideReminder?: boolean; finished?: boolean } = {}) {
  const media = video({ ended: !!options.ended });
  const main = frame({ ...options, signIn: options.signIn && !options.nestedReminder, video: options.nested ? undefined : media });
  const frames = options.nested ? [main, frame({ ...options, signIn: options.signIn && options.nestedReminder, video: media })] : [main];
  if (options.multiple) frames.push(frame({ video: video() }));
  if (options.sideLogin) frames.push(frame({ login: true }));
  if (options.sideReminder) frames.push(frame({ signIn: true }));
  let requests = 0, closes = 0, reminders = 0;
  const directory = {
    addInitScript: async () => {}, goto: async () => { requests++; }, url: () => course,
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    evaluate: async () => ({ title: '测试课程', rows: [{ href: target, title: '第一节', position: '1.', status: '待考试', currentTime: '2938', duration: '2938', excluded: false }] }),
    close: async () => { closes++; },
  };
  const page = { url: () => options.current ?? target, mainFrame: () => main, frames: () => frames, context: () => ({ newPage: async () => directory }) };
  return { player: new HuayiPlayer(page as never, course, 'video-a', '学习中', {
    onReminder: () => reminders++, isFinished: () => !!options.finished,
  }), media, requests: () => requests, closes: () => closes, reminders: () => reminders,
    clicks: () => frames.reduce((sum, frame) => sum + frame.clicks(), 0) };
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
  const f = fixture({ ended: true, nested: true, activeChapter: 'video-a' });
  const state = await f.player.readForMonitor();
  assert.equal(state.ended, true);
  assert.equal(state.progress.platformStatus, '待考试');
  assert.equal(state.progress.currentTime, 1451, '目录的累计时间不冒充媒体时间');
  assert.equal(f.requests(), 1);
  assert.equal(f.closes(), 1);
  await f.player.readForMonitor();
  assert.equal(f.requests(), 1, '确认请求有间隔限制');
  assert.equal((await f.player.read()).progress.platformStatus, '待考试', '最终快照不被旧侧栏的学习中覆盖');
});

test('华医温馨提示在主页面或媒体 iframe 自动点击后恢复，快照只读且不会重复点击', async () => {
  for (const options of [{}, { nested: true }, { nested: true, nestedReminder: true }]) {
    const f = fixture({ ...options, signIn: true });
    f.media.pause();
    assert.match((await f.player.read()).needsAttention!, /温馨提示.*好的，知道了/);
    assert.equal(f.clicks(), 0, '暂停时读取快照不会处理弹窗');
    const state = await f.player.readForMonitor();
    assert.equal(state.needsAttention, null);
    assert.equal(state.progress.currentTime, 1451);
    assert.equal(state.progress.playbackState, 'playing');
    assert.equal(f.media.playbackRate, 1);
    assert.equal(f.clicks(), 1);
    assert.equal(f.reminders(), 1);
    assert.equal(f.requests(), 0);
    await f.player.readForMonitor();
    assert.equal(f.clicks(), 1);
  }
});

test('华医启动时已有温馨提示会自动确认；隐藏提示及无关 iframe 的按钮不点击', async () => {
  const startup = fixture({ signIn: true });
  startup.media.pause();
  assert.equal((await startup.player.ready()).needsAttention, null);
  assert.equal(startup.clicks(), 1);
  assert.equal(startup.media.paused, false);
  const hidden = fixture({ signIn: true, hidden: true });
  assert.equal((await hidden.player.readForMonitor()).needsAttention, null);
  assert.equal(hidden.clicks(), 0);
  const unrelated = fixture({ sideReminder: true });
  assert.equal((await unrelated.player.readForMonitor()).needsAttention, null);
  assert.equal(unrelated.clicks(), 0);
});

test('华医提示点击失败、未关闭或按钮文案不匹配时保持等待，不恢复媒体', async () => {
  for (const options of [{ clickFails: true }, { stickyReminder: true }, { signText: '开始人脸验证' }]) {
    const f = fixture({ ...options, signIn: true });
    f.media.pause();
    const state = await f.player.readForMonitor();
    assert.match(state.needsAttention!, /打卡验证/);
    assert.equal(f.media.paused, true);
    assert.equal(f.reminders(), 0);
    assert.equal(f.requests(), 0);
  }
});

test('华医章节不匹配、多个播放器、登录或身份验证及已停止任务均不自动点击', async () => {
  for (const options of [{ current: target.replace('video-a', 'other') }, { activeChapter: 'other' },
    { multiple: true }, { login: true }, { dialog: '请完成人脸身份验证' }, { finished: true }]) {
    const f = fixture({ ...options, signIn: true });
    f.media.pause();
    assert.ok((await f.player.readForMonitor()).needsAttention);
    assert.equal(f.clicks(), 0);
    assert.equal(f.media.paused, true);
  }
});
