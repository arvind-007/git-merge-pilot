/**
 * webhook.process: normalize a stored delivery; ignore it when the repository is not monitored or
 * all its projects are paused; upsert the PR, record a pr_event and enqueue follow-ups.
 */
import {
  githubApps,
  installations,
  prEvents,
  prReviews,
  pullRequests,
  repositories,
  webhookDeliveries,
  type Database,
  type PullRequest,
  type Repository,
  type WebhookDelivery,
} from '@gmp/db';
import {
  normalizeWebhook,
  type CheckNormalizedEvent,
  type InstallationNormalizedEvent,
  type InstallationReposNormalizedEvent,
  type NormalizedEvent,
  type PullRequestNormalizedEvent,
  type PushNormalizedEvent,
  type RepositoryNormalizedEvent,
  type ReviewNormalizedEvent,
  type StatusNormalizedEvent,
} from '@gmp/github';
import { dispatch } from '@gmp/notify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { WorkerContext } from '../deps.ts';
import { DISCOVER_DEBOUNCE_SECONDS, singletonKeys } from '../queues.ts';
import { loadRepoState, monitorSkipReason, type RepoState } from '../repo-state.ts';
import {
  deactivateRelationships,
  refreshAffectedReadiness,
  upsertCheck,
  upsertPullRequestFromWebhook,
} from '../snapshot.ts';
import { errorText, toDate } from '../util.ts';
import { isFinalAttempt, type Handler, type HandlerResult } from './types.ts';

const PR_EVENT_TYPES = new Set([
  'pr_opened',
  'pr_updated',
  'pr_synchronized',
  'pr_edited',
  'pr_closed',
  'pr_merged',
  'pr_reopened',
]);

interface EventScope {
  ctx: WorkerContext;
  delivery: WebhookDelivery;
  orgId: string;
  occurredAt: Date;
}

type Outcome = { status: 'processed' | 'ignored'; detail?: string; followUps?: number };

export const handleWebhookProcess: Handler<'webhook.process'> = async (ctx, data, job) => {
  const { db } = ctx;
  const [delivery] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.deliveryId, data.deliveryId))
    .limit(1);
  if (!delivery) return { status: 'skipped', reason: 'delivery_not_found' };
  if (delivery.status === 'processed' || delivery.status === 'ignored') {
    return { status: 'unchanged', reason: `already_${delivery.status}` };
  }
  await db
    .update(webhookDeliveries)
    .set({ attempts: sql`${webhookDeliveries.attempts} + 1` })
    .where(eq(webhookDeliveries.id, delivery.id));

  try {
    const outcome = await processDelivery(ctx, delivery);
    await db
      .update(webhookDeliveries)
      .set({
        status: outcome.status,
        error: outcome.status === 'ignored' ? (outcome.detail ?? null) : null,
        processedAt: ctx.now(),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    const result: HandlerResult = {
      status: outcome.status === 'processed' ? 'completed' : 'ignored',
    };
    if (outcome.detail) result.reason = outcome.detail;
    if (outcome.followUps !== undefined) result.followUps = outcome.followUps;
    return result;
  } catch (err) {
    const message = errorText(err);
    await db
      .update(webhookDeliveries)
      .set({ status: 'failed', error: message })
      .where(eq(webhookDeliveries.id, delivery.id));
    if (isFinalAttempt(job)) await notifyWebhookFailure(ctx, delivery, message);
    throw err;
  }
};

async function notifyWebhookFailure(
  ctx: WorkerContext,
  delivery: WebhookDelivery,
  message: string,
): Promise<void> {
  const orgId = delivery.orgId ?? (await orgForInstallation(ctx.db, delivery.installationId));
  if (!orgId) return;
  try {
    await dispatch({
      db: ctx.db,
      orgId,
      now: ctx.now(),
      event: {
        kind: 'webhook_failure',
        severity: 'high',
        projectId: null,
        title: `Webhook processing failed: ${delivery.event}${delivery.action ? `.${delivery.action}` : ''}${delivery.repositoryFullName ? ` (${delivery.repositoryFullName})` : ''}`,
        body: `GitHub delivery ${delivery.deliveryId} could not be processed after several attempts: ${message}. Missed changes are picked up by the 15-minute reconciliation.`,
        url: `${ctx.publicUrl}/settings/system`,
        dedupKey: `webhook_failure:${delivery.deliveryId}`,
      },
    });
  } catch (err) {
    ctx.logger.error({ err: errorText(err) }, 'webhook failure notification failed');
  }
}

async function orgForInstallation(
  db: Database,
  installationId: number | null,
): Promise<string | null> {
  if (installationId === null) return null;
  const [row] = await db
    .select({ orgId: installations.orgId })
    .from(installations)
    .where(eq(installations.installationId, installationId))
    .limit(1);
  return row?.orgId ?? null;
}

async function resolveOrg(
  db: Database,
  delivery: WebhookDelivery,
  event: NormalizedEvent,
): Promise<string | null> {
  if (delivery.orgId) return delivery.orgId;
  const byInstallation = await orgForInstallation(
    db,
    event.installationId ?? delivery.installationId,
  );
  if (byInstallation) return byInstallation;
  if ('installation' in event && event.installation.appId !== null) {
    const [app] = await db
      .select({ orgId: githubApps.orgId })
      .from(githubApps)
      .where(eq(githubApps.appId, event.installation.appId))
      .limit(1);
    if (app) return app.orgId;
  }
  if (event.repository) {
    const rows = await db
      .select({ orgId: repositories.orgId })
      .from(repositories)
      .where(eq(repositories.githubId, event.repository.githubId))
      .limit(2);
    if (rows.length === 1) return rows[0]!.orgId;
  }
  return null;
}

async function processDelivery(ctx: WorkerContext, delivery: WebhookDelivery): Promise<Outcome> {
  if (!delivery.payload) return { status: 'ignored', detail: 'payload no longer available' };
  const event = normalizeWebhook(delivery.event, delivery.payload, { now: delivery.receivedAt });
  if (!event) return { status: 'ignored', detail: 'event not relevant' };
  const orgId = await resolveOrg(ctx.db, delivery, event);
  if (!orgId) return { status: 'ignored', detail: 'no organization for this installation' };
  if (!delivery.orgId) {
    await ctx.db
      .update(webhookDeliveries)
      .set({ orgId })
      .where(eq(webhookDeliveries.id, delivery.id));
  }
  const scope: EventScope = {
    ctx,
    delivery,
    orgId,
    occurredAt: toDate(event.occurredAt) ?? delivery.receivedAt,
  };

  switch (event.type) {
    case 'installation_changed':
      return onInstallation(scope, event);
    case 'installation_repos_changed':
      return onInstallationRepos(scope, event);
    case 'repository_changed':
      return onRepositoryChanged(scope, event);
    default:
      break;
  }

  if (!event.repository) return { status: 'ignored', detail: 'no repository in payload' };
  const [repo] = await ctx.db
    .select()
    .from(repositories)
    .where(and(eq(repositories.orgId, orgId), eq(repositories.githubId, event.repository.githubId)))
    .limit(1);
  if (!repo) return { status: 'ignored', detail: 'repository not tracked' };
  const state = await loadRepoState(ctx.db, repo.id);
  if (!state) return { status: 'ignored', detail: 'repository not tracked' };
  const skip = monitorSkipReason(state);
  if (skip) return { status: 'ignored', detail: skip.replace(/_/g, ' ') };

  switch (event.type) {
    case 'review_submitted':
      return onReview(scope, state, event);
    case 'review_comment': {
      const pr = await upsertPullRequestFromWebhook(
        ctx.db,
        repo,
        event.pullRequest,
        scope.occurredAt,
      );
      await recordEvent(scope, pr, event.type, {
        commentId: event.comment.githubId,
        path: event.comment.path,
        url: event.comment.htmlUrl,
      });
      return { status: 'processed' };
    }
    case 'issue_comment': {
      const pr = await findPr(ctx.db, repo.id, event.pullRequestNumber);
      if (!pr) return { status: 'ignored', detail: 'pull request not synced yet' };
      await recordEvent(scope, pr, event.type, {
        commentId: event.comment.githubId,
        url: event.comment.htmlUrl,
      });
      return { status: 'processed' };
    }
    case 'check_updated':
      return onCheck(scope, repo, event);
    case 'status_updated':
      return onStatus(scope, repo, event);
    case 'push':
      return onPush(scope, repo, event);
    default:
      if (PR_EVENT_TYPES.has(event.type)) {
        return onPullRequest(scope, repo, event as PullRequestNormalizedEvent);
      }
      return { status: 'ignored', detail: 'event not relevant' };
  }
}

async function findPr(db: Database, repositoryId: string, number: number) {
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.number, number)))
    .limit(1);
  return pr ?? null;
}

/** Inserts the timeline event once per (delivery, PR, type). */
async function recordEvent(
  scope: EventScope,
  pr: PullRequest,
  type: string,
  data: Record<string, unknown>,
  actorLogin?: string | null,
): Promise<void> {
  const { db } = scope.ctx;
  const [existing] = await db
    .select({ id: prEvents.id })
    .from(prEvents)
    .where(
      and(
        eq(prEvents.pullRequestId, pr.id),
        eq(prEvents.deliveryId, scope.delivery.deliveryId),
        eq(prEvents.type, type),
      ),
    )
    .limit(1);
  if (existing) return;
  await db.insert(prEvents).values({
    orgId: scope.orgId,
    pullRequestId: pr.id,
    type,
    actorLogin: actorLogin ?? null,
    data,
    occurredAt: scope.occurredAt,
    deliveryId: scope.delivery.deliveryId,
  });
}

async function onPullRequest(
  scope: EventScope,
  repo: Repository,
  event: PullRequestNormalizedEvent,
): Promise<Outcome> {
  const { ctx } = scope;
  const pr = await upsertPullRequestFromWebhook(ctx.db, repo, event.pullRequest, scope.occurredAt);
  await recordEvent(
    scope,
    pr,
    event.type,
    {
      action: event.action,
      changedFields: event.changedFields,
      beforeSha: event.beforeSha,
      afterSha: event.afterSha,
      headSha: event.pullRequest.headSha,
    },
    event.senderLogin,
  );
  if (event.type === 'pr_closed' || event.type === 'pr_merged') {
    // Pass the PRs that were related to this one on: once deactivated, overlap.recompute
    // can no longer find them, and their readiness/overlap sections must be refreshed.
    const affected = await deactivateRelationships(ctx.db, pr.id);
    await ctx.queue.send(
      'overlap.recompute',
      { pullRequestId: pr.id, affectedPullRequestIds: affected },
      { singletonKey: singletonKeys.overlap(pr.id) },
    );
    await refreshAffectedReadiness(ctx, affected);
    return { status: 'processed', followUps: 1 + affected.length };
  }
  await ctx.queue.send(
    'pr.sync',
    { pullRequestId: pr.id, reason: event.type },
    { singletonKey: singletonKeys.prSync(pr.id) },
  );
  return { status: 'processed', followUps: 1 };
}

async function onReview(
  scope: EventScope,
  state: RepoState,
  event: ReviewNormalizedEvent,
): Promise<Outcome> {
  const { ctx } = scope;
  const pr = await upsertPullRequestFromWebhook(
    ctx.db,
    state.repo,
    event.pullRequest,
    scope.occurredAt,
  );
  const r = event.review;
  await ctx.db
    .insert(prReviews)
    .values({
      pullRequestId: pr.id,
      githubId: r.githubId,
      reviewerLogin: r.reviewerLogin,
      state: r.state,
      submittedAt: toDate(r.submittedAt),
      body: r.body,
    })
    .onConflictDoUpdate({
      target: [prReviews.pullRequestId, prReviews.githubId],
      set: { state: r.state, submittedAt: toDate(r.submittedAt), body: r.body },
    });
  await recordEvent(
    scope,
    pr,
    event.type,
    { action: event.action, reviewId: r.githubId, state: r.state, url: r.htmlUrl },
    r.reviewerLogin ?? event.senderLogin,
  );
  // reviewDecision comes from GraphQL in the snapshot; pr.sync refreshes it, then readiness runs.
  await ctx.queue.send(
    'pr.sync',
    { pullRequestId: pr.id, reason: 'review' },
    { singletonKey: singletonKeys.prSync(pr.id) },
  );
  return { status: 'processed', followUps: 1 };
}

async function openPrsForCheck(
  db: Database,
  repositoryId: string,
  numbers: number[],
  sha: string,
): Promise<PullRequest[]> {
  if (numbers.length > 0) {
    return db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(pullRequests.state, 'open'),
          inArray(pullRequests.number, numbers),
        ),
      );
  }
  return db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.state, 'open'),
        eq(pullRequests.headSha, sha),
      ),
    );
}

async function onCheck(
  scope: EventScope,
  repo: Repository,
  event: CheckNormalizedEvent,
): Promise<Outcome> {
  const { ctx } = scope;
  const c = event.check;
  const prs = await openPrsForCheck(ctx.db, repo.id, event.pullRequestNumbers, c.headSha);
  if (prs.length === 0)
    return { status: 'ignored', detail: 'no open pull request for this commit' };
  for (const pr of prs) {
    if (c.kind === 'check_run') {
      await upsertCheck(ctx.db, pr.id, {
        headSha: c.headSha,
        name: c.name,
        status: c.status ?? 'queued',
        conclusion: c.conclusion,
        url: c.url,
        completedAt: toDate(c.completedAt),
      });
      if (pr.headSha === c.headSha) {
        await ctx.queue.send(
          'pr.readiness',
          { pullRequestId: pr.id },
          { singletonKey: singletonKeys.prReadiness(pr.id) },
        );
      }
    } else {
      // A suite has no single named check; refresh the PR's checks from the API.
      await ctx.queue.send(
        'pr.sync',
        { pullRequestId: pr.id, reason: 'check_suite' },
        { singletonKey: singletonKeys.prSync(pr.id) },
      );
    }
  }
  return { status: 'processed', followUps: prs.length };
}

async function onStatus(
  scope: EventScope,
  repo: Repository,
  event: StatusNormalizedEvent,
): Promise<Outcome> {
  const { ctx } = scope;
  const s = event.status;
  const prs = await openPrsForCheck(ctx.db, repo.id, [], s.sha);
  if (prs.length === 0)
    return { status: 'ignored', detail: 'no open pull request for this commit' };
  const pending = s.state === 'pending';
  for (const pr of prs) {
    await upsertCheck(ctx.db, pr.id, {
      headSha: s.sha,
      name: s.context,
      status: pending ? 'pending' : 'completed',
      conclusion: pending ? null : s.state,
      url: s.targetUrl,
      completedAt: pending ? null : scope.occurredAt,
    });
    await ctx.queue.send(
      'pr.readiness',
      { pullRequestId: pr.id },
      { singletonKey: singletonKeys.prReadiness(pr.id) },
    );
  }
  return { status: 'processed', followUps: prs.length };
}

async function onPush(
  scope: EventScope,
  repo: Repository,
  event: PushNormalizedEvent,
): Promise<Outcome> {
  if (!event.push.isDefaultBranch || event.push.deleted) {
    return { status: 'ignored', detail: 'push to a non-default branch' };
  }
  await scope.ctx.queue.send(
    'repo.discover',
    { repositoryId: repo.id },
    { singletonKey: singletonKeys.repo(repo.id), debounceSeconds: DISCOVER_DEBOUNCE_SECONDS },
  );
  return { status: 'processed', followUps: 1 };
}

async function onInstallation(
  scope: EventScope,
  event: InstallationNormalizedEvent,
): Promise<Outcome> {
  const { db } = scope.ctx;
  const inst = event.installation;
  const where = and(
    eq(installations.orgId, scope.orgId),
    eq(installations.installationId, inst.installationId),
  );
  switch (event.action) {
    case 'deleted':
      await db.delete(installations).where(where);
      return { status: 'processed', detail: 'installation removed' };
    case 'suspend':
      await db
        .update(installations)
        .set({ suspendedAt: toDate(inst.suspendedAt) ?? scope.occurredAt })
        .where(where);
      return { status: 'processed' };
    case 'unsuspend':
      await db.update(installations).set({ suspendedAt: null }).where(where);
      return { status: 'processed' };
    default: {
      if (inst.appId === null) return { status: 'ignored', detail: 'no app id in payload' };
      const [app] = await db
        .select({ id: githubApps.id })
        .from(githubApps)
        .where(and(eq(githubApps.orgId, scope.orgId), eq(githubApps.appId, inst.appId)))
        .limit(1);
      if (!app) return { status: 'ignored', detail: 'GitHub App not connected' };
      const values = {
        accountLogin: inst.accountLogin ?? '',
        accountType: inst.accountType ?? 'User',
        repositorySelection: inst.repositorySelection ?? 'selected',
        permissions: inst.permissions,
        suspendedAt: toDate(inst.suspendedAt),
      };
      await db
        .insert(installations)
        .values({
          orgId: scope.orgId,
          githubAppId: app.id,
          installationId: inst.installationId,
          ...values,
        })
        .onConflictDoUpdate({ target: installations.installationId, set: values });
      return { status: 'processed' };
    }
  }
}

async function onInstallationRepos(
  scope: EventScope,
  event: InstallationReposNormalizedEvent,
): Promise<Outcome> {
  const { db } = scope.ctx;
  const [inst] = await db
    .select()
    .from(installations)
    .where(
      and(
        eq(installations.orgId, scope.orgId),
        eq(installations.installationId, event.installation.installationId),
      ),
    )
    .limit(1);
  if (!inst) return { status: 'ignored', detail: 'installation not connected' };
  if (event.repositorySelection) {
    await db
      .update(installations)
      .set({ repositorySelection: event.repositorySelection })
      .where(eq(installations.id, inst.id));
  }
  const removed = event.repositoriesRemoved.map((r) => r.githubId);
  if (removed.length > 0) {
    // Access was revoked: keep history, but the repository can no longer be fetched.
    await db
      .update(repositories)
      .set({ installationId: null })
      .where(
        and(
          eq(repositories.orgId, scope.orgId),
          eq(repositories.installationId, inst.id),
          inArray(repositories.githubId, removed),
        ),
      );
  }
  const added = event.repositoriesAdded.map((r) => r.githubId);
  let followUps = 0;
  if (added.length > 0) {
    // Re-granted access to repositories already known to git-merge-pilot.
    await db
      .update(repositories)
      .set({ installationId: inst.id })
      .where(and(eq(repositories.orgId, scope.orgId), inArray(repositories.githubId, added)));
    // Repositories new to git-merge-pilot (new repo under "All repositories", or access granted
    // outside the setup flow) are imported and discovered right away. The default branch is a
    // placeholder until repo.discover reads it from GitHub.
    const inserted = await db
      .insert(repositories)
      .values(
        event.repositoriesAdded.map((r) => ({
          orgId: scope.orgId,
          installationId: inst.id,
          githubId: r.githubId,
          owner: r.owner,
          name: r.name,
          fullName: r.fullName,
          private: r.private,
          defaultBranch: 'main',
          monitoringEnabled: true,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: repositories.id });
    for (const r of inserted) {
      await scope.ctx.queue.send(
        'repo.discover',
        { repositoryId: r.id },
        { singletonKey: singletonKeys.repo(r.id) },
      );
      followUps += 1;
    }
  }
  return { status: 'processed', followUps };
}

async function onRepositoryChanged(
  scope: EventScope,
  event: RepositoryNormalizedEvent,
): Promise<Outcome> {
  const { db } = scope.ctx;
  const r = event.repository;
  const where = and(eq(repositories.orgId, scope.orgId), eq(repositories.githubId, r.githubId));
  if (event.action === 'deleted') {
    const rows = await db
      .update(repositories)
      .set({ archived: true, installationId: null })
      .where(where)
      .returning({ id: repositories.id });
    return rows.length
      ? { status: 'processed' }
      : { status: 'ignored', detail: 'repository not tracked' };
  }
  const rows = await db
    .update(repositories)
    .set({
      owner: r.owner,
      name: r.name,
      fullName: r.fullName,
      private: r.private,
      archived: r.archived,
      ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}),
    })
    .where(where)
    .returning({ id: repositories.id });
  if (rows.length === 0) return { status: 'ignored', detail: 'repository not tracked' };
  if ('default_branch' in event.changes) {
    await scope.ctx.queue.send(
      'repo.discover',
      { repositoryId: rows[0]!.id },
      { singletonKey: singletonKeys.repo(rows[0]!.id) },
    );
  }
  return { status: 'processed' };
}
