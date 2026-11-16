/**
 * Authorization: admins see everything in their org; members only see repositories that belong
 * to projects they are a member of (design §2, §12).
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  projectMembers,
  projectRepositories,
  projects,
  pullRequests,
  repositories,
  type DbOrTx,
} from '@gmp/db';
import type { AuthUser } from './context.ts';
import { forbidden, notFound } from './errors.ts';

export interface AccessScope {
  orgId: string;
  isAdmin: boolean;
  /** Repository ids the user may read (all org repositories for admins). */
  repositoryIds: string[];
  /** Project ids the user may read (all org projects for admins). */
  projectIds: string[];
}

/** Repository ids `user` may read. */
export async function accessibleRepositoryIds(db: DbOrTx, user: AuthUser): Promise<string[]> {
  if (user.role === 'admin') {
    const rows = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.orgId, user.orgId));
    return rows.map((r) => r.id);
  }
  const rows = await db
    .selectDistinct({ id: projectRepositories.repositoryId })
    .from(projectRepositories)
    .innerJoin(projectMembers, eq(projectMembers.projectId, projectRepositories.projectId))
    .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
    .innerJoin(repositories, eq(repositories.id, projectRepositories.repositoryId))
    .where(
      and(
        eq(projectMembers.userId, user.id),
        eq(projects.orgId, user.orgId),
        eq(repositories.orgId, user.orgId),
      ),
    );
  return rows.map((r) => r.id);
}

/** Project ids `user` may read. */
export async function accessibleProjectIds(db: DbOrTx, user: AuthUser): Promise<string[]> {
  if (user.role === 'admin') {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.orgId, user.orgId));
    return rows.map((r) => r.id);
  }
  const rows = await db
    .select({ id: projects.id })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.userId, user.id), eq(projects.orgId, user.orgId)));
  return rows.map((r) => r.id);
}

export async function computeAccessScope(db: DbOrTx, user: AuthUser): Promise<AccessScope> {
  const [repositoryIds, projectIds] = await Promise.all([
    accessibleRepositoryIds(db, user),
    accessibleProjectIds(db, user),
  ]);
  return { orgId: user.orgId, isAdmin: user.role === 'admin', repositoryIds, projectIds };
}

export function canReadRepository(scope: AccessScope, repositoryId: string): boolean {
  return scope.repositoryIds.includes(repositoryId);
}

export function canReadProject(scope: AccessScope, projectId: string): boolean {
  return scope.projectIds.includes(projectId);
}

/** Throws 404 (not 403, to avoid leaking existence) when the repository is not readable. */
export function assertRepositoryAccess(scope: AccessScope, repositoryId: string): void {
  if (!canReadRepository(scope, repositoryId)) throw notFound('Repository not found.');
}

export function assertProjectAccess(scope: AccessScope, projectId: string): void {
  if (!canReadProject(scope, projectId)) throw notFound('Project not found.');
}

export function assertAdmin(user: AuthUser): void {
  if (user.role !== 'admin') throw forbidden('Only admins can do that.');
}

/** Loads a pull request the user may read, or throws 404. */
export async function loadAccessiblePullRequest(
  db: DbOrTx,
  scope: AccessScope,
  pullRequestId: string,
) {
  if (scope.repositoryIds.length === 0) throw notFound('Pull request not found.');
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.id, pullRequestId),
        eq(pullRequests.orgId, scope.orgId),
        inArray(pullRequests.repositoryId, scope.repositoryIds),
      ),
    )
    .limit(1);
  if (!pr) throw notFound('Pull request not found.');
  return pr;
}
