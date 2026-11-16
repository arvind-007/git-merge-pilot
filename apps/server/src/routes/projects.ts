import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  projectMembers,
  projectRepositories,
  projects,
  repositories,
  users,
  type Project,
} from '@gmp/db';
import { assertProjectAccess } from '../access.ts';
import { auditFromRequest } from '../audit.ts';
import { authOf, requireAdmin, requireAuth, scopeOf } from '../auth/guard.ts';
import { badRequest, conflict, notFound, parseWith } from '../errors.ts';
import { countBy, listPrItems, listRelationships } from '../queries/prs.ts';
import { IdParamsSchema } from '../validation.ts';
import { serializeRepository } from './repositories.ts';
import { QUEUES } from '../queue.ts';

const Threshold = z.number().int().min(1).max(100);
const SettingsSchema = z
  .object({
    riskThresholds: z
      .object({
        critical: Threshold.optional(),
        high: Threshold.optional(),
        medium: Threshold.optional(),
      })
      .strict()
      .refine(
        (t) =>
          (t.critical === undefined || t.high === undefined || t.critical > t.high) &&
          (t.high === undefined || t.medium === undefined || t.high > t.medium) &&
          (t.critical === undefined || t.medium === undefined || t.critical > t.medium),
        'Thresholds must satisfy critical > high > medium',
      )
      .optional(),
    analysisDepth: z.enum(['standard', 'deep']).optional(),
  })
  .strict();

const NameSchema = z.string().trim().min(1, 'Name is required').max(120);
const DescriptionSchema = z.string().trim().max(2000).nullable().optional();

const CreateSchema = z
  .object({
    name: NameSchema,
    description: DescriptionSchema,
    repositoryIds: z.array(z.string().uuid()).max(1000).optional(),
    memberIds: z.array(z.string().uuid()).max(1000).optional(),
    settings: SettingsSchema.optional(),
  })
  .strict();

const PatchSchema = z
  .object({
    name: NameSchema.optional(),
    description: DescriptionSchema,
    settings: SettingsSchema.optional(),
  })
  .strict();

const RepoLinkSchema = z
  .object({
    repositoryId: z.string().uuid().optional(),
    repositoryIds: z.array(z.string().uuid()).max(1000).optional(),
  })
  .refine((v) => v.repositoryId || v.repositoryIds?.length, 'repositoryId is required')
  .transform((v) => [
    ...new Set([...(v.repositoryId ? [v.repositoryId] : []), ...(v.repositoryIds ?? [])]),
  ]);

const MemberLinkSchema = z
  .object({
    userId: z.string().uuid().optional(),
    userIds: z.array(z.string().uuid()).max(1000).optional(),
  })
  .refine((v) => v.userId || v.userIds?.length, 'userId is required')
  .transform((v) => [...new Set([...(v.userId ? [v.userId] : []), ...(v.userIds ?? [])])]);

function serializeProject(p: Project) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    paused: p.paused,
    settings: p.settings,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  async function loadProject(orgId: string, id: string): Promise<Project> {
    const [p] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.orgId, orgId)))
      .limit(1);
    if (!p) throw notFound('Project not found.');
    return p;
  }

  async function assertNameFree(orgId: string, name: string, exceptId?: string) {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), sql`lower(${projects.name}) = ${name.toLowerCase()}`));
    if (rows.some((r) => r.id !== exceptId))
      throw conflict('A project with this name already exists.');
  }

  async function assertReposInOrg(orgId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.orgId, orgId), inArray(repositories.id, ids)));
    if (rows.length !== ids.length)
      throw badRequest('One or more repositories were not found.', 'invalid_reference');
  }

  async function assertUsersInOrg(orgId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), inArray(users.id, ids)));
    if (rows.length !== ids.length)
      throw badRequest('One or more users were not found.', 'invalid_reference');
  }

  app.get('/api/projects', { preHandler: requireAuth }, async (req) => {
    const scope = await scopeOf(req, app);
    if (scope.projectIds.length === 0) return [];
    const list = await db
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, scope.orgId), inArray(projects.id, scope.projectIds)))
      .orderBy(projects.name);
    const ids = list.map((p) => p.id);
    const repoCounts = await db
      .select({ projectId: projectRepositories.projectId, n: sql<number>`count(*)::int` })
      .from(projectRepositories)
      .where(inArray(projectRepositories.projectId, ids))
      .groupBy(projectRepositories.projectId);
    const memberCounts = await db
      .select({ projectId: projectMembers.projectId, n: sql<number>`count(*)::int` })
      .from(projectMembers)
      .where(inArray(projectMembers.projectId, ids))
      .groupBy(projectMembers.projectId);
    const openPrs = await listPrItems(db, scope, { state: 'open', limit: 2000 });
    return list.map((p) => {
      const prs = openPrs.filter((pr) => pr.projectIds.includes(p.id));
      return {
        ...serializeProject(p),
        repositoryCount: repoCounts.find((c) => c.projectId === p.id)?.n ?? 0,
        memberCount: memberCounts.find((c) => c.projectId === p.id)?.n ?? 0,
        openPrCount: prs.length,
        riskCounts: countBy(prs, (pr) => pr.overallRisk),
      };
    });
  });

  app.post('/api/projects', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseWith(CreateSchema, req.body);
    const { user } = authOf(req);
    await assertNameFree(user.orgId, body.name);
    const repoIds = [...new Set(body.repositoryIds ?? [])];
    const memberIds = [...new Set(body.memberIds ?? [])];
    await assertReposInOrg(user.orgId, repoIds);
    await assertUsersInOrg(user.orgId, memberIds);
    const project = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(projects)
        .values({
          orgId: user.orgId,
          name: body.name,
          description: body.description ?? null,
          settings: body.settings ?? {},
        })
        .returning();
      if (repoIds.length) {
        await tx
          .insert(projectRepositories)
          .values(repoIds.map((repositoryId) => ({ projectId: p!.id, repositoryId })));
      }
      if (memberIds.length) {
        await tx
          .insert(projectMembers)
          .values(memberIds.map((userId) => ({ projectId: p!.id, userId })));
      }
      return p!;
    });
    await auditFromRequest(
      db,
      req,
      'project.created',
      { type: 'project', id: project.id },
      {
        name: project.name,
        repositoryIds: repoIds,
        memberIds,
      },
    );
    return reply.status(201).send({
      ...serializeProject(project),
      repositoryCount: repoIds.length,
      memberCount: memberIds.length,
    });
  });

  app.get('/api/projects/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const scope = await scopeOf(req, app);
    assertProjectAccess(scope, id);
    const project = await loadProject(scope.orgId, id);
    const repos = await db
      .select({ repo: repositories })
      .from(projectRepositories)
      .innerJoin(repositories, eq(repositories.id, projectRepositories.repositoryId))
      .where(eq(projectRepositories.projectId, id))
      .orderBy(repositories.fullName);
    const members = await db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        disabled: users.disabled,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, id))
      .orderBy(users.name);
    return {
      ...serializeProject(project),
      repositoryCount: repos.length,
      memberCount: members.length,
      repositories: repos.map((r) => serializeRepository(r.repo)),
      members,
    };
  });

  app.patch('/api/projects/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const body = parseWith(PatchSchema, req.body);
    const { user } = authOf(req);
    await loadProject(user.orgId, id);
    if (body.name) await assertNameFree(user.orgId, body.name, id);
    const set: Partial<typeof projects.$inferInsert> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.description !== undefined) set.description = body.description;
    if (body.settings !== undefined) set.settings = body.settings;
    if (Object.keys(set).length === 0) return serializeProject(await loadProject(user.orgId, id));
    const [updated] = await db
      .update(projects)
      .set(set)
      .where(and(eq(projects.id, id), eq(projects.orgId, user.orgId)))
      .returning();
    await auditFromRequest(db, req, 'project.updated', { type: 'project', id }, { changes: set });
    return serializeProject(updated!);
  });

  app.delete('/api/projects/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const { user } = authOf(req);
    const project = await loadProject(user.orgId, id);
    await db.delete(projects).where(and(eq(projects.id, id), eq(projects.orgId, user.orgId)));
    await auditFromRequest(
      db,
      req,
      'project.deleted',
      { type: 'project', id },
      { name: project.name },
    );
    return { ok: true };
  });

  for (const action of ['pause', 'resume'] as const) {
    app.post(`/api/projects/:id/${action}`, { preHandler: requireAdmin }, async (req) => {
      const { id } = parseWith(IdParamsSchema, req.params);
      const { user } = authOf(req);
      await loadProject(user.orgId, id);
      const [updated] = await db
        .update(projects)
        .set({ paused: action === 'pause' })
        .where(and(eq(projects.id, id), eq(projects.orgId, user.orgId)))
        .returning();
      await auditFromRequest(db, req, `project.${action}d`, { type: 'project', id });
      if (action === 'resume') {
        // Catch up on what happened while paused (webhooks were ignored).
        await app.ctx.queue
          .send(QUEUES.reconcilePoll, {})
          .catch((err: unknown) => req.log.warn({ err }, 'could not enqueue reconcile'));
      }
      return serializeProject(updated!);
    });
  }

  app.post('/api/projects/:id/repositories', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const repoIds = parseWith(RepoLinkSchema, req.body);
    const { user } = authOf(req);
    await loadProject(user.orgId, id);
    await assertReposInOrg(user.orgId, repoIds);
    const added = await db
      .insert(projectRepositories)
      .values(repoIds.map((repositoryId) => ({ projectId: id, repositoryId })))
      .onConflictDoNothing()
      .returning({ repositoryId: projectRepositories.repositoryId });
    await auditFromRequest(
      db,
      req,
      'project.repositories_added',
      { type: 'project', id },
      { repositoryIds: repoIds },
    );
    return { ok: true, added: added.length };
  });

  app.delete('/api/projects/:id/repositories', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const repoIds = parseWith(RepoLinkSchema, req.body ?? req.query);
    const { user } = authOf(req);
    await loadProject(user.orgId, id);
    const removed = await db
      .delete(projectRepositories)
      .where(
        and(
          eq(projectRepositories.projectId, id),
          inArray(projectRepositories.repositoryId, repoIds),
        ),
      )
      .returning({ id: projectRepositories.id });
    await auditFromRequest(
      db,
      req,
      'project.repositories_removed',
      { type: 'project', id },
      { repositoryIds: repoIds },
    );
    return { ok: true, removed: removed.length };
  });

  app.post('/api/projects/:id/members', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const userIds = parseWith(MemberLinkSchema, req.body);
    const { user } = authOf(req);
    await loadProject(user.orgId, id);
    await assertUsersInOrg(user.orgId, userIds);
    const added = await db
      .insert(projectMembers)
      .values(userIds.map((userId) => ({ projectId: id, userId })))
      .onConflictDoNothing()
      .returning({ id: projectMembers.id });
    await auditFromRequest(db, req, 'project.members_added', { type: 'project', id }, { userIds });
    return { ok: true, added: added.length };
  });

  app.delete('/api/projects/:id/members', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const userIds = parseWith(MemberLinkSchema, req.body ?? req.query);
    const { user } = authOf(req);
    await loadProject(user.orgId, id);
    const removed = await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, id), inArray(projectMembers.userId, userIds)))
      .returning({ id: projectMembers.id });
    await auditFromRequest(
      db,
      req,
      'project.members_removed',
      { type: 'project', id },
      { userIds },
    );
    return { ok: true, removed: removed.length };
  });

  app.get('/api/projects/:id/overview', { preHandler: requireAuth }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const scope = await scopeOf(req, app);
    assertProjectAccess(scope, id);
    const project = await loadProject(scope.orgId, id);
    const openPrs = await listPrItems(db, scope, { projectId: id, state: 'open', limit: 1000 });
    const relationships = await listRelationships(db, scope, {
      pullRequestIds: openPrs.map((p) => p.id),
      openOnly: true,
      limit: 200,
    });
    const ids = new Set(openPrs.map((p) => p.id));
    return {
      project: serializeProject(project),
      openPrs,
      riskCounts: countBy(openPrs, (p) => p.overallRisk),
      recommendationCounts: countBy(openPrs, (p) => p.recommendation),
      relationships: relationships.filter((r) => ids.has(r.prA.id) || ids.has(r.prB.id)),
    };
  });
}
