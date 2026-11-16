/** Scheduled jobs: reconcile.poll, notify.flush, digest.daily, retention.cleanup (design §11). */
import type { DigestInput, DigestItem } from '@gmp/ai';
import type { RiskLevel } from '@gmp/core';
import {
  analyses,
  notificationRules,
  organizations,
  pullRequests,
  repositories,
  sessions,
  webhookDeliveries,
  type NotificationRule,
} from '@gmp/db';
import {
  buildDigest,
  defaultRule,
  digestIsEmpty,
  digestTitle,
  dispatch,
  flushPending,
  isDigestDue,
  localDate,
  normalizeTimezone,
  renderDigest,
  type DigestData,
} from '@gmp/notify';
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { WorkerContext } from '../deps.ts';
import { GitHubAccessError } from '../github.ts';
import { singletonKeys } from '../queues.ts';
import { loadRepoState, monitorSkipReason } from '../repo-state.ts';
import { errorText, toDate } from '../util.ts';
import type { Handler } from './types.ts';

// ---------------------------------------------------------------------------
// reconcile.poll
// ---------------------------------------------------------------------------

export const handleReconcilePoll: Handler<'reconcile.poll'> = async (ctx) => {
  const { db } = ctx;
  const repos = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.monitoringEnabled, true),
        eq(repositories.archived, false),
        isNotNull(repositories.installationId),
      ),
    );
  let enqueued = 0;
  let failed = 0;
  for (const { id } of repos) {
    try {
      enqueued += await reconcileRepository(ctx, id);
    } catch (err) {
      failed += 1;
      ctx.logger.warn({ err: errorText(err), repositoryId: id }, 'reconcile failed for repository');
    }
  }
  return { status: 'completed', repositories: repos.length, enqueued, failed };
};

/**
 * How long a failed or still-running analysis of a head counts as "being handled". After that
 * reconcile re-syncs the PR, which re-enqueues the analysis (at most once per cooldown).
 */
export const ANALYSIS_RETRY_COOLDOWN_MS = 60 * 60_000;

/** Enqueues pr.sync for PRs whose GitHub state differs from ours; returns jobs enqueued. */
export async function reconcileRepository(
  ctx: WorkerContext,
  repositoryId: string,
): Promise<number> {
  const { db } = ctx;
  const state = await loadRepoState(db, repositoryId);
  if (!state || monitorSkipReason(state)) return 0;
  const repo = state.repo;
  let sent = 0;
  if (!repo.lastDiscoveredAt) {
    if (
      await ctx.queue.send(
        'repo.discover',
        { repositoryId: repo.id },
        { singletonKey: singletonKeys.repo(repo.id) },
      )
    )
      sent += 1;
  }

  let open;
  try {
    open = await ctx.github.listOpenPullRequests(repo);
  } catch (err) {
    if (err instanceof GitHubAccessError) return sent;
    throw err;
  }
  const retryCutoff = new Date(ctx.now().getTime() - ANALYSIS_RETRY_COOLDOWN_MS).toISOString();
  const stored = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      headSha: pullRequests.headSha,
      lastEventAt: pullRequests.lastEventAt,
      // Analysed: a completed analysis of the head, or an attempt recent enough to still be
      // running/retrying. A failed (or abandoned running) attempt older than the cooldown is
      // retried, so an outage longer than the job's retries does not leave the PR unanalysed.
      // The outer columns are qualified explicitly: drizzle renders single-table columns
      // unqualified, which would bind to the subquery's own `id` / `head_sha`.
      analysed: sql<boolean>`exists (select 1 from ${analyses} a where a.pull_request_id = "pull_requests"."id" and a.head_sha = "pull_requests"."head_sha" and a.kind in ('full', 'incremental') and (a.status = 'completed' or (a.status in ('running', 'queued') and coalesce(a.started_at, a.created_at) > ${retryCutoff}) or (a.status = 'failed' and coalesce(a.completed_at, a.created_at) > ${retryCutoff})))`,
    })
    .from(pullRequests)
    .where(and(eq(pullRequests.repositoryId, repo.id), eq(pullRequests.state, 'open')));
  const byNumber = new Map(stored.map((s) => [s.number, s]));
  const seen = new Set<number>();

  for (const s of open) {
    seen.add(s.number);
    const row = byNumber.get(s.number);
    const updatedAt = toDate(s.updatedAt);
    const stale =
      !row ||
      row.headSha !== s.headSha ||
      !row.analysed ||
      (updatedAt !== null && (row.lastEventAt === null || row.lastEventAt < updatedAt));
    if (!stale) continue;
    const id = row
      ? await ctx.queue.send(
          'pr.sync',
          { pullRequestId: row.id, reason: 'reconcile' },
          { singletonKey: singletonKeys.prSync(row.id) },
        )
      : await ctx.queue.send(
          'pr.sync',
          { repositoryId: repo.id, number: s.number, reason: 'reconcile' },
          { singletonKey: singletonKeys.prSyncByNumber(repo.id, s.number) },
        );
    if (id) sent += 1;
  }
  // Open in our DB but not on GitHub any more: closed or merged while webhooks were missed.
  for (const row of stored) {
    if (seen.has(row.number)) continue;
    const id = await ctx.queue.send(
      'pr.sync',
      { pullRequestId: row.id, reason: 'reconcile_closed' },
      { singletonKey: singletonKeys.prSync(row.id) },
    );
    if (id) sent += 1;
  }
  await db
    .update(repositories)
    .set({ lastPolledAt: ctx.now() })
    .where(eq(repositories.id, repo.id));
  return sent;
}

// ---------------------------------------------------------------------------
// notify.flush
// ---------------------------------------------------------------------------

export const handleNotifyFlush: Handler<'notify.flush'> = async (ctx) => {
  const orgs = await ctx.db.select({ id: organizations.id }).from(organizations);
  let sent = 0;
  for (const org of orgs) {
    try {
      sent += await flushPending({
        db: ctx.db,
        orgId: org.id,
        now: ctx.now(),
        publicUrl: ctx.publicUrl,
        ...(ctx.notifySenders ? { senders: ctx.notifySenders } : {}),
      });
    } catch (err) {
      ctx.logger.error({ err: errorText(err), orgId: org.id }, 'notification flush failed');
    }
  }
  return { status: 'completed', sent };
};

// ---------------------------------------------------------------------------
// digest.daily
// ---------------------------------------------------------------------------

const DEFAULT_DIGEST_KEY = 'digestLastSentAt';

interface DueDigest {
  ruleId: string | null;
  projectId: string | null;
  timezone: string;
  lastDigestAt: Date | null;
}

export const handleDigestDaily: Handler<'digest.daily'> = async (ctx) => {
  const { db } = ctx;
  const now = ctx.now();
  const orgs = await db.select().from(organizations);
  let sent = 0;
  for (const org of orgs) {
    const orgTz = normalizeTimezone(org.timezone);
    const rules: NotificationRule[] = await db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.orgId, org.id));
    const due: DueDigest[] = [];
    if (rules.length === 0) {
      // Built-in default rule (in-app, 09:00 org time); bookkeeping lives in org settings.
      const rule = defaultRule(orgTz);
      const raw = org.settings?.[DEFAULT_DIGEST_KEY];
      const last = typeof raw === 'string' ? toDate(raw) : null;
      if (isDigestDue(now, { ...rule, lastDigestAt: last })) {
        due.push({ ruleId: null, projectId: null, timezone: orgTz, lastDigestAt: last });
      }
    } else {
      for (const r of rules) {
        const timezone = normalizeTimezone(r.timezone, orgTz);
        if (isDigestDue(now, { ...r, timezone })) {
          due.push({
            ruleId: r.id,
            projectId: r.projectId,
            timezone,
            lastDigestAt: r.lastDigestAt,
          });
        }
      }
    }
    for (const d of due) {
      try {
        if (await sendDigest(ctx, org.id, org.name, d, now)) sent += 1;
      } catch (err) {
        ctx.logger.error({ err: errorText(err), orgId: org.id, ruleId: d.ruleId }, 'digest failed');
      }
    }
  }
  return { status: 'completed', sent };
};

/** Claims the rule for today (compare-and-set on last_digest_at), then builds and dispatches. */
async function sendDigest(
  ctx: WorkerContext,
  orgId: string,
  orgName: string,
  d: DueDigest,
  now: Date,
): Promise<boolean> {
  const { db } = ctx;
  const claimed = await claimDigest(ctx, orgId, d, now);
  if (!claimed) return false;
  try {
    const since = d.lastDigestAt ?? new Date(now.getTime() - 24 * 3600_000);
    const data = await buildDigest({
      db,
      orgId,
      projectId: d.projectId,
      since,
      until: now,
      publicUrl: ctx.publicUrl,
    });
    if (digestIsEmpty(data)) return false;
    const text = renderDigest(data, 'text');
    const narrative = await digestNarrative(ctx, orgId, orgName, data);
    const res = await dispatch({
      db,
      orgId,
      now,
      event: {
        kind: 'digest',
        severity: 'info',
        projectId: d.projectId,
        title: digestTitle(data),
        body: narrative ? `${narrative}\n\n${text}` : text,
        url: ctx.publicUrl,
        dedupKey: `digest:${d.ruleId ?? 'default'}:${localDate(now, d.timezone)}`,
      },
    });
    return res.inserted > 0;
  } catch (err) {
    await releaseDigest(ctx, orgId, d);
    throw err;
  }
}

async function claimDigest(
  ctx: WorkerContext,
  orgId: string,
  d: DueDigest,
  now: Date,
): Promise<boolean> {
  const { db } = ctx;
  if (d.ruleId) {
    const rows = await db
      .update(notificationRules)
      .set({ lastDigestAt: now })
      .where(
        and(
          eq(notificationRules.id, d.ruleId),
          d.lastDigestAt
            ? eq(notificationRules.lastDigestAt, d.lastDigestAt)
            : isNull(notificationRules.lastDigestAt),
        ),
      )
      .returning({ id: notificationRules.id });
    return rows.length > 0;
  }
  const prev = d.lastDigestAt ? d.lastDigestAt.toISOString() : null;
  const rows = await db
    .update(organizations)
    .set({
      settings: sql`jsonb_set(${organizations.settings}, ${`{${DEFAULT_DIGEST_KEY}}`}::text[], to_jsonb(${now.toISOString()}::text))`,
    })
    .where(
      and(
        eq(organizations.id, orgId),
        prev
          ? sql`${organizations.settings} ->> ${DEFAULT_DIGEST_KEY} = ${prev}`
          : sql`${organizations.settings} ->> ${DEFAULT_DIGEST_KEY} is null`,
      ),
    )
    .returning({ id: organizations.id });
  return rows.length > 0;
}

async function releaseDigest(ctx: WorkerContext, orgId: string, d: DueDigest): Promise<void> {
  if (d.ruleId) {
    await ctx.db
      .update(notificationRules)
      .set({ lastDigestAt: d.lastDigestAt })
      .where(eq(notificationRules.id, d.ruleId));
    return;
  }
  await ctx.db
    .update(organizations)
    .set({
      settings: d.lastDigestAt
        ? sql`jsonb_set(${organizations.settings}, ${`{${DEFAULT_DIGEST_KEY}}`}::text[], to_jsonb(${d.lastDigestAt.toISOString()}::text))`
        : sql`${organizations.settings} - ${DEFAULT_DIGEST_KEY}`,
    })
    .where(eq(organizations.id, orgId));
}

/** AI-written digest intro when AI is enabled for digests; null otherwise. */
async function digestNarrative(
  ctx: WorkerContext,
  orgId: string,
  orgName: string,
  data: DigestData,
): Promise<string | null> {
  const ai = await ctx.aiService(orgId);
  if (!ai.isEnabledFor(null, 'digest')) return null;
  const prs = new Map<string, DigestItem & { id: string }>();
  for (const p of data.projects) {
    for (const pr of [...p.highRiskPrs, ...p.newPrs, ...p.mergedPrs, ...p.awaitingReview]) {
      if (prs.has(pr.id)) continue;
      prs.set(pr.id, {
        id: pr.id,
        prRef: `${pr.repo}#${pr.number}`,
        title: pr.title,
        repo: pr.repo,
        url: pr.appUrl ?? pr.url,
        overallRisk: pr.risk as RiskLevel | null,
        recommendation: pr.recommendation,
      });
    }
  }
  if (prs.size === 0) return null;
  const repoNames = [...new Set([...prs.values()].map((p) => p.repo))];
  const modes = await ctx.db
    .select({ fullName: repositories.fullName, aiMode: repositories.aiMode })
    .from(repositories)
    .where(and(eq(repositories.orgId, orgId), inArray(repositories.fullName, repoNames)));
  const modeOf = new Map(modes.map((m) => [m.fullName, m.aiMode]));
  const items = [...prs.values()]
    .map(({ id: _id, ...item }) => ({ ...item, aiMode: modeOf.get(item.repo) ?? 'off' }))
    .slice(0, 60);
  const input: DigestInput = {
    orgName,
    periodLabel: `${data.since.toISOString().slice(0, 16).replace('T', ' ')} – ${data.until
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ')} UTC`,
    projectName: data.projects.length === 1 ? data.projects[0]!.projectName : null,
    items,
    stats: { ...data.totals },
  };
  const text = await ai.writeDigest(input);
  return text.trim() || null;
}

// ---------------------------------------------------------------------------
// retention.cleanup
// ---------------------------------------------------------------------------

export const handleRetentionCleanup: Handler<'retention.cleanup'> = async (ctx) => {
  const { db } = ctx;
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - ctx.limits.webhookPayloadRetentionDays * 86_400_000);
  const payloads = await db
    .update(webhookDeliveries)
    .set({ payload: null })
    .where(and(lt(webhookDeliveries.receivedAt, cutoff), isNotNull(webhookDeliveries.payload)))
    .returning({ id: webhookDeliveries.id });
  const expired = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return {
    status: 'completed',
    webhookPayloadsCleared: payloads.length,
    sessionsDeleted: expired.length,
  };
};
