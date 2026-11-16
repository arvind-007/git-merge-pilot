/**
 * Queue names, job payloads and enqueue helpers for @gmp/worker (design §11).
 *
 * This module has no heavy imports (no analysis/AI), so the server can import it through the
 * `@gmp/worker/queues` subpath to enqueue jobs with the same names, payload shapes and options.
 */
import type { PgBoss, Queue, SendOptions } from 'pg-boss';
import { z } from 'zod';

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
export const QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUES);

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const uuid = z.uuid();

/** `deliveryId` is the X-GitHub-Delivery header value stored in webhook_deliveries.delivery_id. */
export const WebhookProcessPayloadSchema = z.object({ deliveryId: z.string().min(1).max(200) });

export const RepoDiscoverPayloadSchema = z.object({
  repositoryId: uuid,
  /** Re-index even when the default-branch head did not change. */
  force: z.boolean().optional(),
});

export const RepoIndexPayloadSchema = z.object({
  repositoryId: uuid,
  ref: z.string().min(1).max(255).optional(),
  force: z.boolean().optional(),
});

export const PrSyncPayloadSchema = z.union([
  z.object({
    pullRequestId: uuid,
    force: z.boolean().optional(),
    reason: z.string().max(100).optional(),
  }),
  z.object({
    repositoryId: uuid,
    number: z.number().int().positive(),
    force: z.boolean().optional(),
    reason: z.string().max(100).optional(),
  }),
]);

export const PrAnalyzePayloadSchema = z.object({
  pullRequestId: uuid,
  headSha: z.string().min(1).max(64).optional(),
  /** Re-run even when a completed analysis exists for the head (admin "reanalyze"). */
  force: z.boolean().optional(),
});

export const PrReadinessPayloadSchema = z.object({ pullRequestId: uuid });

export const OverlapRecomputePayloadSchema = z.object({
  pullRequestId: uuid,
  /** Other PRs whose relationship with `pullRequestId` changed (refresh their readiness). */
  affectedPullRequestIds: z.array(uuid).max(500).optional(),
});

export const EmptyPayloadSchema = z.object({}).loose();

export type WebhookProcessPayload = z.infer<typeof WebhookProcessPayloadSchema>;
export type RepoDiscoverPayload = z.infer<typeof RepoDiscoverPayloadSchema>;
export type RepoIndexPayload = z.infer<typeof RepoIndexPayloadSchema>;
export type PrSyncPayload = z.infer<typeof PrSyncPayloadSchema>;
export type PrAnalyzePayload = z.infer<typeof PrAnalyzePayloadSchema>;
export type PrReadinessPayload = z.infer<typeof PrReadinessPayloadSchema>;
export type OverlapRecomputePayload = z.infer<typeof OverlapRecomputePayloadSchema>;

export interface QueuePayloads {
  'webhook.process': WebhookProcessPayload;
  'repo.discover': RepoDiscoverPayload;
  'repo.index': RepoIndexPayload;
  'pr.sync': PrSyncPayload;
  'pr.analyze': PrAnalyzePayload;
  'pr.readiness': PrReadinessPayload;
  'overlap.recompute': OverlapRecomputePayload;
  'notify.flush': Record<string, never>;
  'digest.daily': Record<string, never>;
  'reconcile.poll': Record<string, never>;
  'retention.cleanup': Record<string, never>;
}

export const PAYLOAD_SCHEMAS: { readonly [Q in QueueName]: z.ZodType<QueuePayloads[Q]> } = {
  'webhook.process': WebhookProcessPayloadSchema,
  'repo.discover': RepoDiscoverPayloadSchema,
  'repo.index': RepoIndexPayloadSchema,
  'pr.sync': PrSyncPayloadSchema,
  'pr.analyze': PrAnalyzePayloadSchema,
  'pr.readiness': PrReadinessPayloadSchema,
  'overlap.recompute': OverlapRecomputePayloadSchema,
  'notify.flush': EmptyPayloadSchema as unknown as z.ZodType<Record<string, never>>,
  'digest.daily': EmptyPayloadSchema as unknown as z.ZodType<Record<string, never>>,
  'reconcile.poll': EmptyPayloadSchema as unknown as z.ZodType<Record<string, never>>,
  'retention.cleanup': EmptyPayloadSchema as unknown as z.ZodType<Record<string, never>>,
};

// ---------------------------------------------------------------------------
// Queue configuration
// ---------------------------------------------------------------------------

/** Design §11: retryLimit 5 with exponential backoff for every queue. */
export const RETRY_LIMIT = 5;

const base: Omit<Queue, 'name'> = {
  retryLimit: RETRY_LIMIT,
  retryBackoff: true,
  retryDelay: 15,
  retryDelayMax: 900,
};

/**
 * Per-queue options. `stately` keeps at most one queued and one active job per singleton key,
 * which collapses duplicate PR / repo jobs while one is already running.
 */
export const QUEUE_OPTIONS: { readonly [Q in QueueName]: Omit<Queue, 'name'> } = {
  'webhook.process': { ...base, policy: 'standard', expireInSeconds: 300 },
  'repo.discover': { ...base, policy: 'stately', expireInSeconds: 600 },
  'repo.index': { ...base, policy: 'stately', expireInSeconds: 1800 },
  'pr.sync': { ...base, policy: 'stately', expireInSeconds: 600 },
  'pr.analyze': { ...base, policy: 'stately', expireInSeconds: 1800 },
  'pr.readiness': { ...base, policy: 'stately', expireInSeconds: 300 },
  'overlap.recompute': { ...base, policy: 'stately', expireInSeconds: 600 },
  'notify.flush': { ...base, policy: 'stately', expireInSeconds: 300, retryLimit: 1 },
  'digest.daily': { ...base, policy: 'stately', expireInSeconds: 900, retryLimit: 2 },
  'reconcile.poll': { ...base, policy: 'stately', expireInSeconds: 1800, retryLimit: 1 },
  'retention.cleanup': { ...base, policy: 'stately', expireInSeconds: 900 },
};

/** Recurring jobs (cron, UTC). */
export const SCHEDULES: ReadonlyArray<{ queue: QueueName; cron: string }> = [
  { queue: 'notify.flush', cron: '* * * * *' },
  { queue: 'digest.daily', cron: '*/15 * * * *' },
  { queue: 'reconcile.poll', cron: '*/15 * * * *' },
  { queue: 'retention.cleanup', cron: '17 3 * * *' },
];

/** Debounce for `repo.discover` after pushes to the default branch (design §11: 10 min). */
export const DISCOVER_DEBOUNCE_SECONDS = 600;

// ---------------------------------------------------------------------------
// Singleton keys
// ---------------------------------------------------------------------------

export const singletonKeys = {
  prSync: (pullRequestId: string) => `pr:${pullRequestId}`,
  prSyncByNumber: (repositoryId: string, number: number) => `repo:${repositoryId}:pr:${number}`,
  prAnalyze: (pullRequestId: string, headSha: string) => `pr:${pullRequestId}:${headSha}`,
  prReadiness: (pullRequestId: string) => `pr:${pullRequestId}`,
  overlap: (pullRequestId: string) => `pr:${pullRequestId}`,
  repo: (repositoryId: string) => `repo:${repositoryId}`,
} as const;

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  singletonKey?: string;
  /** Debounce window: at most one job per key per window (pg-boss sendDebounced). */
  debounceSeconds?: number;
  startAfter?: Date | number;
  priority?: number;
}

/** Minimal enqueue interface used by handlers (pg-boss in production, a recorder in tests). */
export interface JobQueue {
  send<Q extends QueueName>(
    queue: Q,
    data: QueuePayloads[Q],
    options?: EnqueueOptions,
  ): Promise<string | null>;
}

/**
 * Creates every queue with its options (or updates the options of existing ones). pg-boss
 * rejects sends to queues that do not exist, so the server should call this once after
 * `boss.start()` as well.
 */
export async function ensureQueues(
  boss: Pick<PgBoss, 'getQueue' | 'createQueue' | 'updateQueue'>,
): Promise<void> {
  for (const name of QUEUE_NAMES) {
    const { policy: _policy, ...updatable } = QUEUE_OPTIONS[name];
    if (await boss.getQueue(name)) await boss.updateQueue(name, updatable);
    else await boss.createQueue(name, QUEUE_OPTIONS[name]);
  }
}

/** JobQueue backed by a started pg-boss instance. */
export function createBossJobQueue(boss: Pick<PgBoss, 'send' | 'sendDebounced'>): JobQueue {
  return {
    async send(queue, data, options = {}) {
      const opts: SendOptions = {};
      if (options.singletonKey) opts.singletonKey = options.singletonKey;
      if (options.startAfter !== undefined) opts.startAfter = options.startAfter;
      if (options.priority !== undefined) opts.priority = options.priority;
      if (options.debounceSeconds && options.debounceSeconds > 0) {
        return boss.sendDebounced(
          queue,
          data as object,
          opts,
          options.debounceSeconds,
          options.singletonKey,
        );
      }
      return boss.send(queue, data as object, opts);
    },
  };
}

export interface RecordedJob<Q extends QueueName = QueueName> {
  queue: Q;
  data: QueuePayloads[Q];
  options: EnqueueOptions;
}

/**
 * In-memory JobQueue for tests: records sends and, like pg-boss stately queues, drops a send
 * whose singleton key is already queued.
 */
export class RecordingJobQueue implements JobQueue {
  readonly jobs: RecordedJob[] = [];
  private seq = 0;

  async send<Q extends QueueName>(
    queue: Q,
    data: QueuePayloads[Q],
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    if (
      options.singletonKey &&
      this.jobs.some((j) => j.queue === queue && j.options.singletonKey === options.singletonKey)
    ) {
      return null;
    }
    this.jobs.push({ queue, data, options } as RecordedJob);
    this.seq += 1;
    return `job-${this.seq}`;
  }

  /** Removes and returns the queued jobs (optionally only for one queue). */
  take<Q extends QueueName>(queue?: Q): RecordedJob<Q>[] {
    const out: RecordedJob[] = [];
    for (let i = 0; i < this.jobs.length;) {
      const j = this.jobs[i]!;
      if (!queue || j.queue === queue) {
        out.push(j);
        this.jobs.splice(i, 1);
      } else i += 1;
    }
    return out as RecordedJob<Q>[];
  }

  clear(): void {
    this.jobs.length = 0;
  }
}
