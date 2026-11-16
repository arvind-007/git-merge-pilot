import { createRequire } from 'node:module';
import pino from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';
import { redactSecrets } from './redaction.ts';

export type { Logger } from 'pino';

/** Keys whose values are always replaced with `[REDACTED]` in log output (design §5). */
export const SENSITIVE_KEY_PATTERN =
  /token|secret|key|password|passwd|authorization|cookie|credential/i;

/**
 * Keys that match {@link SENSITIVE_KEY_PATTERN} but are known not to hold secrets
 * (token counts, dedup/queue keys, key ids), so useful diagnostics are not lost.
 */
const SAFE_KEY_PATTERN =
  /^(?:(?:input|output|cache_?read|cache_?creation|cache_?write|max_?input|max_?output|max|total|prompt|completion|reasoning)_?tokens(?:_?per_?call)?|tokens_?used|(?:dedup|singleton|cache|idempotency|partition|sort|primary|foreign|group|routing|lookup|row|job|queue|map|object|redis|state|translation|i18n|react)_?key|key_?(?:id|count|name)s?|keys)$/i;

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;
const MAX_STRING_SCAN = 64 * 1024;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) && !SAFE_KEY_PATTERN.test(key);
}

function redactString(value: string): string {
  if (value.length > MAX_STRING_SCAN) return value;
  return redactSecrets(value).text;
}

/** Recursively redacts sensitive keys and secret-looking string values. */
export function redactLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      type: value.name,
      message: redactString(value.message),
    };
    if (value.stack) out.stack = redactString(value.stack);
    for (const [k, v] of Object.entries(value)) {
      if (k === 'message' || k === 'stack') continue;
      out[k] = isSensitiveKey(k) ? REDACTED : redactLogValue(v, depth + 1, seen);
    }
    if ('cause' in value && value.cause !== undefined) {
      out.cause = redactLogValue(value.cause, depth + 1, seen);
    }
    return out;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((v) => redactLogValue(v, depth + 1, seen));
  if (value instanceof Map) {
    return redactLogValue(Object.fromEntries(value), depth, seen);
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k) && v !== null && v !== undefined && typeof v !== 'boolean') {
      out[k] = REDACTED;
    } else {
      out[k] = redactLogValue(v, depth + 1, seen);
    }
  }
  return out;
}

export interface CreateLoggerOptions {
  level?: pino.LevelWithSilent;
  /** Custom destination (tests). Disables pretty printing. */
  destination?: DestinationStream;
  /** Force pretty output on/off. Default: on in development when stdout is a TTY and pino-pretty is installed. */
  pretty?: boolean;
  /** Extra bindings for every line. */
  bindings?: Record<string, unknown>;
}

function canUsePretty(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function buildOptions(level: pino.LevelWithSilent): LoggerOptions {
  return {
    level,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Errors are serialised (and redacted) by redactLogValue in formatters.log, which runs
    // before serializers; identity serializers stop pino re-wrapping them as plain objects.
    serializers: { err: (v: unknown) => v, error: (v: unknown) => v },
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => redactLogValue(obj) as Record<string, unknown>,
    },
    hooks: {
      // Redact secrets inside interpolated message strings, e.g. log.info('url %s', url).
      logMethod(args, method) {
        const redacted = args.map((a) => (typeof a === 'string' ? redactString(a) : a));
        return method.apply(this, redacted as Parameters<typeof method>);
      },
    },
  };
}

let rootLogger: Logger | null = null;

function defaultLevel(): pino.LevelWithSilent {
  const lvl = (process.env.LOG_LEVEL ?? '').toLowerCase();
  const valid = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
  if (valid.includes(lvl)) return lvl as pino.LevelWithSilent;
  return process.env.NODE_ENV === 'test' ? 'silent' : 'info';
}

function getRootLogger(): Logger {
  if (rootLogger) return rootLogger;
  const level = defaultLevel();
  const options = buildOptions(level);
  const pretty =
    process.env.NODE_ENV === 'development' && process.stdout.isTTY === true && canUsePretty();
  rootLogger = pretty
    ? pino({
        ...options,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
        },
      })
    : pino(options);
  return rootLogger;
}

/**
 * Creates a named logger. Keys matching /token|secret|key|password|authorization/i are
 * redacted, as are secret-looking substrings in any logged string.
 * Without options, returns a child of a shared process-wide root logger.
 */
export function createLogger(name: string, options: CreateLoggerOptions = {}): Logger {
  const bindings = { name, ...(options.bindings ?? {}) };
  if (!options.destination && options.pretty === undefined && options.level === undefined) {
    return getRootLogger().child(bindings);
  }
  const level = options.level ?? defaultLevel();
  const base = buildOptions(level);
  if (options.destination) return pino(base, options.destination).child(bindings);
  if (options.pretty && canUsePretty()) {
    return pino({
      ...base,
      transport: { target: 'pino-pretty', options: { colorize: true } },
    }).child(bindings);
  }
  return pino(base).child(bindings);
}
