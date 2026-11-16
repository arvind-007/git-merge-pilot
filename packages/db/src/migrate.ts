import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Arbitrary constant used for pg_advisory_lock so server and worker never migrate concurrently. */
const MIGRATION_LOCK_ID = 727_436_001;

export interface MigrateOptions {
  /** Directory containing drizzle-kit output (meta/_journal.json). Auto-detected by default. */
  migrationsFolder?: string;
}

/**
 * Locates the migrations folder. Order: explicit option, GMP_MIGRATIONS_DIR env,
 * next to this module (source layout: packages/db/src → ../drizzle), bundled layouts
 * (dist/ → ./drizzle, ../drizzle), and finally <cwd>/packages/db/drizzle.
 */
export function resolveMigrationsFolder(explicit?: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    process.env.GMP_MIGRATIONS_DIR,
    resolve(here, '../drizzle'),
    resolve(here, './drizzle'),
    resolve(here, '../../drizzle'),
    resolve(process.cwd(), 'packages/db/drizzle'),
    resolve(process.cwd(), 'drizzle'),
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'meta', '_journal.json'))) return dir;
  }
  throw new Error(
    `Could not find drizzle migrations (looked in: ${candidates.join(', ')}). Set GMP_MIGRATIONS_DIR.`,
  );
}

/**
 * Applies all pending migrations. Safe to run repeatedly and concurrently
 * (serialised with a Postgres advisory lock).
 */
export async function migrate(url: string, options: MigrateOptions = {}): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder(options.migrationsFolder);
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    application_name: 'git-merge-pilot-migrate',
  });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      const db = drizzle(client);
      await drizzleMigrate(db, { migrationsFolder });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}
