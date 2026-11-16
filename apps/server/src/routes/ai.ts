import type { FastifyInstance } from 'fastify';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AI_PROVIDER_KINDS,
  TaskModelsSchema,
  decrypt,
  encrypt,
  redactSecrets,
  type TaskModels,
} from '@gmp/core';
import { DEFAULT_ANTHROPIC_MODELS, monthWindow } from '@gmp/ai';
import { aiProviders, aiSettings, aiUsage, organizations, type AiProviderRow } from '@gmp/db';
import { budgetJson, createAiService } from '../ai-status.ts';
import { auditFromRequest } from '../audit.ts';
import { authOf, requireAdmin } from '../auth/guard.ts';
import { badRequest, notFound, parseWith } from '../errors.ts';
import { HttpUrlSchema, IdParamsSchema } from '../validation.ts';

const SettingsUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    consent: z.boolean().optional(),
    taskModels: TaskModelsSchema.optional(),
    monthlyBudgetUsd: z.number().min(0).max(1_000_000).optional(),
    alertThresholdPct: z.number().int().min(1).max(100).optional(),
    maxInputTokensPerCall: z.number().int().min(1000).max(2_000_000).optional(),
  })
  .strict();

const ProviderCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(AI_PROVIDER_KINDS),
    baseUrl: HttpUrlSchema.nullable().optional(),
    apiKey: z.string().trim().min(1, 'API key is required').max(4000),
    enabled: z.boolean().optional(),
  })
  .strict();

const ProviderPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    baseUrl: HttpUrlSchema.nullable().optional(),
    apiKey: z.string().trim().min(1).max(4000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const ProviderTestSchema = z
  .object({ model: z.string().trim().min(1).max(200).optional() })
  .strict();

function serializeProvider(p: AiProviderRow) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    enabled: p.enabled,
    apiKeyConfigured: Boolean(p.apiKeyEnc),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.ctx;

  async function ensureSettings(orgId: string) {
    await db.insert(aiSettings).values({ orgId }).onConflictDoNothing();
    const [row] = await db.select().from(aiSettings).where(eq(aiSettings.orgId, orgId)).limit(1);
    return row!;
  }

  async function settingsResponse(orgId: string) {
    const s = await ensureSettings(orgId);
    const svc = await createAiService(app.ctx, orgId);
    const budget = await svc.budgetStatus();
    return {
      enabled: s.enabled,
      consentAt: s.consentAt,
      consentBy: s.consentBy,
      taskModels: s.taskModels,
      monthlyBudgetUsd: s.monthlyBudgetUsd,
      alertThresholdPct: s.alertThresholdPct,
      maxInputTokensPerCall: s.maxInputTokensPerCall,
      defaultModels: DEFAULT_ANTHROPIC_MODELS,
      budget: budgetJson(budget),
      disabledReason: svc.disabledReason(null),
      unpricedModels: svc.unpricedModels(),
    };
  }

  async function loadProvider(orgId: string, id: string): Promise<AiProviderRow> {
    const [p] = await db
      .select()
      .from(aiProviders)
      .where(and(eq(aiProviders.id, id), eq(aiProviders.orgId, orgId)))
      .limit(1);
    if (!p) throw notFound('AI provider not found.');
    return p;
  }

  app.get('/api/settings/ai', { preHandler: requireAdmin }, async (req) => {
    return settingsResponse(authOf(req).user.orgId);
  });

  app.put('/api/settings/ai', { preHandler: requireAdmin }, async (req) => {
    const body = parseWith(SettingsUpdateSchema, req.body);
    const { user } = authOf(req);
    const current = await ensureSettings(user.orgId);
    const set: Partial<typeof aiSettings.$inferInsert> = {};
    const now = app.ctx.now();

    if (body.consent === true && !current.consentAt) {
      set.consentAt = now;
      set.consentBy = user.id;
    }
    if (body.consent === false) {
      // Withdrawing consent always disables AI.
      set.consentAt = null;
      set.consentBy = null;
      set.enabled = false;
    }
    if (body.enabled !== undefined && body.consent !== false) {
      const hasConsent = Boolean(set.consentAt ?? current.consentAt);
      if (body.enabled && !hasConsent) {
        throw badRequest(
          'Review the AI data-flow screen and give consent before enabling AI.',
          'consent_required',
        );
      }
      set.enabled = body.enabled;
    }
    if (body.taskModels !== undefined) {
      const ids = [...new Set(Object.values(body.taskModels).map((t) => t!.providerId))];
      if (ids.length) {
        const rows = await db
          .select({ id: aiProviders.id })
          .from(aiProviders)
          .where(
            and(
              eq(aiProviders.orgId, user.orgId),
              sql`${aiProviders.id} = ANY(${`{${ids.join(',')}}`}::uuid[])`,
            ),
          );
        if (rows.length !== ids.length)
          throw badRequest('Unknown AI provider in task models.', 'invalid_reference');
      }
      set.taskModels = body.taskModels as TaskModels;
    }
    if (body.monthlyBudgetUsd !== undefined) set.monthlyBudgetUsd = body.monthlyBudgetUsd;
    if (body.alertThresholdPct !== undefined) set.alertThresholdPct = body.alertThresholdPct;
    if (body.maxInputTokensPerCall !== undefined)
      set.maxInputTokensPerCall = body.maxInputTokensPerCall;

    if (Object.keys(set).length) {
      await db.update(aiSettings).set(set).where(eq(aiSettings.orgId, user.orgId));
      await auditFromRequest(
        db,
        req,
        'ai.settings_updated',
        { type: 'ai_settings', id: current.id },
        {
          changes: { ...set, consentAt: set.consentAt?.toISOString?.() ?? set.consentAt },
        },
      );
    }
    return settingsResponse(user.orgId);
  });

  app.get('/api/settings/ai/providers', { preHandler: requireAdmin }, async (req) => {
    const rows = await db
      .select()
      .from(aiProviders)
      .where(eq(aiProviders.orgId, authOf(req).user.orgId))
      .orderBy(aiProviders.name);
    return rows.map(serializeProvider);
  });

  app.post('/api/settings/ai/providers', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseWith(ProviderCreateSchema, req.body);
    const { user } = authOf(req);
    const [row] = await db
      .insert(aiProviders)
      .values({
        orgId: user.orgId,
        name: body.name,
        kind: body.kind,
        baseUrl: body.baseUrl ?? null,
        apiKeyEnc: encrypt(body.apiKey, config.masterKey),
        enabled: body.enabled ?? true,
      })
      .returning();
    await auditFromRequest(
      db,
      req,
      'ai.provider_created',
      { type: 'ai_provider', id: row!.id },
      {
        name: row!.name,
        kind: row!.kind,
        baseUrl: row!.baseUrl,
      },
    );
    return reply.status(201).send(serializeProvider(row!));
  });

  app.patch('/api/settings/ai/providers/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const body = parseWith(ProviderPatchSchema, req.body);
    const { user } = authOf(req);
    await loadProvider(user.orgId, id);
    const set: Partial<typeof aiProviders.$inferInsert> = {};
    if (body.name !== undefined) set.name = body.name;
    if (body.baseUrl !== undefined) set.baseUrl = body.baseUrl;
    if (body.enabled !== undefined) set.enabled = body.enabled;
    if (body.apiKey !== undefined) set.apiKeyEnc = encrypt(body.apiKey, config.masterKey);
    if (Object.keys(set).length === 0) return serializeProvider(await loadProvider(user.orgId, id));
    const [row] = await db
      .update(aiProviders)
      .set(set)
      .where(and(eq(aiProviders.id, id), eq(aiProviders.orgId, user.orgId)))
      .returning();
    await auditFromRequest(
      db,
      req,
      'ai.provider_updated',
      { type: 'ai_provider', id },
      {
        name: body.name,
        baseUrl: body.baseUrl,
        enabled: body.enabled,
        apiKeyChanged: body.apiKey !== undefined,
      },
    );
    return serializeProvider(row!);
  });

  app.delete('/api/settings/ai/providers/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const { user } = authOf(req);
    const p = await loadProvider(user.orgId, id);
    await db.transaction(async (tx) => {
      await tx
        .delete(aiProviders)
        .where(and(eq(aiProviders.id, id), eq(aiProviders.orgId, user.orgId)));
      const [s] = await tx
        .select()
        .from(aiSettings)
        .where(eq(aiSettings.orgId, user.orgId))
        .limit(1);
      if (s) {
        const next: TaskModels = {};
        for (const [task, cfg] of Object.entries(s.taskModels ?? {})) {
          if (cfg && cfg.providerId !== id) next[task as keyof TaskModels] = cfg;
        }
        await tx.update(aiSettings).set({ taskModels: next }).where(eq(aiSettings.id, s.id));
      }
    });
    await auditFromRequest(
      db,
      req,
      'ai.provider_deleted',
      { type: 'ai_provider', id },
      { name: p.name },
    );
    return { ok: true };
  });

  app.post('/api/settings/ai/providers/:id/test', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const body = parseWith(ProviderTestSchema, req.body ?? {});
    const { user } = authOf(req);
    const p = await loadProvider(user.orgId, id);
    const [s] = await db.select().from(aiSettings).where(eq(aiSettings.orgId, user.orgId)).limit(1);
    const configured = Object.values(s?.taskModels ?? {}).find((t) => t?.providerId === id)?.model;
    const model =
      body.model ??
      configured ??
      (p.kind === 'anthropic' ? DEFAULT_ANTHROPIC_MODELS.triage : undefined);
    if (!model) {
      return {
        ok: false,
        error: 'Choose a model for this provider (task models) before testing it.',
      };
    }
    let apiKey: string;
    try {
      apiKey = p.apiKeyEnc ? decrypt(p.apiKeyEnc, config.masterKey) : '';
    } catch {
      return { ok: false, error: 'The stored API key could not be decrypted (check MASTER_KEY).' };
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const provider = app.ctx.aiProviderFactory({
        providerId: p.id,
        kind: p.kind,
        apiKey,
        baseUrl: p.baseUrl,
      });
      const res = await provider.complete({
        model,
        system: 'You are a connectivity check. Reply with the single word OK.',
        messages: [{ role: 'user', content: 'ping' }],
        maxOutputTokens: 16,
        signal: controller.signal,
      });
      await auditFromRequest(
        db,
        req,
        'ai.provider_tested',
        { type: 'ai_provider', id },
        { ok: true, model },
      );
      return { ok: true, model: res.model ?? model, latencyMs: Date.now() - started };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const error = redactSecrets(raw)
        .text.replaceAll(apiKey || '\u0000', '[REDACTED]')
        .slice(0, 500);
      await auditFromRequest(
        db,
        req,
        'ai.provider_tested',
        { type: 'ai_provider', id },
        { ok: false, model },
      );
      return { ok: false, error, model, latencyMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  });

  app.get('/api/usage', { preHandler: requireAdmin }, async (req) => {
    const { user } = authOf(req);
    const svc = await createAiService(app.ctx, user.orgId);
    const budget = await svc.budgetStatus();
    const [org] = await db
      .select({ timezone: organizations.timezone })
      .from(organizations)
      .where(eq(organizations.id, user.orgId));
    const window = monthWindow(app.ctx.now(), org?.timezone ?? 'UTC');
    const where = and(
      eq(aiUsage.orgId, user.orgId),
      gte(aiUsage.occurredAt, window.start),
      lt(aiUsage.occurredAt, window.end),
    );
    const agg = {
      inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::bigint`,
      cacheReadTokens: sql<number>`coalesce(sum(${aiUsage.cacheReadTokens}), 0)::bigint`,
      costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float8`,
      calls: sql<number>`count(*)::int`,
    };
    const byTask = await db
      .select({ key: aiUsage.task, ...agg })
      .from(aiUsage)
      .where(where)
      .groupBy(aiUsage.task)
      .orderBy(aiUsage.task);
    const byModel = await db
      .select({ key: aiUsage.model, ...agg })
      .from(aiUsage)
      .where(where)
      .groupBy(aiUsage.model)
      .orderBy(aiUsage.model);
    const tz = window.timeZone;
    const daily = await db
      .select({
        date: sql<string>`to_char(${aiUsage.occurredAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
        costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float8`,
      })
      .from(aiUsage)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const num = <T extends Record<string, unknown>>(r: T) => ({
      ...r,
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
      costUsd: Number(r.costUsd),
    });
    return {
      budget: budgetJson(budget),
      byTask: byTask.map(num),
      byModel: byModel.map(num),
      daily: daily.map((d) => ({ date: d.date, costUsd: Number(d.costUsd) })),
    };
  });
}
