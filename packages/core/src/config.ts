import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Treat empty strings as "not set" so `.env` lines like `SMEE_URL=` behave as absent. */
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);

function withDefault(value: string) {
  return z.preprocess(
    (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? value : v),
    z.string(),
  );
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

const httpUrl = (name: string) =>
  z
    .string()
    .trim()
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    }, `${name} must be an absolute http(s) URL`)
    .transform(trimSlash);

/** Decodes a base64 string strictly; returns null when it is not valid base64. */
function decodeBase64(value: string): Buffer | null {
  const v = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buf.length > 0 ? buf : null;
}

const EnvSchema = z.object({
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .trim()
    .refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a postgres:// URL'),
  PUBLIC_URL: z.preprocess(
    (v) => (v === undefined || v === '' ? 'http://localhost:3000' : v),
    httpUrl('PUBLIC_URL'),
  ),
  WEB_URL: optionalString.pipe(httpUrl('WEB_URL').optional()),
  PORT: z.preprocess(
    (v) => (v === undefined || v === '' ? '3000' : v),
    z.coerce.number().int().min(1).max(65535),
  ),
  MASTER_KEY: z
    .string({ error: 'MASTER_KEY is required (run `pnpm init-env`)' })
    .transform((v, ctx) => {
      const buf = decodeBase64(v);
      if (!buf || buf.length !== 32) {
        ctx.addIssue({
          code: 'custom',
          message: 'MASTER_KEY must be base64 encoding exactly 32 bytes',
        });
        return z.NEVER;
      }
      return buf;
    }),
  SESSION_SECRET: z
    .string({ error: 'SESSION_SECRET is required (run `pnpm init-env`)' })
    .refine((v) => {
      const buf = decodeBase64(v);
      return buf !== null && buf.length >= 32;
    }, 'SESSION_SECRET must be base64 encoding at least 32 bytes'),
  GITHUB_API_URL: z.preprocess(
    (v) => (v === undefined || v === '' ? 'https://api.github.com' : v),
    httpUrl('GITHUB_API_URL'),
  ),
  GITHUB_WEB_URL: z.preprocess(
    (v) => (v === undefined || v === '' ? 'https://github.com' : v),
    httpUrl('GITHUB_WEB_URL'),
  ),
  SMEE_URL: optionalString.pipe(
    z
      .string()
      .refine((v) => /^https?:\/\//.test(v), 'SMEE_URL must be an http(s) URL')
      .optional(),
  ),
  REPO_CACHE_DIR: withDefault('./.data/repos'),
  LOG_LEVEL: z.preprocess(
    (v) => (v === undefined || v === '' ? 'info' : typeof v === 'string' ? v.toLowerCase() : v),
    z.enum(LOG_LEVELS),
  ),
  NODE_ENV: z.preprocess(
    (v) => (v === undefined || v === '' ? 'development' : v),
    z.enum(['development', 'production', 'test']),
  ),
});

export interface Config {
  databaseUrl: string;
  /** Without trailing slash. */
  publicUrl: string;
  /**
   * Where users open the web UI, without trailing slash. Equals `publicUrl` unless
   * `WEB_URL` is set (e.g. the Vite dev server during `pnpm dev`). Used for redirects
   * after GitHub callbacks and for links shown to users.
   */
  webUrl: string;
  port: number;
  /** Decoded 32-byte AES-256 key. */
  masterKey: Buffer;
  /** Raw (base64) session secret. */
  sessionSecret: string;
  githubApiUrl: string;
  githubWebUrl: string;
  smeeUrl: string | undefined;
  /** Absolute path. */
  repoCacheDir: string;
  logLevel: LogLevel;
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  /** True when PUBLIC_URL is https (cookies get `Secure`). */
  secureCookies: boolean;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Validates environment variables (design §4) and returns a typed config.
 * Pure: does not read `.env` files (call {@link loadDotenv} first if wanted).
 * Error messages name the offending variable but never include its value.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    publicUrl: e.PUBLIC_URL,
    webUrl: e.WEB_URL ?? e.PUBLIC_URL,
    port: e.PORT,
    masterKey: e.MASTER_KEY,
    sessionSecret: e.SESSION_SECRET,
    githubApiUrl: e.GITHUB_API_URL,
    githubWebUrl: e.GITHUB_WEB_URL,
    smeeUrl: e.SMEE_URL,
    repoCacheDir: resolve(e.REPO_CACHE_DIR),
    logLevel: e.LOG_LEVEL,
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    secureCookies: e.PUBLIC_URL.startsWith('https://'),
  };
}

/**
 * Loads the nearest `.env` file (searching upwards from `startDir`, default cwd) into
 * `process.env` without overriding variables that are already set.
 * Returns the path loaded, or null when none was found.
 */
export function loadDotenv(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      dotenvConfig({ path: candidate, override: false, quiet: true });
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
