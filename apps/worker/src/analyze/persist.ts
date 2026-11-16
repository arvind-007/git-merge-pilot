import { diffFindings } from '@gmp/analysis';
import type { Finding, FindingLifecycle } from '@gmp/core';
import { findings, type DbOrTx } from '@gmp/db';
import { and, eq, ne } from 'drizzle-orm';
import { chunk } from '../util.ts';

export interface FindingLifecycleResult {
  new: Finding[];
  unchanged: Finding[];
  resolved: Finding[];
}

/** Findings that were present (not resolved) in an analysis. */
export async function loadPresentFindings(db: DbOrTx, analysisId: string): Promise<Finding[]> {
  const rows = await db
    .select({ data: findings.data })
    .from(findings)
    .where(and(eq(findings.analysisId, analysisId), ne(findings.lifecycle, 'resolved')));
  return rows.map((r) => r.data);
}

/**
 * Replaces the analysis's findings with the current set, tagged new / unchanged against the
 * previous analysis, plus `resolved` rows for previous findings that are gone.
 */
export async function persistFindings(
  db: DbOrTx,
  input: {
    orgId: string;
    analysisId: string;
    pullRequestId: string;
    current: readonly Finding[];
    previous: readonly Finding[] | null;
  },
): Promise<FindingLifecycleResult> {
  const diff = input.previous
    ? diffFindings(input.previous, input.current)
    : diffFindings([], input.current);
  await db.delete(findings).where(eq(findings.analysisId, input.analysisId));
  const rows = (
    [
      ['new', diff.new],
      ['unchanged', diff.unchanged],
      ['resolved', diff.resolved],
    ] as Array<[FindingLifecycle, Finding[]]>
  ).flatMap(([lifecycle, list]) =>
    list.map((f) => ({
      orgId: input.orgId,
      analysisId: input.analysisId,
      pullRequestId: input.pullRequestId,
      fingerprint: f.fingerprint,
      category: f.category,
      severity: f.severity,
      title: f.title.slice(0, 500),
      data: f,
      lifecycle,
      verified: f.verified,
    })),
  );
  for (const part of chunk(rows, 500)) {
    await db.insert(findings).values(part).onConflictDoNothing();
  }
  return diff;
}

/** Copies an analysis's findings (all lifecycles) onto another analysis (readiness recomputes). */
export async function copyFindings(
  db: DbOrTx,
  fromAnalysisId: string,
  toAnalysisId: string,
): Promise<number> {
  const rows = await db.select().from(findings).where(eq(findings.analysisId, fromAnalysisId));
  await db.delete(findings).where(eq(findings.analysisId, toAnalysisId));
  for (const part of chunk(rows, 500)) {
    await db
      .insert(findings)
      .values(
        part.map(({ id: _id, createdAt: _c, updatedAt: _u, ...r }) => ({
          ...r,
          analysisId: toAnalysisId,
        })),
      )
      .onConflictDoNothing();
  }
  return rows.length;
}
