// 手动浏览器回归：node --import tsx apps/server/test/huayi-reminder.browser.ts
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { HuayiPlayer } from '../src/automation/huayi-playback.js';
const { chromium } = await import('playwright');

const course = 'https://cme28.91huayi.com/pages/course.aspx?cid=local-test';
const target = 'https://cme28.91huayi.com/course_ware/course_ware.aspx?cwid=local-video';
const reminder = `<div class="study_diaog" style="display:none;position:fixed;inset:20px;background:white;z-index:99">
  <h2>温馨提示</h2><p>学习路上，您不是孤单一人。累了就休息一下，我们一直在这里陪伴您。</p>
  <button class="btn_sign" onclick="this.parentElement.style.display='none';this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">好的，知道了</button>
</div>`;
const media = `<video muted width="320" height="180"></video><canvas width="320" height="180" hidden></canvas>
<script>
const canvas = document.querySelector('canvas');
const draw = () => { const context = canvas.getContext('2d'); context.fillStyle = '#155e75'; context.fillRect(0,0,320,180); requestAnimationFrame(draw); };
draw();
document.querySelector('video').srcObject = canvas.captureStream(10);
document.querySelector('video').play();
</script>`;

const browser = await chromium.launch({ channel: config.channel, headless: true });
try {
  for (const mode of ['main', 'parent-reminder', 'iframe-reminder'] as const) {
    const page = await browser.newPage();
    // 所有页面均为本地测试内容，不连接华医网，也不使用账号资料。
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: mode === 'main'
      ? `<h1>本地弹窗回归测试</h1>${media}${reminder}`
      : `<h1>本地弹窗回归测试</h1>${mode === 'parent-reminder' ? reminder : ''}
        <iframe style="width:600px;height:400px" srcdoc="${(media + (mode === 'iframe-reminder' ? reminder : '')).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>` }));
    await page.goto(target);
    const mediaFrame = mode === 'main' ? page.mainFrame() : page.frames().find(frame => frame !== page.mainFrame())!;
    await mediaFrame.waitForFunction(() => document.querySelector('video')!.readyState >= 3);
    const reminderFrame = mode === 'iframe-reminder' ? mediaFrame : page.mainFrame();
    let confirmations = 0;
    const player = new HuayiPlayer(page, course, 'local-video', '学习中', { onReminder: () => confirmations++ });
    await mediaFrame.locator('video').evaluate(video => video.pause());
    await reminderFrame.locator('.study_diaog').evaluate(element => { (element as HTMLElement).style.display = 'block'; });
    const before = await player.read();
    assert.match(before.needsAttention!, /温馨提示/);
    assert.equal(before.progress.playbackState, 'paused');
    const after = await player.readForMonitor();
    assert.equal(after.needsAttention, null);
    assert.equal(after.progress.playbackState, 'playing');
    assert.equal(confirmations, 1);
    await mediaFrame.waitForFunction(time => document.querySelector('video')!.currentTime > time + 0.1, after.progress.currentTime!);
    assert.equal(await reminderFrame.locator('.btn_sign').getAttribute('data-clicks'), '1');
    await player.readForMonitor();
    assert.equal(confirmations, 1, '提示关闭后不重复确认');
    await player.pause();
    assert.equal((await player.read()).progress.playbackState, 'paused');
    console.log(`PASS ${mode}: 原生按钮点击、弹窗关闭、媒体续播与进度增长、暂停`);
    await page.close();
  }
} finally { await browser.close(); }
