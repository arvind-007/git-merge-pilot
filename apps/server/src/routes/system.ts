import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { auditLog, installations, repositories, users, webhookDeliveries } from '@gmp/db';
import { describeError } from '@gmp/github';
import { aiStatusForOrg } from '../ai-status.ts';
import { authOf, requireAdmin } from '../auth/guard.ts';
import { badRequest, parseWith } from '../errors.ts';
import { appClient, getOrgApp } from '../github/app-store.ts';
import { LimitSchema } from '../validation.ts';

const AuditQuerySchema = z.object({
  limit: LimitSchema(50, 200),
  before: z.string().max(200).optional(),
  action: z.string().max(100).optional(),
});

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = new Date(iso ?? '');
  if (!id || Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id))
    throw badRequest('Invalid cursor.');
  return { at, id };
}

interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: string | null;
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.ctx;
  const rateCache = new Map<string, { at: number; value: RateLimitInfo | null }>();

  async function githubRateLimit(orgId: string): Promise<RateLimitInfo | null> {
    const cached = rateCache.get(orgId);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    let value: RateLimitInfo | null = null;
    try {
      const ghApp = await getOrgApp(db, orgId);
      if (ghApp) {
        const [inst] = await db
          .select({ installationId: installations.installationId })
          .from(installations)
          .where(
            and(eq(installations.githubAppId, ghApp.id), sql`${installations.suspendedAt} is null`),
          )
          .limit(1);
        if (inst) {
          const octokit = appClient(app.ctx, ghApp).installationOctokit(inst.installationId);
          const res = await octokit.rest.rateLimit.get();
          const core = res.data.resources.core;
          value = {
            limit: core.limit,
            remaining: core.remaining,
            resetAt: new Date(core.reset * 1000).toISOString(),
          };
        }
      }
    } catch (err) {
      app.ctx.logger.debug({ err: describeError(err) }, 'GitHub rate limit lookup failed');
      value = null;
    }
    rateCache.set(orgId, { at: Date.now(), value });
    return value;
  }

  app.get('/api/system/status', { preHandler: requireAdmin }, async (req) => {
    const { user } = authOf(req);
    let dbOk = true;
    try {
      await db.execute(sql`select 1`);
    } catch {
      dbOk = false;
    }
    const [queues, failedJobs] = await Promise.all([
      app.ctx.queue.stats().catch(() => []),
      app.ctx.queue.failedJobs(20).catch(() => []),
    ]);
    const orgDeliveries = or(
      eq(webhookDeliveries.orgId, user.orgId),
      sql`${webhookDeliveries.orgId} is null`,
    );
    const [backlog] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .where(and(orgDeliveries, inArray(webhookDeliveries.status, ['received', 'queued'])));
    const since = new Date(app.ctx.now().getTime() - 24 * 60 * 60 * 1000);
    const [failed24h] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .where(
        and(
          orgDeliveries,
          eq(webhookDeliveries.status, 'failed'),
          gte(webhookDeliveries.receivedAt, since),
        ),
      );
    const [last] = await db
      .select({
        receivedAt: webhookDeliveries.receivedAt,
        status: webhookDeliveries.status,
        event: webhookDeliveries.event,
      })
      .from(webhookDeliveries)
      .where(orgDeliveries)
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(1);
    const recentFailures = await db
      .select({
        deliveryId: webhookDeliveries.deliveryId,
        event: webhookDeliveries.event,
        error: webhookDeliveries.error,
        receivedAt: webhookDeliveries.receivedAt,
      })
      .from(webhookDeliveries)
      .where(and(orgDeliveries, eq(webhookDeliveries.status, 'failed')))
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(10);
    const [poll] = await db
      .select({ at: sql<Date | null>`max(${repositories.lastPolledAt})` })
      .from(repositories)
      .where(eq(repositories.orgId, user.orgId));
    const ai = await aiStatusForOrg(app.ctx, user.orgId);
    return {
      version: app.ctx.version,
      database: { ok: dbOk },
      queues,
      failedJobs,
      webhooks: {
        backlog: backlog?.n ?? 0,
        failed24h: failed24h?.n ?? 0,
        lastDeliveryAt: last?.receivedAt ?? null,
        lastDeliveryStatus: last?.status ?? null,
        lastDeliveryEvent: last?.event ?? null,
        recentFailures,
      },
      rateLimit: await githubRateLimit(user.orgId),
      ai: {
        enabled: ai.enabled,
        spentUsd: ai.spentUsd,
        capUsd: ai.capUsd,
        pct: ai.pct,
        exhausted: ai.budgetExhausted,
        alert: ai.alert,
        reason: ai.reason,
      },
      // The smee channel URL lets anyone read deliveries, so only report whether it is used.
      smeeEnabled: Boolean(config.smeeUrl),
      smeeUrl: config.smeeUrl ? `${new URL(config.smeeUrl).origin}/…` : null,
      publicUrl: config.publicUrl,
      lastPollAt: poll?.at ?? null,
    };
  });

  app.get('/api/audit-log', { preHandler: requireAdmin }, async (req) => {
    const q = parseWith(AuditQuerySchema, req.query);
    const { user } = authOf(req);
    const conds: SQL[] = [eq(auditLog.orgId, user.orgId)];
    if (q.before) {
      const c = decodeCursor(q.before);
      conds.push(
        sql`(date_trunc('milliseconds', ${auditLog.occurredAt}), ${auditLog.id}) < (${c.at.toISOString()}::timestamptz, ${c.id}::uuid)`,
      );
    }
    if (q.action) conds.push(eq(auditLog.action, q.action));
    const rows = await db
      .select({
        id: auditLog.id,
        userId: auditLog.userId,
        userName: users.name,
        userEmail: users.email,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        ip: auditLog.ip,
        data: auditLog.data,
        occurredAt: auditLog.occurredAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.userId))
      .where(and(...conds))
      .orderBy(desc(sql`date_trunc('milliseconds', ${auditLog.occurredAt})`), desc(auditLog.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const entries = rows.slice(0, q.limit);
    const lastEntry = entries[entries.length - 1];
    return {
      entries,
      nextCursor: hasMore && lastEntry ? encodeCursor(lastEntry.occurredAt, lastEntry.id) : null,
    };
  });
}
