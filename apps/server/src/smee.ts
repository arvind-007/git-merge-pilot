import type { Logger } from '@gmp/core';
import { GITHUB_ROUTES } from '@gmp/github';

export interface SmeeRelay {
  stop(): Promise<void>;
}

/**
 * Relays webhook deliveries from a smee.io channel (SMEE_URL) to the local webhook endpoint,
 * for installs that GitHub cannot reach directly. Signatures are still verified locally.
 */
export async function startSmeeRelay(opts: {
  smeeUrl: string;
  port: number;
  logger: Logger;
}): Promise<SmeeRelay> {
  const { default: SmeeClient } = await import('smee-client');
  const target = `http://127.0.0.1:${opts.port}${GITHUB_ROUTES.webhook}`;
  const log = opts.logger.child({ component: 'smee' });
  const client = new SmeeClient({
    source: opts.smeeUrl,
    target,
    logger: {
      info: (...args: unknown[]) => log.debug({ detail: args.map(String).join(' ') }, 'smee'),
      error: (...args: unknown[]) =>
        log.warn({ detail: args.map(String).join(' ') }, 'smee relay error'),
    },
  });
  await client.start();
  log.info({ source: new URL(opts.smeeUrl).origin }, 'smee webhook relay started');
  return {
    async stop() {
      await client.stop();
    },
  };
}
