import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AI_MODES } from '@gmp/core';
import {
  projectRepositories,
  projects,
  repositories,
  repositoryProfiles,
  type Repository,
} from '@gmp/db';
import { assertRepositoryAccess } from '../access.ts';
import { auditFromRequest } from '../audit.ts';
import { authOf, requireAdmin, requireAuth, scopeOf } from '../auth/guard.ts';
import { notFound, parseWith } from '../errors.ts';
import { countBy, listOpenFindings, listPrItems, uuidArray } from '../queries/prs.ts';
import { QUEUES, type RepoDiscoverJob } from '../queue.ts';
import { IdParamsSchema } from '../validation.ts';

const ProfileDataSchema = z
  .object({
    languages: z.record(z.string().max(100), z.number().min(0)).optional(),
    frameworks: z.array(z.string().max(200)).max(200).optional(),
    buildTools: z.array(z.string().max(200)).max(200).optional(),
    packageManagers: z.array(z.string().max(200)).max(200).optional(),
    testFrameworks: z.array(z.string().max(200)).max(200).optional(),
    ciWorkflows: z.array(z.string().max(500)).max(500).optional(),
    securityTools: z.array(z.string().max(200)).max(200).optional(),
    codeowners: z.string().max(500).nullable().optional(),
    prTemplate: z.string().max(500).nullable().optional(),
    contributing: z.string().max(500).nullable().optional(),
    architectureDocs: z.array(z.string().max(500)).max(200).optional(),
    packages: z
      .array(z.object({ name: z.string().max(300), path: z.string().max(500) }))
      .max(1000)
      .optional(),
    notes: z.string().max(5000).optional(),
  })
  .strict();

const PatchSchema = z
  .object({
    monitoringEnabled: z.boolean().optional(),
    aiMode: z.enum(AI_MODES).optional(),
    excludePaths: z
      .array(z.string().trim().min(1).max(500))
      .max(200)
      .optional()
      .transform((v) => (v ? [...new Set(v)] : v)),
    profileOverrides: ProfileDataSchema.optional(),
  })
  .strict();

const ListQuerySchema = z.object({
  monitored: z.enum(['true', 'false']).optional(),
});

export function serializeRepository(r: Repository) {
  return {
    id: r.id,
    githubId: r.githubId,
    owner: r.owner,
    name: r.name,
    fullName: r.fullName,
    private: r.private,
    defaultBranch: r.defaultBranch,
    archived: r.archived,
    monitoringEnabled: r.monitoringEnabled,
    aiMode: r.aiMode,
    excludePaths: r.excludePaths,
    lastDiscoveredAt: r.lastDiscoveredAt,
    lastPolledAt: r.lastPolledAt,
    installationId: r.installationId,
    connected: r.installationId !== null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function repositoryRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  async function loadRepo(orgId: string, id: string): Promise<Repository> {
    const [repo] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, id), eq(repositories.orgId, orgId)))
      .limit(1);
    if (!repo) throw notFound('Repository not found.');
    return repo;
  }

  app.get('/api/repositories', { preHandler: requireAuth }, async (req) => {
    const scope = await scopeOf(req, app);
    const q = parseWith(ListQuerySchema, req.query);
    if (scope.repositoryIds.length === 0) return [];
    const conds = [
      eq(repositories.orgId, scope.orgId),
      inArray(repositories.id, scope.repositoryIds),
    ];
    if (q.monitored) conds.push(eq(repositories.monitoringEnabled, q.monitored === 'true'));
    const repos = await db
      .select()
      .from(repositories)
      .where(and(...conds))
      .orderBy(repositories.fullName);
    if (repos.length === 0) return [];
    const ids = repos.map((r) => r.id);
    const links = scope.projectIds.length
      ? await db
          .select({
            repositoryId: projectRepositories.repositoryId,
            id: projects.id,
            name: projects.name,
          })
          .from(projectRepositories)
          .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
          .where(
            and(
              inArray(projectRepositories.repositoryId, ids),
              inArray(projects.id, scope.projectIds),
            ),
          )
      : [];
    const openCounts = await db.execute(
      sql`SELECT repository_id, count(*)::int AS n FROM pull_requests
          WHERE org_id = ${scope.orgId} AND state = 'open' AND repository_id = ANY(${uuidArray(ids)}::uuid[])
          GROUP BY repository_id`,
    );
    const open = new Map(
      (openCounts as unknown as { rows: Array<{ repository_id: string; n: number }> }).rows.map(
        (r) => [r.repository_id, Number(r.n)],
      ),
    );
    return repos.map((r) => ({
      ...serializeRepository(r),
      projects: links
        .filter((l) => l.repositoryId === r.id)
        .map((l) => ({ id: l.id, name: l.name })),
      openPrCount: open.get(r.id) ?? 0,
    }));
  });

  app.get('/api/repositories/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const scope = await scopeOf(req, app);
    assertRepositoryAccess(scope, id);
    const repo = await loadRepo(scope.orgId, id);
    const [profile] = await db
      .select()
      .from(repositoryProfiles)
      .where(eq(repositoryProfiles.repositoryId, id))
      .limit(1);
    const links = scope.projectIds.length
      ? await db
          .select({ id: projects.id, name: projects.name })
          .from(projectRepositories)
          .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
          .where(
            and(eq(projectRepositories.repositoryId, id), inArray(projects.id, scope.projectIds)),
          )
      : [];
    return {
      ...serializeRepository(repo),
      projects: links,
      profile: profile
        ? {
            discovered: profile.discovered,
            overrides: profile.overrides,
            headSha: profile.headSha,
            updatedAt: profile.updatedAt,
          }
        : null,
    };
  });

  app.patch('/api/repositories/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const body = parseWith(PatchSchema, req.body);
    const { user } = authOf(req);
    const before = await loadRepo(user.orgId, id);
    const set: Partial<typeof repositories.$inferInsert> = {};
    if (body.monitoringEnabled !== undefined) set.monitoringEnabled = body.monitoringEnabled;
    if (body.aiMode !== undefined) set.aiMode = body.aiMode;
    if (body.excludePaths !== undefined) set.excludePaths = body.excludePaths;
    let repo = before;
    if (Object.keys(set).length) {
      const [updated] = await db
        .update(repositories)
        .set(set)
        .where(and(eq(repositories.id, id), eq(repositories.orgId, user.orgId)))
        .returning();
      repo = updated!;
    }
    if (body.profileOverrides !== undefined) {
      await db
        .insert(repositoryProfiles)
        .values({ repositoryId: id, overrides: body.profileOverrides })
        .onConflictDoUpdate({
          target: repositoryProfiles.repositoryId,
          set: { overrides: body.profileOverrides },
        });
    }
    if (body.monitoringEnabled === true && !before.monitoringEnabled) {
      const job: RepoDiscoverJob = {
        orgId: user.orgId,
        repositoryId: id,
        reason: 'monitoring_enabled',
      };
      await app.ctx.queue.send(QUEUES.repoDiscover, job, { singletonKey: `repo:${id}` });
    }
    await auditFromRequest(
      db,
      req,
      'repository.updated',
      { type: 'repository', id },
      {
        fullName: repo.fullName,
        changes: {
          ...set,
          ...(body.profileOverrides !== undefined ? { profileOverrides: true } : {}),
        },
      },
    );
    return serializeRepository(repo);
  });

  app.post('/api/repositories/:id/rediscover', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const { user } = authOf(req);
    const repo = await loadRepo(user.orgId, id);
    const job: RepoDiscoverJob = {
      orgId: user.orgId,
      repositoryId: id,
      reason: 'manual',
      force: true,
    };
    const jobId = await app.ctx.queue.send(QUEUES.repoDiscover, job, {
      singletonKey: `repo:${id}:manual`,
    });
    await auditFromRequest(
      db,
      req,
      'repository.rediscover',
      { type: 'repository', id },
      {
        fullName: repo.fullName,
      },
    );
    return reply.status(202).send({ queued: true, jobId });
  });

  app.get('/api/repositories/:id/overview', { preHandler: requireAuth }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const scope = await scopeOf(req, app);
    assertRepositoryAccess(scope, id);
    const repo = await loadRepo(scope.orgId, id);
    const openPrs = await listPrItems(db, scope, { repositoryId: id, state: 'open', limit: 500 });
    const recentFindings = await listOpenFindings(db, scope, {
      repositoryId: id,
      severities: ['critical', 'high', 'medium'],
      limit: 50,
    });
    return {
      repository: serializeRepository(repo),
      openPrs,
      riskCounts: countBy(openPrs, (p) => p.overallRisk),
      recommendationCounts: countBy(openPrs, (p) => p.recommendation),
      recentFindings,
    };
  });
}
