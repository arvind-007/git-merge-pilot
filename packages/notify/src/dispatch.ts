import {
  NOTIFICATION_KINDS,
  SEVERITIES,
  redactSecrets,
  severityAtLeast,
  type ChannelKind,
  type Severity,
} from '@gmp/core';
import {
  notificationChannels,
  notificationRules,
  notifications,
  organizations,
  projectMembers,
  projects,
  pullRequests,
  users,
  type NewNotification,
  type NotificationRule,
} from '@gmp/db';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { truncate } from './escape.ts';
import { normalizeTimezone, quietHoursEnd } from './quiet-hours.ts';
import type {
  DispatchInput,
  DispatchResult,
  NotifyDb,
  ResolvedRule,
  NotificationEvent,
} from './types.ts';

export const MAX_TITLE_LENGTH = 300;
export const MAX_BODY_LENGTH = 10_000;

/** Built-in rule used when the org has no notification rules at all: in-app only, high+. */
export function defaultRule(timezone: string): ResolvedRule {
  return {
    id: null,
    projectId: null,
    minSeverity: 'high',
    events: [],
    channelIds: [],
    digestEnabled: true,
    digestHour: 9,
    timezone,
    quietStart: null,
    quietEnd: null,
  };
}

function toResolved(rule: NotificationRule, orgTimezone: string): ResolvedRule {
  return {
    id: rule.id,
    projectId: rule.projectId,
    minSeverity: rule.minSeverity,
    events: rule.events,
    channelIds: rule.channelIds,
    digestEnabled: rule.digestEnabled,
    digestHour: rule.digestHour,
    timezone: normalizeTimezone(rule.timezone, orgTimezone),
    quietStart: rule.quietStart,
    quietEnd: rule.quietEnd,
  };
}

/**
 * Picks the rule for an event: the project's own rule when one exists, else the org default
 * (project_id null). When several rules match at the same level, the most recently updated wins.
 */
export async function resolveRule(
  db: NotifyDb,
  orgId: string,
  projectId: string | null | undefined,
  orgTimezone = 'UTC',
): Promise<ResolvedRule | null> {
  const rows = await db
    .select()
    .from(notificationRules)
    .where(
      and(
        eq(notificationRules.orgId, orgId),
        projectId
          ? or(eq(notificationRules.projectId, projectId), isNull(notificationRules.projectId))
          : isNull(notificationRules.projectId),
      ),
    )
    .orderBy(desc(notificationRules.updatedAt), desc(notificationRules.createdAt));
  const projectRule = projectId ? rows.find((r) => r.projectId === projectId) : undefined;
  const orgRule = rows.find((r) => r.projectId === null);
  const picked = projectRule ?? orgRule;
  return picked ? toResolved(picked, orgTimezone) : null;
}

/** Why a rule rejects an event, or null when it accepts it. */
export function ruleRejects(
  rule: ResolvedRule,
  event: Pick<NotificationEvent, 'kind' | 'severity'>,
): 'below_min_severity' | 'event_not_subscribed' | 'digest_disabled' | null {
  if (event.kind === 'digest') return rule.digestEnabled ? null : 'digest_disabled';
  if (rule.events.length > 0 && !rule.events.includes(event.kind)) return 'event_not_subscribed';
  if (!severityAtLeast(event.severity, rule.minSeverity)) return 'below_min_severity';
  return null;
}

/**
 * Users with access to a project: enabled admins plus enabled project members. For org-level
 * events (no project) only admins are recipients.
 */
export async function projectRecipients(
  db: NotifyDb,
  orgId: string,
  projectId: string | null | undefined,
): Promise<Array<{ id: string; email: string; name: string }>> {
  const accessCond = projectId
    ? or(
        eq(users.role, 'admin'),
        inArray(
          users.id,
          db
            .select({ id: projectMembers.userId })
            .from(projectMembers)
            .where(eq(projectMembers.projectId, projectId)),
        ),
      )
    : eq(users.role, 'admin');
  return db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.disabled, false), accessCond))
    .orderBy(users.email);
}

/** Keeps absolute http(s) URLs and app-relative paths ("/pull-requests/…"); drops anything else. */
export function sanitizeNotificationUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const v = url.trim();
  if (v.startsWith('/') && !v.startsWith('//') && !/[\s\\]/.test(v)) return v;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function validateEvent(event: NotificationEvent): void {
  const issues: string[] = [];
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(event.kind)) issues.push('kind');
  if (!(SEVERITIES as readonly string[]).includes(event.severity)) issues.push('severity');
  if (
    typeof event.dedupKey !== 'string' ||
    event.dedupKey.trim() === '' ||
    event.dedupKey.length > 500
  ) {
    issues.push('dedupKey');
  }
  if (typeof event.title !== 'string' || event.title.trim() === '') issues.push('title');
  if (typeof event.body !== 'string') issues.push('body');
  if (issues.length) throw new TypeError(`dispatch: invalid event fields: ${issues.join(', ')}`);
}

/** Stored dedup key for a Slack row: one row per channel (user_id is null for Slack). */
export function slackDedupKey(dedupKey: string, channelId: string): string {
  return `${dedupKey}#slack:${channelId}`;
}

/**
 * Resolves the rule for the event (project rule, else org default, else built-in in-app default),
 * filters by event kind and minimum severity, expands recipients per channel and writes
 * notification rows. Duplicates (same dedup key / channel kind / recipient) are ignored via
 * `ON CONFLICT DO NOTHING`. Non-critical email/Slack rows inside quiet hours are written as
 * `deferred` with `send_after` = end of quiet hours; in-app rows are visible immediately.
 * External delivery happens in {@link flushPending}.
 */
export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const { db, orgId, event } = input;
  validateEvent(event);
  const now = input.now ?? new Date();
  const projectId = event.projectId ?? null;
  const pullRequestId = event.pullRequestId ?? null;

  const [org] = await db
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error('dispatch: organization not found');
  const orgTimezone = normalizeTimezone(org.timezone);

  const base = { inserted: 0, duplicates: 0, deferredUntil: null } as const;

  if (projectId) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
      .limit(1);
    if (!project) return { ...base, ruleId: null, skipped: 'project_not_found' };
  }
  if (pullRequestId) {
    const [pr] = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(and(eq(pullRequests.id, pullRequestId), eq(pullRequests.orgId, orgId)))
      .limit(1);
    if (!pr) throw new Error('dispatch: pull request not found in organization');
  }

  const rule = (await resolveRule(db, orgId, projectId, orgTimezone)) ?? defaultRule(orgTimezone);
  const rejected = ruleRejects(rule, event);
  if (rejected) return { ...base, ruleId: rule.id, skipped: rejected };

  // Channels selected by the rule (enabled, same org). No selection → in-app only.
  const channels =
    rule.channelIds.length > 0
      ? await db
          .select({ id: notificationChannels.id, kind: notificationChannels.kind })
          .from(notificationChannels)
          .where(
            and(
              eq(notificationChannels.orgId, orgId),
              eq(notificationChannels.enabled, true),
              inArray(notificationChannels.id, rule.channelIds),
            ),
          )
      : [];
  // Keep the rule's channel order (first email channel wins for per-user email rows).
  const order = new Map(rule.channelIds.map((id, i) => [id, i]));
  channels.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const wantInApp = channels.length === 0 || channels.some((c) => c.kind === 'in_app');
  const emailChannel = channels.find((c) => c.kind === 'email') ?? null;
  const slackChannels = channels.filter((c) => c.kind === 'slack');

  const recipients = wantInApp || emailChannel ? await projectRecipients(db, orgId, projectId) : [];

  const deferUntil =
    event.severity === 'critical'
      ? null
      : quietHoursEnd(now, {
          quietStart: rule.quietStart,
          quietEnd: rule.quietEnd,
          timezone: rule.timezone,
        });

  const title = truncate(redactSecrets(event.title.trim()).text, MAX_TITLE_LENGTH);
  const body = truncate(redactSecrets(event.body).text, MAX_BODY_LENGTH);
  const url = sanitizeNotificationUrl(event.url);
  const dedupKey = event.dedupKey.trim();

  const common = {
    orgId,
    projectId,
    pullRequestId,
    kind: event.kind,
    severity: event.severity as Severity,
    title,
    body,
    url,
  };
  const external = (channelKind: ChannelKind) =>
    deferUntil
      ? { channelKind, status: 'deferred' as const, sendAfter: deferUntil }
      : { channelKind, status: 'pending' as const, sendAfter: now };

  const rows: NewNotification[] = [];
  if (wantInApp) {
    const inApp = channels.find((c) => c.kind === 'in_app') ?? null;
    for (const u of recipients) {
      rows.push({
        ...common,
        userId: u.id,
        channelId: inApp?.id ?? null,
        dedupKey,
        channelKind: 'in_app',
        status: 'sent',
        sentAt: now,
      });
    }
  }
  if (emailChannel) {
    for (const u of recipients) {
      rows.push({
        ...common,
        userId: u.id,
        channelId: emailChannel.id,
        dedupKey,
        ...external('email'),
      });
    }
  }
  for (const ch of slackChannels) {
    rows.push({
      ...common,
      userId: null,
      channelId: ch.id,
      dedupKey: slackDedupKey(dedupKey, ch.id),
      ...external('slack'),
    });
  }

  if (rows.length === 0) return { ...base, ruleId: rule.id, skipped: 'no_recipients' };

  const inserted = await db
    .insert(notifications)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: notifications.id, status: notifications.status });

  const deferredInserted = inserted.some((r) => r.status === 'deferred');
  return {
    ruleId: rule.id,
    inserted: inserted.length,
    duplicates: rows.length - inserted.length,
    deferredUntil: deferredInserted ? deferUntil : null,
  };
}

/** Marks an in-app notification read for its owner. Returns true when a row changed. */
export async function markNotificationRead(
  db: NotifyDb,
  orgId: string,
  userId: string,
  notificationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ readAt: now, status: 'read' })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.orgId, orgId),
        eq(notifications.userId, userId),
        eq(notifications.channelKind, 'in_app'),
        sql`${notifications.readAt} is null`,
      ),
    )
    .returning({ id: notifications.id });
  return rows.length > 0;
}
