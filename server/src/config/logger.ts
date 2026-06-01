import { env } from './env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

function format(level: Level, msg: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const base = `${ts} ${level.toUpperCase()} ${msg}`;
  const withMeta = meta !== undefined ? `${base} ${safeStringify(meta)}` : base;
  if (env.isProd) return withMeta;
  return `${COLORS[level]}${withMeta}${RESET}`;
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  debug(msg: string, meta?: unknown): void {
    if (env.isDev) console.debug(format('debug', msg, meta));
  },
  info(msg: string, meta?: unknown): void {
    console.info(format('info', msg, meta));
  },
  warn(msg: string, meta?: unknown): void {
    console.warn(format('warn', msg, meta));
  },
  error(msg: string, meta?: unknown): void {
    console.error(format('error', msg, meta));
  },
};
