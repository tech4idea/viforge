import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';

import { LOGS_ROOT } from './env';

type ConsoleMethod = 'debug' | 'error' | 'info' | 'log' | 'warn';

let installed = false;
let writeQueue: Promise<void> = Promise.resolve();
let originalConsoleError: (...args: unknown[]) => void = console.error.bind(console);

const MAX_JSON_LOG_STRING_LENGTH = 60_000;
const MAX_JSON_LOG_ARRAY_LENGTH = 200;
const MAX_JSON_LOG_OBJECT_KEYS = 200;
const MAX_JSON_LOG_DEPTH = 8;

export function installFileLogger(logRoot = LOGS_ROOT): void {
  if (installed) return;
  installed = true;

  const originals: Record<ConsoleMethod, (...args: unknown[]) => void> = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };
  originalConsoleError = originals.error;

  const write = (fileName: string, line: string) => {
    enqueueLogWrite(logRoot, fileName, line);
  };

  const patch = (method: ConsoleMethod, fileName: string, mirrorToMainLog: boolean) => {
    console[method] = (...args: unknown[]) => {
      originals[method](...args);
      const line = formatLogLine(method, args);
      if (mirrorToMainLog) write('api.log', line);
      write(fileName, line);
    };
  };

  patch('debug', 'api.log', false);
  patch('info', 'api.log', false);
  patch('log', 'api.log', false);
  patch('warn', 'api.error.log', true);
  patch('error', 'api.error.log', true);
}

export function appendJsonLog(fileName: string, record: Record<string, unknown>, logRoot = LOGS_ROOT): void {
  const line = `${JSON.stringify(toJsonLogValue({ timestamp: new Date().toISOString(), ...record }))}\n`;
  enqueueLogWrite(logRoot, fileName, line);
}

function enqueueLogWrite(logRoot: string, fileName: string, line: string): void {
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(logRoot, { recursive: true });
      await appendFile(path.join(logRoot, fileName), line, 'utf8');
    })
    .catch((error: unknown) => {
      originalConsoleError('[api logger] failed to write log file', error);
    });
}

function formatLogLine(level: ConsoleMethod, args: unknown[]): string {
  return `[${new Date().toISOString()}] [${level.toUpperCase()}] ${args.map(formatLogArg).join(' ')}\n`;
}

function formatLogArg(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  return inspect(value, { colors: false, depth: 8, breakLength: 160 });
}

function toJsonLogValue(value: unknown, depth = 0, seen = new WeakSet<object>(), key = ''): unknown {
  if (isSensitiveLogKey(key)) {
    return '[redacted]';
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'string') {
    return truncateLogString(value);
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value ?? null;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return String(value);
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[circular]';
  }

  if (depth >= MAX_JSON_LOG_DEPTH) {
    return '[max-depth]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_JSON_LOG_ARRAY_LENGTH)
      .map((item) => toJsonLogValue(item, depth + 1, seen));
    if (value.length > MAX_JSON_LOG_ARRAY_LENGTH) {
      items.push(`[truncated ${value.length - MAX_JSON_LOG_ARRAY_LENGTH} items]`);
    }
    seen.delete(value);
    return items;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [entryKey, entryValue] of entries.slice(0, MAX_JSON_LOG_OBJECT_KEYS)) {
    output[entryKey] = toJsonLogValue(entryValue, depth + 1, seen, entryKey);
  }
  if (entries.length > MAX_JSON_LOG_OBJECT_KEYS) {
    output.__truncatedKeys = entries.length - MAX_JSON_LOG_OBJECT_KEYS;
  }
  seen.delete(value);
  return output;
}

function truncateLogString(value: string): string {
  if (value.length <= MAX_JSON_LOG_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_JSON_LOG_STRING_LENGTH)}...[truncated ${value.length - MAX_JSON_LOG_STRING_LENGTH} chars]`;
}

function isSensitiveLogKey(key: string): boolean {
  return /(?:api[_-]?key|auth|authorization|bearer|cookie|password|secret|token)/i.test(key);
}
