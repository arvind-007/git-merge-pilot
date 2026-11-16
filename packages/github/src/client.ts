/**
 * Authenticated GitHub clients (design §7): App (JWT) and per-installation
 * Octokit instances with throttling + retry plugins and a configurable base URL
 * (GitHub Enterprise Server: GITHUB_API_URL, e.g. https://ghe.example.com/api/v3).
 */
import { createAppAuth } from '@octokit/auth-app';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';
import { createLogger } from '@gmp/core';
import type { Logger } from '@gmp/core';
import { arr, bool, isNotFoundError, isoDate, login, num, obj, str } from './util.ts';

export { Octokit } from '@octokit/rest';

/** Octokit class with throttling + retry plugins applied. */
export const GmpOctokit = Octokit.plugin(throttling, retry);
export type GitHubOctokit = InstanceType<typeof GmpOctokit>;

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const USER_AGENT = 'git-merge-pilot';

export interface OctokitFactoryOptions {
  /** Base REST URL. Default https://api.github.com. */
  baseUrl?: string;
  /** Enable the throttling plugin (default true). */
  throttle?: boolean;
  /** Throttling group id; requests with the same id share rate-limit queues. */
  throttleId?: string;
  /** Retries for 5xx/transient failures (default 3). 0 disables retrying. */
  retries?: number;
  /** Base unit (ms) for retry backoff and rate-limit waits (default 1000). Mainly for tests. */
  retryAfterBaseMs?: number;
  /** How many times to wait out a primary/secondary rate limit before failing (default 2). */
  maxRateLimitRetries?: number;
  /** Never sleep longer than this many seconds for a rate limit; fail instead so the job can be retried later (default 300). */
  maxRateLimitWaitSeconds?: number;
  logger?: Logger;
  /** Extra Octokit `request` options (custom fetch, timeouts). */
  request?: Record<string, unknown>;
  userAgent?: string;
}

export interface CreateOctokitOptions extends OctokitFactoryOptions {
  /** Token (installation token, PAT) — omit for unauthenticated requests. */
  auth?: string;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function octokitLog(logger: Logger) {
  return {
    debug: (msg: string, ...rest: unknown[]) => logger.debug({ extra: rest }, msg),
    info: (msg: string, ...rest: unknown[]) => logger.debug({ extra: rest }, msg),
    warn: (msg: string, ...rest: unknown[]) => logger.warn({ extra: rest }, msg),
    // Octokit logs every failed request here. A 4xx (e.g. code scanning or Dependabot not
    // enabled on a repository) is handled by the caller, which records it as a report
    // limitation or rethrows it, so it is only debug noise at this level.
    error: (msg: string, ...rest: unknown[]) =>
      / - 4\d\d with id /.test(msg)
        ? logger.debug({ extra: rest }, msg)
        : logger.error({ extra: rest }, msg),
  };
}

/** Constructor options shared by every Octokit this package builds. */
function baseOctokitOptions(opts: OctokitFactoryOptions, defaultThrottleId: string) {
  const logger = opts.logger ?? createLogger('github');
  const maxRetries = opts.maxRateLimitRetries ?? 2;
  const maxWait = opts.maxRateLimitWaitSeconds ?? 300;
  const onLimit =
    (kind: 'primary' | 'secondary') =>
    (
      retryAfter: number,
      options: { method?: string; url?: string },
      _o: unknown,
      retryCount: number,
    ) => {
      const willRetry = retryCount < maxRetries && retryAfter <= maxWait;
      logger.warn(
        { kind, retryAfter, retryCount, method: options.method, url: options.url, willRetry },
        `GitHub ${kind} rate limit hit`,
      );
      return willRetry;
    };
  const retries = opts.retries ?? 3;
  return {
    baseUrl: trimSlash(opts.baseUrl ?? DEFAULT_GITHUB_API_URL),
    userAgent: opts.userAgent ?? USER_AGENT,
    log: octokitLog(logger),
    throttle:
      opts.throttle === false
        ? { enabled: false as const }
        : {
            id: opts.throttleId ?? defaultThrottleId,
            onRateLimit: onLimit('primary'),
            onSecondaryRateLimit: onLimit('secondary'),
            ...(opts.retryAfterBaseMs !== undefined
              ? { retryAfterBaseValue: opts.retryAfterBaseMs }
              : {}),
          },
    retry: {
      enabled: retries > 0,
      retries,
      ...(opts.retryAfterBaseMs !== undefined
        ? { retryAfterBaseValue: opts.retryAfterBaseMs }
        : {}),
    },
    ...(opts.request ? { request: opts.request } : {}),
  };
}

/**
 * Creates a token-authenticated (or unauthenticated) Octokit with throttling +
 * retry. Use {@link GitHubClient.installationOctokit} for App installations.
 */
export function createOctokit(opts: CreateOctokitOptions = {}): GitHubOctokit {
  return new GmpOctokit({
    ...baseOctokitOptions(opts, 'gmp-token'),
    ...(opts.auth ? { auth: opts.auth } : {}),
  });
}

export interface GitHubAppCredentials {
  appId: number | string;
  /** PEM private key (decrypted). */
  privateKey: string;
  /** GITHUB_API_URL; default https://api.github.com. */
  apiUrl?: string;
}

export interface GitHubClientOptions extends Omit<OctokitFactoryOptions, 'baseUrl' | 'throttleId'> {
  /** Max installation Octokit instances kept in memory (LRU; default 500). */
  maxCachedInstallations?: number;
}

export interface InstallationToken {
  token: string;
  /** ISO timestamp. */
  expiresAt: string;
}

export interface InstallationInfo {
  installationId: number;
  appId: number | null;
  accountLogin: string;
  accountType: string;
  repositorySelection: 'all' | 'selected' | string;
  permissions: Record<string, string>;
  events: string[];
  suspendedAt: string | null;
  htmlUrl: string | null;
}

export interface InstallationRepository {
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  htmlUrl: string;
  language: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
}

export interface AppInfo {
  appId: number;
  slug: string;
  name: string;
  ownerLogin: string | null;
  htmlUrl: string | null;
  permissions: Record<string, string>;
  events: string[];
}

export interface GitHubClient {
  readonly appId: number;
  readonly apiUrl: string;
  /** JWT-authenticated Octokit acting as the App itself. */
  appOctokit(): GitHubOctokit;
  /** Cached (LRU) installation-authenticated Octokit; tokens are minted and refreshed automatically. */
  installationOctokit(installationId: number): GitHubOctokit;
  /** A (cached, auto-refreshed) installation access token, e.g. for `ensureRepoClone`. Never log it. */
  getInstallationToken(installationId: number): Promise<InstallationToken>;
  getApp(): Promise<AppInfo>;
  listInstallations(): Promise<InstallationInfo[]>;
  /** null when the installation no longer exists. */
  getInstallation(installationId: number): Promise<InstallationInfo | null>;
  listInstallationRepos(installationId: number): Promise<InstallationRepository[]>;
  /** Drops a cached installation Octokit (e.g. after uninstall). */
  forgetInstallation(installationId: number): void;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(value) ?? {})) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function stringList(value: unknown): string[] {
  return arr(value).filter((v): v is string => typeof v === 'string');
}

export function toInstallationInfo(raw: unknown): InstallationInfo {
  const d = obj(raw) ?? {};
  const account = obj(d.account) ?? {};
  return {
    installationId: num(d.id) ?? 0,
    appId: num(d.app_id),
    accountLogin: str(account.login) ?? str(account.slug) ?? '',
    accountType: str(account.type) ?? (str(account.slug) ? 'Enterprise' : 'User'),
    repositorySelection: str(d.repository_selection) ?? 'selected',
    permissions: stringRecord(d.permissions),
    events: stringList(d.events),
    suspendedAt: isoDate(d.suspended_at),
    htmlUrl: str(d.html_url),
  };
}

export function toInstallationRepository(raw: unknown): InstallationRepository {
  const d = obj(raw) ?? {};
  const fullName = str(d.full_name) ?? '';
  const owner = login(d.owner) ?? fullName.split('/')[0] ?? '';
  return {
    githubId: num(d.id) ?? 0,
    owner,
    name: str(d.name) ?? fullName.split('/')[1] ?? '',
    fullName,
    private: bool(d.private) ?? false,
    defaultBranch: str(d.default_branch) ?? 'main',
    archived: bool(d.archived) ?? false,
    disabled: bool(d.disabled) ?? false,
    fork: bool(d.fork) ?? false,
    htmlUrl: str(d.html_url) ?? '',
    language: str(d.language),
    pushedAt: isoDate(d.pushed_at),
    updatedAt: isoDate(d.updated_at),
  };
}

/** Creates the App-level GitHub client (design §7). */
export function createGitHubClient(
  creds: GitHubAppCredentials,
  options: GitHubClientOptions = {},
): GitHubClient {
  const appId = Number(creds.appId);
  if (!Number.isSafeInteger(appId) || appId <= 0)
    throw new TypeError('appId must be a positive integer');
  if (!creds.privateKey || !creds.privateKey.includes('PRIVATE KEY')) {
    throw new TypeError('privateKey must be a PEM-encoded private key');
  }
  const apiUrl = trimSlash(creds.apiUrl ?? DEFAULT_GITHUB_API_URL);
  const logger = options.logger ?? createLogger('github');
  const maxCached = Math.max(1, options.maxCachedInstallations ?? 500);
  const factory: OctokitFactoryOptions = { ...options, baseUrl: apiUrl, logger };

  let app: GitHubOctokit | null = null;
  const cache = new Map<number, GitHubOctokit>();

  function appOctokit(): GitHubOctokit {
    app ??= new GmpOctokit({
      ...baseOctokitOptions(factory, `gmp-app-${appId}`),
      authStrategy: createAppAuth,
      auth: { appId, privateKey: creds.privateKey },
    });
    return app;
  }

  function assertInstallationId(installationId: number): void {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new TypeError('installationId must be a positive integer');
    }
  }

  function installationOctokit(installationId: number): GitHubOctokit {
    assertInstallationId(installationId);
    const hit = cache.get(installationId);
    if (hit) {
      cache.delete(installationId);
      cache.set(installationId, hit);
      return hit;
    }
    const octokit = new GmpOctokit({
      ...baseOctokitOptions(factory, `gmp-app-${appId}-inst-${installationId}`),
      authStrategy: createAppAuth,
      auth: { appId, privateKey: creds.privateKey, installationId },
    });
    cache.set(installationId, octokit);
    while (cache.size > maxCached) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return octokit;
  }

  async function getInstallationToken(installationId: number): Promise<InstallationToken> {
    const auth = (await installationOctokit(installationId).auth({ type: 'installation' })) as {
      token?: unknown;
      expiresAt?: unknown;
    };
    const token = str(auth.token);
    if (!token) throw new Error('GitHub did not return an installation token');
    return {
      token,
      expiresAt: isoDate(auth.expiresAt) ?? new Date(Date.now() + 50 * 60_000).toISOString(),
    };
  }

  async function getApp(): Promise<AppInfo> {
    const { data } = await appOctokit().rest.apps.getAuthenticated();
    const d = (obj(data) ?? {}) as Record<string, unknown>;
    return {
      appId: num(d.id) ?? appId,
      slug: str(d.slug) ?? '',
      name: str(d.name) ?? '',
      ownerLogin: login(d.owner),
      htmlUrl: str(d.html_url),
      permissions: stringRecord(d.permissions),
      events: stringList(d.events),
    };
  }

  async function listInstallations(): Promise<InstallationInfo[]> {
    const octokit = appOctokit();
    const items = await octokit.paginate(octokit.rest.apps.listInstallations, { per_page: 100 });
    return items.map(toInstallationInfo);
  }

  async function getInstallation(installationId: number): Promise<InstallationInfo | null> {
    assertInstallationId(installationId);
    try {
      const { data } = await appOctokit().rest.apps.getInstallation({
        installation_id: installationId,
      });
      return toInstallationInfo(data);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async function listInstallationRepos(installationId: number): Promise<InstallationRepository[]> {
    const octokit = installationOctokit(installationId);
    const items = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
      per_page: 100,
    });
    return (items as unknown[]).map(toInstallationRepository);
  }

  return {
    appId,
    apiUrl,
    appOctokit,
    installationOctokit,
    getInstallationToken,
    getApp,
    listInstallations,
    getInstallation,
    listInstallationRepos,
    forgetInstallation: (installationId: number) => {
      cache.delete(installationId);
    },
  };
}
