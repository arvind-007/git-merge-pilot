// @gmp/server — Fastify API, auth, setup, webhook endpoint, serves web (design §12, §14).
// Library entry for tests/embedding. The runnable entry point is src/main.ts.
export {
  buildServer,
  SERVER_VERSION,
  type BuildServerOptions,
  type RateLimitOptions,
} from './app.ts';
export type { AuthContext, AuthSession, AuthUser, GitHubDeps, ServerContext } from './context.ts';
export {
  accessibleProjectIds,
  accessibleRepositoryIds,
  computeAccessScope,
  canReadProject,
  canReadRepository,
  type AccessScope,
} from './access.ts';
export {
  QUEUES,
  QUEUE_NAMES,
  QUEUE_DEFAULTS,
  MemoryJobQueue,
  ensureQueues,
  pgBossJobQueue,
  startPgBossQueue,
  type FailedJob,
  type JobQueue,
  type PrAnalyzeJob,
  type QueueName,
  type QueueStat,
  type RepoDiscoverJob,
  type SendJobOptions,
  type WebhookProcessJob,
} from './queue.ts';
export { ensureSetupToken, printSetupBanner, type SetupTokenResult } from './setup-token.ts';
export { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './auth/password.ts';
export { SESSION_COOKIE, CSRF_HEADER, DEFAULT_SESSION_TTL_MS } from './auth/session.ts';
export { syncInstallations, type SyncSummary } from './github/app-store.ts';
export { HttpError, toErrorResponse } from './errors.ts';
export { writeAudit, sanitizeAuditData } from './audit.ts';
export { resolveWebDist } from './static.ts';
export { startSmeeRelay } from './smee.ts';
