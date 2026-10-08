let kind;
process.on('message', message => {
  if (message.type === 'start') {
    kind = message.job.kind;
    if (message.job.kind === 'playback') {
      process.send({ type: 'progress', progress: { currentTime: 12, duration: 100, playbackState: 'playing', platformStatus: '学习中', sampledAt: new Date().toISOString() } });
      if (message.job.chapterId === 'verify') process.send({ type: 'waiting_user', message: '等待人工打卡验证' });
      if (message.job.chapterId === 'complete-exam') {
        process.send({ type: 'progress', progress: { currentTime: 100, duration: 100, playbackState: 'ended', platformStatus: '待考试', sampledAt: new Date().toISOString() } });
        process.send({ type: 'done', status: 'completed', message: '视频学习结束，待考试；继续下一视频' });
        process.disconnect();
      }
    } else process.send({ type: 'waiting_user', message: '等待测试确认' });
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
