import type { FastifyInstance } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { sha256Hex } from '@gmp/core';
import { aiSettings, invites, organizations, sessions, systemState, users } from '@gmp/db';
import { writeAudit } from '../audit.ts';
import { authOf, requireAdmin, requireAuth } from '../auth/guard.ts';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyDummyPassword,
  verifyPassword,
} from '../auth/password.ts';
import { buildMeResponse, clearSessionCookie, startSession } from '../auth/session.ts';
import type { AuthUser } from '../context.ts';
import { HttpError, conflict, parseWith, unauthorized } from '../errors.ts';
import { adminExists, ensureSystemState, setupTokenMatches } from '../setup-token.ts';
import { EmailSchema, NameSchema, TimezoneSchema } from '../validation.ts';
import { QUEUES } from '../queue.ts';

const PasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH);

const SetupAdminSchema = z.object({
  setupToken: z.string().trim().min(1, 'Setup token is required').max(200),
  orgName: z.string().trim().min(1).max(120).optional().default('My organization'),
  email: EmailSchema,
  name: NameSchema,
  password: PasswordSchema,
  timezone: TimezoneSchema.optional().default('UTC'),
});

const LoginSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const AcceptInviteSchema = z.object({
  token: z.string().trim().min(10).max(200),
  name: NameSchema,
  password: PasswordSchema,
  timezone: TimezoneSchema.optional(),
});

const SetupStepSchema = z.object({ step: z.number().int().min(1).max(7) });

export interface AuthRouteLimits {
  login: { max: number; timeWindow: number };
}

export function authRoutes(limits: AuthRouteLimits) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const { db } = app.ctx;
    const strict = { rateLimit: { max: limits.login.max, timeWindow: limits.login.timeWindow } };

    // ---------------------------------------------------------------- setup
    app.get('/api/setup/status', async () => {
      const state = await ensureSystemState(db);
      const hasAdmin = await adminExists(db);
      return {
        completed: Boolean(state.setupCompletedAt),
        adminCreated: hasAdmin,
        step: hasAdmin ? Math.max(2, state.setupStep) : 1,
        setupTokenRequired: !hasAdmin,
        completedAt: state.setupCompletedAt,
      };
    });

    app.post(
      '/api/setup/admin',
      { config: { ...strict, csrfExempt: true } },
      async (req, reply) => {
        const body = parseWith(SetupAdminSchema, req.body);
        const result = await db.transaction(async (tx) => {
          await ensureSystemState(tx);
          // Serialize concurrent attempts on the singleton row.
          const [state] = await tx
            .select()
            .from(systemState)
            .where(eq(systemState.singleton, true))
            .for('update');
          if (await adminExists(tx)) {
            throw conflict('Setup has already been completed. Please sign in.', 'setup_done');
          }
          if (!setupTokenMatches(state?.setupTokenHash ?? null, body.setupToken)) {
            throw new HttpError(
              401,
              'invalid_setup_token',
              'The setup token is invalid. Use the token printed in the server log.',
            );
          }
          const [org] = await tx
            .insert(organizations)
            .values({ name: body.orgName, timezone: body.timezone })
            .returning();
          const [user] = await tx
            .insert(users)
            .values({
              orgId: org!.id,
              email: body.email,
              name: body.name,
              passwordHash: await hashPassword(body.password),
              role: 'admin',
              timezone: body.timezone,
              lastLoginAt: app.ctx.now(),
            })
            .returning();
          await tx.insert(aiSettings).values({ orgId: org!.id }).onConflictDoNothing();
          await tx
            .update(systemState)
            .set({ setupTokenHash: null, setupStep: 2 })
            .where(eq(systemState.singleton, true));
          const authUser: AuthUser = {
            id: user!.id,
            orgId: org!.id,
            email: user!.email,
            name: user!.name,
            role: 'admin',
            timezone: user!.timezone,
          };
          await writeAudit(tx, {
            orgId: org!.id,
            userId: user!.id,
            action: 'setup.admin_created',
            targetType: 'user',
            targetId: user!.id,
            ip: req.ip,
            data: { email: user!.email, orgName: org!.name },
          });
          const me = await startSession(req, reply, app.ctx, tx, authUser);
          return me;
        });
        app.ctx.logger.info({ orgId: result.org.id }, 'first admin created; setup token cleared');
        return reply.status(201).send(result);
      },
    );

    app.put('/api/setup/step', { preHandler: requireAdmin }, async (req) => {
      const { step } = parseWith(SetupStepSchema, req.body);
      await ensureSystemState(db);
      const [row] = await db
        .update(systemState)
        .set({ setupStep: step })
        .where(eq(systemState.singleton, true))
        .returning();
      await writeAudit(db, {
        orgId: req.auth!.user.orgId,
        userId: req.auth!.user.id,
        action: 'setup.step_updated',
        ip: req.ip,
        data: { step },
      });
      return { completed: Boolean(row?.setupCompletedAt), adminCreated: true, step };
    });

    app.post('/api/setup/complete', { preHandler: requireAdmin }, async (req) => {
      await ensureSystemState(db);
      const now = app.ctx.now();
      const [row] = await db
        .update(systemState)
        .set({
          setupCompletedAt: sql`coalesce(${systemState.setupCompletedAt}, ${now.toISOString()}::timestamptz)`,
          setupStep: 7,
        })
        .where(eq(systemState.singleton, true))
        .returning();
      await writeAudit(db, {
        orgId: req.auth!.user.orgId,
        userId: req.auth!.user.id,
        action: 'setup.completed',
        ip: req.ip,
      });
      // Import open pull requests of the monitored repositories now, not at the next cron tick.
      await app.ctx.queue
        .send(QUEUES.reconcilePoll, {})
        .catch((err: unknown) => req.log.warn({ err }, 'could not enqueue initial reconcile'));
      return { completed: true, adminCreated: true, step: 7, completedAt: row?.setupCompletedAt };
    });

    // ----------------------------------------------------------------- auth
    app.post('/api/auth/login', { config: { ...strict, csrfExempt: true } }, async (req, reply) => {
      const body = parseWith(LoginSchema, req.body);
      const candidates = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${body.email}`)
        .limit(5);
      let matched: (typeof candidates)[number] | null = null;
      if (candidates.length === 0) {
        await verifyDummyPassword(body.password);
      }
      for (const u of candidates) {
        if (await verifyPassword(u.passwordHash, body.password)) {
          matched = u;
          break;
        }
      }
      if (!matched || matched.disabled) {
        req.log.info({ reason: matched ? 'disabled' : 'bad_credentials' }, 'login rejected');
        throw unauthorized('Invalid email or password.', 'invalid_credentials');
      }
      // Rotate: drop the session this browser had, if any.
      if (req.auth) await db.delete(sessions).where(eq(sessions.id, req.auth.session.id));
      const now = app.ctx.now();
      await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, matched.id));
      const authUser: AuthUser = {
        id: matched.id,
        orgId: matched.orgId,
        email: matched.email,
        name: matched.name,
        role: matched.role,
        timezone: matched.timezone,
      };
      const me = await startSession(req, reply, app.ctx, db, authUser);
      await writeAudit(db, {
        orgId: matched.orgId,
        userId: matched.id,
        action: 'auth.login',
        targetType: 'user',
        targetId: matched.id,
        ip: req.ip,
      });
      return me;
    });

    app.post('/api/auth/logout', async (req, reply) => {
      if (req.auth) {
        await db.delete(sessions).where(eq(sessions.id, req.auth.session.id));
      }
      clearSessionCookie(reply, app.ctx);
      req.auth = null;
      return { ok: true };
    });

    app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
      const auth = authOf(req);
      return buildMeResponse(db, auth.user, auth.session.csrfToken);
    });

    app.post(
      '/api/auth/invite/accept',
      { config: { ...strict, csrfExempt: true } },
      async (req, reply) => {
        const body = parseWith(AcceptInviteSchema, req.body);
        const now = app.ctx.now();
        const result = await db.transaction(async (tx) => {
          const [invite] = await tx
            .select()
            .from(invites)
            .where(
              and(
                eq(invites.tokenHash, sha256Hex(body.token)),
                isNull(invites.acceptedAt),
                gt(invites.expiresAt, now),
              ),
            )
            .for('update')
            .limit(1);
          if (!invite) {
            throw new HttpError(
              400,
              'invite_invalid',
              'This invitation link is invalid or has expired. Ask an admin for a new one.',
            );
          }
          const [existing] = await tx
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.orgId, invite.orgId),
                sql`lower(${users.email}) = ${invite.email.toLowerCase()}`,
              ),
            )
            .limit(1);
          if (existing)
            throw conflict('An account with this email already exists. Please sign in.');
          const [org] = await tx
            .select({ timezone: organizations.timezone })
            .from(organizations)
            .where(eq(organizations.id, invite.orgId));
          const [user] = await tx
            .insert(users)
            .values({
              orgId: invite.orgId,
              email: invite.email.toLowerCase(),
              name: body.name,
              passwordHash: await hashPassword(body.password),
              role: invite.role,
              timezone: body.timezone ?? org?.timezone ?? null,
              lastLoginAt: now,
            })
            .returning();
          await tx.update(invites).set({ acceptedAt: now }).where(eq(invites.id, invite.id));
          await writeAudit(tx, {
            orgId: invite.orgId,
            userId: user!.id,
            action: 'auth.invite_accepted',
            targetType: 'invite',
            targetId: invite.id,
            ip: req.ip,
            data: { email: user!.email, role: user!.role },
          });
          const authUser: AuthUser = {
            id: user!.id,
            orgId: user!.orgId,
            email: user!.email,
            name: user!.name,
            role: user!.role,
            timezone: user!.timezone,
          };
          return startSession(req, reply, app.ctx, tx, authUser);
        });
        return reply.status(201).send(result);
      },
    );
  };
}
