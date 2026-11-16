import { createLogger, redactSecrets } from '@gmp/core';
import { notificationChannels, notifications, projects, users, type Notification } from '@gmp/db';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { ChannelConfigError, decryptChannelConfig } from './channel-config.ts';
import { ChannelSendError, sendEmail } from './channels/email.ts';
import { sendSlack } from './channels/slack.ts';
import { oneLine, safeHttpUrl } from './escape.ts';
import { renderNotificationEmail, renderNotificationSlack } from './render.ts';
import type {
  ChannelSenders,
  EmailChannelConfig,
  FlushInput,
  SlackChannelConfig,
} from './types.ts';

const log = createLogger('notify.flush');

/** Retry delays after attempt 1, 2, 3, 4 … (last value repeats). */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 10 * 60_000;
const ERROR_MAX = 500;

/** Attempts already made, as recorded in the `error` column ("attempt N/M: …"). */
export function parseAttempts(error: string | null | undefined): number {
  const m = error ? /^attempt (\d+)\//.exec(error) : null;
  return m ? Number(m[1]) : 0;
}

/** Delay before retry number `attempt + 1`. */
export function retryDelayMs(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[idx]!;
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return oneLine(redactSecrets(raw).text, ERROR_MAX);
}

function isPermanent(err: unknown): boolean {
  if (err instanceof ChannelConfigError) return true;
  if (err instanceof ChannelSendError) return !err.retryable;
  return false;
}

function resolveUrl(url: string | null, publicUrl: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/')) {
    if (!publicUrl) return null;
    return safeHttpUrl(`${publicUrl.replace(/\/+$/, '')}${url}`);
  }
  return safeHttpUrl(url);
}

/**
 * Sends due email/Slack notifications (status pending/deferred with send_after <= now) for one
 * org. Rows are claimed with `FOR UPDATE SKIP LOCKED` and leased, so concurrent workers never
 * double-send. Failures are retried with backoff (1m, 5m, 15m, 60m) and recorded in `error` as
 * "attempt N/M: reason"; after `maxAttempts` (default 5) or a permanent error the row is `failed`.
 * Returns the number of notifications sent.
 */
export async function flushPending(input: FlushInput): Promise<number> {
  const { db, orgId } = input;
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? DEFAULT_LEASE_MS));
  const senders: ChannelSenders = {
    email: input.senders?.email ?? ((cfg, msg) => sendEmail(cfg, msg)),
    slack: input.senders?.slack ?? ((url, msg) => sendSlack(url, msg)),
  };

  const due = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, orgId),
        inArray(notifications.channelKind, ['email', 'slack']),
        inArray(notifications.status, ['pending', 'deferred']),
        or(isNull(notifications.sendAfter), lte(notifications.sendAfter, now)),
      ),
    )
    .orderBy(sql`${notifications.sendAfter} asc nulls first`, asc(notifications.createdAt))
    .limit(limit)
    .for('update', { skipLocked: true });

  const claimed: Notification[] = await db
    .update(notifications)
    .set({ status: 'pending', sendAfter: leaseUntil })
    .where(inArray(notifications.id, due))
    .returning();
  if (claimed.length === 0) return 0;
  claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const channelIds = [...new Set(claimed.map((n) => n.channelId).filter((v): v is string => !!v))];
  const userIds = [...new Set(claimed.map((n) => n.userId).filter((v): v is string => !!v))];
  const projectIds = [...new Set(claimed.map((n) => n.projectId).filter((v): v is string => !!v))];

  const [channelRows, userRows, projectRows] = await Promise.all([
    channelIds.length
      ? db
          .select()
          .from(notificationChannels)
          .where(
            and(
              eq(notificationChannels.orgId, orgId),
              inArray(notificationChannels.id, channelIds),
            ),
          )
      : Promise.resolve([]),
    userIds.length
      ? db
          .select({ id: users.id, email: users.email, disabled: users.disabled })
          .from(users)
          .where(and(eq(users.orgId, orgId), inArray(users.id, userIds)))
      : Promise.resolve([]),
    projectIds.length
      ? db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.orgId, orgId), inArray(projects.id, projectIds)))
      : Promise.resolve([]),
  ]);
  const channelById = new Map(channelRows.map((c) => [c.id, c]));
  const userById = new Map(userRows.map((u) => [u.id, u]));
  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));
  const configCache = new Map<string, EmailChannelConfig | SlackChannelConfig | Error>();

  let sent = 0;
  for (const n of claimed) {
    const attempt = parseAttempts(n.error) + 1;
    try {
      const channel = n.channelId ? channelById.get(n.channelId) : undefined;
      if (!channel || !channel.enabled || channel.kind !== n.channelKind) {
        throw new ChannelConfigError(['channel was removed, disabled or changed kind']);
      }
      let cfg = configCache.get(channel.id);
      if (!cfg) {
        try {
          cfg = decryptChannelConfig(channel.kind, channel.configEnc) as
            EmailChannelConfig | SlackChannelConfig;
        } catch (err) {
          cfg = err instanceof Error ? err : new Error(String(err));
        }
        configCache.set(channel.id, cfg);
      }
      if (cfg instanceof Error) throw cfg;

      const renderable = {
        kind: n.kind,
        severity: n.severity,
        title: n.title,
        body: n.body,
        url: resolveUrl(n.url, input.publicUrl),
        projectName: n.projectId ? (projectName.get(n.projectId) ?? null) : null,
      };
      if (n.channelKind === 'email') {
        const user = n.userId ? userById.get(n.userId) : undefined;
        if (!user || user.disabled) {
          throw new ChannelSendError('email', 'Recipient user is missing or disabled', {
            retryable: false,
          });
        }
        await senders.email(
          cfg as EmailChannelConfig,
          renderNotificationEmail(renderable, user.email),
        );
      } else {
        await senders.slack(
          (cfg as SlackChannelConfig).webhookUrl,
          renderNotificationSlack(renderable),
        );
      }

      await db
        .update(notifications)
        .set({ status: 'sent', sentAt: new Date(), error: null, sendAfter: null })
        .where(eq(notifications.id, n.id));
      sent++;
    } catch (err) {
      const permanent = isPermanent(err);
      const giveUp = permanent || attempt >= maxAttempts;
      const msg = `attempt ${attempt}/${maxAttempts}${permanent ? ' (permanent)' : ''}: ${errorMessage(err)}`;
      await db
        .update(notifications)
        .set(
          giveUp
            ? { status: 'failed', error: msg, sendAfter: null }
            : {
                status: 'pending',
                error: msg,
                sendAfter: new Date(now.getTime() + retryDelayMs(attempt)),
              },
        )
        .where(eq(notifications.id, n.id));
      log.warn(
        {
          notificationId: n.id,
          channelKind: n.channelKind,
          attempt,
          giveUp,
          err: errorMessage(err),
        },
        'notification delivery failed',
      );
    }
  }
  return sent;
}
