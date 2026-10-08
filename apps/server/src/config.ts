import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
loadEnv({ path: resolve(projectRoot, '.env'), quiet: true });

function integer(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} 必须是 1～${maximum} 的整数`);
  return value;
}

export const config = {
  port: integer('API_PORT', 3000, 65535),
  webPort: integer('WEB_PORT', 5173, 65535),
  maxConcurrency: integer('MAX_CONCURRENCY', 1, 8),
  dataDir: resolve(projectRoot, process.env.DATA_DIR ?? 'data'),
  webDist: resolve(projectRoot, 'apps/web/dist'),
  channel: process.env.BROWSER_CHANNEL ?? 'chromium',
};

process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(projectRoot,
  process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(config.dataDir, 'browsers'));
