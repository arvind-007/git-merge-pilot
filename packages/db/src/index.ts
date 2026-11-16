// @gmp/db — Drizzle schema, client, migrations (design §6).
import * as schema from './schema.ts';

export { schema };
export * from './schema.ts';
export * from './types.ts';
export {
  createDb,
  type CreateDbOptions,
  type Database,
  type DbHandle,
  type DbOrTx,
  type Schema,
  type Transaction,
} from './client.ts';
export { migrate, resolveMigrationsFolder, type MigrateOptions } from './migrate.ts';
export {
  createTestDatabase,
  isDatabaseReachable,
  testDatabaseBaseUrl,
  DEFAULT_TEST_DATABASE_URL,
  type TestDatabase,
} from './testing.ts';
