import type { WorkerContext } from '../deps.ts';
import type { QueueName, QueuePayloads } from '../queues.ts';

/** Job metadata handlers may use (retry bookkeeping). */
export interface JobInfo {
  id: string | null;
  /** Retries already made for this job (0 on the first attempt). */
  retryCount: number;
  retryLimit: number;
}

export interface HandlerResult {
  status: 'completed' | 'skipped' | 'unchanged' | 'ignored';
  reason?: string;
  [key: string]: unknown;
}

export type Handler<Q extends QueueName> = (
  ctx: WorkerContext,
  data: QueuePayloads[Q],
  job: JobInfo,
) => Promise<HandlerResult>;

export type HandlerMap = { [Q in QueueName]: Handler<Q> };

export const skipped = (reason: string, extra: Record<string, unknown> = {}): HandlerResult => ({
  status: 'skipped',
  reason,
  ...extra,
});

export const isFinalAttempt = (job: JobInfo): boolean => job.retryCount >= job.retryLimit;
