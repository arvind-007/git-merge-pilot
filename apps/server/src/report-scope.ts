/**
 * Read-time scoping of stored PR reports. Reports are built once per analysis with relationship
 * data from the whole organization; a member must not learn about PRs in repositories outside
 * their projects (design §12), so entries and mentions of such PRs are removed or redacted.
 */
import type { Evidence, PrReport } from '@gmp/core';
import { inArray } from 'drizzle-orm';
import { pullRequests, repositories, type Database } from '@gmp/db';
import type { AccessScope } from './access.ts';

export const HIDDEN_PR_TEXT = 'a related PR in a repository you cannot access';

/** Repository full name of a `owner/repo#12` reference, or null. */
export function repoOfRef(ref: string): string | null {
  const m = /^(.+)#\d+$/.exec(ref.trim());
  return m ? m[1]! : null;
}

export interface ReportVisibility {
  /** Repository full names the reader may see. */
  visibleRepos: ReadonlySet<string>;
  /** PR ids (of related PRs) the reader may see. */
  visiblePullRequestIds: ReadonlySet<string>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes overlapping-work entries about PRs the reader may not see, drops evidence from
 * repositories they may not see, and replaces every textual mention of hidden PR references.
 * Pure: returns a new report (or the same one when nothing is hidden).
 */
export function scopeReport(report: PrReport, v: ReportVisibility): PrReport {
  const hiddenRefs = new Set<string>();
  const overlappingWork = report.overlappingWork.filter((o) => {
    const repo = o.repository ?? repoOfRef(o.prRef);
    const visible = o.pullRequestId
      ? v.visiblePullRequestIds.has(o.pullRequestId)
      : repo !== null && v.visibleRepos.has(repo);
    if (!visible) hiddenRefs.add(o.prRef);
    return visible;
  });
  const evidenceVisible = (e: Evidence) => !e.repo || v.visibleRepos.has(e.repo);
  const hasHiddenEvidence = report.riskScores.some((s) => !s.evidence.every(evidenceVisible));
  if (hiddenRefs.size === 0 && !hasHiddenEvidence) return report;

  const refRe = hiddenRefs.size
    ? new RegExp(
        [...hiddenRefs]
          .sort((a, b) => b.length - a.length)
          .map((r) => `${escapeRegExp(r)}(?!\\d)`)
          .join('|'),
        'g',
      )
    : null;
  const clean = (text: string) => (refRe ? text.replace(refRe, HIDDEN_PR_TEXT) : text);
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return clean(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(value)) out[k] = scrub(val);
      return out;
    }
    return value;
  };
  const scoped: PrReport = {
    ...report,
    overlappingWork,
    riskScores: report.riskScores.map((s) => ({
      ...s,
      evidence: s.evidence.filter(evidenceVisible),
    })),
  };
  return scrub(scoped) as PrReport;
}

/** Loads what the reader may see among the PRs/repositories a set of reports mentions. */
export async function loadReportVisibility(
  db: Database,
  scope: AccessScope,
  reports: ReadonlyArray<PrReport | null | undefined>,
): Promise<ReportVisibility | null> {
  if (scope.isAdmin) return null;
  const prIds = new Set<string>();
  for (const r of reports) {
    for (const o of r?.overlappingWork ?? []) if (o.pullRequestId) prIds.add(o.pullRequestId);
  }
  const allowed = new Set(scope.repositoryIds);
  const repoRows = scope.repositoryIds.length
    ? await db
        .select({ fullName: repositories.fullName })
        .from(repositories)
        .where(inArray(repositories.id, scope.repositoryIds))
    : [];
  const prRows = prIds.size
    ? await db
        .select({ id: pullRequests.id, repositoryId: pullRequests.repositoryId })
        .from(pullRequests)
        .where(inArray(pullRequests.id, [...prIds]))
    : [];
  return {
    visibleRepos: new Set(repoRows.map((r) => r.fullName)),
    visiblePullRequestIds: new Set(
      prRows.filter((p) => allowed.has(p.repositoryId)).map((p) => p.id),
    ),
  };
}
