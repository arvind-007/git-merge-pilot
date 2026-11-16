import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { decrypt } from '@gmp/core';
import { githubApps, installations, repositories, type Database, type GithubApp } from '@gmp/db';
import type { GitHubClient, InstallationInfo, InstallationRepository } from '@gmp/github';
import type { ServerContext } from '../context.ts';
import { HttpError } from '../errors.ts';
import { QUEUES, type RepoDiscoverJob } from '../queue.ts';

/** The org's GitHub App row (most recently created when several exist). */
export async function getOrgApp(db: Database, orgId: string): Promise<GithubApp | null> {
  const [row] = await db
    .select()
    .from(githubApps)
    .where(eq(githubApps.orgId, orgId))
    .orderBy(desc(githubApps.createdAt))
    .limit(1);
  return row ?? null;
}

export function appClient(ctx: ServerContext, app: GithubApp): GitHubClient {
  let privateKey: string;
  try {
    privateKey = decrypt(app.privateKeyEnc, ctx.config.masterKey);
  } catch {
    throw new HttpError(
      500,
      'credentials_unreadable',
      'Stored GitHub App credentials could not be decrypted. Check MASTER_KEY.',
    );
  }
  return ctx.github.createClient({ appId: app.appId, privateKey, apiUrl: ctx.config.githubApiUrl });
}

/** Minimal logger shape (pino or Fastify request logger). */
export interface WarnLogger {
  warn(obj: object, msg?: string): void;
}

export interface SyncSummary {
  installations: number;
  repositories: number;
  addedRepositories: number;
  detachedRepositories: number;
  removedInstallations: number;
  errors: string[];
}

async function upsertInstallation(
  db: Database,
  orgId: string,
  app: GithubApp,
  info: InstallationInfo,
): Promise<string> {
  const values = {
    orgId,
    githubAppId: app.id,
    installationId: info.installationId,
    accountLogin: info.accountLogin,
    accountType: info.accountType,
    repositorySelection: info.repositorySelection,
    permissions: info.permissions,
    suspendedAt: info.suspendedAt ? new Date(info.suspendedAt) : null,
  };
  const [row] = await db
    .insert(installations)
    .values(values)
    .onConflictDoUpdate({
      target: installations.installationId,
      set: {
        orgId,
        githubAppId: app.id,
        accountLogin: values.accountLogin,
        accountType: values.accountType,
        repositorySelection: values.repositorySelection,
        permissions: values.permissions,
        suspendedAt: values.suspendedAt,
      },
    })
    .returning({ id: installations.id });
  return row!.id;
}

/**
 * Upserts the repositories of one installation. Returns ids of newly inserted repositories.
 * Repositories previously attached to this installation but no longer visible are detached
 * (installation_id = null, monitoring disabled) — history is kept.
 */
async function syncInstallationRepos(
  db: Database,
  orgId: string,
  installationRowId: string,
  repos: InstallationRepository[],
): Promise<{ added: string[]; detached: number }> {
  const added: string[] = [];
  const now = new Date();
  for (const r of repos) {
    const [existing] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.orgId, orgId), eq(repositories.githubId, r.githubId)))
      .limit(1);
    if (existing) {
      await db
        .update(repositories)
        .set({
          installationId: installationRowId,
          owner: r.owner,
          name: r.name,
          fullName: r.fullName,
          private: r.private,
          defaultBranch: r.defaultBranch || 'main',
          archived: r.archived,
        })
        .where(eq(repositories.id, existing.id));
    } else {
      const [row] = await db
        .insert(repositories)
        .values({
          orgId,
          installationId: installationRowId,
          githubId: r.githubId,
          owner: r.owner,
          name: r.name,
          fullName: r.fullName,
          private: r.private,
          defaultBranch: r.defaultBranch || 'main',
          archived: r.archived,
          monitoringEnabled: !r.archived,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: repositories.id });
      if (row) added.push(row.id);
    }
  }
  const visible = repos.map((r) => r.githubId);
  const detachedWhere = and(
    eq(repositories.orgId, orgId),
    eq(repositories.installationId, installationRowId),
    visible.length ? notInArray(repositories.githubId, visible) : sql`true`,
  );
  const detached = await db
    .update(repositories)
    .set({ installationId: null, monitoringEnabled: false })
    .where(detachedWhere)
    .returning({ id: repositories.id });
  return { added, detached: detached.length };
}

/**
 * Reads installations + their repositories from GitHub and mirrors them into the database, then
 * enqueues repo.discover for newly added, monitored repositories.
 */
export async function syncInstallations(
  ctx: ServerContext,
  orgId: string,
  logger?: WarnLogger,
): Promise<SyncSummary> {
  const app = await getOrgApp(ctx.db, orgId);
  if (!app) throw new HttpError(409, 'github_not_connected', 'Connect a GitHub App first.');
  const client = appClient(ctx, app);
  let infos: InstallationInfo[];
  try {
    infos = await client.listInstallations();
  } catch (err) {
    logger?.warn({ err }, 'listing GitHub App installations failed');
    throw new HttpError(502, 'github_unavailable', 'Could not reach GitHub to list installations.');
  }

  const summary: SyncSummary = {
    installations: 0,
    repositories: 0,
    addedRepositories: 0,
    detachedRepositories: 0,
    removedInstallations: 0,
    errors: [],
  };
  const keptRowIds: string[] = [];
  const toDiscover: string[] = [];
  for (const info of infos) {
    const rowId = await upsertInstallation(ctx.db, orgId, app, info);
    keptRowIds.push(rowId);
    summary.installations++;
    if (info.suspendedAt) continue;
    let repos: InstallationRepository[];
    try {
      repos = await client.listInstallationRepos(info.installationId);
    } catch (err) {
      logger?.warn(
        { err, installationId: info.installationId },
        'listing installation repos failed',
      );
      summary.errors.push(`Could not list repositories for ${info.accountLogin}.`);
      continue;
    }
    summary.repositories += repos.length;
    const { added, detached } = await syncInstallationRepos(ctx.db, orgId, rowId, repos);
    summary.addedRepositories += added.length;
    summary.detachedRepositories += detached;
    toDiscover.push(...added);
  }

  // Installations GitHub no longer reports (uninstalled) are removed; repos are detached via FK.
  const removed = await ctx.db
    .delete(installations)
    .where(
      and(
        eq(installations.orgId, orgId),
        eq(installations.githubAppId, app.id),
        keptRowIds.length ? notInArray(installations.id, keptRowIds) : sql`true`,
      ),
    )
    .returning({ id: installations.id });
  summary.removedInstallations = removed.length;
  if (removed.length) {
    await ctx.db
      .update(repositories)
      .set({ monitoringEnabled: false })
      .where(and(eq(repositories.orgId, orgId), sql`${repositories.installationId} is null`));
  }

  if (toDiscover.length) {
    const monitored = await ctx.db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(inArray(repositories.id, toDiscover), eq(repositories.monitoringEnabled, true)));
    for (const r of monitored) {
      const job: RepoDiscoverJob = { orgId, repositoryId: r.id, reason: 'installation_sync' };
      await ctx.queue.send(QUEUES.repoDiscover, job, { singletonKey: `repo:${r.id}` });
    }
  }
  return summary;
}
