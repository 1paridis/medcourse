let kind;
let loginSaved = false;
process.on('message', message => {
  if (message.type === 'course_name') {
    setTimeout(() => {
      process.send({ type: 'course_name', requestId: message.requestId, name: '自动读取的课程名称' });
      if (!kind) process.disconnect();
    }, 80);
    return;
  }
  if (message.type === 'start') {
    kind = message.job.kind;
    if (kind === 'playlist' && message.job.courseId) {
      process.send({ type: 'playlist', courseUrl: message.job.url, courseTitle: '测试课程', items: [
        { chapterId: 'v1', chapterTitle: '测试视频', position: 1, durationText: '10:00', platformStatus: '未学习' },
      ] });
      process.send({ type: 'done', status: 'completed', message: '列表读取完成' });
      process.disconnect();
      return;
    }
    if (message.job.kind === 'playback') {
      process.send({ type: 'progress', progress: { currentTime: 12, duration: 100, playbackState: 'playing', platformStatus: '学习中', sampledAt: new Date().toISOString() } });
      if (message.job.chapterId === 'verify') process.send({ type: 'waiting_user', message: '等待人工打卡验证' });
      if (message.job.chapterId === 'complete-exam') {
        process.send({ type: 'progress', progress: { currentTime: 100, duration: 100, playbackState: 'ended', platformStatus: '待考试', sampledAt: new Date().toISOString() } });
        process.send({ type: 'done', status: 'completed', message: '视频学习结束，待考试；继续下一视频' });
        process.disconnect();
      }
    } else process.send({ type: 'waiting_user', message: '等待平台登录成功，状态自动记录' });
  }
  if (message.type === 'test_authenticated' && kind === 'login') {
    loginSaved = true;
    process.send({ type: 'login_saved', message: '登录状态已自动记录' });
    return;
  }
  if (message.type === 'test_close' && kind === 'login') {
    process.send({ type: 'done', status: loginSaved ? 'completed' : 'stopped', message: '登录窗口已关闭' });
    process.disconnect();
    return;
  }
  if (message.type === 'confirm' && kind === 'playback') {
    process.send({ type: 'playback_resumed', message: '验证完成，继续播放' });
    return;
  }
  if (['confirm', 'stop', 'pause'].includes(message.type)) {
    process.send({ type: 'done', status: message.type === 'confirm' ? 'completed' : message.type === 'pause' ? 'paused' : 'stopped', message: '测试进程结束' });
    process.disconnect();
  }
});
