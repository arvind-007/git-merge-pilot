import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { CHANNEL_KINDS, NOTIFICATION_KINDS, SEVERITIES, type ChannelKind } from '@gmp/core';
import {
  notificationChannels,
  notificationRules,
  notifications,
  projects,
  type NotificationChannel,
  type NotificationRule,
} from '@gmp/db';
import {
  ChannelConfigError,
  decryptChannelConfig,
  describeChannelConfig,
  encryptChannelConfig,
  markNotificationRead,
  testChannel,
  type ChannelConfig,
} from '@gmp/notify';
import { auditFromRequest } from '../audit.ts';
import { authOf, requireAdmin, requireAuth, scopeOf } from '../auth/guard.ts';
import { HttpError, badRequest, notFound, parseWith } from '../errors.ts';
import {
  ClockSchema,
  IdParamsSchema,
  LimitSchema,
  QueryBool,
  TimezoneSchema,
} from '../validation.ts';

const ConfigInput = z.record(z.string(), z.unknown()).nullable().optional();

const ChannelCreateSchema = z
  .object({
    kind: z.enum(CHANNEL_KINDS),
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().optional(),
    config: ConfigInput,
  })
  .strict();

const ChannelPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    config: ConfigInput,
  })
  .strict();

const ChannelTestSchema = z.object({ to: z.string().trim().max(254).optional() }).strict();

const RuleBase = z.object({
  projectId: z.string().uuid().nullable().optional(),
  minSeverity: z.enum(SEVERITIES).optional(),
  events: z.array(z.enum(NOTIFICATION_KINDS)).max(NOTIFICATION_KINDS.length).optional(),
  channelIds: z.array(z.string().uuid()).max(50).optional(),
  digestEnabled: z.boolean().optional(),
  digestHour: z.number().int().min(0).max(23).optional(),
  timezone: TimezoneSchema.nullable().optional(),
  quietStart: ClockSchema.nullable().optional(),
  quietEnd: ClockSchema.nullable().optional(),
});
const RuleCreateSchema = RuleBase.strict().refine(
  (r) => (r.quietStart == null) === (r.quietEnd == null),
  'Set both quiet hours start and end, or neither',
);
const RulePatchSchema = RuleBase.strict();

const NotificationsQuerySchema = z.object({
  unread: QueryBool,
  limit: LimitSchema(50, 200),
});

/**
 * Normalizes the web form shape (user/pass) onto the @gmp/notify config keys. Email channels
 * deliver to each recipient user's own address; a legacy `to` list only provides the test
 * address (its first entry).
 */
function normalizeConfigInput(
  kind: ChannelKind,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (kind !== 'email') return input;
  const out: Record<string, unknown> = { ...input };
  if (out.username === undefined && typeof out.user === 'string') out.username = out.user;
  if (out.password === undefined && typeof out.pass === 'string') out.password = out.pass;
  if (out.testRecipient === undefined && Array.isArray(out.to) && typeof out.to[0] === 'string') {
    out.testRecipient = out.to[0];
  }
  delete out.user;
  delete out.pass;
  delete out.to;
  return out;
}

function configSummary(kind: ChannelKind, description: Record<string, unknown>): string | null {
  if (kind === 'email') {
    const to = description.testRecipient ? ` (test: ${String(description.testRecipient)})` : '';
    return `from ${String(description.from)} via ${String(description.host)}:${String(description.port)}${to}`;
  }
  if (kind === 'slack')
    return description.webhookHost ? `Slack webhook on ${String(description.webhookHost)}` : null;
  return 'In-app notifications';
}

function channelConfigOrThrow<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ChannelConfigError) {
      throw new HttpError(400, 'invalid_channel_config', err.message, err.issues);
    }
    throw err;
  }
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.ctx;

  function serializeChannel(c: NotificationChannel) {
    let description: Record<string, unknown> = {};
    let configured = c.kind === 'in_app';
    let configError: string | null = null;
    if (c.kind !== 'in_app' && c.configEnc) {
      try {
        description = describeChannelConfig(
          c.kind,
          decryptChannelConfig(c.kind, c.configEnc, config.masterKey),
        );
        configured = true;
      } catch {
        configError = 'Stored configuration could not be read.';
      }
    }
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      enabled: c.enabled,
      configured,
      config: description,
      summary: configured ? configSummary(c.kind, description) : null,
      configError,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  async function loadChannel(orgId: string, id: string): Promise<NotificationChannel> {
    const [c] = await db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, orgId)))
      .limit(1);
    if (!c) throw notFound('Notification channel not found.');
    return c;
  }

  // ------------------------------------------------------------- channels
  app.get('/api/settings/notification-channels', { preHandler: requireAdmin }, async (req) => {
    const rows = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.orgId, authOf(req).user.orgId))
      .orderBy(notificationChannels.name);
    return rows.map(serializeChannel);
  });

  app.post(
    '/api/settings/notification-channels',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const body = parseWith(ChannelCreateSchema, req.body);
      const { user } = authOf(req);
      if (body.kind !== 'in_app' && !body.config)
        throw badRequest('Channel configuration is required.', 'invalid_channel_config');
      const configEnc = channelConfigOrThrow(() =>
        encryptChannelConfig(
          body.kind,
          normalizeConfigInput(body.kind, body.config ?? {}),
          config.masterKey,
        ),
      );
      const [row] = await db
        .insert(notificationChannels)
        .values({
          orgId: user.orgId,
          kind: body.kind,
          name: body.name,
          enabled: body.enabled ?? true,
          configEnc,
        })
        .returning();
      await auditFromRequest(
        db,
        req,
        'notification.channel_created',
        { type: 'notification_channel', id: row!.id },
        {
          kind: row!.kind,
          name: row!.name,
        },
      );
      return reply.status(201).send(serializeChannel(row!));
    },
  );

  app.patch(
    '/api/settings/notification-channels/:id',
    { preHandler: requireAdmin },
    async (req) => {
      const { id } = parseWith(IdParamsSchema, req.params);
      const body = parseWith(ChannelPatchSchema, req.body);
      const { user } = authOf(req);
      const ch = await loadChannel(user.orgId, id);
      const set: Partial<typeof notificationChannels.$inferInsert> = {};
      if (body.name !== undefined) set.name = body.name;
      if (body.enabled !== undefined) set.enabled = body.enabled;
      if (body.config && ch.kind !== 'in_app') {
        // Write-only secrets: omitted/blank fields keep their stored values.
        let previous: ChannelConfig = {};
        if (ch.configEnc) {
          try {
            previous = decryptChannelConfig(ch.kind, ch.configEnc, config.masterKey);
          } catch {
            previous = {};
          }
        }
        const incoming = normalizeConfigInput(ch.kind, body.config);
        const merged: Record<string, unknown> = { ...(previous as Record<string, unknown>) };
        for (const [k, v] of Object.entries(incoming)) {
          if (v === undefined || v === null || v === '') continue;
          merged[k] = v;
        }
        set.configEnc = channelConfigOrThrow(() =>
          encryptChannelConfig(ch.kind, merged, config.masterKey),
        );
      }
      if (Object.keys(set).length === 0) return serializeChannel(ch);
      const [row] = await db
        .update(notificationChannels)
        .set(set)
        .where(and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, user.orgId)))
        .returning();
      await auditFromRequest(
        db,
        req,
        'notification.channel_updated',
        { type: 'notification_channel', id },
        {
          name: body.name,
          enabled: body.enabled,
          configChanged: Boolean(set.configEnc),
        },
      );
      return serializeChannel(row!);
    },
  );

  app.delete(
    '/api/settings/notification-channels/:id',
    { preHandler: requireAdmin },
    async (req) => {
      const { id } = parseWith(IdParamsSchema, req.params);
      const { user } = authOf(req);
      const ch = await loadChannel(user.orgId, id);
      await db.transaction(async (tx) => {
        await tx.delete(notificationChannels).where(eq(notificationChannels.id, id));
        await tx
          .update(notificationRules)
          .set({ channelIds: sql`array_remove(${notificationRules.channelIds}, ${id}::uuid)` })
          .where(
            and(
              eq(notificationRules.orgId, user.orgId),
              sql`${id}::uuid = ANY(${notificationRules.channelIds})`,
            ),
          );
      });
      await auditFromRequest(
        db,
        req,
        'notification.channel_deleted',
        { type: 'notification_channel', id },
        {
          kind: ch.kind,
          name: ch.name,
        },
      );
      return { ok: true };
    },
  );

  app.post(
    '/api/settings/notification-channels/:id/test',
    { preHandler: requireAdmin },
    async (req) => {
      const { id } = parseWith(IdParamsSchema, req.params);
      const body = parseWith(ChannelTestSchema, req.body ?? {});
      const { user } = authOf(req);
      const ch = await loadChannel(user.orgId, id);
      // decryptChannelConfig defaults to core's key; pass the config explicitly so the key is ours.
      let decrypted: ChannelConfig | undefined;
      try {
        decrypted =
          ch.kind === 'in_app' ? {} : decryptChannelConfig(ch.kind, ch.configEnc, config.masterKey);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Configuration unreadable',
        };
      }
      const result = await testChannel(
        { kind: ch.kind, config: decrypted, name: ch.name },
        {
          ...app.ctx.notifyTestOptions,
          // Without an explicit or configured test address, send the test to the admin.
          ...(body.to
            ? { to: body.to }
            : ch.kind === 'email' && !(decrypted as { testRecipient?: string }).testRecipient
              ? { to: user.email }
              : {}),
        },
      );
      await auditFromRequest(
        db,
        req,
        'notification.channel_tested',
        { type: 'notification_channel', id },
        {
          ok: result.ok,
        },
      );
      return result;
    },
  );

  // ---------------------------------------------------------------- rules
  function serializeRule(r: NotificationRule) {
    return {
      id: r.id,
      projectId: r.projectId,
      minSeverity: r.minSeverity,
      events: r.events,
      channelIds: r.channelIds,
      digestEnabled: r.digestEnabled,
      digestHour: r.digestHour,
      timezone: r.timezone,
      quietStart: r.quietStart,
      quietEnd: r.quietEnd,
      lastDigestAt: r.lastDigestAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async function validateRuleRefs(
    orgId: string,
    body: { projectId?: string | null; channelIds?: string[] },
  ) {
    if (body.projectId) {
      const [p] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, body.projectId), eq(projects.orgId, orgId)));
      if (!p) throw badRequest('Project not found.', 'invalid_reference');
    }
    const ids = [...new Set(body.channelIds ?? [])];
    if (ids.length) {
      const rows = await db
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(and(eq(notificationChannels.orgId, orgId), inArray(notificationChannels.id, ids)));
      if (rows.length !== ids.length)
        throw badRequest('Unknown notification channel.', 'invalid_reference');
    }
  }

  async function loadRule(orgId: string, id: string): Promise<NotificationRule> {
    const [r] = await db
      .select()
      .from(notificationRules)
      .where(and(eq(notificationRules.id, id), eq(notificationRules.orgId, orgId)))
      .limit(1);
    if (!r) throw notFound('Notification rule not found.');
    return r;
  }

  app.get('/api/settings/notification-rules', { preHandler: requireAdmin }, async (req) => {
    const rows = await db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.orgId, authOf(req).user.orgId))
      .orderBy(sql`${notificationRules.projectId} NULLS FIRST`, notificationRules.createdAt);
    return rows.map(serializeRule);
  });

  app.post('/api/settings/notification-rules', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseWith(RuleCreateSchema, req.body);
    const { user } = authOf(req);
    await validateRuleRefs(user.orgId, body);
    const scopeCond = body.projectId
      ? eq(notificationRules.projectId, body.projectId)
      : isNull(notificationRules.projectId);
    const [dup] = await db
      .select({ id: notificationRules.id })
      .from(notificationRules)
      .where(and(eq(notificationRules.orgId, user.orgId), scopeCond));
    if (dup) {
      throw new HttpError(
        409,
        'conflict',
        body.projectId
          ? 'This project already has a notification rule. Edit it instead.'
          : 'An organization default rule already exists. Edit it instead.',
      );
    }
    const [row] = await db
      .insert(notificationRules)
      .values({
        orgId: user.orgId,
        projectId: body.projectId ?? null,
        minSeverity: body.minSeverity ?? 'high',
        events: body.events ?? [...NOTIFICATION_KINDS],
        channelIds: [...new Set(body.channelIds ?? [])],
        digestEnabled: body.digestEnabled ?? true,
        digestHour: body.digestHour ?? 9,
        timezone: body.timezone ?? user.timezone ?? 'UTC',
        quietStart: body.quietStart ?? null,
        quietEnd: body.quietEnd ?? null,
      })
      .returning();
    await auditFromRequest(
      db,
      req,
      'notification.rule_created',
      { type: 'notification_rule', id: row!.id },
      serializeRule(row!),
    );
    return reply.status(201).send(serializeRule(row!));
  });

  app.patch('/api/settings/notification-rules/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const body = parseWith(RulePatchSchema, req.body);
    const { user } = authOf(req);
    const existing = await loadRule(user.orgId, id);
    await validateRuleRefs(user.orgId, body);
    const set: Partial<typeof notificationRules.$inferInsert> = {};
    if (body.projectId !== undefined && body.projectId !== existing.projectId) {
      throw badRequest('A rule cannot be moved to another project; create a new rule instead.');
    }
    if (body.minSeverity !== undefined) set.minSeverity = body.minSeverity;
    if (body.events !== undefined) set.events = body.events;
    if (body.channelIds !== undefined) set.channelIds = [...new Set(body.channelIds)];
    if (body.digestEnabled !== undefined) set.digestEnabled = body.digestEnabled;
    if (body.digestHour !== undefined) set.digestHour = body.digestHour;
    if (body.timezone !== undefined) set.timezone = body.timezone ?? 'UTC';
    if (body.quietStart !== undefined) set.quietStart = body.quietStart;
    if (body.quietEnd !== undefined) set.quietEnd = body.quietEnd;
    const qs = set.quietStart !== undefined ? set.quietStart : existing.quietStart;
    const qe = set.quietEnd !== undefined ? set.quietEnd : existing.quietEnd;
    if ((qs == null) !== (qe == null))
      throw badRequest('Set both quiet hours start and end, or neither.');
    if (Object.keys(set).length === 0) return serializeRule(existing);
    const [row] = await db
      .update(notificationRules)
      .set(set)
      .where(and(eq(notificationRules.id, id), eq(notificationRules.orgId, user.orgId)))
      .returning();
    await auditFromRequest(
      db,
      req,
      'notification.rule_updated',
      { type: 'notification_rule', id },
      { changes: set },
    );
    return serializeRule(row!);
  });

  app.delete('/api/settings/notification-rules/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const { user } = authOf(req);
    await loadRule(user.orgId, id);
    await db
      .delete(notificationRules)
      .where(and(eq(notificationRules.id, id), eq(notificationRules.orgId, user.orgId)));
    await auditFromRequest(db, req, 'notification.rule_deleted', { type: 'notification_rule', id });
    return { ok: true };
  });

  // -------------------------------------------------------- in-app inbox
  app.get('/api/notifications', { preHandler: requireAuth }, async (req) => {
    const q = parseWith(NotificationsQuerySchema, req.query);
    const { user } = authOf(req);
    const scope = await scopeOf(req, app);
    const conds: SQL[] = [
      eq(notifications.orgId, user.orgId),
      eq(notifications.channelKind, 'in_app'),
      user.role === 'admin'
        ? or(eq(notifications.userId, user.id), isNull(notifications.userId))!
        : eq(notifications.userId, user.id),
    ];
    if (user.role !== 'admin') {
      // Members never see items tied to projects they are not in.
      conds.push(
        scope.projectIds.length
          ? or(isNull(notifications.projectId), inArray(notifications.projectId, scope.projectIds))!
          : isNull(notifications.projectId),
      );
    }
    if (q.unread) conds.push(isNull(notifications.readAt));
    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conds))
      .orderBy(desc(notifications.createdAt))
      .limit(q.limit);
    return rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      severity: n.severity,
      title: n.title,
      body: n.body,
      url: n.url,
      status: n.status,
      readAt: n.readAt,
      createdAt: n.createdAt,
      pullRequestId: n.pullRequestId,
      projectId: n.projectId,
    }));
  });

  app.post('/api/notifications/:id/read', { preHandler: requireAuth }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const { user } = authOf(req);
    const now = app.ctx.now();
    const updated = await markNotificationRead(db, user.orgId, user.id, id, now);
    if (updated) return { ok: true };
    const ownerCond =
      user.role === 'admin'
        ? or(eq(notifications.userId, user.id), isNull(notifications.userId))
        : eq(notifications.userId, user.id);
    const [row] = await db
      .select({ id: notifications.id, readAt: notifications.readAt, userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.orgId, user.orgId),
          eq(notifications.channelKind, 'in_app'),
          ownerCond,
        ),
      );
    if (!row) throw notFound('Notification not found.');
    if (!row.readAt && row.userId === null) {
      await db
        .update(notifications)
        .set({ readAt: now, status: 'read' })
        .where(eq(notifications.id, id));
    }
    return { ok: true };
  });
}
