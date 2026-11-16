import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PR_STATES, RISK_LEVELS } from '@gmp/core';
import {
  analyses,
  findings,
  prChecks,
  prFiles,
  prReviews,
  repositories,
  type Analysis,
} from '@gmp/db';
import { assertProjectAccess, loadAccessiblePullRequest } from '../access.ts';
import { auditFromRequest } from '../audit.ts';
import { authOf, requireAdmin, requireAuth, scopeOf } from '../auth/guard.ts';
import { conflict, parseWith } from '../errors.ts';
import { aiStatusForOrg } from '../ai-status.ts';
import { listPrItems, listRelationships } from '../queries/prs.ts';
import { QUEUES, type PrAnalyzeJob } from '../queue.ts';
import { loadReportVisibility, scopeReport, type ReportVisibility } from '../report-scope.ts';
import { IdParamsSchema, LimitSchema } from '../validation.ts';

const ListQuerySchema = z.object({
  projectId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  repositoryId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  state: z
    .enum(PR_STATES)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  risk: z
    .enum(RISK_LEVELS)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  author: z.string().trim().max(100).optional(),
  limit: LimitSchema(100, 500),
  offset: z.coerce.number().int().min(0).max(100_000).optional().default(0),
});

const HistoryQuerySchema = z.object({
  includeReport: z.enum(['true', 'false', '1', '0']).optional(),
  limit: LimitSchema(50, 200),
});

export function serializeAnalysis(
  a: Analysis,
  includeReport = true,
  visibility: ReportVisibility | null = null,
) {
  const report =
    includeReport && a.report && visibility ? scopeReport(a.report, visibility) : a.report;
  return {
    id: a.id,
    pullRequestId: a.pullRequestId,
    headSha: a.headSha,
    baseSha: a.baseSha,
    previousAnalysisId: a.previousAnalysisId,
    kind: a.kind,
    status: a.status,
    ...(includeReport ? { report } : {}),
    overallRisk: a.overallRisk,
    recommendation: a.recommendation,
    confidence: a.confidence,
    generatedBy: a.generatedBy,
    aiUsage: a.aiUsage,
    error: a.error,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    createdAt: a.createdAt,
  };
}

export async function pullRequestRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  app.get('/api/pull-requests', { preHandler: requireAuth }, async (req) => {
    const q = parseWith(ListQuerySchema, req.query);
    const scope = await scopeOf(req, app);
    if (q.projectId) assertProjectAccess(scope, q.projectId);
    return listPrItems(db, scope, {
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.repositoryId ? { repositoryId: q.repositoryId } : {}),
      ...(q.state ? { state: q.state } : {}),
      ...(q.risk ? { risk: q.risk } : {}),
      ...(q.author ? { author: q.author } : {}),
      limit: q.limit,
      offset: q.offset,
    });
  });

  app.get('/api/pull-requests/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const scope = await scopeOf(req, app);
    const pr = await loadAccessiblePullRequest(db, scope, id);
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, pr.repositoryId));

    const recent = await db
      .select()
      .from(analyses)
      .where(eq(analyses.pullRequestId, pr.id))
      .orderBy(desc(analyses.createdAt))
      .limit(50);
    // The report for the PR's current head wins over a newer-completed report of an older head.
    const completed = recent
      .filter((a) => a.status === 'completed')
      .sort(
        (a, b) =>
          Number(b.headSha === pr.headSha) - Number(a.headSha === pr.headSha) ||
          (b.completedAt?.getTime() ?? b.createdAt.getTime()) -
            (a.completedAt?.getTime() ?? a.createdAt.getTime()),
      );
    const analysis = completed[0] ?? recent[0] ?? null;
    // The most recently started run (a forced re-run reuses its row, so createdAt alone is not enough).
    const runTime = (a: Analysis) => Math.max(a.startedAt?.getTime() ?? 0, a.createdAt.getTime());
    const latestRun = [...recent].sort((a, b) => runTime(b) - runTime(a))[0] ?? null;
    const findingsAnalysis = completed.find((a) => a.kind !== 'readiness_only') ?? null;
    const findingRows = findingsAnalysis
      ? await db
          .select()
          .from(findings)
          .where(eq(findings.analysisId, findingsAnalysis.id))
          .orderBy(
            sql`CASE ${findings.severity} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
            desc(findings.verified),
          )
      : [];

    const visibility = await loadReportVisibility(db, scope, [analysis?.report]);
    const rels = await listRelationships(db, scope, { pullRequestIds: [pr.id], limit: 200 });
    const relationships = rels.map((r) => {
      const other = r.prA.id === pr.id ? r.prB : r.prA;
      return {
        id: r.id,
        type: r.type,
        confidence: r.confidence,
        summary: r.summary,
        evidence: r.evidence,
        active: r.active,
        otherPr: other,
      };
    });

    const [checks, reviews, files] = await Promise.all([
      db
        .select()
        .from(prChecks)
        .where(and(eq(prChecks.pullRequestId, pr.id), eq(prChecks.headSha, pr.headSha)))
        .orderBy(prChecks.name),
      db
        .select()
        .from(prReviews)
        .where(eq(prReviews.pullRequestId, pr.id))
        .orderBy(desc(prReviews.submittedAt)),
      db
        .select()
        .from(prFiles)
        .where(and(eq(prFiles.pullRequestId, pr.id), eq(prFiles.headSha, pr.headSha)))
        .orderBy(prFiles.path)
        .limit(3000),
    ]);

    return {
      pullRequest: pr,
      repository: {
        id: repo!.id,
        fullName: repo!.fullName,
        owner: repo!.owner,
        name: repo!.name,
        aiMode: repo!.aiMode,
        defaultBranch: repo!.defaultBranch,
        monitoringEnabled: repo!.monitoringEnabled,
        private: repo!.private,
      },
      analysis: analysis ? serializeAnalysis(analysis, true, visibility) : null,
      latestRun:
        latestRun && latestRun.id !== analysis?.id ? serializeAnalysis(latestRun, false) : null,
      findings: findingRows.map((f) => ({
        id: f.id,
        analysisId: f.analysisId,
        fingerprint: f.fingerprint,
        category: f.category,
        severity: f.severity,
        title: f.title,
        data: f.data,
        lifecycle: f.lifecycle,
        verified: f.verified,
      })),
      relationships,
      checks: checks.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        url: c.url,
        completedAt: c.completedAt,
      })),
      reviews: reviews.map((r) => ({
        id: r.id,
        reviewerLogin: r.reviewerLogin ?? 'unknown',
        state: r.state,
        submittedAt: r.submittedAt,
      })),
      files: files.map((f) => ({
        path: f.path,
        previousPath: f.previousPath,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
      ai: await aiStatusForOrg(app.ctx, scope.orgId, repo!.aiMode),
    };
  });

  app.get('/api/pull-requests/:id/analyses', { preHandler: requireAuth }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const q = parseWith(HistoryQuerySchema, req.query);
    const includeReport = q.includeReport === 'true' || q.includeReport === '1';
    const scope = await scopeOf(req, app);
    const pr = await loadAccessiblePullRequest(db, scope, id);
    const list = await db
      .select()
      .from(analyses)
      .where(eq(analyses.pullRequestId, pr.id))
      .orderBy(desc(analyses.createdAt))
      .limit(q.limit);
    const ids = list.map((a) => a.id);
    const visibility = includeReport
      ? await loadReportVisibility(
          db,
          scope,
          list.map((a) => a.report),
        )
      : null;
    const fRows = ids.length
      ? await db
          .select({
            analysisId: findings.analysisId,
            fingerprint: findings.fingerprint,
            title: findings.title,
            severity: findings.severity,
            category: findings.category,
            lifecycle: findings.lifecycle,
            verified: findings.verified,
          })
          .from(findings)
          .where(inArray(findings.analysisId, ids))
      : [];
    return list.map((a) => {
      const fs = fRows.filter((f) => f.analysisId === a.id);
      const findingCounts: Record<string, number> = {};
      for (const f of fs) findingCounts[f.lifecycle] = (findingCounts[f.lifecycle] ?? 0) + 1;
      return {
        ...serializeAnalysis(a, includeReport, visibility),
        findings: fs.map(({ analysisId: _a, ...rest }) => rest),
        findingCounts,
      };
    });
  });

  app.post('/api/pull-requests/:id/reanalyze', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const scope = await scopeOf(req, app);
    const pr = await loadAccessiblePullRequest(db, scope, id);
    if (pr.state !== 'open') {
      throw conflict(
        `This pull request is ${pr.state}. Only open pull requests can be re-analyzed.`,
        'pull_request_not_open',
      );
    }
    const { user } = authOf(req);
    const job: PrAnalyzeJob = {
      orgId: user.orgId,
      pullRequestId: pr.id,
      headSha: pr.headSha,
      force: true,
      reason: 'manual',
      requestedBy: user.id,
    };
    const jobId = await app.ctx.queue.send(QUEUES.prAnalyze, job, {
      // Same key as the regular analysis job of this head, so the two never run concurrently.
      singletonKey: `pr:${pr.id}:${pr.headSha}`,
    });
    await auditFromRequest(
      db,
      req,
      'pull_request.reanalyze',
      { type: 'pull_request', id: pr.id },
      {
        number: pr.number,
        headSha: pr.headSha,
      },
    );
    return reply.status(202).send({ queued: true, jobId });
  });
}
