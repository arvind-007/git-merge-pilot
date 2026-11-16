import {
  RELATIONSHIP_CONFIDENCES,
  SEVERITIES,
  compareSeverityDesc,
  severityAtLeast,
  type Recommendation,
  type RiskLevel,
  type Severity,
} from '@gmp/core';
import {
  analyses,
  findings,
  organizations,
  prRelationships,
  projectRepositories,
  projects,
  pullRequests,
  repositories,
} from '@gmp/db';
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { normalizeTimezone } from './quiet-hours.ts';
import type {
  BuildDigestInput,
  DigestData,
  DigestFinding,
  DigestOverlap,
  DigestPr,
  DigestPrRef,
  DigestTotals,
  ProjectDigest,
} from './types.ts';

const HIGH_RISK: ReadonlySet<string> = new Set<RiskLevel>(['high', 'critical']);
const OVERLAP_CONFIDENCES = RELATIONSHIP_CONFIDENCES.filter((c) => c !== 'possible');

interface PrRow {
  id: string;
  repositoryId: string;
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  authorLogin: string | null;
  draft: boolean;
  state: string;
  reviewDecision: string | null;
  requestedReviewers: string[];
  openedAt: Date | null;
  mergedAt: Date | null;
}

function inWindow(d: Date | null, since: Date, until: Date): boolean {
  return d !== null && d.getTime() >= since.getTime() && d.getTime() < until.getTime();
}

function appUrlFor(publicUrl: string | undefined, prId: string): string | undefined {
  if (!publicUrl) return undefined;
  return `${publicUrl.replace(/\/+$/, '')}/pull-requests/${encodeURIComponent(prId)}`;
}

/** Awaiting review: open, not draft, and review still required (or reviewers requested, no decision). */
export function isAwaitingReview(pr: {
  state: string;
  draft: boolean;
  reviewDecision: string | null;
  requestedReviewers: string[];
}): boolean {
  if (pr.state !== 'open' || pr.draft) return false;
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return true;
  return pr.reviewDecision === null && pr.requestedReviewers.length > 0;
}

const HIDDEN_REF: DigestPrRef = Object.freeze({
  id: '',
  repo: 'another repository',
  number: 0,
  title: 'A pull request outside this project',
  url: '',
  hidden: true,
}) as DigestPrRef;

function emptyTotals(): DigestTotals {
  return {
    newPrs: 0,
    mergedPrs: 0,
    highRiskPrs: 0,
    securityFindings: 0,
    overlaps: 0,
    awaitingReview: 0,
  };
}

/**
 * Collects digest data per project for the [since, until) window: new PRs, merged PRs, currently
 * high-risk open PRs (latest completed analysis), new security findings, new confirmed/likely
 * overlaps and PRs awaiting review. Everything is scoped to `orgId`.
 */
export async function buildDigest(input: BuildDigestInput): Promise<DigestData> {
  const { db, orgId, since, until } = input;
  if (!(since instanceof Date) || !(until instanceof Date) || since.getTime() >= until.getTime()) {
    throw new RangeError('buildDigest: `since` must be a Date before `until`');
  }
  const maxItems = Math.max(1, input.maxItemsPerSection ?? 25);
  const minFindingSeverity: Severity = input.minFindingSeverity ?? 'medium';

  const [org] = await db
    .select({ name: organizations.name, timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error('buildDigest: organization not found');

  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      input.projectId
        ? and(eq(projects.orgId, orgId), eq(projects.id, input.projectId))
        : and(eq(projects.orgId, orgId), eq(projects.paused, false)),
    )
    .orderBy(asc(projects.name));

  const base: DigestData = {
    orgId,
    orgName: org.name,
    timezone: normalizeTimezone(org.timezone),
    since,
    until,
    generatedAt: new Date(),
    projects: [],
    totals: emptyTotals(),
  };
  if (projectRows.length === 0) return base;

  const projectIds = projectRows.map((p) => p.id);
  const links = await db
    .select({
      projectId: projectRepositories.projectId,
      repositoryId: projectRepositories.repositoryId,
    })
    .from(projectRepositories)
    .innerJoin(repositories, eq(repositories.id, projectRepositories.repositoryId))
    .where(and(inArray(projectRepositories.projectId, projectIds), eq(repositories.orgId, orgId)));

  const reposByProject = new Map<string, Set<string>>();
  for (const l of links) {
    let set = reposByProject.get(l.projectId);
    if (!set) reposByProject.set(l.projectId, (set = new Set()));
    set.add(l.repositoryId);
  }
  const repoIds = [...new Set(links.map((l) => l.repositoryId))];

  let prs: PrRow[] = [];
  if (repoIds.length > 0) {
    prs = await db
      .select({
        id: pullRequests.id,
        repositoryId: pullRequests.repositoryId,
        repo: repositories.fullName,
        number: pullRequests.number,
        title: pullRequests.title,
        htmlUrl: pullRequests.htmlUrl,
        authorLogin: pullRequests.authorLogin,
        draft: pullRequests.draft,
        state: pullRequests.state,
        reviewDecision: pullRequests.reviewDecision,
        requestedReviewers: pullRequests.requestedReviewers,
        openedAt: pullRequests.openedAt,
        mergedAt: pullRequests.mergedAt,
      })
      .from(pullRequests)
      .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
      .where(
        and(
          eq(pullRequests.orgId, orgId),
          inArray(pullRequests.repositoryId, repoIds),
          or(
            eq(pullRequests.state, 'open'),
            and(gte(pullRequests.openedAt, since), lt(pullRequests.openedAt, until)),
            and(gte(pullRequests.mergedAt, since), lt(pullRequests.mergedAt, until)),
          ),
        ),
      );
  }
  const prIds = prs.map((p) => p.id);

  // Latest completed analysis per PR (risk + recommendation).
  const latest = new Map<
    string,
    { risk: RiskLevel | null; recommendation: Recommendation | null }
  >();
  if (prIds.length > 0) {
    const rows = await db
      .selectDistinctOn([analyses.pullRequestId], {
        pullRequestId: analyses.pullRequestId,
        overallRisk: analyses.overallRisk,
        recommendation: analyses.recommendation,
      })
      .from(analyses)
      .where(
        and(
          eq(analyses.orgId, orgId),
          inArray(analyses.pullRequestId, prIds),
          eq(analyses.status, 'completed'),
        ),
      )
      .orderBy(
        analyses.pullRequestId,
        sql`${analyses.completedAt} desc nulls last`,
        desc(analyses.createdAt),
      );
    for (const r of rows) {
      latest.set(r.pullRequestId, {
        risk: r.overallRisk ?? null,
        recommendation: r.recommendation ?? null,
      });
    }
  }

  const toDigestPr = (p: PrRow): DigestPr => {
    const a = latest.get(p.id);
    const pr: DigestPr = {
      id: p.id,
      repo: p.repo,
      number: p.number,
      title: p.title,
      url: p.htmlUrl,
      author: p.authorLogin,
      draft: p.draft,
      risk: a?.risk ?? null,
      recommendation: a?.recommendation ?? null,
      openedAt: p.openedAt,
      mergedAt: p.mergedAt,
      reviewDecision: p.reviewDecision,
    };
    const appUrl = appUrlFor(input.publicUrl, p.id);
    if (appUrl) pr.appUrl = appUrl;
    return pr;
  };

  // New security findings (first seen in the window), deduped per PR + fingerprint.
  const allowedSeverities = SEVERITIES.filter((s) => severityAtLeast(s, minFindingSeverity));
  const findingRows =
    repoIds.length === 0
      ? []
      : await db
          .select({
            id: findings.id,
            pullRequestId: findings.pullRequestId,
            fingerprint: findings.fingerprint,
            severity: findings.severity,
            title: findings.title,
            verified: findings.verified,
            createdAt: findings.createdAt,
            repositoryId: pullRequests.repositoryId,
            repo: repositories.fullName,
            prNumber: pullRequests.number,
            prTitle: pullRequests.title,
            prUrl: pullRequests.htmlUrl,
          })
          .from(findings)
          .innerJoin(pullRequests, eq(pullRequests.id, findings.pullRequestId))
          .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
          .where(
            and(
              eq(findings.orgId, orgId),
              eq(findings.category, 'security'),
              eq(findings.lifecycle, 'new'),
              inArray(findings.severity, allowedSeverities),
              gte(findings.createdAt, since),
              lt(findings.createdAt, until),
              inArray(pullRequests.repositoryId, repoIds),
            ),
          )
          .orderBy(asc(findings.createdAt));
  const seenFindings = new Set<string>();
  const uniqueFindings = findingRows.filter((f) => {
    const k = `${f.pullRequestId}:${f.fingerprint}`;
    if (seenFindings.has(k)) return false;
    seenFindings.add(k);
    return true;
  });

  // New confirmed/likely overlaps in the window touching any project PR.
  const relRows =
    repoIds.length === 0
      ? []
      : await db
          .select({
            id: prRelationships.id,
            prAId: prRelationships.prAId,
            prBId: prRelationships.prBId,
            type: prRelationships.type,
            confidence: prRelationships.confidence,
            summary: prRelationships.summary,
          })
          .from(prRelationships)
          .where(
            and(
              eq(prRelationships.orgId, orgId),
              eq(prRelationships.active, true),
              inArray(prRelationships.confidence, OVERLAP_CONFIDENCES),
              gte(prRelationships.createdAt, since),
              lt(prRelationships.createdAt, until),
            ),
          )
          .orderBy(asc(prRelationships.createdAt));

  const refIds = [...new Set(relRows.flatMap((r) => [r.prAId, r.prBId]))];
  const refs = new Map<string, DigestPrRef & { repositoryId: string }>();
  if (refIds.length > 0) {
    const rows = await db
      .select({
        id: pullRequests.id,
        repositoryId: pullRequests.repositoryId,
        repo: repositories.fullName,
        number: pullRequests.number,
        title: pullRequests.title,
        url: pullRequests.htmlUrl,
      })
      .from(pullRequests)
      .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
      .where(and(eq(pullRequests.orgId, orgId), inArray(pullRequests.id, refIds)));
    for (const r of rows) {
      const ref: DigestPrRef & { repositoryId: string } = { ...r };
      const appUrl = appUrlFor(input.publicUrl, r.id);
      if (appUrl) ref.appUrl = appUrl;
      refs.set(r.id, ref);
    }
  }

  const strip = ({
    repositoryId: _r,
    ...rest
  }: DigestPrRef & { repositoryId: string }): DigestPrRef => rest;
  const totals = emptyTotals();
  const result: ProjectDigest[] = [];

  for (const project of projectRows) {
    const repoSet = reposByProject.get(project.id) ?? new Set<string>();
    const projectPrs = prs.filter((p) => repoSet.has(p.repositoryId));

    const newPrs = projectPrs
      .filter((p) => inWindow(p.openedAt, since, until))
      .sort((a, b) => (a.openedAt?.getTime() ?? 0) - (b.openedAt?.getTime() ?? 0))
      .map(toDigestPr);
    const mergedPrs = projectPrs
      .filter((p) => p.state === 'merged' && inWindow(p.mergedAt, since, until))
      .sort((a, b) => (a.mergedAt?.getTime() ?? 0) - (b.mergedAt?.getTime() ?? 0))
      .map(toDigestPr);
    const highRiskPrs = projectPrs
      .filter((p) => p.state === 'open' && HIGH_RISK.has(latest.get(p.id)?.risk ?? ''))
      .map(toDigestPr)
      .sort((a, b) =>
        a.risk === b.risk
          ? a.repo.localeCompare(b.repo) || a.number - b.number
          : a.risk === 'critical'
            ? -1
            : 1,
      );
    const awaitingReview = projectPrs
      .filter(isAwaitingReview)
      .sort((a, b) => (a.openedAt?.getTime() ?? 0) - (b.openedAt?.getTime() ?? 0))
      .map(toDigestPr);

    const securityFindings: DigestFinding[] = uniqueFindings
      .filter((f) => repoSet.has(f.repositoryId))
      .map((f) => {
        const df: DigestFinding = {
          id: f.id,
          pullRequestId: f.pullRequestId,
          repo: f.repo,
          prNumber: f.prNumber,
          prTitle: f.prTitle,
          prUrl: f.prUrl,
          severity: f.severity,
          title: f.title,
          verified: f.verified,
          createdAt: f.createdAt,
        };
        const appUrl = appUrlFor(input.publicUrl, f.pullRequestId);
        if (appUrl) df.appUrl = appUrl;
        return df;
      })
      .sort(
        (a, b) =>
          compareSeverityDesc(a.severity, b.severity) || Number(b.verified) - Number(a.verified),
      );

    const overlaps: DigestOverlap[] = [];
    for (const r of relRows) {
      const a = refs.get(r.prAId);
      const b = refs.get(r.prBId);
      if (!a || !b) continue;
      const seeA = repoSet.has(a.repositoryId);
      const seeB = repoSet.has(b.repositoryId);
      if (!seeA && !seeB) continue;
      // Project digests go to project members: a PR in a repository outside the project is
      // mentioned without its reference, title or the summary (which names its files).
      overlaps.push({
        id: r.id,
        type: r.type,
        confidence: r.confidence,
        summary:
          seeA && seeB
            ? r.summary
            : 'Overlaps with a pull request in a repository outside this project; an administrator can see the details.',
        prA: seeA ? strip(a) : HIDDEN_REF,
        prB: seeB ? strip(b) : HIDDEN_REF,
      });
    }
    overlaps.sort((x, y) =>
      x.confidence === y.confidence ? 0 : x.confidence === 'confirmed' ? -1 : 1,
    );

    const counts: DigestTotals = {
      newPrs: newPrs.length,
      mergedPrs: mergedPrs.length,
      highRiskPrs: highRiskPrs.length,
      securityFindings: securityFindings.length,
      overlaps: overlaps.length,
      awaitingReview: awaitingReview.length,
    };
    for (const k of Object.keys(counts) as (keyof DigestTotals)[]) totals[k] += counts[k];

    result.push({
      projectId: project.id,
      projectName: project.name,
      newPrs: newPrs.slice(0, maxItems),
      mergedPrs: mergedPrs.slice(0, maxItems),
      highRiskPrs: highRiskPrs.slice(0, maxItems),
      securityFindings: securityFindings.slice(0, maxItems),
      overlaps: overlaps.slice(0, maxItems),
      awaitingReview: awaitingReview.slice(0, maxItems),
      counts,
    });
  }

  return { ...base, projects: result, totals };
}
