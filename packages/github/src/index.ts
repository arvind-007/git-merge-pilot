// @gmp/github — GitHub App (manifest flow), clients, webhooks, discovery and PR snapshots (design §7).
export {
  APP_PERMISSIONS,
  GITHUB_ROUTES,
  IMPLICIT_APP_EVENTS,
  MANIFEST_EVENTS,
  MAX_APP_NAME_LENGTH,
  ManifestConversionError,
  WEBHOOK_EVENTS,
  buildAppManifest,
  convertManifestCode,
  isValidGitHubLogin,
} from './manifest.ts';
export type {
  AppManifest,
  BuildAppManifestInput,
  BuildAppManifestResult,
  ConvertManifestCodeOptions,
  ManifestConversion,
  WebhookEventName,
} from './manifest.ts';

export {
  DEFAULT_GITHUB_API_URL,
  GmpOctokit,
  Octokit,
  createGitHubClient,
  createOctokit,
  toInstallationInfo,
  toInstallationRepository,
} from './client.ts';
export type {
  AppInfo,
  CreateOctokitOptions,
  GitHubAppCredentials,
  GitHubClient,
  GitHubClientOptions,
  GitHubOctokit,
  InstallationInfo,
  InstallationRepository,
  InstallationToken,
  OctokitFactoryOptions,
} from './client.ts';

export {
  NORMALIZED_EVENT_TYPES,
  normalizeWebhook,
  parseClosingReferences,
  parseWebhookPullRequest,
  parseWebhookRepository,
  signWebhookPayload,
  verifyWebhookSignature,
} from './webhooks.ts';
export type {
  CheckNormalizedEvent,
  InstallationNormalizedEvent,
  InstallationReposNormalizedEvent,
  IssueCommentNormalizedEvent,
  NormalizeWebhookOptions,
  NormalizedEvent,
  NormalizedEventType,
  PullRequestEventType,
  PullRequestNormalizedEvent,
  PushNormalizedEvent,
  RepositoryNormalizedEvent,
  ReviewCommentNormalizedEvent,
  ReviewNormalizedEvent,
  StatusNormalizedEvent,
  WebhookCheck,
  WebhookComment,
  WebhookInstallation,
  WebhookPullRequest,
  WebhookPush,
  WebhookRepoRef,
  WebhookRepository,
  WebhookReview,
  WebhookStatus,
} from './webhooks.ts';

export {
  GITHUB_MAX_COMPARE_FILES,
  GITHUB_MAX_PR_COMMITS,
  GITHUB_MAX_PR_FILES,
  compareCommits,
  fetchPullRequestSnapshot,
  getFileContent,
  listOpenPullRequests,
  mergeLinkedIssues,
  toPrCommitSnapshot,
  toPrFileSnapshot,
  toPrMeta,
  toPrSummary,
} from './pulls.ts';
export type { FetchPullRequestSnapshotOptions, GetFileContentOptions } from './pulls.ts';

export { discoverRepository, resolveCommitSha } from './discovery.ts';
export type { DiscoverRepositoryOptions } from './discovery.ts';
export { CODEOWNERS_LOCATIONS, analyzeRepositoryTree, selectDiscoveryFiles } from './profile.ts';
export type { AnalyzeRepositoryInput } from './profile.ts';
export { parseCodeowners } from './parsers.ts';

export { GitCommandError, ensureRepoClone, getCloneHeadSha, isSafeGitRef } from './clone.ts';
export type { EnsureRepoCloneOptions } from './clone.ts';

export { describeError, httpStatus, isNotFoundError, isUnavailableError } from './util.ts';

export type * from './types.ts';
