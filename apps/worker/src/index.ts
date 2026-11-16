// @gmp/worker — pg-boss job handlers (design §11). The runnable entrypoint is src/main.ts.
export {
  createWorker,
  HANDLERS,
  DEFAULT_CONCURRENCY,
  type Worker,
  type StartOptions,
} from './worker.ts';
export {
  DEFAULT_LIMITS,
  SnapshotCache,
  resolveContext,
  type AiProviderFactory,
  type WorkerContext,
  type WorkerDeps,
  type WorkerLimits,
} from './deps.ts';
export {
  GitHubAccessError,
  createGitHubGateway,
  type GitHubGateway,
  type GitHubGatewayOptions,
  type RepoClone,
  type RepoTarget,
} from './github.ts';
export * from './queues.ts';
export type { Handler, HandlerMap, HandlerResult, JobInfo } from './handlers/types.ts';
export { reconcileRepository } from './handlers/scheduled.ts';
export { reuseNarrative } from './handlers/pr-analyze.ts';
