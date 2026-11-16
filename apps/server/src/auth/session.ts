import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, lt } from 'drizzle-orm';
import { generateToken, sha256Hex } from '@gmp/core';
import { organizations, sessions, users, type Database, type DbOrTx } from '@gmp/db';
import type { AuthContext, AuthUser, ServerContext } from '../context.ts';

export const SESSION_COOKIE = 'gmp_session';
export const CSRF_HEADER = 'x-gmp-csrf';
export const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
  id: string;
}

export async function createSession(
  db: DbOrTx,
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null; ttlMs: number; now: Date },
): Promise<CreatedSession> {
  const token = generateToken(32);
  const csrfToken = generateToken(24);
  const expiresAt = new Date(meta.now.getTime() + meta.ttlMs);
  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: sha256Hex(token),
      csrfToken,
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    })
    .returning({ id: sessions.id });
  return { token, csrfToken, expiresAt, id: row!.id };
}

export function setSessionCookie(
  reply: FastifyReply,
  ctx: ServerContext,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, ctx: ServerContext): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
  });
}

/** Resolves the session cookie into an AuthContext (or null), sliding the expiry when due. */
export async function loadSession(
  db: Database,
  token: string,
  ctx: ServerContext,
  reply: FastifyReply,
): Promise<AuthContext | null> {
  if (!token || token.length > 200) return null;
  const now = ctx.now();
  const rows = await db
    .select({
      sessionId: sessions.id,
      csrfToken: sessions.csrfToken,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      orgId: users.orgId,
      email: users.email,
      name: users.name,
      role: users.role,
      timezone: users.timezone,
      disabled: users.disabled,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row || row.disabled) return null;

  let expiresAt = row.expiresAt;
  if (expiresAt.getTime() - now.getTime() < ctx.sessionTtlMs / 2) {
    expiresAt = new Date(now.getTime() + ctx.sessionTtlMs);
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, row.sessionId));
    setSessionCookie(reply, ctx, token, expiresAt);
  }
  const user: AuthUser = {
    id: row.userId,
    orgId: row.orgId,
    email: row.email,
    name: row.name,
    role: row.role,
    timezone: row.timezone,
  };
  return { user, session: { id: row.sessionId, csrfToken: row.csrfToken, expiresAt } };
}

export async function deleteExpiredSessions(db: Database, now: Date): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    role: AuthUser['role'];
    timezone: string | null;
  };
  org: { id: string; name: string; timezone: string };
  csrfToken: string;
}

export async function buildMeResponse(
  db: DbOrTx,
  user: AuthUser,
  csrfToken: string,
): Promise<MeResponse> {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, user.orgId))
    .limit(1);
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone,
    },
    org: org ?? { id: user.orgId, name: '', timezone: 'UTC' },
    csrfToken,
  };
}

/** Starts a session for `user`, sets the cookie, and returns the /me payload. */
export async function startSession(
  req: FastifyRequest,
  reply: FastifyReply,
  ctx: ServerContext,
  db: DbOrTx,
  user: AuthUser,
): Promise<MeResponse> {
  const s = await createSession(db, user.id, {
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlMs: ctx.sessionTtlMs,
    now: ctx.now(),
  });
  setSessionCookie(reply, ctx, s.token, s.expiresAt);
  req.auth = { user, session: { id: s.id, csrfToken: s.csrfToken, expiresAt: s.expiresAt } };
  return buildMeResponse(db, user, s.csrfToken);
}
