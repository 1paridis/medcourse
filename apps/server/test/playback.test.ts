import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { monitorPlayback, runPlaybackWithRestarts, VerificationRestartBudget, waitForPlaybackCheck } from '../src/automation/playback.js';
import type { readPlayback } from '../src/automation/platform.js';

type Observation = Awaited<ReturnType<typeof readPlayback>>;
function observation(time: number, changes: Partial<Observation> = {}): Observation {
  return {
    selected: true, ended: false, needsAttention: null,
    progress: { currentTime: time, duration: 1000, playbackState: 'playing', platformStatus: '学习中', sampledAt: new Date().toISOString() },
    ...changes,
  };
}

function harness(states: Observation[]) {
  let stopped = false;
  let clock = 0;
  let reads = 0;
  const waits: { timeoutMs: number; observeMedia: boolean }[] = [];
  const finishes: { status: string; message: string }[] = [];
  const initial = states.shift()!;
  const options = {
    read: async () => { reads++; assert.ok(states.length, '不应额外读取状态'); return states.shift()!; },
    wait: async (timeoutMs: number, observeMedia: boolean) => { waits.push({ timeoutMs, observeMedia }); clock += timeoutMs; },
    progress: () => {},
    finish: async (status: string, message: string) => { finishes.push({ status, message }); stopped = true; },
    isFinished: () => stopped,
    now: () => clock,
  };
  return { initial, options, waits, finishes, reads: () => reads, stop: () => { stopped = true; } };
}

test('正常播放每 5 秒读取进度，并在确认播放结束后完成', async () => {
  const finished = observation(1000, { ended: true });
  finished.progress.platformStatus = '已完成';
  const h = harness([observation(0), observation(100), observation(300), finished]);
  await monitorPlayback(h.initial, h.options);
  assert.deepEqual(h.waits, [5000, 5000, 5000].map(timeoutMs => ({ timeoutMs, observeMedia: true })));
  assert.equal(h.reads(), 3);
  assert.equal(h.finishes[0].status, 'completed');
});

test('视频结束后平台变为待考试也完成播放任务，不阻塞下一视频', async () => {
  const ended = observation(1000, { ended: true });
  ended.progress.playbackState = 'ended';
  const awaitingExam = { ...ended, progress: { ...ended.progress, platformStatus: '待考试' } };
  const h = harness([observation(995), ended, awaitingExam]);
  await monitorPlayback(h.initial, h.options);
  assert.deepEqual(h.waits, [
    { timeoutMs: 5000, observeMedia: true }, { timeoutMs: 15_000, observeMedia: false },
  ]);
  assert.equal(h.finishes[0].status, 'completed');
  assert.match(h.finishes[0].message, /待考试.*考试需人工处理/);
});

test('短暂缓冲不误判停滞，持续 60 秒未前进才停止', async () => {
  const h = harness([
    observation(0), ...Array.from({ length: 6 }, () => observation(0)),
    observation(100), ...Array.from({ length: 12 }, () => observation(100)),
  ]);
  await monitorPlayback(h.initial, h.options);
  assert.equal(h.waits.length, 19);
  assert.equal(h.finishes[0].status, 'needs_attention');
  assert.match(h.finishes[0].message, /60 秒/);
});

test('持续无法读取时间 60 秒后要求人工处理', async () => {
  const unknown = () => {
    const state = observation(0);
    state.progress.currentTime = null;
    state.progress.playbackState = 'unknown';
    return state;
  };
  const missing = harness(Array.from({ length: 13 }, unknown));
  await monitorPlayback(missing.initial, missing.options);
  assert.equal(missing.reads(), 12);
  assert.equal(missing.finishes[0].status, 'needs_attention');
});

test('结束后只做两次平台确认，未确认时不继续下一视频', async () => {
  const ended = () => observation(1000, { ended: true });
  const h = harness([ended(), ended(), ended()]);
  await monitorPlayback(h.initial, h.options);
  assert.deepEqual(h.waits, [15_000, 15_000].map(timeoutMs => ({ timeoutMs, observeMedia: false })));
  assert.equal(h.finishes[0].status, 'needs_attention');
  assert.match(h.finishes[0].message, /完成状态未确认/);
});

test('媒体报错、人工验证、章节切换都会停止当前任务', async () => {
  const error = observation(50);
  error.progress.playbackState = 'error';
  for (const state of [error, observation(50, { needsAttention: '请人工验证' }), observation(50, { selected: false })]) {
    const h = harness([observation(0), state]);
    await monitorPlayback(h.initial, h.options);
    assert.equal(h.reads(), 1);
    assert.equal(h.finishes[0].status, 'needs_attention');
  }
});

test('等待期间暂停后不再获取视频状态或覆盖结束状态', async () => {
  const h = harness([observation(0)]);
  h.options.wait = async () => { h.stop(); };
  await monitorPlayback(h.initial, h.options);
  assert.equal(h.reads(), 0);
  assert.equal(h.finishes.length, 0);
});

test('打卡等待超过停滞时限仍保留任务，验证完成后恢复播放并完成', async () => {
  const verification = observation(35, { needsAttention: '平台弹出打卡验证，需要人工完成后继续播放' });
  verification.progress.playbackState = 'paused';
  const ended = observation(1000, { ended: true });
  ended.progress.platformStatus = '已完成';
  const h = harness([observation(0), ...Array.from({ length: 20 }, () => verification), observation(35), observation(40), ended]);
  const notices: string[] = [];
  let resumes = 0;
  await monitorPlayback(h.initial, {
    ...h.options,
    onAttention: async message => { notices.push(message); },
    onResume: async () => { resumes++; },
  });
  assert.equal(notices.length, 1);
  assert.equal(resumes, 1);
  assert.equal(h.finishes.length, 1);
  assert.equal(h.finishes[0].status, 'completed');
  assert.equal(h.waits.filter(wait => !wait.observeMedia).length, 20);
});

test('等待打卡时可手动暂停，且验证期间章节切换后不自动恢复播放', async () => {
  const state = observation(35, { needsAttention: '平台弹出打卡验证，需要人工完成后继续播放' });
  const h = harness([state]);
  h.options.wait = async () => { h.stop(); };
  await monitorPlayback(h.initial, { ...h.options, onAttention: async () => {} });
  assert.equal(h.reads(), 0);
  assert.equal(h.finishes.length, 0);
  const switched = harness([state, observation(50, { selected: false })]);
  await monitorPlayback(switched.initial, {
    ...switched.options, onAttention: async () => {},
    onResume: async () => { assert.fail('不能恢复其他章节'); },
  });
  assert.equal(switched.finishes[0].status, 'needs_attention');
});

test('验证触发时返回重启请求并提供真实进度，不结束任务或覆盖队列', async () => {
  const state = observation(2111, { needsAttention: '平台弹出打卡验证，需要人工完成后继续播放' });
  state.progress.playbackState = 'paused';
  const h = harness([state]);
  assert.equal(await monitorPlayback(h.initial, {
    ...h.options,
    onAttention: async (message, progress) => {
      assert.match(message, /打卡/);
      assert.equal(progress.currentTime, 2111);
      assert.equal(progress.playbackState, 'paused');
      return 'restart';
    },
  }), 'restart');
  assert.equal(h.waits.length, 0);
  assert.equal(h.reads(), 0);
  assert.equal(h.finishes.length, 0);
  const wrongChapter = harness([{ ...state, selected: false }]);
  await monitorPlayback(wrongChapter.initial, {
    ...wrongChapter.options, onAttention: async () => { assert.fail('不能自动重开已切换的章节'); },
  });
  assert.equal(wrongChapter.finishes[0].status, 'needs_attention');
});

test('重启只在保存进度和关闭旧浏览器后打开新页面，始终重试同一任务', async () => {
  const actions: string[] = [];
  let pages = 1;
  await runPlaybackWithRestarts(1, {
    play: async page => { actions.push(`play:${page}`); return page < 3 ? 'restart' : undefined; },
    pause: async page => { actions.push(`save:${page}`); },
    close: async () => { actions.push('close'); },
    open: async () => { actions.push('open'); return ++pages; },
    isFinished: () => false,
  });
  assert.deepEqual(actions, ['play:1', 'save:1', 'close', 'open', 'play:2', 'save:2', 'close', 'open', 'play:3']);
});

test('自动重启任一阶段手动暂停后不再开启下一轮，打开失败会交给任务错误处理', async () => {
  for (const stage of ['play', 'pause', 'close', 'open']) {
    let stopped = false;
    const actions: string[] = [];
    const action = (name: string) => { actions.push(name); if (stage === name) stopped = true; };
    await runPlaybackWithRestarts(1, {
      play: async () => { action('play'); return 'restart'; },
      pause: async () => { action('pause'); }, close: async () => { action('close'); },
      open: async () => { action('open'); return 2; }, isFinished: () => stopped,
    });
    assert.deepEqual(actions, ['play', 'pause', 'close', 'open'].slice(0, ['play', 'pause', 'close', 'open'].indexOf(stage) + 1));
  }
  await assert.rejects(runPlaybackWithRestarts(1, {
    play: async () => 'restart', pause: async () => {}, close: async () => {},
    open: async () => { throw new Error('浏览器打开失败'); }, isFinished: () => false,
  }), /浏览器打开失败/);
});

test('一分钟内允许前五次自动重启，第六次拒绝，满一分钟后恢复额度', () => {
  let clock = 0;
  const budget = new VerificationRestartBudget(() => clock);
  assert.deepEqual(Array.from({ length: 6 }, () => budget.request()), [1, 2, 3, 4, 5, null]);
  clock = 59_999;
  assert.equal(budget.request(), null);
  clock = 60_000;
  assert.equal(budget.request(), 1);
});

test('浏览器等待脚本只设一次定时器，结束/报错事件提前唤醒并移除监听', async () => {
  for (const eventType of ['ended', 'error', 'timeout', 'already-ended', 'confirm']) {
    const listeners = new Map<string, Function>();
    const timers: Function[] = [];
    let cleared = 0;
    let videoReads = 0;
    class Video {
      ended = eventType === 'already-ended';
      error = null;
      matches() { return true; }
    }
    const video = new Video();
    const document = {
      addEventListener: (type: string, callback: Function) => listeners.set(type, callback),
      removeEventListener: (type: string) => listeners.delete(type),
      querySelector: () => { videoReads++; return video; },
    };
    const page = {
      evaluate: (fn: Function, input: unknown) => runInNewContext(`(${fn.toString()})(input)`, {
        input, document, HTMLVideoElement: Video,
        setTimeout: (callback: Function, ms: number) => { assert.equal(ms, 5000); timers.push(callback); return 1; },
        clearTimeout: () => { cleared++; },
      }),
    };
    const waiting = waitForPlaybackCheck(page as never, 5000, eventType !== 'confirm');
    // evaluate 同步安装监听，异步等待结果。非视频事件不能触发检查。
    if (eventType === 'ended' || eventType === 'error') {
      listeners.get(eventType)!({ target: {} });
      assert.equal(cleared, 0);
      listeners.get(eventType)!({ target: video });
    } else if (eventType !== 'already-ended') timers[0]();
    await waiting;
    assert.equal(timers.length, 1);
    assert.equal(cleared, 1);
    assert.equal(listeners.size, 0);
    assert.equal(videoReads, eventType === 'confirm' ? 0 : 1);
  }
});
