import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { createApp } from './app.js';
import { acquireLock } from './lock.js';

process.umask(0o077);
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
chmodSync(config.dataDir, 0o700);
const releaseLock = acquireLock(join(config.dataDir, '.server.lock'));
process.once('exit', releaseLock);
const store = new Store(join(config.dataDir, 'medcourse.sqlite'));
const scheduler = new Scheduler(store, config);
const app = await createApp({ ...config, store, scheduler });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await scheduler.close();
  await app.close();
  store.close();
  releaseLock();
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
try {
  await app.listen({ host: '127.0.0.1', port: config.port });
  store.recoverInterrupted();
  scheduler.pump();
} catch (error) {
  app.log.error(error);
  await close();
  process.exitCode = 1;
}
