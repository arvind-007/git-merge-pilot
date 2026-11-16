import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { decrypt, encrypt, generateToken, timingSafeEqualStr } from '@gmp/core';
import {
  githubApps,
  installations,
  repositories,
  systemState,
  webhookDeliveries,
  type Database,
} from '@gmp/db';
import {
  GITHUB_ROUTES,
  WEBHOOK_EVENTS,
  buildAppManifest,
  describeError,
  isValidGitHubLogin,
  verifyWebhookSignature,
} from '@gmp/github';
import { auditFromRequest, writeAudit } from '../audit.ts';
import { authOf, requireAdmin, requireAuth } from '../auth/guard.ts';
import { HttpError, badRequest, parseWith } from '../errors.ts';
import { appClient, getOrgApp, syncInstallations } from '../github/app-store.ts';
import { QUEUES, type WebhookProcessJob } from '../queue.ts';

const STATE_COOKIE = 'gmp_gh_state';
const STATE_TTL_SECONDS = 3600;
/** GitHub caps webhook payloads at 25 MB. */
export const WEBHOOK_BODY_LIMIT = 26 * 1024 * 1024;

const ManifestSchema = z.object({
  appName: z.string().trim().min(1).max(34).optional(),
  org: z
    .string()
    .trim()
    .max(39)
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || isValidGitHubLogin(v), 'Invalid GitHub organization login'),
  returnTo: z.enum(['setup', 'settings']).optional().default('settings'),
});

const CallbackQuerySchema = z.object({
  code: z.string().trim().min(1).max(200).optional(),
  state: z.string().trim().max(200).optional(),
});

const InstallQuerySchema = z.object({
  installation_id: z.coerce.number().int().positive().optional(),
  setup_action: z.string().max(40).optional(),
  state: z.string().max(200).optional(),
});

type ReturnTo = 'setup' | 'settings';

function returnPath(returnTo: ReturnTo, params: Record<string, string>): string {
  const qs = new URLSearchParams(params);
  if (returnTo === 'setup') {
    qs.set('step', '2');
    return `/setup?${qs.toString()}`;
  }
  return `/settings/github?${qs.toString()}`;
}

/** Strips NUL characters (rejected by jsonb) from a parsed JSON value. */
function stripNul(value: unknown): unknown {
  if (typeof value === 'string')
    return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
  if (Array.isArray(value)) return value.map(stripNul);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[stripNul(k) as string] = stripNul(v);
    return out;
  }
  return value;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

interface WebhookSecretEntry {
  orgId: string;
  secret: string;
}

async function loadWebhookSecrets(db: Database, masterKey: Buffer): Promise<WebhookSecretEntry[]> {
  const rows = await db
    .select({ orgId: githubApps.orgId, enc: githubApps.webhookSecretEnc })
    .from(githubApps)
    .orderBy(desc(githubApps.createdAt));
  const out: WebhookSecretEntry[] = [];
  for (const r of rows) {
    try {
      const secret = decrypt(r.enc, masterKey);
      if (secret) out.push({ orgId: r.orgId, secret });
    } catch {
      // Undecryptable secret (wrong MASTER_KEY): cannot verify with it.
    }
  }
  return out;
}

/** Reduces a smee.io channel URL to its origin so the channel id never leaves the server. */
export function maskSmeeUrl(smeeUrl: string): string {
  try {
    return `${new URL(smeeUrl).origin}/…`;
  } catch {
    return 'smee relay (configured)';
  }
}

export async function githubRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;
  const { db, config } = ctx;
  // The smee channel URL is a bearer secret: anyone who knows it can read every
  // webhook delivery for every repository. It is never returned by the API.
  const webhookUrl = config.smeeUrl
    ? maskSmeeUrl(config.smeeUrl)
    : `${config.publicUrl}${GITHUB_ROUTES.webhook}`;
  // GitHub redirects the browser to PUBLIC_URL; send it on to the UI, which lives at
  // WEB_URL when that differs (e.g. the Vite dev server during `pnpm dev`).
  const toWeb = (path: string) =>
    config.webUrl && config.webUrl !== config.publicUrl ? `${config.webUrl}${path}` : path;

  async function lastDelivery(orgId: string) {
    const [row] = await db
      .select({ receivedAt: webhookDeliveries.receivedAt, status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.orgId, orgId))
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(1);
    return row ?? null;
  }

  app.get('/api/github/status', { preHandler: requireAuth }, async (req) => {
    const { user } = authOf(req);
    const ghApp = await getOrgApp(db, user.orgId);
    const inst = ghApp
      ? await db
          .select()
          .from(installations)
          .where(and(eq(installations.orgId, user.orgId), eq(installations.githubAppId, ghApp.id)))
          .orderBy(installations.accountLogin)
      : [];
    const last = await lastDelivery(user.orgId);
    return {
      connected: Boolean(ghApp),
      app: ghApp
        ? {
            appId: ghApp.appId,
            slug: ghApp.slug,
            name: ghApp.name,
            htmlUrl: ghApp.htmlUrl,
            ownerLogin: ghApp.ownerLogin,
            clientId: ghApp.clientId,
            clientSecretConfigured: Boolean(ghApp.clientSecretEnc),
            privateKeyConfigured: Boolean(ghApp.privateKeyEnc),
            webhookSecretConfigured: Boolean(ghApp.webhookSecretEnc),
            createdAt: ghApp.createdAt,
          }
        : null,
      installUrl: ghApp?.htmlUrl ? `${ghApp.htmlUrl.replace(/\/+$/, '')}/installations/new` : null,
      installations: inst.map((i) => ({
        id: i.id,
        installationId: i.installationId,
        accountLogin: i.accountLogin,
        accountType: i.accountType,
        repositorySelection: i.repositorySelection,
        permissions: i.permissions,
        suspendedAt: i.suspendedAt,
        createdAt: i.createdAt,
      })),
      webUrl: config.githubWebUrl,
      webhookUrl,
      smeeEnabled: Boolean(config.smeeUrl),
      lastDeliveryAt: last?.receivedAt ?? null,
      lastDeliveryStatus: last?.status ?? null,
    };
  });

  app.post('/api/github/manifest', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseWith(ManifestSchema, req.body ?? {});
    const state = generateToken(24);
    const appName = body.appName ?? `git-merge-pilot-${randomBytes(3).toString('hex')}`;
    let built;
    try {
      built = buildAppManifest({
        publicUrl: config.publicUrl,
        appName,
        org: body.org ?? null,
        webUrl: config.githubWebUrl,
        webhookUrl: config.smeeUrl ?? null,
        state,
      });
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'Invalid manifest input');
    }
    reply.setCookie(STATE_COOKIE, `${state}.${body.returnTo}`, {
      path: '/api/github',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: STATE_TTL_SECONDS,
      signed: true,
    });
    await auditFromRequest(
      db,
      req,
      'github.manifest_created',
      { type: 'github_app' },
      {
        appName: built.manifest.name,
        org: body.org ?? null,
      },
    );
    return { postUrl: built.postUrl, manifest: built.manifest, state };
  });

  function readStateCookie(req: FastifyRequest): { state: string; returnTo: ReturnTo } | null {
    const raw = req.cookies[STATE_COOKIE];
    if (!raw) return null;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null;
    const idx = unsigned.value.lastIndexOf('.');
    if (idx <= 0) return null;
    const returnTo = unsigned.value.slice(idx + 1);
    return {
      state: unsigned.value.slice(0, idx),
      returnTo: returnTo === 'setup' ? 'setup' : 'settings',
    };
  }

  function redirectToLogin(req: FastifyRequest, reply: FastifyReply) {
    const next = req.url.slice(0, 1500);
    return reply.redirect(toWeb(`/login?next=${encodeURIComponent(next)}`), 302);
  }

  app.get(GITHUB_ROUTES.manifestCallback, async (req, reply) => {
    if (!req.auth) return redirectToLogin(req, reply);
    const stateCookie = readStateCookie(req);
    const returnTo: ReturnTo = stateCookie?.returnTo ?? 'settings';
    if (req.auth.user.role !== 'admin') {
      return reply.redirect(toWeb(returnPath(returnTo, { error: 'forbidden' })), 302);
    }
    const q = CallbackQuerySchema.safeParse(req.query);
    if (!q.success || !q.data.code) {
      return reply.redirect(toWeb(returnPath(returnTo, { error: 'missing_code' })), 302);
    }
    if (!stateCookie || !q.data.state || !timingSafeEqualStr(stateCookie.state, q.data.state)) {
      return reply.redirect(toWeb(returnPath(returnTo, { error: 'invalid_state' })), 302);
    }
    reply.clearCookie(STATE_COOKIE, { path: '/api/github' });
    const { user } = req.auth;
    let conv;
    try {
      conv = await ctx.github.convertManifestCode(q.data.code, { apiUrl: config.githubApiUrl });
    } catch (err) {
      req.log.warn({ err: describeError(err) }, 'GitHub manifest conversion failed');
      return reply.redirect(toWeb(returnPath(returnTo, { error: 'conversion_failed' })), 302);
    }
    const values = {
      orgId: user.orgId,
      appId: conv.appId,
      slug: conv.slug,
      name: conv.name,
      clientId: conv.clientId,
      clientSecretEnc: encrypt(conv.clientSecret, config.masterKey),
      privateKeyEnc: encrypt(conv.pem, config.masterKey),
      webhookSecretEnc: encrypt(conv.webhookSecret ?? '', config.masterKey),
      htmlUrl: conv.htmlUrl,
      ownerLogin: conv.ownerLogin,
    };
    const [row] = await db
      .insert(githubApps)
      .values(values)
      .onConflictDoUpdate({
        target: githubApps.appId,
        set: {
          orgId: values.orgId,
          slug: values.slug,
          name: values.name,
          clientId: values.clientId,
          clientSecretEnc: values.clientSecretEnc,
          privateKeyEnc: values.privateKeyEnc,
          webhookSecretEnc: values.webhookSecretEnc,
          htmlUrl: values.htmlUrl,
          ownerLogin: values.ownerLogin,
        },
      })
      .returning({ id: githubApps.id });
    await writeAudit(db, {
      orgId: user.orgId,
      userId: user.id,
      action: 'github.app_connected',
      targetType: 'github_app',
      targetId: row!.id,
      ip: req.ip,
      data: { appId: conv.appId, slug: conv.slug, ownerLogin: conv.ownerLogin },
    });
    if (!conv.webhookSecret) {
      req.log.warn('GitHub returned no webhook secret; webhook deliveries cannot be verified');
    }
    return reply.redirect(toWeb(returnPath(returnTo, { github: 'created' })), 302);
  });

  app.get(GITHUB_ROUTES.installCallback, async (req, reply) => {
    if (!req.auth) return redirectToLogin(req, reply);
    const [state] = await db.select().from(systemState).limit(1);
    const inSetup = !state?.setupCompletedAt;
    const target = (params: Record<string, string>) => {
      const qs = new URLSearchParams(params);
      if (inSetup) {
        qs.set('step', '3');
        return `/setup?${qs.toString()}`;
      }
      return `/settings/github?${qs.toString()}`;
    };
    if (req.auth.user.role !== 'admin')
      return reply.redirect(toWeb(target({ error: 'forbidden' })), 302);
    const q = InstallQuerySchema.safeParse(req.query);
    if (!q.success) return reply.redirect(toWeb(target({ error: 'invalid_request' })), 302);
    try {
      const summary = await syncInstallations(ctx, req.auth.user.orgId, req.log);
      await auditFromRequest(
        db,
        req,
        'github.installations_synced',
        { type: 'github_app' },
        {
          trigger: 'install_callback',
          installationId: q.data.installation_id ?? null,
          setupAction: q.data.setup_action ?? null,
          installations: summary.installations,
          addedRepositories: summary.addedRepositories,
        },
      );
      return reply.redirect(toWeb(target({ github: 'installed' })), 302);
    } catch (err) {
      req.log.warn({ err: describeError(err) }, 'installation sync after install callback failed');
      const code = err instanceof HttpError ? err.code : 'sync_failed';
      return reply.redirect(toWeb(target({ error: code })), 302);
    }
  });

  app.post('/api/github/sync-installations', { preHandler: requireAdmin }, async (req) => {
    const { user } = authOf(req);
    const summary = await syncInstallations(ctx, user.orgId, req.log);
    await auditFromRequest(
      db,
      req,
      'github.installations_synced',
      { type: 'github_app' },
      {
        trigger: 'manual',
        installations: summary.installations,
        addedRepositories: summary.addedRepositories,
        detachedRepositories: summary.detachedRepositories,
      },
    );
    return summary;
  });

  app.get('/api/github/repositories', { preHandler: requireAdmin }, async (req) => {
    const { user } = authOf(req);
    const ghApp = await getOrgApp(db, user.orgId);
    if (!ghApp) return [];
    const insts = await db
      .select()
      .from(installations)
      .where(and(eq(installations.orgId, user.orgId), eq(installations.githubAppId, ghApp.id)));
    const client = appClient(ctx, ghApp);
    const out: Array<{
      githubId: number;
      owner: string;
      name: string;
      fullName: string;
      private: boolean;
      archived: boolean;
      defaultBranch: string;
      installationId: number;
      htmlUrl: string;
      language: string | null;
    }> = [];
    const errors: string[] = [];
    for (const inst of insts) {
      if (inst.suspendedAt) continue;
      try {
        const repos = await client.listInstallationRepos(inst.installationId);
        for (const r of repos) {
          out.push({
            githubId: r.githubId,
            owner: r.owner,
            name: r.name,
            fullName: r.fullName,
            private: r.private,
            archived: r.archived,
            defaultBranch: r.defaultBranch,
            installationId: inst.installationId,
            htmlUrl: r.htmlUrl,
            language: r.language,
          });
        }
      } catch (err) {
        req.log.warn(
          { err: describeError(err), installationId: inst.installationId },
          'list repos failed',
        );
        errors.push(inst.accountLogin);
      }
    }
    const githubIds = out.map((r) => r.githubId);
    const tracked = githubIds.length
      ? await db
          .select({
            id: repositories.id,
            githubId: repositories.githubId,
            monitoringEnabled: repositories.monitoringEnabled,
          })
          .from(repositories)
          .where(and(eq(repositories.orgId, user.orgId), inArray(repositories.githubId, githubIds)))
      : [];
    const byGithubId = new Map(tracked.map((t) => [t.githubId, t]));
    if (errors.length && out.length === 0) {
      throw new HttpError(502, 'github_unavailable', 'Could not list repositories from GitHub.');
    }
    return out
      .map((r) => {
        const t = byGithubId.get(r.githubId);
        return {
          ...r,
          repositoryId: t?.id ?? null,
          monitoringEnabled: t?.monitoringEnabled ?? false,
        };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  });

  app.delete('/api/github/app', { preHandler: requireAdmin }, async (req) => {
    const { user } = authOf(req);
    const deleted = await db
      .delete(githubApps)
      .where(eq(githubApps.orgId, user.orgId))
      .returning({ id: githubApps.id, appId: githubApps.appId });
    if (deleted.length) {
      await db
        .update(repositories)
        .set({ monitoringEnabled: false })
        .where(eq(repositories.orgId, user.orgId));
    }
    await auditFromRequest(
      db,
      req,
      'github.app_disconnected',
      { type: 'github_app' },
      {
        appIds: deleted.map((d) => d.appId),
      },
    );
    return { ok: true, removed: deleted.length };
  });

  // --------------------------------------------------------------- webhook
  // Raw-body parsing is scoped to this encapsulated child so the rest of the API keeps JSON.
  await app.register(async (child) => {
    child.removeAllContentTypeParsers();
    child.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT },
      (_req, body, done) => done(null, body),
    );

    child.post(
      GITHUB_ROUTES.webhook,
      {
        bodyLimit: WEBHOOK_BODY_LIMIT,
        config: {
          csrfExempt: true,
          rawBody: true,
          rateLimit: { max: 3000, timeWindow: 60_000 },
        },
      },
      async (req, reply) => {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const signature = header(req, 'x-hub-signature-256');
        const deliveryId = header(req, 'x-github-delivery')?.trim();
        const event = header(req, 'x-github-event')?.trim();

        // 1. Verify the HMAC over the raw bytes before parsing anything.
        const secrets = await loadWebhookSecrets(db, config.masterKey);
        const match = signature
          ? secrets.find((s) => verifyWebhookSignature(s.secret, raw, signature))
          : undefined;
        if (!match) {
          req.log.warn(
            { deliveryId: deliveryId ?? null, event: event ?? null },
            'webhook signature rejected',
          );
          throw new HttpError(401, 'invalid_signature', 'Invalid webhook signature.');
        }
        if (
          !deliveryId ||
          !/^[A-Za-z0-9-]{1,100}$/.test(deliveryId) ||
          !event ||
          !/^[a-z_]{1,64}$/.test(event)
        ) {
          throw badRequest('Missing or invalid GitHub delivery headers.', 'invalid_headers');
        }

        // 2. Parse (JSON, or form-encoded `payload=` as GitHub may be configured to send).
        let payload: Record<string, unknown>;
        try {
          const ct = String(req.headers['content-type'] ?? '').toLowerCase();
          const text = raw.toString('utf8');
          const json = ct.startsWith('application/x-www-form-urlencoded')
            ? (new URLSearchParams(text).get('payload') ?? '')
            : text;
          const parsed = JSON.parse(json) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('not an object');
          payload = stripNul(parsed) as Record<string, unknown>;
        } catch {
          throw badRequest('Webhook payload is not valid JSON.', 'invalid_payload');
        }

        const action = typeof payload.action === 'string' ? payload.action.slice(0, 100) : null;
        const inst = payload.installation as { id?: unknown } | undefined;
        const installationId = typeof inst?.id === 'number' ? inst.id : null;
        const repo = payload.repository as { full_name?: unknown } | undefined;
        const repositoryFullName =
          typeof repo?.full_name === 'string' ? repo.full_name.slice(0, 300) : null;
        const handled = (WEBHOOK_EVENTS as readonly string[]).includes(event);
        const now = ctx.now();

        // 3. Store idempotently by delivery id.
        const inserted = await db
          .insert(webhookDeliveries)
          .values({
            orgId: match.orgId,
            deliveryId,
            event,
            action,
            installationId,
            repositoryFullName,
            payload,
            status: handled ? 'received' : 'ignored',
            receivedAt: now,
            processedAt: handled ? null : now,
            error: handled ? null : `Event "${event}" is not handled`,
          })
          .onConflictDoNothing({ target: webhookDeliveries.deliveryId })
          .returning({ id: webhookDeliveries.id });

        let row = inserted[0];
        let duplicate = false;
        if (!row) {
          duplicate = true;
          const [existing] = await db
            .select({ id: webhookDeliveries.id, status: webhookDeliveries.status })
            .from(webhookDeliveries)
            .where(eq(webhookDeliveries.deliveryId, deliveryId))
            .limit(1);
          // Re-enqueue when a previous attempt stored the delivery but never queued it, or
          // when processing permanently failed and the admin used GitHub's "Redeliver".
          // Deliveries that are queued, processed or ignored stay deduplicated.
          if (!existing || (existing.status !== 'received' && existing.status !== 'failed')) {
            return reply.status(202).send({ ok: true, duplicate: true, deliveryId });
          }
          if (existing.status === 'failed') {
            const reset = await db
              .update(webhookDeliveries)
              .set({ status: 'received', error: null, processedAt: null, receivedAt: now })
              .where(
                and(eq(webhookDeliveries.id, existing.id), eq(webhookDeliveries.status, 'failed')),
              )
              .returning({ id: webhookDeliveries.id });
            if (!reset[0]) {
              return reply.status(202).send({ ok: true, duplicate: true, deliveryId });
            }
          }
          row = { id: existing.id };
        }
        if (!handled) {
          return reply.status(202).send({ ok: true, ignored: true, deliveryId });
        }

        // 4. Enqueue processing; the worker does the rest.
        const job: WebhookProcessJob = {
          webhookDeliveryId: row.id,
          deliveryId,
          event,
          orgId: match.orgId,
        };
        try {
          await ctx.queue.send(QUEUES.webhookProcess, job, {
            singletonKey: `delivery:${deliveryId}`,
          });
          await db
            .update(webhookDeliveries)
            .set({ status: 'queued' })
            .where(and(eq(webhookDeliveries.id, row.id), eq(webhookDeliveries.status, 'received')));
        } catch (err) {
          // Delivery is stored with status "received"; a GitHub redelivery will retry the enqueue.
          req.log.error({ err, deliveryId }, 'failed to enqueue webhook delivery');
          throw new HttpError(
            503,
            'queue_unavailable',
            'Could not queue the delivery. Please redeliver.',
          );
        }
        return reply.status(202).send({ ok: true, duplicate, deliveryId });
      },
    );
  });
}
