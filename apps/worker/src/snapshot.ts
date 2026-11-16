/** Persisting GitHub PR data (snapshots and webhook payloads) into pull_requests + child tables. */
import {
  prChecks,
  prCommits,
  prFiles,
  prRelationships,
  prReviews,
  pullRequests,
  type DbOrTx,
  type NewPullRequest,
  type PullRequest,
  type Repository,
} from '@gmp/db';
import type { PrSnapshot, WebhookPullRequest } from '@gmp/github';
import { and, eq, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { singletonKeys, type JobQueue } from './queues.ts';
import { chunk, toDate } from './util.ts';

type PrFields = Omit<NewPullRequest, 'id' | 'createdAt' | 'updatedAt'>;

function prConflictSet(fields: PrFields) {
  const { orgId: _org, repositoryId: _repo, number: _num, ...rest } = fields;
  return rest;
}

async function upsertPr(
  db: DbOrTx,
  fields: PrFields,
  guard?: { onlyIfNewer?: Date; onlyIfHeadSha?: string },
): Promise<PullRequest> {
  const conditions: SQL[] = [];
  if (guard?.onlyIfNewer) {
    conditions.push(
      or(isNull(pullRequests.lastEventAt), lte(pullRequests.lastEventAt, guard.onlyIfNewer))!,
    );
  }
  if (guard?.onlyIfHeadSha) conditions.push(eq(pullRequests.headSha, guard.onlyIfHeadSha));
  const [row] = await db
    .insert(pullRequests)
    .values(fields)
    .onConflictDoUpdate({
      target: [pullRequests.repositoryId, pullRequests.number],
      set: prConflictSet(fields),
      ...(conditions.length ? { setWhere: and(...conditions) } : {}),
    })
    .returning();
  if (row) return row;
  // Out-of-order (older) webhook: keep the newer stored state.
  const [existing] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, fields.repositoryId),
        eq(pullRequests.number, fields.number),
      ),
    )
    .limit(1);
  return existing!;
}

/** Upserts the PR row from a webhook payload. Does not move `headSha` backwards in time. */
export async function upsertPullRequestFromWebhook(
  db: DbOrTx,
  repo: Repository,
  pr: WebhookPullRequest,
  occurredAt: Date,
): Promise<PullRequest> {
  const fields: PrFields = {
    orgId: repo.orgId,
    repositoryId: repo.id,
    githubId: pr.githubId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    draft: pr.draft,
    authorLogin: pr.authorLogin,
    assignees: pr.assignees,
    requestedReviewers: pr.requestedReviewers,
    labels: pr.labels,
    baseRef: pr.baseRef,
    headRef: pr.headRef,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    htmlUrl: pr.htmlUrl,
    openedAt: toDate(pr.openedAt),
    closedAt: toDate(pr.closedAt),
    mergedAt: toDate(pr.mergedAt),
    lastEventAt: occurredAt,
    linkedIssues: pr.linkedIssues,
  };
  // Simplified payloads (reviews, review comments) carry no mergeable_state, additions etc.;
  // keep the stored values instead of wiping them (a stored "dirty" is a merge blocker).
  if (pr.mergeableState !== null) fields.mergeableState = pr.mergeableState;
  if (pr.additions !== null) fields.additions = pr.additions;
  if (pr.deletions !== null) fields.deletions = pr.deletions;
  if (pr.changedFiles !== null) fields.changedFiles = pr.changedFiles;
  return upsertPr(db, fields, { onlyIfNewer: occurredAt });
}

/**
 * Writes a full snapshot: PR fields, files for the head sha, commits, reviews and checks. All
 * child writes are upserts, so re-running for the same snapshot is a no-op.
 */
export async function persistSnapshot(
  db: DbOrTx,
  repo: Repository,
  snap: PrSnapshot,
  now: Date,
  options: {
    /**
     * Only write when the stored head is still the snapshot's head. Used for cached
     * snapshots, which may be older than what a later sync already stored.
     */
    onlyIfSameHead?: boolean;
  } = {},
): Promise<PullRequest> {
  const m = snap.pullRequest;
  const pr = await upsertPr(
    db,
    {
      orgId: repo.orgId,
      repositoryId: repo.id,
      githubId: m.githubId,
      number: m.number,
      title: m.title,
      body: m.body,
      state: m.state,
      draft: m.draft,
      authorLogin: m.authorLogin,
      assignees: m.assignees,
      requestedReviewers: m.requestedReviewers,
      labels: m.labels,
      baseRef: m.baseRef,
      headRef: m.headRef,
      headSha: m.headSha,
      baseSha: m.baseSha,
      mergeableState: snap.mergeableState ?? m.mergeableState,
      reviewDecision: snap.reviewDecision,
      additions: m.additions,
      deletions: m.deletions,
      changedFiles: m.changedFiles,
      htmlUrl: m.htmlUrl,
      openedAt: toDate(m.openedAt),
      closedAt: toDate(m.closedAt),
      mergedAt: toDate(m.mergedAt),
      lastEventAt: toDate(m.updatedAt) ?? now,
      linkedIssues: snap.linkedIssues,
    },
    options.onlyIfSameHead ? { onlyIfHeadSha: m.headSha } : undefined,
  );
  // The stored PR moved on (newer head): leave its files/checks alone.
  if (pr.headSha !== m.headSha) return pr;

  for (const part of chunk(snap.files, 500)) {
    await db
      .insert(prFiles)
      .values(
        part.map((f) => ({
          pullRequestId: pr.id,
          headSha: m.headSha,
          path: f.path,
          previousPath: f.previousPath,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        })),
      )
      .onConflictDoUpdate({
        target: [prFiles.pullRequestId, prFiles.headSha, prFiles.path],
        set: {
          previousPath: sql`excluded.previous_path`,
          status: sql`excluded.status`,
          additions: sql`excluded.additions`,
          deletions: sql`excluded.deletions`,
        },
      });
  }
  for (const part of chunk(snap.commits, 500)) {
    await db
      .insert(prCommits)
      .values(
        part.map((c) => ({
          pullRequestId: pr.id,
          sha: c.sha,
          message: c.message,
          authorLogin: c.authorLogin,
          committedAt: toDate(c.committedAt),
        })),
      )
      .onConflictDoUpdate({
        target: [prCommits.pullRequestId, prCommits.sha],
        set: { message: sql`excluded.message`, authorLogin: sql`excluded.author_login` },
      });
  }
  for (const part of chunk(snap.reviews, 500)) {
    await db
      .insert(prReviews)
      .values(
        part.map((r) => ({
          pullRequestId: pr.id,
          githubId: r.githubId,
          reviewerLogin: r.reviewerLogin,
          state: r.state,
          submittedAt: toDate(r.submittedAt),
          body: r.body,
        })),
      )
      .onConflictDoUpdate({
        target: [prReviews.pullRequestId, prReviews.githubId],
        set: {
          state: sql`excluded.state`,
          submittedAt: sql`excluded.submitted_at`,
          body: sql`excluded.body`,
        },
      });
  }
  // A name can appear twice (check run + commit status); keep the last one.
  const checks = [...new Map(snap.checks.map((c) => [c.name, c])).values()];
  for (const part of chunk(checks, 500)) {
    await db
      .insert(prChecks)
      .values(
        part.map((c) => ({
          pullRequestId: pr.id,
          headSha: m.headSha,
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          url: c.url,
          completedAt: toDate(c.completedAt),
        })),
      )
      .onConflictDoUpdate({
        target: [prChecks.pullRequestId, prChecks.headSha, prChecks.name],
        set: {
          status: sql`excluded.status`,
          conclusion: sql`excluded.conclusion`,
          url: sql`excluded.url`,
          completedAt: sql`excluded.completed_at`,
        },
      });
  }
  return pr;
}

/** Upserts one check row (check_run / commit status webhook). */
export async function upsertCheck(
  db: DbOrTx,
  pullRequestId: string,
  check: {
    headSha: string;
    name: string;
    status: string;
    conclusion: string | null;
    url: string | null;
    completedAt: Date | null;
  },
): Promise<void> {
  await db
    .insert(prChecks)
    .values({ pullRequestId, ...check })
    .onConflictDoUpdate({
      target: [prChecks.pullRequestId, prChecks.headSha, prChecks.name],
      set: {
        status: check.status,
        conclusion: check.conclusion,
        url: check.url,
        completedAt: check.completedAt,
      },
    });
}

/** Marks every relationship involving the PR inactive; returns the other PR ids affected. */
export async function deactivateRelationships(
  db: DbOrTx,
  pullRequestId: string,
): Promise<string[]> {
  const rows = await db
    .update(prRelationships)
    .set({ active: false })
    .where(
      and(
        eq(prRelationships.active, true),
        or(eq(prRelationships.prAId, pullRequestId), eq(prRelationships.prBId, pullRequestId)),
      ),
    )
    .returning({ a: prRelationships.prAId, b: prRelationships.prBId });
  return [...new Set(rows.map((r) => (r.a === pullRequestId ? r.b : r.a)))];
}

/** Re-evaluates readiness of PRs whose relationships to a closed/merged PR were deactivated. */
export async function refreshAffectedReadiness(
  ctx: { queue: JobQueue },
  pullRequestIds: readonly string[],
): Promise<void> {
  for (const id of new Set(pullRequestIds)) {
    await ctx.queue.send(
      'pr.readiness',
      { pullRequestId: id },
      { singletonKey: singletonKeys.prReadiness(id) },
    );
  }
}
