import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

let logFile: string | null = null;
const MAX = 5 * 1024 * 1024;

export function initLogger(dir: string) {
  mkdirSync(dir, { recursive: true });
  logFile = join(dir, 'app.log');
}

function write(level: string, msg: string, extra?: unknown) {
  const line = `${new Date().toISOString()} [${level}] ${msg}${extra !== undefined ? ' ' + safe(extra) : ''}\n`;
  if (process.env.SBM_LOG_STDOUT) process.stdout.write(line);
  if (!logFile) return;
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX) renameSync(logFile, `${logFile}.1`);
    appendFileSync(logFile, line);
  } catch { /* never crash because of logging */ }
}

function safe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ''}`;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const log = {
  info: (m: string, e?: unknown) => write('INFO', m, e),
  warn: (m: string, e?: unknown) => write('WARN', m, e),
  error: (m: string, e?: unknown) => write('ERROR', m, e),
};
