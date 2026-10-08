import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const commands = [
  { name: 'SHARED', args: [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', 'packages/shared/tsconfig.json', '--watch', '--preserveWatchOutput'], cwd: root },
  { name: 'API', args: ['--import', 'tsx', '--watch', 'apps/server/src/index.ts'], cwd: root },
  { name: 'WEB', args: [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))], cwd: fileURLToPath(new URL('../apps/web/', import.meta.url)) },
];
const children = commands.map(command => {
  const child = spawn(process.execPath, command.args, { cwd: command.cwd, stdio: 'inherit' });
  child.on('error', error => { console.error(`${command.name} 无法启动：${error.message}`); stop(1); });
  child.once('exit', code => { if (!stopping) stop(code ?? 1); });
  return child;
});
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
