/** Meaningful-change notifications after an analysis (design §10). */
import type { Relationship } from '@gmp/analysis';
import {
  severityAtLeast,
  type Finding,
  type PrReport,
  type RiskLevel,
  type Severity,
} from '@gmp/core';
import { projectRepositories, type PullRequest } from '@gmp/db';
import { inArray } from 'drizzle-orm';
import { dispatch, isMeaningfulChange, type NotificationEvent } from '@gmp/notify';
import type { WorkerContext } from '../deps.ts';
import type { RepoState } from '../repo-state.ts';
import { notifyProjectIds } from '../repo-state.ts';
import { errorText, prAppUrl, prRef, riskSeverity, shortSha } from '../util.ts';

export interface AnalysisNotificationInput {
  state: RepoState;
  pr: PullRequest;
  report: PrReport;
  previousRisk: RiskLevel | null;
  isFirst: boolean;
  newFindings: readonly Finding[];
  appearedRelationships: readonly Relationship[];
  refOf: (pullRequestId: string) => string;
  /** Repository id of another PR (for project-scoped redaction); null when unknown. */
  repositoryOf?: (pullRequestId: string) => string | null;
}

/**
 * A notification event that mentions another PR. Project recipients only see that PR's ref and
 * summary when its repository belongs to the same project; otherwise `redacted` is sent.
 */
export type AnalysisEvent = NotificationEvent & {
  otherRepositoryId?: string | null;
  redacted?: { title: string; body: string };
};

/** Builds the events to send; empty when nothing meaningful changed (and not a first analysis). */
export function analysisEvents(
  input: AnalysisNotificationInput,
  publicUrl: string,
): AnalysisEvent[] {
  const { pr, report, state } = input;
  const ref = prRef(state.repo.fullName, pr.number);
  const url = prAppUrl(publicUrl, pr.id);
  const change = isMeaningfulChange({
    previousRisk: input.previousRisk,
    currentRisk: report.overallRisk,
    newFindings: input.newFindings,
    newRelationships: input.appearedRelationships,
  });
  if (!input.isFirst && !change.meaningful) return [];

  const sha = shortSha(pr.headSha);
  const events: AnalysisEvent[] = [];
  const recommendation = report.mergeReadiness.recommendation.replace(/_/g, ' ');
  events.push({
    kind: input.isFirst ? 'pr_analyzed' : 'pr_updated_meaningfully',
    severity: riskSeverity(report.overallRisk),
    pullRequestId: pr.id,
    title: `${input.isFirst ? 'PR analysed' : 'PR changed'}: ${ref} ${pr.title} — ${report.overallRisk} risk`,
    body: [
      report.executiveSummary,
      `Recommendation: ${recommendation}.`,
      input.isFirst
        ? ''
        : `Why you are notified: ${change.reasons.map((r) => r.replace(/_/g, ' ')).join(', ')}.`,
    ]
      .filter(Boolean)
      .join('\n\n'),
    url,
    dedupKey: `${input.isFirst ? 'pr_analyzed' : 'pr_updated'}:${pr.id}:${pr.headSha}`,
  });

  const riskUp = change.reasons.includes('risk_increased');
  if (
    (input.isFirst || riskUp) &&
    (report.overallRisk === 'high' || report.overallRisk === 'critical')
  ) {
    events.push({
      kind: 'high_risk',
      severity: report.overallRisk,
      pullRequestId: pr.id,
      title: `${report.overallRisk === 'critical' ? 'Critical' : 'High'} risk: ${ref} ${pr.title}`,
      body: [
        report.executiveSummary,
        ...report.mergeReadiness.blockers.slice(0, 5).map((b) => `• ${b}`),
      ].join('\n'),
      url,
      dedupKey: `high_risk:${pr.id}:${report.overallRisk}:${sha}`,
    });
  }

  for (const f of input.newFindings) {
    if (!severityAtLeast(f.severity, 'high')) continue;
    if (f.category !== 'security' && f.category !== 'breaking_change') continue;
    events.push({
      kind: f.category === 'security' ? 'security_finding' : 'breaking_change',
      severity: f.severity,
      pullRequestId: pr.id,
      title: `${f.category === 'security' ? 'Security' : 'Breaking change'}: ${f.title} (${ref})`,
      body: [f.description, f.whatMightBreak ?? '', f.recommendation ?? '']
        .filter(Boolean)
        .join('\n\n'),
      url,
      dedupKey: `finding:${pr.id}:${f.fingerprint}`,
    });
  }

  for (const r of input.appearedRelationships) {
    if (r.confidence !== 'confirmed' && r.confidence !== 'likely') continue;
    const otherId = r.prAId === pr.id ? r.prBId : r.prAId;
    const other = input.refOf(otherId);
    const otherRepositoryId = input.repositoryOf?.(otherId) ?? null;
    const severity: Severity = r.confidence === 'confirmed' ? 'high' : 'medium';
    const kindLabel = `${r.type.replace(/_/g, ' ')}, ${r.confidence}`;
    events.push({
      kind: 'overlap_detected',
      severity,
      pullRequestId: pr.id,
      title: `Overlapping work: ${ref} and ${other} (${kindLabel})`,
      body: r.summary,
      url,
      dedupKey: `overlap:${r.prAId}:${r.prBId}:${r.type}:${r.confidence}`,
      ...(otherRepositoryId !== state.repo.id
        ? {
            otherRepositoryId,
            redacted: {
              title: `Overlapping work: ${ref} and a PR in another repository (${kindLabel})`,
              body: `${ref} overlaps with a pull request in a repository outside this project. An administrator can see the details.`,
            },
          }
        : {}),
    });
  }

  if (report.mergeReadiness.recommendation === 'needs_clarification') {
    events.push({
      kind: 'clarification_needed',
      severity: 'medium',
      pullRequestId: pr.id,
      title: `Clarification needed: ${ref} ${pr.title}`,
      body: report.mergeReadiness.rationale,
      url,
      dedupKey: `clarification:${pr.id}:${sha}`,
    });
  }
  return events;
}

/** Dispatches the events to every active project of the repository. Never throws. */
export async function dispatchEvents(
  ctx: WorkerContext,
  orgId: string,
  state: RepoState | null,
  events: readonly AnalysisEvent[],
): Promise<number> {
  let inserted = 0;
  const projectIds = state ? notifyProjectIds(state) : [null];
  const scoped = events.some((e) => e.redacted);
  const projectRepos = new Map<string, Set<string>>();
  if (scoped) {
    const ids = projectIds.filter((p): p is string => p !== null);
    const rows = ids.length
      ? await ctx.db
          .select({
            projectId: projectRepositories.projectId,
            repositoryId: projectRepositories.repositoryId,
          })
          .from(projectRepositories)
          .where(inArray(projectRepositories.projectId, ids))
      : [];
    for (const r of rows) {
      const set = projectRepos.get(r.projectId) ?? new Set<string>();
      set.add(r.repositoryId);
      projectRepos.set(r.projectId, set);
    }
  }
  for (const event of events) {
    const { otherRepositoryId, redacted, ...base } = event;
    // Org-level events (no project) only reach admins, who may see every repository.
    const visibleIn = (projectId: string | null) =>
      !redacted ||
      projectId === null ||
      (!!otherRepositoryId && !!projectRepos.get(projectId)?.has(otherRepositoryId));
    // Full-detail projects first, so a user in several projects (dedup per user) gets the
    // most detailed version they are allowed to see.
    const ordered = [...projectIds].sort((a, b) => Number(visibleIn(b)) - Number(visibleIn(a)));
    for (const projectId of ordered) {
      const visible = visibleIn(projectId);
      try {
        const res = await dispatch({
          db: ctx.db,
          orgId,
          event: {
            ...base,
            ...(visible ? {} : redacted),
            projectId,
          },
          now: ctx.now(),
        });
        inserted += res.inserted;
      } catch (err) {
        ctx.logger.error({ err: errorText(err), kind: event.kind }, 'notification dispatch failed');
      }
    }
  }
  return inserted;
}
