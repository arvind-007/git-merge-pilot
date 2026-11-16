/**
 * overlap.recompute: after a PR is analysed (or closed), refresh the other open PRs whose
 * relationship with it changed, so their reports' overlap section and readiness stay current.
 */
import { prRelationships, pullRequests } from '@gmp/db';
import { and, eq, inArray, or } from 'drizzle-orm';
import { singletonKeys } from '../queues.ts';
import { deactivateRelationships } from '../snapshot.ts';
import { skipped, type Handler } from './types.ts';

export const handleOverlapRecompute: Handler<'overlap.recompute'> = async (ctx, data) => {
  const { db } = ctx;
  const [pr] = await db
    .select({ id: pullRequests.id, orgId: pullRequests.orgId, state: pullRequests.state })
    .from(pullRequests)
    .where(eq(pullRequests.id, data.pullRequestId))
    .limit(1);
  if (!pr) return skipped('pr_not_found');

  let affected: string[];
  if (pr.state !== 'open') {
    // The webhook handler may already have deactivated the rows and passed their ids along.
    affected = [
      ...(await deactivateRelationships(db, pr.id)),
      ...(data.affectedPullRequestIds ?? []),
    ];
  } else if (data.affectedPullRequestIds) {
    affected = data.affectedPullRequestIds;
  } else {
    const rows = await db
      .select({ a: prRelationships.prAId, b: prRelationships.prBId })
      .from(prRelationships)
      .where(
        and(
          eq(prRelationships.orgId, pr.orgId),
          eq(prRelationships.active, true),
          or(eq(prRelationships.prAId, pr.id), eq(prRelationships.prBId, pr.id)),
        ),
      );
    affected = rows.map((r) => (r.a === pr.id ? r.b : r.a));
  }
  affected = [...new Set(affected)].filter((id) => id !== pr.id);
  if (affected.length === 0) return { status: 'completed', refreshed: 0 };

  const open = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.orgId, pr.orgId),
        eq(pullRequests.state, 'open'),
        inArray(pullRequests.id, affected),
      ),
    );
  for (const o of open) {
    await ctx.queue.send(
      'pr.readiness',
      { pullRequestId: o.id },
      { singletonKey: singletonKeys.prReadiness(o.id) },
    );
  }
  return { status: 'completed', refreshed: open.length };
};
