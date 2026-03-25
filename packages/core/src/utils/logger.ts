/**
 * Lightweight structured logger.
 *
 * Usage:
 *   const log = logger('my-module');
 *   log.info('Started', { port: 3000 });
 *
 * Call initFileLogs(dir) once in the daemon process to enable daily-rotating
 * file output: neoclaw_YYYY-MM-DD.log.  When not initialised, output goes to
 * stdout/stderr (useful in dev / foreground mode).
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let _activeLevel: Level = 'info';

// File-sink state — null means "use console"
let _logDir: string | null = null;
let _currentDate = '';
let _currentLogPath = '';

export function setLogLevel(level: Level): void {
  _activeLevel = level;
}

/**
 * Enable daily-rotating file logging.  Safe to call before the directory
 * exists — it will be created.  Subsequent calls update the directory.
 */
export function initFileLogs(logDir: string): void {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  _logDir = logDir;
  _currentDate = ''; // force path refresh on next write
}

// ── helpers ──────────────────────────────────────────────────────────────────

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timestamp(): string {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = now.getMinutes().toString().padStart(2, '0');
  const s = now.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function shouldLog(level: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[_activeLevel];
}

function formatLine(level: Level, module: string, msg: string): string {
  const tag = level.toUpperCase().padEnd(5);
  return `[${timestamp()}] ${tag} [${module}] ${msg}`;
}

function serializeArgs(args: unknown[]): string {
  if (!args.length) return '';
  return ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

function emit(level: Level, line: string, args: unknown[]): void {
  if (_logDir !== null) {
    // Rotate to a new file when the calendar date changes
    const date = todayStr();
    if (date !== _currentDate) {
      _currentDate = date;
      _currentLogPath = join(_logDir, `${date}.log`);
    }
    appendFileSync(_currentLogPath, line + serializeArgs(args) + '\n');
  } else {
    if (level === 'warn' || level === 'error') {
      console.error(line, ...args);
    } else {
      console.log(line, ...args);
    }
  }
}

// ── public interface ──────────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function logger(module: string): Logger {
  return {
    debug(msg, ...args) {
      if (shouldLog('debug')) emit('debug', formatLine('debug', module, msg), args);
    },
    info(msg, ...args) {
      if (shouldLog('info')) emit('info', formatLine('info', module, msg), args);
    },
    warn(msg, ...args) {
      if (shouldLog('warn')) emit('warn', formatLine('warn', module, msg), args);
    },
    error(msg, ...args) {
      if (shouldLog('error')) emit('error', formatLine('error', module, msg), args);
    },
  };
}
