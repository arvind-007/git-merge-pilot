import type { RepoContext, RepoProfileSummary } from '@gmp/ai';
import {
  projectRepositories,
  projects,
  repositories,
  repositoryProfiles,
  type DbOrTx,
  type Project,
  type ProjectSettings,
  type Repository,
  type RepositoryProfileData,
} from '@gmp/db';
import { eq } from 'drizzle-orm';

export interface RepoState {
  repo: Repository;
  profile: RepositoryProfileData | null;
  projects: Project[];
  activeProjects: Project[];
}

export type MonitorSkipReason = 'monitoring_disabled' | 'projects_paused' | 'archived';

export async function loadRepoState(db: DbOrTx, repositoryId: string): Promise<RepoState | null> {
  const [repo] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!repo) return null;
  const [profileRow] = await db
    .select()
    .from(repositoryProfiles)
    .where(eq(repositoryProfiles.repositoryId, repositoryId))
    .limit(1);
  const projectRows = await db
    .select({ project: projects })
    .from(projectRepositories)
    .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
    .where(eq(projectRepositories.repositoryId, repositoryId));
  const all = projectRows.map((r) => r.project).filter((p) => p.orgId === repo.orgId);
  const profile = profileRow ? mergeProfile(profileRow.discovered, profileRow.overrides) : null;
  return { repo, profile, projects: all, activeProjects: all.filter((p) => !p.paused) };
}

/** Overrides win over discovered values, key by key. */
export function mergeProfile(
  discovered: RepositoryProfileData | null | undefined,
  overrides: RepositoryProfileData | null | undefined,
): RepositoryProfileData {
  const out: RepositoryProfileData = { ...(discovered ?? {}) };
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * Why a repository's PRs should not be processed: monitoring switched off, archived, or every
 * project it belongs to is paused. A repository in no project is still monitored.
 */
export function monitorSkipReason(state: RepoState): MonitorSkipReason | null {
  if (!state.repo.monitoringEnabled) return 'monitoring_disabled';
  if (state.repo.archived) return 'archived';
  if (state.projects.length > 0 && state.activeProjects.length === 0) return 'projects_paused';
  return null;
}

/** Strictest (lowest) risk thresholds across the repository's active projects. */
export function effectiveProjectSettings(state: RepoState): ProjectSettings | null {
  const list = state.activeProjects.length > 0 ? state.activeProjects : state.projects;
  if (list.length === 0) return null;
  const thresholds: Partial<Record<'critical' | 'high' | 'medium', number>> = {};
  for (const p of list) {
    for (const key of ['critical', 'high', 'medium'] as const) {
      const v = p.settings?.riskThresholds?.[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        thresholds[key] = thresholds[key] === undefined ? v : Math.min(thresholds[key]!, v);
      }
    }
  }
  return Object.keys(thresholds).length > 0 ? { riskThresholds: thresholds } : {};
}

export function repoContext(state: RepoState): RepoContext {
  const profile = state.profile;
  return {
    fullName: state.repo.fullName,
    aiMode: state.repo.aiMode,
    excludePaths: state.repo.excludePaths,
    profile: profile ? (profile as RepoProfileSummary) : null,
  };
}

/** Projects to notify for a repository (active ones; none → org-level). */
export function notifyProjectIds(state: RepoState): Array<string | null> {
  return state.activeProjects.length > 0 ? state.activeProjects.map((p) => p.id) : [null];
}
