/**
 * Integration-test harness: a freshly migrated Postgres database per test file
 * (gmp_test_server_<random>) on the docker-compose.dev.yml server, plus a built Fastify app.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig, type Config } from '@gmp/core';
import { createDb, migrate, testDatabaseBaseUrl, type DbHandle } from '@gmp/db';
import { buildServer, type BuildServerOptions } from '../app.ts';
import { MemoryJobQueue } from '../queue.ts';
import { ensureSetupToken } from '../setup-token.ts';
import { SESSION_COOKIE, CSRF_HEADER } from '../auth/session.ts';

export interface ServerTestDb {
  url: string;
  name: string;
  handle: DbHandle;
  drop(): Promise<void>;
}

export async function createServerTestDb(): Promise<ServerTestDb> {
  const base = testDatabaseBaseUrl();
  const name = `gmp_test_server_${randomBytes(5).toString('hex')}`;
  const admin = createDb(base, { max: 1 });
  try {
    await admin.pool.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.close();
  }
  const u = new URL(base);
  u.pathname = `/${name}`;
  const url = u.toString();
  await migrate(url);
  const handle = createDb(url, { max: 5 });
  return {
    url,
    name,
    handle,
    async drop() {
      await handle.close();
      const c = createDb(base, { max: 1 });
      try {
        await c.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await c.close();
      }
    },
  };
}

export function testConfig(databaseUrl: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: databaseUrl,
    PUBLIC_URL: 'http://localhost:3000',
    MASTER_KEY: randomBytes(32).toString('base64'),
    SESSION_SECRET: randomBytes(48).toString('base64'),
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export interface TestApp {
  app: FastifyInstance;
  db: ServerTestDb;
  queue: MemoryJobQueue;
  config: Config;
  setupToken: string;
  close(): Promise<void>;
}

export async function createTestApp(
  options: Partial<Omit<BuildServerOptions, 'config' | 'db' | 'queue'>> & {
    configOverrides?: Record<string, string>;
  } = {},
): Promise<TestApp> {
  const db = await createServerTestDb();
  const config = testConfig(db.url, options.configOverrides);
  const queue = new MemoryJobQueue();
  const { configOverrides: _c, ...rest } = options;
  const app = await buildServer({
    config,
    db: db.handle.db,
    queue,
    webDist: null,
    rateLimit: false,
    ...rest,
  });
  await app.ready();
  let token = '';
  await ensureSetupToken(db.handle.db, {
    publicUrl: config.publicUrl,
    print: (t) => {
      token = t ?? '';
    },
  });
  return {
    app,
    db,
    queue,
    config,
    setupToken: token,
    async close() {
      await app.close();
      await db.drop();
    },
  };
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
  orgId: string;
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  if (!c) throw new Error(`no session cookie in response (status ${res.statusCode}): ${res.body}`);
  return c.value;
}

export function toSession(res: LightMyRequestResponse): Session {
  const body = res.json() as { csrfToken: string; user: { id: string }; org: { id: string } };
  return {
    cookie: sessionCookie(res),
    csrf: body.csrfToken,
    userId: body.user.id,
    orgId: body.org.id,
  };
}

export const ADMIN = {
  email: 'Admin@Example.test',
  password: 'correct horse battery staple',
  name: 'Admin User',
  orgName: 'Test Org',
  timezone: 'UTC',
};

export async function setupAdmin(t: TestApp): Promise<Session> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/setup/admin',
    payload: { ...ADMIN, setupToken: t.setupToken },
  });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return toSession(res);
}

/** Inject helper that attaches the session cookie and CSRF header. */
export function as(t: TestApp, s: Session | null) {
  return (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    extra: { csrf?: string | null } = {},
  ) => {
    const headers: Record<string, string> = {};
    const csrf = extra.csrf === undefined ? s?.csrf : extra.csrf;
    if (csrf) headers[CSRF_HEADER] = csrf;
    return t.app.inject({
      method,
      url,
      headers,
      ...(s ? { cookies: { [SESSION_COOKIE]: s.cookie } } : {}),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  };
}

/** Creates a member via invite + accept and returns its session. */
export async function createMember(
  t: TestApp,
  admin: Session,
  email: string,
  role = 'member',
): Promise<Session> {
  const inv = await as(t, admin)('POST', '/api/users/invite', { email, role });
  if (inv.statusCode !== 201) throw new Error(`invite failed: ${inv.body}`);
  const url = (inv.json() as { inviteUrl: string }).inviteUrl;
  const token = decodeURIComponent(url.split('/invite/')[1]!);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/invite/accept',
    payload: { token, name: email.split('@')[0], password: 'member password 123' },
  });
  if (res.statusCode !== 201) throw new Error(`accept failed: ${res.body}`);
  return toSession(res);
}
