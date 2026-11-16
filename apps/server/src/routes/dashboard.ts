import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Recommendation, RiskLevel } from '@gmp/core';
import { installations, projects, repositories } from '@gmp/db';
import { aiStatusForOrg } from '../ai-status.ts';
import { requireAuth, scopeOf } from '../auth/guard.ts';
import { getOrgApp } from '../github/app-store.ts';
import {
  countBy,
  listOpenFindings,
  listPrItems,
  listRelationships,
  type PrListItem,
} from '../queries/prs.ts';

const HIGH_RISK: RiskLevel[] = ['critical', 'high'];
const ATTENTION_RECOMMENDATIONS: Recommendation[] = [
  'escalate',
  'changes_required',
  'needs_clarification',
];

function needsAttention(p: PrListItem): boolean {
  return (
    (p.overallRisk !== null && HIGH_RISK.includes(p.overallRisk)) ||
    (p.recommendation !== null && ATTENTION_RECOMMENDATIONS.includes(p.recommendation))
  );
}

const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function byRisk(a: PrListItem, b: PrListItem): number {
  return (RISK_ORDER[a.overallRisk ?? ''] ?? 4) - (RISK_ORDER[b.overallRisk ?? ''] ?? 4);
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  app.get('/api/overview', { preHandler: requireAuth }, async (req) => {
    const scope = await scopeOf(req, app);
    const openPrs = await listPrItems(db, scope, { state: 'open', limit: 2000 });
    const recent = await listPrItems(db, scope, { limit: 10 });
    const projectRows = scope.projectIds.length
      ? await db
          .select()
          .from(projects)
          .where(and(eq(projects.orgId, scope.orgId), inArray(projects.id, scope.projectIds)))
          .orderBy(projects.name)
      : [];
    const monitored = scope.repositoryIds.length
      ? await db
          .select({ n: sql<number>`count(*)::int` })
          .from(repositories)
          .where(
            and(
              eq(repositories.orgId, scope.orgId),
              eq(repositories.monitoringEnabled, true),
              inArray(repositories.id, scope.repositoryIds),
            ),
          )
      : [{ n: 0 }];
    const overlaps = await listRelationships(db, scope, {
      openOnly: true,
      confidences: ['confirmed', 'likely'],
      limit: 1000,
    });
    const ghApp = await getOrgApp(db, scope.orgId);
    const instCount = ghApp
      ? await db
          .select({ n: sql<number>`count(*)::int` })
          .from(installations)
          .where(eq(installations.githubAppId, ghApp.id))
      : [{ n: 0 }];
    const attention = openPrs.filter(needsAttention).sort(byRisk).slice(0, 20);
    return {
      stats: {
        openPrs: openPrs.length,
        highRiskPrs: openPrs.filter((p) => p.overallRisk && HIGH_RISK.includes(p.overallRisk))
          .length,
        needsAttention: openPrs.filter(needsAttention).length,
        projects: projectRows.length,
        monitoredRepositories: monitored[0]?.n ?? 0,
        activeOverlaps: overlaps.length,
      },
      riskCounts: countBy(openPrs, (p) => p.overallRisk),
      recommendationCounts: countBy(openPrs, (p) => p.recommendation),
      attention,
      recent,
      projects: projectRows.map((p) => {
        const prs = openPrs.filter((pr) => pr.projectIds.includes(p.id));
        return {
          id: p.id,
          name: p.name,
          description: p.description,
          paused: p.paused,
          settings: p.settings,
          openPrCount: prs.length,
          riskCounts: countBy(prs, (pr) => pr.overallRisk),
        };
      }),
      ai: await aiStatusForOrg(app.ctx, scope.orgId),
      github: { connected: Boolean(ghApp), installations: instCount[0]?.n ?? 0 },
    };
  });

  app.get('/api/risk-center', { preHandler: requireAuth }, async (req) => {
    const scope = await scopeOf(req, app);
    const openPrs = await listPrItems(db, scope, { state: 'open', limit: 2000 });
    const flagged = openPrs.filter(needsAttention).sort(byRisk);
    const findingItems = await listOpenFindings(db, scope, {
      severities: ['critical', 'high'],
      limit: 200,
    });
    const relationships = await listRelationships(db, scope, {
      openOnly: true,
      confidences: ['confirmed', 'likely'],
      limit: 200,
    });
    return { pullRequests: flagged, findings: findingItems, relationships };
  });

  app.get('/api/developers', { preHandler: requireAuth }, async (req) => {
    const scope = await scopeOf(req, app);
    const prs = await listPrItems(db, scope, { limit: 2000 });
    const since = app.ctx.now().getTime() - 30 * 24 * 60 * 60 * 1000;
    const byLogin = new Map<string, PrListItem[]>();
    for (const p of prs) {
      if (!p.authorLogin) continue;
      const list = byLogin.get(p.authorLogin) ?? [];
      list.push(p);
      byLogin.set(p.authorLogin, list);
    }
    const out = [...byLogin.entries()].map(([login, list]) => {
      const open = list.filter((p) => p.state === 'open');
      const last = list
        .map((p) => (p.lastEventAt ?? p.updatedAt).getTime())
        .reduce((a, b) => Math.max(a, b), 0);
      return {
        login,
        openPrs: open.length,
        mergedPrs: list.filter(
          (p) => p.state === 'merged' && p.mergedAt && p.mergedAt.getTime() >= since,
        ).length,
        highRiskPrs: open.filter((p) => p.overallRisk && HIGH_RISK.includes(p.overallRisk)).length,
        findings: open.reduce(
          (n, p) => n + Object.values(p.findingCounts).reduce((a, b) => a + (b ?? 0), 0),
          0,
        ),
        repositories: [...new Set(list.map((p) => p.repositoryFullName))].sort(),
        lastActivityAt: last ? new Date(last) : null,
        recommendationCounts: countBy(open, (p) => p.recommendation),
      };
    });
    return out.sort((a, b) => b.openPrs - a.openPrs || a.login.localeCompare(b.login));
  });
}
