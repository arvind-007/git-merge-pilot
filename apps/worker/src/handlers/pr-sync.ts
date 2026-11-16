/** pr.sync: fetch the PR snapshot, upsert PR + files/commits/reviews/checks, enqueue follow-ups. */
import { analyses, pullRequests } from '@gmp/db';
import { and, eq, inArray } from 'drizzle-orm';
import { GitHubAccessError } from '../github.ts';
import { singletonKeys } from '../queues.ts';
import { loadRepoState, monitorSkipReason } from '../repo-state.ts';
import { deactivateRelationships, persistSnapshot } from '../snapshot.ts';
import { snapshotCacheKey } from './pr-analyze.ts';
import { skipped, type Handler } from './types.ts';

export const handlePrSync: Handler<'pr.sync'> = async (ctx, data) => {
  const { db } = ctx;
  let repositoryId: string;
  let number: number;
  if ('pullRequestId' in data) {
    const [pr] = await db
      .select({ repositoryId: pullRequests.repositoryId, number: pullRequests.number })
      .from(pullRequests)
      .where(eq(pullRequests.id, data.pullRequestId))
      .limit(1);
    if (!pr) return skipped('pr_not_found');
    repositoryId = pr.repositoryId;
    number = pr.number;
  } else {
    repositoryId = data.repositoryId;
    number = data.number;
  }

  const state = await loadRepoState(db, repositoryId);
  if (!state) return skipped('repository_not_found');
  const skip = monitorSkipReason(state);
  if (skip) return skipped(skip);

  let snap;
  try {
    snap = await ctx.github.fetchPullRequestSnapshot(state.repo, number);
  } catch (err) {
    if (err instanceof GitHubAccessError) return skipped('github_access', { error: err.message });
    throw err;
  }
  const pr = await persistSnapshot(db, state.repo, snap, ctx.now());

  if (pr.state !== 'open') {
    const affected = await deactivateRelationships(db, pr.id);
    for (const id of affected) {
      await ctx.queue.send(
        'pr.readiness',
        { pullRequestId: id },
        { singletonKey: singletonKeys.prReadiness(id) },
      );
    }
    return { status: 'completed', pullRequestId: pr.id, state: pr.state, followUp: 'closed' };
  }

  ctx.snapshots.set(snapshotCacheKey(pr.id, pr.headSha), snap, ctx.now().getTime());

  const [analysed] = await db
    .select({ id: analyses.id })
    .from(analyses)
    .where(
      and(
        eq(analyses.pullRequestId, pr.id),
        eq(analyses.headSha, pr.headSha),
        eq(analyses.status, 'completed'),
        inArray(analyses.kind, ['full', 'incremental']),
      ),
    )
    .limit(1);

  if (!analysed || data.force) {
    await ctx.queue.send(
      'pr.analyze',
      { pullRequestId: pr.id, headSha: pr.headSha, ...(data.force ? { force: true } : {}) },
      { singletonKey: singletonKeys.prAnalyze(pr.id, pr.headSha) },
    );
    return { status: 'completed', pullRequestId: pr.id, followUp: 'pr.analyze' };
  }
  await ctx.queue.send(
    'pr.readiness',
    { pullRequestId: pr.id },
    { singletonKey: singletonKeys.prReadiness(pr.id) },
  );
  return { status: 'completed', pullRequestId: pr.id, followUp: 'pr.readiness' };
};
