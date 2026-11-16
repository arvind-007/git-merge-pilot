import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { USER_ROLES, generateToken, sha256Hex } from '@gmp/core';
import { invites, sessions, users } from '@gmp/db';
import { auditFromRequest } from '../audit.ts';
import { authOf, requireAdmin } from '../auth/guard.ts';
import { badRequest, conflict, notFound, parseWith } from '../errors.ts';
import { EmailSchema, IdParamsSchema, NameSchema, TimezoneSchema } from '../validation.ts';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const InviteSchema = z
  .object({ email: EmailSchema, role: z.enum(USER_ROLES).optional().default('member') })
  .strict();

const PatchSchema = z
  .object({
    role: z.enum(USER_ROLES).optional(),
    disabled: z.boolean().optional(),
    name: NameSchema.optional(),
    timezone: TimezoneSchema.nullable().optional(),
  })
  .strict();

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.ctx;

  app.get('/api/users', { preHandler: requireAdmin }, async (req) => {
    const { user } = authOf(req);
    const list = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        disabled: users.disabled,
        timezone: users.timezone,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.orgId, user.orgId))
      .orderBy(users.name);
    const pending = await db
      .select({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        expiresAt: invites.expiresAt,
        acceptedAt: invites.acceptedAt,
        createdAt: invites.createdAt,
      })
      .from(invites)
      .where(
        and(
          eq(invites.orgId, user.orgId),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, app.ctx.now()),
        ),
      )
      .orderBy(desc(invites.createdAt));
    return { users: list, invites: pending };
  });

  app.post('/api/users/invite', { preHandler: requireAdmin }, async (req, reply) => {
    const body = parseWith(InviteSchema, req.body);
    const { user } = authOf(req);
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, user.orgId), sql`lower(${users.email}) = ${body.email}`));
    if (existing) throw conflict('A user with this email already exists.', 'user_exists');
    const token = generateToken(32);
    const expiresAt = new Date(app.ctx.now().getTime() + INVITE_TTL_MS);
    const row = await db.transaction(async (tx) => {
      // A new invite replaces any earlier pending invite for the same address.
      await tx
        .delete(invites)
        .where(
          and(
            eq(invites.orgId, user.orgId),
            eq(invites.email, body.email),
            isNull(invites.acceptedAt),
          ),
        );
      const [inv] = await tx
        .insert(invites)
        .values({
          orgId: user.orgId,
          email: body.email,
          role: body.role,
          tokenHash: sha256Hex(token),
          expiresAt,
          createdBy: user.id,
        })
        .returning();
      return inv!;
    });
    await auditFromRequest(
      db,
      req,
      'user.invited',
      { type: 'invite', id: row.id },
      {
        email: body.email,
        role: body.role,
      },
    );
    return reply.status(201).send({
      id: row.id,
      email: row.email,
      role: row.role,
      inviteUrl: `${config.webUrl}/invite/${encodeURIComponent(token)}`,
      expiresAt,
    });
  });

  app.delete('/api/users/invites/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const { user } = authOf(req);
    const deleted = await db
      .delete(invites)
      .where(and(eq(invites.id, id), eq(invites.orgId, user.orgId), isNull(invites.acceptedAt)))
      .returning({ email: invites.email });
    if (!deleted.length) throw notFound('Invite not found.');
    await auditFromRequest(
      db,
      req,
      'user.invite_revoked',
      { type: 'invite', id },
      { email: deleted[0]!.email },
    );
    return { ok: true };
  });

  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = parseWith(IdParamsSchema, req.params);
    const body = parseWith(PatchSchema, req.body);
    const { user } = authOf(req);
    const [target] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.orgId, user.orgId)))
      .limit(1);
    if (!target) throw notFound('User not found.');

    const losingAdmin =
      target.role === 'admin' &&
      !target.disabled &&
      ((body.role !== undefined && body.role !== 'admin') || body.disabled === true);
    if (losingAdmin) {
      if (target.id === user.id) {
        throw badRequest(
          'You cannot remove your own admin access or disable yourself.',
          'self_lockout',
        );
      }
      const [others] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(
          and(
            eq(users.orgId, user.orgId),
            eq(users.role, 'admin'),
            eq(users.disabled, false),
            ne(users.id, target.id),
          ),
        );
      if ((others?.n ?? 0) === 0)
        throw badRequest('At least one active admin is required.', 'last_admin');
    }
    const set: Partial<typeof users.$inferInsert> = {};
    if (body.role !== undefined) set.role = body.role;
    if (body.disabled !== undefined) set.disabled = body.disabled;
    if (body.name !== undefined) set.name = body.name;
    if (body.timezone !== undefined) set.timezone = body.timezone;
    if (Object.keys(set).length === 0) throw badRequest('Nothing to update.');
    const [row] = await db.update(users).set(set).where(eq(users.id, id)).returning();
    if (body.disabled === true || (body.role !== undefined && body.role !== target.role)) {
      // Force re-authentication so the new role/state takes effect everywhere.
      if (target.id !== user.id) await db.delete(sessions).where(eq(sessions.userId, id));
    }
    await auditFromRequest(
      db,
      req,
      'user.updated',
      { type: 'user', id },
      {
        email: target.email,
        changes: set,
      },
    );
    return {
      id: row!.id,
      email: row!.email,
      name: row!.name,
      role: row!.role,
      disabled: row!.disabled,
      timezone: row!.timezone,
      lastLoginAt: row!.lastLoginAt,
      createdAt: row!.createdAt,
    };
  });
}
