import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export function acquireLock(path: string): () => void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('服务锁文件无效，请检查 data/.server.lock');
    try {
      process.kill(pid, 0);
      throw new Error('已有服务使用这个数据目录，请先关闭原服务');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      rmSync(path);
    }
  }
  const descriptor = openSync(path, 'wx', 0o600);
  try { writeFileSync(descriptor, String(process.pid)); }
  finally { closeSync(descriptor); }
  return () => {
    if (existsSync(path) && readFileSync(path, 'utf8') === String(process.pid)) rmSync(path);
  };
}
