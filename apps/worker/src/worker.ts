/** createWorker: binds handlers to pg-boss queues and schedules (design §11). */
import type { Job, PgBoss } from 'pg-boss';
import { resolveContext, type WorkerContext, type WorkerDeps } from './deps.ts';
import { handleOverlapRecompute } from './handlers/overlap-recompute.ts';
import { handlePrAnalyze } from './handlers/pr-analyze.ts';
import { handlePrReadiness } from './handlers/pr-readiness.ts';
import { handlePrSync } from './handlers/pr-sync.ts';
import { handleRepoDiscover, handleRepoIndex } from './handlers/repo.ts';
import {
  handleDigestDaily,
  handleNotifyFlush,
  handleReconcilePoll,
  handleRetentionCleanup,
} from './handlers/scheduled.ts';
import type { HandlerMap, HandlerResult, JobInfo } from './handlers/types.ts';
import { handleWebhookProcess } from './handlers/webhook-process.ts';
import {
  PAYLOAD_SCHEMAS,
  QUEUE_NAMES,
  QUEUE_OPTIONS,
  ensureQueues,
  SCHEDULES,
  type QueueName,
  type QueuePayloads,
} from './queues.ts';
import { errorText } from './util.ts';

export const HANDLERS: HandlerMap = {
  'webhook.process': handleWebhookProcess,
  'repo.discover': handleRepoDiscover,
  'repo.index': handleRepoIndex,
  'pr.sync': handlePrSync,
  'pr.analyze': handlePrAnalyze,
  'pr.readiness': handlePrReadiness,
  'overlap.recompute': handleOverlapRecompute,
  'notify.flush': handleNotifyFlush,
  'digest.daily': handleDigestDaily,
  'reconcile.poll': handleReconcilePoll,
  'retention.cleanup': handleRetentionCleanup,
};

/** Parallel jobs per queue in one worker process. */
export const DEFAULT_CONCURRENCY: { readonly [Q in QueueName]: number } = {
  'webhook.process': 4,
  'repo.discover': 2,
  'repo.index': 1,
  'pr.sync': 4,
  'pr.analyze': 2,
  'pr.readiness': 4,
  'overlap.recompute': 2,
  'notify.flush': 1,
  'digest.daily': 1,
  'reconcile.poll': 1,
  'retention.cleanup': 1,
};

export interface StartOptions {
  /** Register cron schedules (default true). */
  schedule?: boolean;
  /** Override per-queue local concurrency. */
  concurrency?: Partial<Record<QueueName, number>>;
  /** Only work these queues (default all). */
  queues?: readonly QueueName[];
}

export interface Worker {
  readonly ctx: WorkerContext;
  /** Validates the payload and runs a handler directly (used by pg-boss and tests). */
  run<Q extends QueueName>(queue: Q, data: unknown, job?: Partial<JobInfo>): Promise<HandlerResult>;
  /** Creates queues, registers schedules and starts consuming on a started pg-boss instance. */
  start(boss: PgBoss, options?: StartOptions): Promise<void>;
  /** Stops consuming (does not stop pg-boss itself). */
  stop(): Promise<void>;
}

export function createWorker(deps: WorkerDeps): Worker {
  const ctx = resolveContext(deps);
  let boss: PgBoss | null = null;
  const working: QueueName[] = [];

  async function run<Q extends QueueName>(
    queue: Q,
    data: unknown,
    job: Partial<JobInfo> = {},
  ): Promise<HandlerResult> {
    const parsed = PAYLOAD_SCHEMAS[queue].safeParse(data ?? {});
    if (!parsed.success) {
      ctx.logger.error({ queue, issues: parsed.error.issues.length }, 'invalid job payload');
      return { status: 'skipped', reason: 'invalid_payload' };
    }
    const handler = HANDLERS[queue] as (
      c: WorkerContext,
      d: QueuePayloads[Q],
      j: JobInfo,
    ) => Promise<HandlerResult>;
    const info: JobInfo = {
      id: job.id ?? null,
      retryCount: job.retryCount ?? 0,
      retryLimit: job.retryLimit ?? QUEUE_OPTIONS[queue].retryLimit ?? 0,
    };
    const started = Date.now();
    try {
      const result = await handler(ctx, parsed.data, info);
      ctx.logger.info(
        {
          queue,
          jobId: info.id,
          ms: Date.now() - started,
          status: result.status,
          reason: result.reason,
        },
        'job finished',
      );
      return result;
    } catch (err) {
      ctx.logger.error(
        { queue, jobId: info.id, retry: info.retryCount, err: errorText(err) },
        'job failed',
      );
      throw err;
    }
  }

  return {
    ctx,
    run,
    async start(b, options = {}) {
      boss = b;
      const queues = options.queues ?? QUEUE_NAMES;
      await ensureQueues(b);
      if (options.schedule !== false) {
        for (const s of SCHEDULES) await b.schedule(s.queue, s.cron, {}, { tz: 'UTC' });
        // Catch up right away (missed webhooks while down, repositories never polled) instead of
        // waiting for the first cron tick.
        await b
          .send('reconcile.poll', {})
          .catch((err: unknown) =>
            ctx.logger.warn({ err: String(err) }, 'could not enqueue startup reconcile'),
          );
      }
      for (const name of queues) {
        const localConcurrency = options.concurrency?.[name] ?? DEFAULT_CONCURRENCY[name];
        await b.work(name, { localConcurrency, batchSize: 1 }, async (jobs: Job<unknown>[]) => {
          for (const j of jobs) {
            await run(name, j.data, { id: j.id, retryCount: j.retryCount });
          }
        });
        working.push(name);
      }
    },
    async stop() {
      if (!boss) return;
      for (const name of working.splice(0)) {
        await boss.offWork(name).catch(() => undefined);
      }
    },
  };
}
