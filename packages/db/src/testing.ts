import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from './migrate.ts';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://gmp:gmp@localhost:54329/gmp';

export interface TestDatabase {
  /** Connection URL of the freshly created, migrated database. */
  url: string;
  name: string;
  /** Drops the database (terminating remaining connections). */
  drop(): Promise<void>;
}

/** Base URL for tests: TEST_DATABASE_URL, then DATABASE_URL, then the docker-compose.dev.yml default. */
export function testDatabaseBaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

/**
 * Creates an isolated, fully migrated database on the server behind `baseUrl` (the role needs
 * CREATEDB). Intended for integration tests in any package.
 */
export async function createTestDatabase(
  baseUrl: string = testDatabaseBaseUrl(),
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const name = `gmp_test_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  if (options.migrate !== false) await migrate(url);
  return {
    url,
    name,
    async drop() {
      const c = new pg.Client({ connectionString: baseUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

/** Returns true when a Postgres server is reachable at `url` (used to skip DB tests cleanly). */
export async function isDatabaseReachable(url: string = testDatabaseBaseUrl()): Promise<boolean> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}
