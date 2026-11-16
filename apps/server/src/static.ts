import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/** Locates the built SPA (apps/web/dist): explicit, GMP_WEB_DIST, next to this module, or cwd. */
export function resolveWebDist(explicit?: string | null): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit ?? undefined,
    process.env.GMP_WEB_DIST,
    resolve(here, '../../web/dist'), // apps/server/src → apps/web/dist, apps/server/dist → apps/web/dist
    resolve(process.cwd(), 'apps/web/dist'),
    resolve(process.cwd(), '../web/dist'),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return resolve(c);
  }
  return null;
}

/**
 * Serves the SPA with an index.html fallback for client-side routes. API and unknown asset
 * paths still return JSON 404s.
 */
export async function registerStatic(app: FastifyInstance, webDist: string | null): Promise<void> {
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: false,
      index: false,
      setHeaders(res, path) {
        if (/[/\\]assets[/\\]/.test(path)) {
          res.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
          res.header('cache-control', 'no-cache');
        }
      },
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
    const isAsset = /\.[a-z0-9]{1,8}$/i.test(path);
    if (
      webDist &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !path.startsWith('/api/') &&
      path !== '/api' &&
      !isAsset &&
      (wantsHtml || path === '/')
    ) {
      reply.header('cache-control', 'no-cache');
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    if (!webDist && !path.startsWith('/api') && wantsHtml) {
      return reply
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('The git-merge-pilot web UI has not been built. Run `pnpm --filter @gmp/web build`.');
    }
    return reply.status(404).send({ error: 'Not Found', message: 'Not found.', code: 'not_found' });
  });
}
