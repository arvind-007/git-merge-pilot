/**
 * pr.analyze (design §11): deterministic analysis always; incremental when the previous analysed
 * head is an ancestor of the new head; AI triage decides whether to regenerate the narrative;
 * report; findings lifecycle; relationships; meaningful-change notifications.
 */
import {
  buildDeterministicReport,
  aiAssessmentOf,
  reapplyAiAssessment,
  refreshSummaryReadiness,
  type AiService,
  type GenerateReportResult,
  type PrBrief,
  type ReportInput,
} from '@gmp/ai';
import {
  analyzeChanges,
  computeFootprint,
  dedupeFindings,
  detectBreakingChanges,
  detectRelationships,
  diffFindings,
  runSecurityScan,
  scoreRisk,
  type CheckInput,
  type RelationshipPrInput,
} from '@gmp/analysis';
import { PrReportSchema, type Finding, type PrReport } from '@gmp/core';
import { analyses, pullRequests, type Analysis, type PullRequest } from '@gmp/db';
import { isNotFoundError, type PrFileSnapshot, type PrSnapshot } from '@gmp/github';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { maybeBudgetAlert } from '../analyze/budget.ts';
import {
  buildChangedFiles,
  githubAlertFindings,
  materializeHeadFiles,
  pinEvidenceRefs,
} from '../analyze/inputs.ts';
import { analysisEvents, dispatchEvents } from '../analyze/notify.ts';
import { loadPresentFindings, persistFindings } from '../analyze/persist.ts';
import {
  confirmCandidates,
  loadConsumerIndex,
  loadPeers,
  persistRelationships,
  slimFacts,
  toReportRelationships,
  type PeerInfo,
} from '../analyze/relationships.ts';
import {
  toReportChecks,
  toReportFacts,
  toReportFiles,
  toReportPr,
} from '../analyze/report-input.ts';
import type { WorkerContext } from '../deps.ts';
import { GitHubAccessError } from '../github.ts';
import { singletonKeys } from '../queues.ts';
import {
  effectiveProjectSettings,
  loadRepoState,
  monitorSkipReason,
  repoContext,
  type RepoState,
} from '../repo-state.ts';
import { deactivateRelationships, persistSnapshot, refreshAffectedReadiness } from '../snapshot.ts';
import { countApprovals, errorText, prRef, shortSha, unique } from '../util.ts';
import { skipped, type Handler } from './types.ts';

export const snapshotCacheKey = (pullRequestId: string, headSha: string) =>
  `${pullRequestId}:${headSha}`;

/**
 * Latest completed full/incremental analysis of a PR, optionally excluding one head sha. With
 * `preferHeadSha`, an analysis of that head wins over a later-completed one of another head.
 */
export async function latestCompletedAnalysis(
  ctx: WorkerContext,
  pullRequestId: string,
  excludeHeadSha?: string,
  preferHeadSha?: string,
): Promise<Analysis | null> {
  const [row] = await ctx.db
    .select()
    .from(analyses)
    .where(
      and(
        eq(analyses.pullRequestId, pullRequestId),
        eq(analyses.status, 'completed'),
        inArray(analyses.kind, ['full', 'incremental']),
        excludeHeadSha ? ne(analyses.headSha, excludeHeadSha) : undefined,
      ),
    )
    .orderBy(
      ...(preferHeadSha ? [sql`(${analyses.headSha} = ${preferHeadSha}) desc`] : []),
      desc(analyses.completedAt),
      desc(analyses.createdAt),
    )
    .limit(1);
  return row ?? null;
}

export const handlePrAnalyze: Handler<'pr.analyze'> = async (ctx, data) => {
  const [initial] = await ctx.db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, data.pullRequestId))
    .limit(1);
  if (!initial) return skipped('pr_not_found');
  const state = await loadRepoState(ctx.db, initial.repositoryId);
  if (!state || state.repo.orgId !== initial.orgId) return skipped('repository_not_found');
  const skip = monitorSkipReason(state);
  if (skip) return skipped(skip);
  if (initial.state !== 'open') {
    await refreshAffectedReadiness(ctx, await deactivateRelationships(ctx.db, initial.id));
    return skipped('pr_not_open');
  }
  // A job for a head that is no longer the PR's head is superseded: analysing it would move
  // the PR back to an old commit and spend AI budget on a report nobody should read.
  if (data.headSha && data.headSha !== initial.headSha) {
    return skipped('superseded', { headSha: data.headSha, currentHeadSha: initial.headSha });
  }

  let snap: PrSnapshot | undefined;
  let fromCache = false;
  if (data.headSha) {
    const cached = ctx.snapshots.get<PrSnapshot>(
      snapshotCacheKey(initial.id, data.headSha),
      ctx.limits.snapshotTtlMs,
      ctx.now().getTime(),
    );
    // Only reuse a cached snapshot that still matches the stored head.
    if (cached && cached.pullRequest.headSha === initial.headSha) {
      snap = cached;
      fromCache = true;
    }
  }
  try {
    snap ??= await ctx.github.fetchPullRequestSnapshot(state.repo, initial.number);
  } catch (err) {
    if (err instanceof GitHubAccessError) return skipped('github_access', { error: err.message });
    throw err;
  }
  // A cached snapshot must never move the head (or checks/files) back in time.
  const pr = await persistSnapshot(ctx.db, state.repo, snap, ctx.now(), {
    onlyIfSameHead: fromCache,
  });
  if (pr.state !== 'open') {
    await refreshAffectedReadiness(ctx, await deactivateRelationships(ctx.db, pr.id));
    return skipped('pr_not_open');
  }
  if (pr.headSha !== snap.pullRequest.headSha) {
    return skipped('superseded', { headSha: snap.pullRequest.headSha, currentHeadSha: pr.headSha });
  }
  if (data.headSha && snap.pullRequest.headSha !== data.headSha) {
    // GitHub already has a newer head: hand over to the job for that head.
    await ctx.queue.send(
      'pr.analyze',
      {
        pullRequestId: pr.id,
        headSha: snap.pullRequest.headSha,
        ...(data.force ? { force: true } : {}),
      },
      { singletonKey: singletonKeys.prAnalyze(pr.id, snap.pullRequest.headSha) },
    );
    return skipped('superseded', { headSha: data.headSha, currentHeadSha: pr.headSha });
  }
  const headSha = snap.pullRequest.headSha;

  const [done] = await ctx.db
    .select({ id: analyses.id })
    .from(analyses)
    .where(
      and(
        eq(analyses.pullRequestId, pr.id),
        eq(analyses.headSha, headSha),
        eq(analyses.status, 'completed'),
        inArray(analyses.kind, ['full', 'incremental']),
      ),
    )
    .limit(1);
  if (done && !data.force) return { status: 'unchanged', analysisId: done.id, headSha };

  return runAnalysis(ctx, state, pr, snap);
};

async function runAnalysis(
  ctx: WorkerContext,
  state: RepoState,
  pr: PullRequest,
  snap: PrSnapshot,
) {
  const { db } = ctx;
  const repo = state.repo;
  const orgId = repo.orgId;
  const headSha = snap.pullRequest.headSha;
  const previous = await latestCompletedAnalysis(ctx, pr.id, headSha);
  const limitations: string[] = [...snap.limitations];

  // Incremental when the previous analysed head is an ancestor of the new head.
  let kind: 'full' | 'incremental' = 'full';
  let increment: PrFileSnapshot[] | null = null;
  if (previous) {
    try {
      const cmp = await ctx.github.compareCommits(repo, previous.headSha, headSha);
      if (cmp.status === 'ahead') {
        kind = 'incremental';
        increment = cmp.files;
      }
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    if (kind === 'full') {
      limitations.push(
        `The branch history changed since the analysis of ${shortSha(previous.headSha)} (force-push or rebase); the whole pull request was re-analysed.`,
      );
    }
  }

  // "Before" contents come from the merge base so base-branch changes are not attributed to the PR.
  let baseRef = snap.pullRequest.baseSha;
  try {
    const cmp = await ctx.github.compareCommits(repo, snap.pullRequest.baseSha, headSha);
    if (cmp.mergeBaseSha) baseRef = cmp.mergeBaseSha;
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  const now = ctx.now();
  const [claimed] = await db
    .insert(analyses)
    .values({
      orgId,
      pullRequestId: pr.id,
      headSha,
      baseSha: snap.pullRequest.baseSha,
      previousAnalysisId: previous?.id ?? null,
      kind,
      status: 'running',
      startedAt: now,
    })
    .onConflictDoUpdate({
      target: [analyses.pullRequestId, analyses.headSha, analyses.kind],
      set: {
        status: 'running',
        startedAt: now,
        error: null,
        baseSha: snap.pullRequest.baseSha,
        previousAnalysisId: previous?.id ?? null,
      },
    })
    .returning({ id: analyses.id });
  const analysisId = claimed!.id;

  try {
    // ---- deterministic analysis -------------------------------------------------------
    const changed = await buildChangedFiles(ctx, repo, snap, baseRef);
    limitations.push(...changed.limitations);
    const facts = analyzeChanges({
      repo: repo.fullName,
      files: changed.files,
      profile: state.profile,
    });
    const breaking = detectBreakingChanges(facts);
    const scanTree =
      ctx.scanners.gitleaks === false && ctx.scanners.semgrep === false
        ? null
        : await materializeHeadFiles(changed.files);
    let security;
    try {
      security = await runSecurityScan({
        repo: repo.fullName,
        files: changed.files.map((f) => ({
          path: f.path,
          status: f.status,
          patch: f.patch ?? null,
          content: f.patch ? null : (f.after ?? null),
        })),
        workdir: scanTree?.dir ?? null,
        scanners: ctx.scanners,
      });
    } finally {
      await scanTree?.cleanup();
    }
    const findingsList = dedupeFindings([
      ...breaking,
      ...security,
      ...githubAlertFindings(repo.fullName, snap),
    ]);
    pinEvidenceRefs(findingsList, repo.fullName, { base: baseRef, head: headSha });
    const footprint = computeFootprint(facts);

    // ---- relationships ------------------------------------------------------------------
    const ai = await ctx.aiService(orgId);
    const peers = await loadPeers(db, orgId, pr.id, ctx.limits.maxRelationshipPeers);
    const consumers = await loadConsumerIndex(db, orgId, [
      footprint,
      ...peers.map((p) => p.input.footprint),
    ]);
    const self: RelationshipPrInput = {
      id: pr.id,
      repo: repo.fullName,
      number: pr.number,
      footprint,
      title: pr.title,
      body: pr.body,
      linkedIssues: pr.linkedIssues,
    };
    const refs = new Map<string, string>([[pr.id, prRef(repo.fullName, pr.number)]]);
    const briefs = new Map<string, PrBrief>([
      [
        pr.id,
        {
          id: pr.id,
          ref: prRef(repo.fullName, pr.number),
          title: pr.title,
          body: pr.body,
          files: snap.files.map((f) => f.path),
          repo: repoContext(state),
        },
      ],
    ]);
    for (const p of peers) {
      refs.set(p.input.id, p.ref);
      briefs.set(p.input.id, {
        id: p.input.id,
        ref: p.ref,
        title: p.input.title,
        body: p.input.body ?? null,
        files: p.input.footprint.files.map((f) => f.path),
        repo: { fullName: p.input.repo, aiMode: p.aiMode, excludePaths: p.excludePaths },
      });
    }
    const refOf = (id: string) => refs.get(id) ?? id;
    const peerInfo = new Map<string, PeerInfo>(
      peers.map((p) => [
        p.input.id,
        {
          ref: p.ref,
          repositoryId: p.repositoryId,
          repository: p.input.repo,
          aiMode: p.aiMode,
          excludePaths: p.excludePaths,
        },
      ]),
    );
    const peerOf = (id: string): PeerInfo => peerInfo.get(id) ?? { ref: refOf(id) };
    const relationships = await confirmCandidates(
      detectRelationships(
        self,
        peers.map((p) => p.input),
        consumers,
      ),
      briefs,
      (c) => ai.confirmRelationships(c),
    );

    // ---- risk ---------------------------------------------------------------------------
    const checks: CheckInput[] = snap.checks.map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      url: c.url,
    }));
    const risk = scoreRisk({
      facts,
      findings: findingsList,
      relationships,
      checks,
      reviewDecision: snap.reviewDecision,
      approvedReviews: countApprovals(snap.reviews),
      mergeableState: snap.mergeableState,
      projectSettings: effectiveProjectSettings(state),
      draft: pr.draft,
    });
    pinEvidenceRefs(risk.riskScores, repo.fullName, { base: baseRef, head: headSha });

    // ---- report -------------------------------------------------------------------------
    const previousFindings = previous ? await loadPresentFindings(db, previous.id) : null;
    const reportInput: ReportInput = {
      repo: repoContext(state),
      pr: toReportPr(pr),
      files: toReportFiles(snap.files),
      facts: toReportFacts(facts, footprint),
      findings: findingsList,
      relationships: toReportRelationships(pr.id, relationships, peerOf),
      checks: toReportChecks(snap.checks),
      risk,
      commits: snap.commits.map((c) => ({ sha: c.sha, message: c.message })),
      previous: previous
        ? { headSha: previous.headSha, executiveSummary: previous.report?.executiveSummary ?? null }
        : null,
      limitations: unique([...limitations, ...facts.limitations]),
      pullRequestId: pr.id,
      analysisId,
    };

    let generated: GenerateReportResult | null = null;
    let report: PrReport | null = null;
    let triageReason: string | null = null;
    if (previous?.report) {
      const newCount = previousFindings
        ? diffFindings(previousFindings, findingsList).new.length
        : findingsList.length;
      const triage = await ai.triage({
        repo: repoContext(state),
        pr: { number: pr.number, title: pr.title, body: pr.body },
        changedFiles: (increment ?? snap.files).map((f) => ({
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
        commitMessages: snap.commits.map((c) => c.message),
        previousSummary: previous.report.executiveSummary,
        newFindings: newCount,
        pullRequestId: pr.id,
        analysisId,
      });
      triageReason = triage.reason;
      if (!triage.meaningful && previous.report.generatedBy === 'ai') {
        report = reuseNarrative(reportInput, previous.report, previous.headSha, triage.reason);
      }
    }
    if (!report) {
      generated = await ai.generateReport(reportInput);
      report = generated.report;
    }

    // ---- persist ------------------------------------------------------------------------
    const storedFootprint = { ...footprint, facts: slimFacts(facts) };
    const outcome = await db.transaction(async (tx) => {
      await tx
        .update(analyses)
        .set({
          kind,
          status: 'completed',
          report,
          overallRisk: report.overallRisk,
          recommendation: report.mergeReadiness.recommendation,
          confidence: Math.round(report.confidence.score),
          generatedBy: report.generatedBy,
          footprint: storedFootprint as unknown as Record<string, unknown>,
          aiUsage: generated?.usage ?? null,
          error: null,
          completedAt: ctx.now(),
        })
        .where(eq(analyses.id, analysisId));
      const lifecycle = await persistFindings(tx, {
        orgId,
        analysisId,
        pullRequestId: pr.id,
        current: findingsList,
        previous: previousFindings,
      });
      const rel = await persistRelationships(tx, orgId, pr.id, relationships);
      return { lifecycle, rel };
    });

    await ctx.queue.send(
      'overlap.recompute',
      { pullRequestId: pr.id, affectedPullRequestIds: outcome.rel.affectedPullRequestIds },
      { singletonKey: singletonKeys.overlap(pr.id) },
    );

    const events = analysisEvents(
      {
        state,
        pr,
        report,
        previousRisk: previous?.overallRisk ?? null,
        isFirst: !previous,
        newFindings: outcome.lifecycle.new,
        appearedRelationships: outcome.rel.appeared,
        refOf,
        repositoryOf: (id) => (id === pr.id ? repo.id : (peerInfo.get(id)?.repositoryId ?? null)),
      },
      ctx.publicUrl,
    );
    const notified = await dispatchEvents(ctx, orgId, state, events);
    await maybeBudgetAlert(ctx, orgId, ai);

    return {
      status: 'completed' as const,
      analysisId,
      kind,
      headSha,
      overallRisk: report.overallRisk,
      generatedBy: report.generatedBy,
      findings: {
        new: outcome.lifecycle.new.length,
        unchanged: outcome.lifecycle.unchanged.length,
        resolved: outcome.lifecycle.resolved.length,
      },
      relationships: relationships.length,
      notifications: notified,
      ...(triageReason ? { triage: triageReason } : {}),
    };
  } catch (err) {
    await db
      .update(analyses)
      .set({ status: 'failed', error: errorText(err), completedAt: ctx.now() })
      .where(eq(analyses.id, analysisId))
      .catch((e: unknown) =>
        ctx.logger.error({ err: errorText(e) }, 'failed to mark analysis failed'),
      );
    throw err;
  }
}

const AI_SOURCE = (f: Finding) => f.source === 'ai';

/**
 * Triage judged the new commits not meaningful: refresh every deterministic section, keep the
 * previous AI narrative and AI concerns.
 */
export function reuseNarrative(
  input: ReportInput,
  previous: PrReport,
  previousHeadSha: string,
  reason: string,
): PrReport | null {
  // Re-apply the previous AI assessment (open questions, score adjustments) on the fresh
  // deterministic scores, so readiness never silently relaxes while the narrative is reused.
  const assessment = aiAssessmentOf(previous);
  const risk = reapplyAiAssessment(input.risk, assessment, input.findings);
  const base = buildDeterministicReport({ ...input, risk });
  const candidate: PrReport = {
    ...base,
    executiveSummary: refreshSummaryReadiness(
      previous.executiveSummary,
      risk.overallRisk,
      risk.mergeReadiness,
    ),
    businessImpact: previous.businessImpact,
    technicalSummary: previous.technicalSummary,
    breakingChanges: [...base.breakingChanges, ...previous.breakingChanges.filter(AI_SOURCE)],
    security: [...base.security, ...previous.security.filter(AI_SOURCE)],
    integrationImpact: [...base.integrationImpact, ...previous.integrationImpact.filter(AI_SOURCE)],
    recommendedActions: unique([...previous.recommendedActions, ...base.recommendedActions]),
    generatedBy: 'ai',
    ...(assessment ? { aiAssessment: assessment } : {}),
    limitations: unique([
      ...base.limitations,
      `The written summary is from the analysis of ${shortSha(previousHeadSha)}; newer changes were judged minor (${reason}). Facts, findings and scores are up to date.`,
    ]),
  };
  const parsed = PrReportSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export type { AiService };
