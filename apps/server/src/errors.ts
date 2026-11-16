import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type z } from 'zod';
import { redactSecrets, type Logger } from '@gmp/core';

/** An error with an HTTP status and a stable machine-readable code, safe to show to clients. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Please sign in.', code = 'unauthorized') =>
  new HttpError(401, code, message);
export const forbidden = (message = 'You do not have permission to do that.', code = 'forbidden') =>
  new HttpError(403, code, message);
export const notFound = (message = 'Not found.', code = 'not_found') =>
  new HttpError(404, code, message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export interface ErrorBody {
  error: string;
  message: string;
  code: string;
  issues?: unknown;
}

export function zodIssues(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
}

/** Parses `data` with `schema`, throwing a 400 HttpError listing the issues on failure. */
export function parseWith<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const res = schema.safeParse(data);
  if (!res.success) {
    throw new HttpError(400, 'validation_error', 'Some fields are invalid.', zodIssues(res.error));
  }
  return res.data;
}

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
}

function pgCode(err: unknown): string | null {
  // drizzle wraps driver errors; the pg error is on `cause`.
  let cur: unknown = err;
  for (let i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
    const c = (cur as PgLikeError).code;
    if (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Maps any thrown value to a status + safe JSON body. Never includes stacks or secrets. */
export function toErrorResponse(
  err: unknown,
  opts: { isProduction: boolean },
): { status: number; body: ErrorBody; log: boolean } {
  if (err instanceof HttpError) {
    const body: ErrorBody = {
      error: STATUS_TEXT[err.statusCode] ?? 'Error',
      message: err.message,
      code: err.code,
    };
    if (err.details !== undefined) body.issues = err.details;
    return { status: err.statusCode, body, log: err.statusCode >= 500 };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: 'Bad Request',
        message: 'Some fields are invalid.',
        code: 'validation_error',
        issues: zodIssues(err),
      },
      log: false,
    };
  }
  const code = pgCode(err);
  if (code === '23505') {
    return {
      status: 409,
      body: { error: 'Conflict', message: 'This already exists.', code: 'conflict' },
      log: false,
    };
  }
  if (code === '23503' || code === '22P02' || code === '23514') {
    return {
      status: 400,
      body: {
        error: 'Bad Request',
        message: 'The request refers to invalid data.',
        code: 'invalid_reference',
      },
      log: true,
    };
  }
  const fe = err as Partial<FastifyError> & { statusCode?: number };
  const status = typeof fe?.statusCode === 'number' ? fe.statusCode : 500;
  if (status >= 400 && status < 500) {
    const message =
      status === 429
        ? 'Too many requests. Please wait a moment and try again.'
        : redactSecrets(String(fe.message ?? 'Bad request')).text;
    return {
      status,
      body: {
        error: STATUS_TEXT[status] ?? 'Error',
        message,
        code: status === 429 ? 'rate_limited' : String(fe.code ?? 'bad_request').toLowerCase(),
      },
      log: false,
    };
  }
  const message =
    !opts.isProduction && err instanceof Error
      ? redactSecrets(err.message).text
      : 'Something went wrong on the server.';
  return {
    status: status >= 500 ? status : 500,
    body: { error: STATUS_TEXT[500]!, message, code: 'internal_error' },
    log: true,
  };
}

export function makeErrorHandler(opts: { isProduction: boolean; logger: Logger }) {
  return (err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const { status, body, log } = toErrorResponse(err, opts);
    if (log) req.log.error({ err, statusCode: status }, 'request failed');
    void reply.status(status).send(body);
  };
}
