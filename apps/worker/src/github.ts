/**
 * GitHub access for the worker. Handlers talk to a narrow {@link GitHubGateway} so tests can pass
 * a fake; production uses {@link createGitHubGateway}, which builds App clients from the
 * encrypted credentials in `github_apps` and resolves each repository's installation.
 */
import { decrypt, type Logger } from '@gmp/core';
import { githubApps, installations, type Database } from '@gmp/db';
import {
  compareCommits,
  createGitHubClient,
  discoverRepository,
  ensureRepoClone,
  fetchPullRequestSnapshot,
  getCloneHeadSha,
  getFileContent,
  listOpenPullRequests,
  type CompareResult,
  type FetchPullRequestSnapshotOptions,
  type GitHubClient,
  type PrSnapshot,
  type PrSummary,
  type RepositoryProfile as DiscoveredProfile,
} from '@gmp/github';
import { eq } from 'drizzle-orm';

/** The repository fields the gateway needs (a `repositories` row satisfies it). */
export interface RepoTarget {
  id: string;
  orgId: string;
  owner: string;
  name: string;
  fullName: string;
  /** FK to installations.id (uuid); null when the App lost access. */
  installationId: string | null;
  defaultBranch: string;
}

export interface RepoClone {
  /** Absolute path of the checkout. */
  dir: string;
  headSha: string;
}

export interface GitHubGateway {
  fetchPullRequestSnapshot(
    repo: RepoTarget,
    number: number,
    options?: FetchPullRequestSnapshotOptions,
  ): Promise<PrSnapshot>;
  compareCommits(repo: RepoTarget, base: string, head: string): Promise<CompareResult>;
  getFileContent(
    repo: RepoTarget,
    path: string,
    ref: string,
    options?: { maxBytes?: number },
  ): Promise<string | null>;
  listOpenPullRequests(repo: RepoTarget): Promise<PrSummary[]>;
  discoverRepository(repo: RepoTarget, ref?: string): Promise<DiscoveredProfile>;
  /** Shallow checkout of `ref` for indexing. */
  cloneRepository(repo: RepoTarget, ref: string): Promise<RepoClone>;
}

/** Thrown when a repository cannot be accessed through any stored GitHub App installation. */
export class GitHubAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAccessError';
  }
}

export interface GitHubGatewayOptions {
  db: Database;
  apiUrl: string;
  webUrl: string;
  repoCacheDir: string;
  masterKey?: Buffer;
  logger?: Logger;
}

interface ResolvedInstallation {
  client: GitHubClient;
  installationId: number;
}

/** Production gateway: GitHub App credentials come from the database (decrypted with MASTER_KEY). */
export function createGitHubGateway(opts: GitHubGatewayOptions): GitHubGateway {
  const clients = new Map<string, { client: GitHubClient; updatedAt: number }>();

  async function resolve(repo: RepoTarget): Promise<ResolvedInstallation> {
    if (!repo.installationId) {
      throw new GitHubAccessError(
        `Repository ${repo.fullName} is not linked to a GitHub App installation`,
      );
    }
    const rows = await opts.db
      .select({
        installationId: installations.installationId,
        suspendedAt: installations.suspendedAt,
        app: githubApps,
      })
      .from(installations)
      .innerJoin(githubApps, eq(githubApps.id, installations.githubAppId))
      .where(eq(installations.id, repo.installationId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new GitHubAccessError(`Installation for ${repo.fullName} was not found`);
    if (row.suspendedAt) {
      throw new GitHubAccessError(`GitHub App installation for ${repo.fullName} is suspended`);
    }
    const cached = clients.get(row.app.id);
    const updatedAt = row.app.updatedAt.getTime();
    let client = cached && cached.updatedAt === updatedAt ? cached.client : null;
    if (!client) {
      const privateKey = decrypt(row.app.privateKeyEnc, opts.masterKey);
      client = createGitHubClient(
        { appId: row.app.appId, privateKey, apiUrl: opts.apiUrl },
        opts.logger ? { logger: opts.logger } : {},
      );
      clients.set(row.app.id, { client, updatedAt });
    }
    return { client, installationId: row.installationId };
  }

  async function octokit(repo: RepoTarget) {
    const { client, installationId } = await resolve(repo);
    return client.installationOctokit(installationId);
  }

  return {
    async fetchPullRequestSnapshot(repo, number, options) {
      return fetchPullRequestSnapshot(await octokit(repo), repo.owner, repo.name, number, options);
    },
    async compareCommits(repo, base, head) {
      return compareCommits(await octokit(repo), repo.owner, repo.name, base, head);
    },
    async getFileContent(repo, path, ref, options) {
      return getFileContent(await octokit(repo), repo.owner, repo.name, path, ref, options);
    },
    async listOpenPullRequests(repo) {
      return listOpenPullRequests(await octokit(repo), repo.owner, repo.name);
    },
    async discoverRepository(repo, ref) {
      return discoverRepository(await octokit(repo), repo.owner, repo.name, ref);
    },
    async cloneRepository(repo, ref) {
      const { client, installationId } = await resolve(repo);
      const token = await client.getInstallationToken(installationId);
      const dir = await ensureRepoClone(opts.repoCacheDir, token.token, repo.fullName, ref, {
        webUrl: opts.webUrl,
      });
      return { dir, headSha: await getCloneHeadSha(dir) };
    },
  };
}
