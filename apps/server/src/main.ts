/**
 * git-merge-pilot server entry point: loads config, migrates the database, starts pg-boss,
 * prints the one-time setup token on first boot, serves the API + SPA, and optionally relays
 * webhooks from smee.io.
 */
import { ConfigError, createLogger, loadConfig, loadDotenv } from '@gmp/core';
import { createDb, migrate } from '@gmp/db';
import { buildServer } from './app.ts';
import { deleteExpiredSessions } from './auth/session.ts';
import { startPgBossQueue } from './queue.ts';
import { ensureSetupToken } from './setup-token.ts';
import { startSmeeRelay, type SmeeRelay } from './smee.ts';

function envFlag(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return !/^(0|false|no|off)$/i.test(v);
}

/** TRUST_PROXY: "true" or a comma-separated list of proxy IPs/CIDRs. */
function trustProxySetting(): boolean | string {
  const v = process.env.TRUST_PROXY?.trim();
  if (!v || /^(0|false|no)$/i.test(v)) return false;
  if (/^(1|true|yes)$/i.test(v)) return true;
  return v;
}

export async function main(): Promise<void> {
  loadDotenv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nRun \`pnpm init-env\` to create a .env file.\n`);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger('server', { level: config.logLevel });

  if (envFlag('GMP_AUTO_MIGRATE', true)) {
    logger.info('applying database migrations');
    await migrate(config.databaseUrl);
  }

  const dbHandle = createDb(config.databaseUrl, {
    applicationName: 'git-merge-pilot-server',
    onPoolError: (err) => logger.error({ err }, 'postgres pool error'),
  });
  const queue = await startPgBossQueue(config.databaseUrl, { logger });

  const app = await buildServer({
    config,
    db: dbHandle.db,
    queue: queue.queue,
    logger,
    trustProxy: trustProxySetting(),
  });

  await ensureSetupToken(dbHandle.db, {
    publicUrl: config.webUrl,
    logger,
    presetToken: process.env.GMP_SETUP_TOKEN ?? null,
  });
  await deleteExpiredSessions(dbHandle.db, new Date()).catch(() => undefined);

  await app.listen({ port: config.port, host: process.env.HOST ?? '0.0.0.0' });
  logger.info({ url: config.publicUrl, port: config.port }, 'git-merge-pilot server listening');

  let smee: SmeeRelay | null = null;
  if (config.smeeUrl) {
    try {
      smee = await startSmeeRelay({ smeeUrl: config.smeeUrl, port: config.port, logger });
    } catch (err) {
      logger.error(
        { err },
        'could not start smee relay; webhooks will rely on PUBLIC_URL and polling',
      );
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await smee?.stop();
      await app.close();
      await queue.stop();
      await dbHandle.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const logger = createLogger('server');
  logger.fatal({ err }, 'server failed to start');
  process.exit(1);
});
