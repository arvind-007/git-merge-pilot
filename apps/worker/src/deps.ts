import { AiService, type AiProvider, type ProviderConfig } from '@gmp/ai';
import { createLogger, type Logger } from '@gmp/core';
import type { Database } from '@gmp/db';
import type { ExternalScannerOptions } from '@gmp/analysis';
import type { ChannelSenders } from '@gmp/notify';
import type { GitHubGateway } from './github.ts';
import type { JobQueue } from './queues.ts';

export interface WorkerLimits {
  /** Changed files whose full before/after content is fetched for symbol-level analysis. */
  maxContentFiles: number;
  /** Max bytes per fetched file. */
  maxContentBytes: number;
  /** Parallel GitHub content requests per analysis. */
  contentConcurrency: number;
  /** How long a snapshot fetched by pr.sync can be reused by pr.analyze. */
  snapshotTtlMs: number;
  /** Max files read from a clone by repo.index. */
  maxIndexFiles: number;
  /** Max bytes per file read by repo.index. */
  maxIndexFileBytes: number;
  /** Open PRs (with analyses) compared against when detecting relationships. */
  maxRelationshipPeers: number;
  /** Webhook payloads older than this are deleted by retention.cleanup. */
  webhookPayloadRetentionDays: number;
}

export const DEFAULT_LIMITS: WorkerLimits = {
  maxContentFiles: 60,
  maxContentBytes: 512 * 1024,
  contentConcurrency: 6,
  snapshotTtlMs: 5 * 60_000,
  maxIndexFiles: 5_000,
  maxIndexFileBytes: 512 * 1024,
  maxRelationshipPeers: 500,
  webhookPayloadRetentionDays: 30,
};

export type AiProviderFactory = (config: ProviderConfig & { providerId: string }) => AiProvider;

/** Everything the handlers need. Tests inject fakes for `github`, `queue` and the AI provider. */
export interface WorkerDeps {
  db: Database;
  github: GitHubGateway;
  queue: JobQueue;
  /** Base URL of the app (no trailing slash), used for notification links. */
  publicUrl: string;
  logger?: Logger;
  now?: () => Date;
  /** Decrypts AI provider keys and channel configs; defaults to core's configured MASTER_KEY. */
  masterKey?: Buffer;
  /** Overrides the AI provider adapters (tests pass a FakeAiProvider). */
  aiProviderFactory?: AiProviderFactory;
  /** Overrides email/Slack delivery in notify.flush. */
  notifySenders?: Partial<ChannelSenders>;
  /**
   * gitleaks/semgrep options. They run (when the binaries are on PATH) over a temporary tree of
   * the changed files' head contents; pass `{ gitleaks: false, semgrep: false }` to disable.
   */
  scanners?: ExternalScannerOptions;
  limits?: Partial<WorkerLimits>;
}

export interface WorkerContext {
  db: Database;
  github: GitHubGateway;
  queue: JobQueue;
  publicUrl: string;
  logger: Logger;
  now: () => Date;
  masterKey: Buffer | undefined;
  notifySenders: Partial<ChannelSenders> | undefined;
  scanners: ExternalScannerOptions;
  limits: WorkerLimits;
  /** Creates an org-scoped AiService with freshly loaded settings and budget. */
  aiService(orgId: string): Promise<AiService>;
  snapshots: SnapshotCache;
}

export function resolveContext(deps: WorkerDeps): WorkerContext {
  const logger = deps.logger ?? createLogger('worker');
  const now = deps.now ?? (() => new Date());
  return {
    db: deps.db,
    github: deps.github,
    queue: deps.queue,
    publicUrl: deps.publicUrl.replace(/\/+$/, ''),
    logger,
    now,
    masterKey: deps.masterKey,
    notifySenders: deps.notifySenders,
    scanners: deps.scanners ?? {},
    limits: { ...DEFAULT_LIMITS, ...deps.limits },
    snapshots: new SnapshotCache(),
    aiService: (orgId) =>
      AiService.create({
        db: deps.db,
        orgId,
        logger: logger.child({ component: 'ai' }),
        now,
        ...(deps.masterKey ? { masterKey: deps.masterKey } : {}),
        ...(deps.aiProviderFactory ? { providerFactory: deps.aiProviderFactory } : {}),
      }),
  };
}

/** Small TTL cache so pr.analyze can reuse the snapshot pr.sync just fetched. */
export class SnapshotCache {
  private readonly map = new Map<string, { at: number; value: unknown }>();
  constructor(private readonly maxEntries = 50) {}

  get<T>(key: string, ttlMs: number, now: number): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set(key: string, value: unknown, now: number): void {
    this.map.delete(key);
    this.map.set(key, { at: now, value });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}
