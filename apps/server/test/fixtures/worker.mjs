process.on('message', message => {
  if (message.type === 'start') {
    if (message.job.kind === 'playback') {
      process.send({ type: 'progress', progress: { currentTime: 12, duration: 100, playbackState: 'playing', platformStatus: '学习中', sampledAt: new Date().toISOString() } });
    } else process.send({ type: 'waiting_user', message: '等待测试确认' });
  }
  if (['confirm', 'stop', 'pause'].includes(message.type)) {
    process.send({ type: 'done', status: message.type === 'confirm' ? 'completed' : message.type === 'pause' ? 'paused' : 'stopped', message: '测试进程结束' });
    process.disconnect();
  }
});
