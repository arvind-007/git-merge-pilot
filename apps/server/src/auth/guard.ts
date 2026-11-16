import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqualStr } from '@gmp/core';
import { computeAccessScope, type AccessScope } from '../access.ts';
import type { AuthContext } from '../context.ts';
import { HttpError, forbidden, unauthorized } from '../errors.ts';
import { CSRF_HEADER, SESSION_COOKIE, loadSession } from './session.ts';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Installs the global auth hook: resolves the session cookie on /api requests, then enforces
 * the CSRF header (`x-gmp-csrf` = session csrf token) on mutating requests made with a session,
 * and JSON-only bodies on mutating API requests.
 */
export function installAuthHooks(app: FastifyInstance): void {
  app.decorateRequest('auth', null);
  app.decorateRequest('accessScope', null);

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    const routeConfig = req.routeOptions.config;

    if (MUTATING.has(req.method) && !routeConfig?.rawBody) {
      const len = Number(req.headers['content-length'] ?? 0);
      const hasBody = len > 0 || req.headers['transfer-encoding'] !== undefined;
      const ct = String(req.headers['content-type'] ?? '').toLowerCase();
      if (hasBody && !ct.startsWith('application/json')) {
        throw new HttpError(415, 'unsupported_media_type', 'Requests must be sent as JSON.');
      }
    }

    const token = req.cookies[SESSION_COOKIE];
    if (token) req.auth = await loadSession(app.ctx.db, token, app.ctx, reply);

    if (req.auth && MUTATING.has(req.method) && !routeConfig?.csrfExempt) {
      const header = req.headers[CSRF_HEADER];
      const value = Array.isArray(header) ? header[0] : header;
      if (!value || !timingSafeEqualStr(value, req.auth.session.csrfToken)) {
        throw new HttpError(
          403,
          'csrf_invalid',
          'Your session security token is missing or expired. Reload the page and try again.',
        );
      }
    }
  });
}

/** preHandler: requires a signed-in user. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.auth) throw unauthorized();
}

/** preHandler: requires a signed-in admin. */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.auth) throw unauthorized();
  if (req.auth.user.role !== 'admin') throw forbidden('Only admins can do that.');
}

export function authOf(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Per-request memoized access scope. */
export function scopeOf(req: FastifyRequest, app: FastifyInstance): Promise<AccessScope> {
  const auth = authOf(req);
  req.accessScope ??= computeAccessScope(app.ctx.db, auth.user);
  return req.accessScope;
}
