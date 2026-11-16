/**
 * pr.readiness: recompute risk scores and merge readiness (no AI) from the latest analysis's stored
 * facts plus current checks, review decision, mergeable state and active relationships. Writes a
 * `readiness_only` analysis for the head sha.
 */
import {
  buildDeterministicReport,
  aiAssessmentOf,
  reapplyAiAssessment,
  refreshSummaryReadiness,
  summarizeChecks,
} from '@gmp/ai';
import { scoreRisk } from '@gmp/analysis';
import { PrReportSchema, type PrReport } from '@gmp/core';
import { analyses, prChecks, prReviews, pullRequests } from '@gmp/db';
import { and, eq } from 'drizzle-orm';
import { copyFindings, loadPresentFindings } from '../analyze/persist.ts';
import {
  isFootprint,
  loadActiveRelationships,
  toReportRelationships,
} from '../analyze/relationships.ts';
import { toReportChecks, toReportPr } from '../analyze/report-input.ts';
import { singletonKeys } from '../queues.ts';
import {
  effectiveProjectSettings,
  loadRepoState,
  monitorSkipReason,
  repoContext,
} from '../repo-state.ts';
import { countApprovals, unique } from '../util.ts';
import { latestCompletedAnalysis } from './pr-analyze.ts';
import { skipped, type Handler } from './types.ts';

const READINESS_NOTE =
  'Merge readiness and risk scores were refreshed from automated analysis after new review/check activity.';

export const handlePrReadiness: Handler<'pr.readiness'> = async (ctx, data) => {
  const { db } = ctx;
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, data.pullRequestId))
    .limit(1);
  if (!pr) return skipped('pr_not_found');
  if (pr.state !== 'open') return skipped('pr_not_open');
  const state = await loadRepoState(db, pr.repositoryId);
  if (!state) return skipped('repository_not_found');
  const skip = monitorSkipReason(state);
  if (skip) return skipped(skip);

  const base = await latestCompletedAnalysis(ctx, pr.id, undefined, pr.headSha);
  const footprint = base?.footprint;
  if (
    !base ||
    base.headSha !== pr.headSha ||
    !base.report ||
    !isFootprint(footprint) ||
    !footprint.facts
  ) {
    await ctx.queue.send(
      'pr.analyze',
      { pullRequestId: pr.id, headSha: pr.headSha },
      { singletonKey: singletonKeys.prAnalyze(pr.id, pr.headSha) },
    );
    return skipped(base ? 'head_not_analyzed' : 'no_analysis');
  }

  const checkRows = await db
    .select()
    .from(prChecks)
    .where(and(eq(prChecks.pullRequestId, pr.id), eq(prChecks.headSha, pr.headSha)));
  const reviewRows = await db
    .select({
      reviewerLogin: prReviews.reviewerLogin,
      state: prReviews.state,
      submittedAt: prReviews.submittedAt,
    })
    .from(prReviews)
    .where(eq(prReviews.pullRequestId, pr.id));
  const findingsList = await loadPresentFindings(db, base.id);
  const active = await loadActiveRelationships(db, pr.orgId, pr.id);
  const relationships = active.map((a) => a.relationship);

  const deterministicRisk = scoreRisk({
    facts: footprint.facts,
    findings: findingsList,
    relationships,
    checks: checkRows.map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      url: c.url,
    })),
    reviewDecision: pr.reviewDecision,
    approvedReviews: countApprovals(reviewRows),
    mergeableState: pr.mergeableState,
    projectSettings: effectiveProjectSettings(state),
    draft: pr.draft,
  });
  const previous: PrReport = base.report;
  // Keep what the AI review contributed (open questions, score adjustments): readiness can only
  // be refreshed from new facts, never silently relaxed by dropping the AI assessment.
  const risk = reapplyAiAssessment(deterministicRisk, aiAssessmentOf(previous), findingsList);
  const reportChecks = toReportChecks(checkRows);
  const peers = new Map(
    active.map((a) => [
      a.relationship.prAId === pr.id ? a.relationship.prBId : a.relationship.prAId,
      a.other,
    ]),
  );
  const reportRelationships = toReportRelationships(
    pr.id,
    relationships,
    (id) => peers.get(id) ?? { ref: id },
  );
  // Rebuild only the overlap section (with coordination advice) through the deterministic builder.
  const overlap = buildDeterministicReport({
    repo: repoContext(state),
    pr: toReportPr(pr),
    files: [],
    facts: {},
    findings: [],
    relationships: reportRelationships,
    checks: reportChecks,
    risk,
  });

  const candidate: PrReport = {
    ...previous,
    executiveSummary: refreshSummaryReadiness(
      previous.executiveSummary,
      risk.overallRisk,
      risk.mergeReadiness,
    ),
    overlappingWork: overlap.overlappingWork,
    testing: { ...previous.testing, ciSummary: summarizeChecks(reportChecks) },
    riskScores: risk.riskScores,
    overallRisk: risk.overallRisk,
    mergeReadiness: risk.mergeReadiness,
    limitations: unique([...previous.limitations, READINESS_NOTE]),
  };
  const report = PrReportSchema.parse(candidate);

  const now = ctx.now();
  const analysisId = await db.transaction(async (tx) => {
    const values = {
      status: 'completed' as const,
      report,
      overallRisk: report.overallRisk,
      recommendation: report.mergeReadiness.recommendation,
      confidence: Math.round(report.confidence.score),
      generatedBy: report.generatedBy,
      footprint: base.footprint,
      previousAnalysisId: base.id,
      baseSha: pr.baseSha,
      aiUsage: null,
      error: null,
      startedAt: now,
      completedAt: now,
    };
    const [row] = await tx
      .insert(analyses)
      .values({
        orgId: pr.orgId,
        pullRequestId: pr.id,
        headSha: pr.headSha,
        kind: 'readiness_only',
        ...values,
      })
      .onConflictDoUpdate({
        target: [analyses.pullRequestId, analyses.headSha, analyses.kind],
        set: values,
      })
      .returning({ id: analyses.id });
    await copyFindings(tx, base.id, row!.id);
    return row!.id;
  });

  return {
    status: 'completed',
    analysisId,
    overallRisk: report.overallRisk,
    recommendation: report.mergeReadiness.recommendation,
  };
};
