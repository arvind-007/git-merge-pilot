/**
 * Fastify application factory (design §12, §14). `buildServer` wires plugins, auth hooks and
 * routes around injected dependencies so tests can run it with `inject()` against a test DB.
 */
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import { createProvider } from '@gmp/ai';
import { createLogger, setMasterKey, type Config, type Logger } from '@gmp/core';
import type { Database } from '@gmp/db';
import { convertManifestCode, createGitHubClient } from '@gmp/github';
import type { TestChannelOptions } from '@gmp/notify';
import { installAuthHooks } from './auth/guard.ts';
import { DEFAULT_SESSION_TTL_MS } from './auth/session.ts';
import type { GitHubDeps, ServerContext } from './context.ts';
import { makeErrorHandler } from './errors.ts';
import type { JobQueue } from './queue.ts';
import { aiRoutes } from './routes/ai.ts';
import { authRoutes } from './routes/auth.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { githubRoutes } from './routes/github.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { projectRoutes } from './routes/projects.ts';
import { pullRequestRoutes } from './routes/pull-requests.ts';
import { repositoryRoutes } from './routes/repositories.ts';
import { systemRoutes } from './routes/system.ts';
import { userRoutes } from './routes/users.ts';
import { registerStatic, resolveWebDist } from './static.ts';

export const SERVER_VERSION = '0.1.0';

export interface RateLimitOptions {
  /** Requests per window per client IP for the whole API (default 600/min). */
  max?: number;
  /** Stricter limit for login, setup and invite acceptance (default 10/min). */
  loginMax?: number;
  /** Window in ms (default 60 000). */
  timeWindow?: number;
}

/**
 * One compact line per request (method, path without query string, status, duration). The query
 * string is never logged: OAuth/manifest callbacks carry one-time codes there.
 */
class RequestLogController extends LogController {
  override incomingRequest(): void {}

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    if (this.isLogDisabled(request)) return;
    const data = {
      method: request.method,
      path: request.url.split('?')[0],
      statusCode: reply.statusCode,
      responseTimeMs: Math.round(reply.elapsedTime),
    };
    if (error) reply.log.error({ ...data, err: error }, 'request errored');
    else reply.log.info(data, 'request completed');
  }
}

export interface BuildServerOptions {
  config: Config;
  db: Database;
  queue: JobQueue;
  logger?: Logger;
  /** Override GitHub integrations (tests). */
  github?: Partial<GitHubDeps>;
  /** Override AI provider construction (tests use FakeAiProvider). */
  aiProviderFactory?: ServerContext['aiProviderFactory'];
  /** Options passed to @gmp/notify testChannel (tests inject fake senders). */
  notifyTestOptions?: TestChannelOptions;
  /** Built SPA directory; `undefined` = auto-detect, `null` = do not serve the SPA. */
  webDist?: string | null;
  /** `false` disables rate limiting entirely. */
  rateLimit?: RateLimitOptions | false;
  /** Trust X-Forwarded-* headers (set when running behind a reverse proxy). */
  trustProxy?: boolean | string;
  sessionTtlMs?: number;
  now?: () => Date;
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const logger = opts.logger ?? createLogger('server', { level: config.logLevel });
  setMasterKey(config.masterKey);

  const ctx: ServerContext = {
    config,
    db: opts.db,
    queue: opts.queue,
    logger,
    github: {
      convertManifestCode: opts.github?.convertManifestCode ?? convertManifestCode,
      createClient: opts.github?.createClient ?? ((creds) => createGitHubClient(creds, { logger })),
    },
    aiProviderFactory: opts.aiProviderFactory ?? ((cfg) => createProvider(cfg)),
    notifyTestOptions: opts.notifyTestOptions ?? {},
    now: opts.now ?? (() => new Date()),
    version: SERVER_VERSION,
    sessionTtlMs: opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  };

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: 1024 * 1024,
    logController: new RequestLogController({
      disableRequestLogging: (req) => (req.url ?? '').startsWith('/healthz'),
    }),
    routerOptions: { ignoreTrailingSlash: true },
  });
  app.decorate('ctx', ctx);
  app.setErrorHandler(makeErrorHandler({ isProduction: config.isProduction, logger }));

  await app.register(fastifyCookie, { secret: config.sessionSecret });

  const secure = config.publicUrl.startsWith('https://');
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://avatars.githubusercontent.com'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        // The GitHub App manifest flow submits a form to GitHub.
        formAction: ["'self'", config.githubWebUrl],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        manifestSrc: ["'self'"],
        ...(secure ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: secure ? { maxAge: 15552000, includeSubDomains: false } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  const rl = opts.rateLimit === false ? null : (opts.rateLimit ?? {});
  const timeWindow = rl?.timeWindow ?? 60_000;
  if (rl) {
    await app.register(fastifyRateLimit, {
      global: true,
      max: rl.max ?? 600,
      timeWindow,
      allowList: (req) => (req.url.split('?')[0] ?? '') === '/healthz',
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        error: 'Too Many Requests',
        code: 'rate_limited',
        message: `Too many requests. Please wait ${Math.ceil(context.ttl / 1000)}s and try again.`,
      }),
    });
  }

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  installAuthHooks(app);

  app.get('/healthz', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await ctx.db.execute(sql`select 1`);
      return { status: 'ok', version: SERVER_VERSION };
    } catch {
      return reply.status(503).send({ status: 'error', database: false });
    }
  });

  await app.register(authRoutes({ login: { max: rl?.loginMax ?? 10, timeWindow } }));
  await app.register(githubRoutes);
  await app.register(repositoryRoutes);
  await app.register(projectRoutes);
  await app.register(pullRequestRoutes);
  await app.register(dashboardRoutes);
  await app.register(aiRoutes);
  await app.register(notificationRoutes);
  await app.register(userRoutes);
  await app.register(systemRoutes);

  const webDist = opts.webDist === undefined ? resolveWebDist() : opts.webDist;
  if (!webDist && opts.webDist === undefined) {
    logger.warn('web UI build not found (apps/web/dist); only the API is served');
  }
  await registerStatic(app, webDist);

  return app;
}
