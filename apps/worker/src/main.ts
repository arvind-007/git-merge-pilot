/**
 * Worker process entrypoint: `node dist/index.js` (Docker `worker` command) or `pnpm dev`.
 * Loads config, runs migrations, starts pg-boss and consumes every queue.
 */
import { ConfigError, createLogger, loadConfig, loadDotenv, setMasterKey } from '@gmp/core';
import { createDb, migrate } from '@gmp/db';
import { PgBoss } from 'pg-boss';
import { createGitHubGateway } from './github.ts';
import { createBossJobQueue } from './queues.ts';
import { createWorker } from './worker.ts';

const logger = createLogger('worker');

async function main(): Promise<void> {
  loadDotenv();
  const config = loadConfig();
  setMasterKey(config.masterKey);

  // Same switch as the server: GMP_AUTO_MIGRATE=false skips migrations (GMP_SKIP_MIGRATE=1 is
  // accepted for compatibility).
  const autoMigrate =
    !/^(0|false|no|off)$/i.test(process.env.GMP_AUTO_MIGRATE ?? '') &&
    process.env.GMP_SKIP_MIGRATE !== '1';
  if (autoMigrate) await migrate(config.databaseUrl);

  const handle = createDb(config.databaseUrl, {
    applicationName: 'gmp-worker',
    onPoolError: (err) => logger.error({ err }, 'database pool error'),
  });
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    application_name: 'gmp-worker-queue',
  });
  boss.on('error', (err: unknown) => logger.error({ err }, 'pg-boss error'));
  await boss.start();

  const worker = createWorker({
    db: handle.db,
    github: createGitHubGateway({
      db: handle.db,
      apiUrl: config.githubApiUrl,
      webUrl: config.githubWebUrl,
      repoCacheDir: config.repoCacheDir,
      masterKey: config.masterKey,
      logger: logger.child({ component: 'github' }),
    }),
    queue: createBossJobQueue(boss),
    publicUrl: config.publicUrl,
    masterKey: config.masterKey,
    logger,
  });
  await worker.start(boss);
  logger.info('git-merge-pilot worker started');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down worker');
    try {
      await worker.stop();
      await boss.stop({ graceful: true, timeout: 30_000 });
      await handle.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    logger.fatal({ issues: err.issues }, 'invalid configuration');
  } else {
    logger.fatal({ err }, 'worker failed to start');
  }
  process.exit(1);
});
