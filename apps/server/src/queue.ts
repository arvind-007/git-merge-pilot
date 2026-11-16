/**
 * Job queue (pg-boss) as seen by the server: it only produces jobs; the worker consumes them
 * (design §11). The `JobQueue` interface lets tests inject an in-memory fake.
 */
import { PgBoss } from 'pg-boss';
import type { Logger } from '@gmp/core';
import { QUEUE_OPTIONS } from '@gmp/worker/queues';

export const QUEUES = {
  webhookProcess: 'webhook.process',
  repoDiscover: 'repo.discover',
  repoIndex: 'repo.index',
  prSync: 'pr.sync',
  prAnalyze: 'pr.analyze',
  prReadiness: 'pr.readiness',
  overlapRecompute: 'overlap.recompute',
  notifyFlush: 'notify.flush',
  digestDaily: 'digest.daily',
  reconcilePoll: 'reconcile.poll',
  retentionCleanup: 'retention.cleanup',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const QUEUE_NAMES: readonly QueueName[] = Object.freeze(Object.values(QUEUES));

/** Job payloads produced by the server. */
export interface WebhookProcessJob {
  /** webhook_deliveries.id (uuid). */
  webhookDeliveryId: string;
  /** X-GitHub-Delivery header value. */
  deliveryId: string;
  event: string;
  orgId: string | null;
}
export interface RepoDiscoverJob {
  orgId: string;
  repositoryId: string;
  reason: 'added' | 'manual' | 'monitoring_enabled' | 'installation_sync';
  force?: boolean;
}
export interface PrAnalyzeJob {
  orgId: string;
  pullRequestId: string;
  headSha: string;
  force: boolean;
  reason: 'manual';
  requestedBy?: string;
}

export interface SendJobOptions {
  singletonKey?: string;
  singletonSeconds?: number;
  startAfter?: number | Date;
  priority?: number;
}

export interface QueueStat {
  name: string;
  queued: number;
  active: number;
  failed: number;
  deferred: number;
  total: number;
}

export interface FailedJob {
  id: string;
  queue: string;
  error: string | null;
  failedAt: string | null;
}

export interface JobQueue {
  send(name: QueueName, data: object, options?: SendJobOptions): Promise<string | null>;
  stats(): Promise<QueueStat[]>;
  failedJobs(limit?: number): Promise<FailedJob[]>;
}

/**
 * Queue options come from the worker (single source of truth): whichever process starts first
 * creates the queues, and pg-boss cannot change a queue's policy afterwards, so both must agree.
 */
export const QUEUE_DEFAULTS = Object.freeze({ ...QUEUE_OPTIONS });

export interface PgBossQueueHandle {
  queue: JobQueue;
  boss: PgBoss;
  stop(): Promise<void>;
}

function errorText(output: unknown): string | null {
  if (output == null) return null;
  if (typeof output === 'string') return output.slice(0, 500);
  if (typeof output === 'object') {
    const o = output as Record<string, unknown>;
    const m = o.message ?? o.error ?? o.value;
    if (typeof m === 'string') return m.slice(0, 500);
    try {
      return JSON.stringify(output).slice(0, 500);
    } catch {
      return null;
    }
  }
  return String(output).slice(0, 500);
}

/** Wraps a started PgBoss instance as a JobQueue. */
export function pgBossJobQueue(boss: PgBoss, schema = 'pgboss'): JobQueue {
  return {
    async send(name, data, options = {}) {
      const opts: Record<string, unknown> = {};
      if (options.singletonKey) opts.singletonKey = options.singletonKey;
      if (options.singletonSeconds) opts.singletonSeconds = options.singletonSeconds;
      if (options.startAfter !== undefined) opts.startAfter = options.startAfter;
      if (options.priority !== undefined) opts.priority = options.priority;
      return boss.send(name, data, opts);
    },
    async stats() {
      const queues = await boss.getQueues([...QUEUE_NAMES]);
      return queues.map((q) => ({
        name: q.name,
        queued: q.queuedCount,
        active: q.activeCount,
        failed: q.failedCount,
        deferred: q.deferredCount,
        total: q.totalCount,
      }));
    },
    async failedJobs(limit = 20) {
      const safeSchema = /^[a-z_][a-z0-9_]*$/i.test(schema) ? schema : 'pgboss';
      try {
        const res = await boss
          .getDb()
          .executeSql(
            `SELECT id::text AS id, name, output, completed_on FROM ${safeSchema}.job WHERE state = 'failed' ORDER BY completed_on DESC NULLS LAST LIMIT $1`,
            [Math.max(1, Math.min(limit, 100))],
          );
        const rows = (res as { rows: Array<Record<string, unknown>> }).rows;
        return rows.map((r) => ({
          id: String(r.id),
          queue: String(r.name),
          error: errorText(r.output),
          failedAt: r.completed_on ? new Date(r.completed_on as string).toISOString() : null,
        }));
      } catch {
        return [];
      }
    },
  };
}

/** Creates any missing queues. Existing queues (possibly created by the worker) are left as-is. */
export async function ensureQueues(boss: PgBoss, logger?: Logger): Promise<void> {
  for (const name of QUEUE_NAMES) {
    try {
      const existing = await boss.getQueue(name);
      if (!existing) await boss.createQueue(name, { ...QUEUE_OPTIONS[name] });
    } catch (err) {
      // A concurrent creator (worker) may win the race; re-check before giving up.
      const existing = await boss.getQueue(name).catch(() => null);
      if (!existing) {
        logger?.error({ err, queue: name }, 'failed to create queue');
        throw err;
      }
    }
  }
}

/** Starts pg-boss against `databaseUrl`, ensures queues, and returns a JobQueue. */
export async function startPgBossQueue(
  databaseUrl: string,
  opts: { logger?: Logger; max?: number; supervise?: boolean } = {},
): Promise<PgBossQueueHandle> {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    max: opts.max ?? 4,
    application_name: 'git-merge-pilot-server',
    // The server only produces jobs; maintenance and cron are the worker's job.
    supervise: opts.supervise ?? false,
    schedule: false,
  });
  boss.on('error', (err: unknown) => opts.logger?.error({ err }, 'pg-boss error'));
  await boss.start({ attempts: 3 });
  await ensureQueues(boss, opts.logger);
  return {
    boss,
    queue: pgBossJobQueue(boss),
    async stop() {
      await boss.stop({ graceful: true, timeout: 5000 });
    },
  };
}

/** In-memory queue for tests. */
export class MemoryJobQueue implements JobQueue {
  readonly jobs: Array<{ id: string; name: QueueName; data: object; options: SendJobOptions }> = [];
  private seq = 0;

  async send(name: QueueName, data: object, options: SendJobOptions = {}): Promise<string | null> {
    const id = `job-${++this.seq}`;
    this.jobs.push({ id, name, data, options });
    return id;
  }

  async stats(): Promise<QueueStat[]> {
    return QUEUE_NAMES.map((name) => {
      const n = this.jobs.filter((j) => j.name === name).length;
      return { name, queued: n, active: 0, failed: 0, deferred: 0, total: n };
    });
  }

  async failedJobs(): Promise<FailedJob[]> {
    return [];
  }

  byName(name: QueueName) {
    return this.jobs.filter((j) => j.name === name);
  }
}
