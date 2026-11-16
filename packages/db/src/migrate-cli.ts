// Usage: pnpm db:migrate   (reads DATABASE_URL from the environment or the nearest .env)
import { createLogger, loadDotenv } from '@gmp/core';
import { migrate, resolveMigrationsFolder } from './migrate.ts';

const log = createLogger('db-migrate', { level: 'info' });

async function main(): Promise<void> {
  loadDotenv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    log.error('DATABASE_URL is not set (run `pnpm init-env` or export it)');
    process.exitCode = 1;
    return;
  }
  const folder = resolveMigrationsFolder();
  log.info({ folder }, 'applying migrations');
  await migrate(url, { migrationsFolder: folder });
  log.info('migrations up to date');
}

main().catch((err: unknown) => {
  log.error({ err }, 'migration failed');
  process.exitCode = 1;
});
