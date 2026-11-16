/**
 * Minimal typed fetch wrapper for the git-merge-pilot API.
 *
 * - Always sends cookies (`credentials: 'include'`).
 * - Mutating requests carry the `x-gmp-csrf` header. The token comes from `GET /api/auth/me`; if it
 *   is not known yet it is fetched lazily, and a CSRF rejection is retried once with a fresh token.
 * - Failures are thrown as `ApiError` with a friendly, plain-language `message`.
 */

export const CSRF_HEADER = 'x-gmp-csrf';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** Raw server-provided message (may be technical). */
  readonly serverMessage: string | undefined;
  readonly details: unknown;

  constructor(opts: {
    status: number;
    message: string;
    code?: string | undefined;
    serverMessage?: string | undefined;
    details?: unknown;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.serverMessage = opts.serverMessage;
    this.details = opts.details;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

interface ErrorBody {
  error?: unknown;
  message?: unknown;
  code?: unknown;
  issues?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Turn an HTTP status + server body into a message suitable for non-developers. */
export function friendlyMessage(status: number, body: ErrorBody | null): string {
  const serverMsg = str(body?.message) ?? str(body?.error);
  switch (status) {
    case 0:
      return 'Could not reach the git-merge-pilot server. Check that it is running and your network connection is working.';
    case 400:
    case 422:
      return (
        serverMsg ??
        'Some of the information entered is not valid. Please check the form and try again.'
      );
    case 401:
      return serverMsg && /invalid|incorrect|wrong/i.test(serverMsg)
        ? serverMsg
        : 'Your session has ended. Please sign in again.';
    case 403:
      if (str(body?.code)?.toLowerCase().includes('csrf')) {
        return 'Your session security token expired. Please reload the page and try again.';
      }
      return serverMsg ?? 'You do not have permission to do that. Ask an admin if you need access.';
    case 404:
      return serverMsg ?? 'We could not find what you were looking for. It may have been removed.';
    case 409:
      return serverMsg ?? 'This conflicts with something that already exists.';
    case 413:
      return 'That request was too large.';
    case 429:
      return 'Too many requests in a short time. Please wait a moment and try again.';
    case 502:
    case 503:
    case 504:
      return 'The server is temporarily unavailable. Please try again in a minute.';
    default:
      if (status >= 500) {
        return 'Something went wrong on the server. Please try again; if it keeps happening, check System status.';
      }
      return serverMsg ?? `Request failed (HTTP ${status}).`;
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  /** Internal: set on the CSRF retry so we only retry once. */
  _retried?: boolean;
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json') || /^[[{]/.test(text.trim())) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

async function ensureCsrfToken(): Promise<string | null> {
  if (csrfToken) return csrfToken;
  try {
    const res = await fetch('/api/auth/me', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await parseBody(res)) as { csrfToken?: unknown } | null;
    if (body && typeof body.csrfToken === 'string') csrfToken = body.csrfToken;
  } catch {
    // ignore: the actual request will surface the error
  }
  return csrfToken;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const mutating = MUTATING.has(method);
  if (mutating) {
    const token = await ensureCsrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }

  let res: Response;
  try {
    const init: RequestInit = { method, headers, credentials: 'include' };
    if (body !== undefined) init.body = body;
    if (opts.signal) init.signal = opts.signal;
    res = await fetch(buildUrl(path, opts.query), init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError({ status: 0, message: friendlyMessage(0, null) });
  }

  const data = await parseBody(res);
  if (res.ok) return data as T;

  const errBody = data && typeof data === 'object' ? (data as ErrorBody) : null;
  const code = str(errBody?.code);

  // Stale CSRF token: refresh once and retry.
  if (
    mutating &&
    res.status === 403 &&
    !opts._retried &&
    (code?.toLowerCase().includes('csrf') ?? false)
  ) {
    csrfToken = null;
    await ensureCsrfToken();
    return request<T>(path, { ...opts, _retried: true });
  }
  if (res.status === 401) csrfToken = null;

  throw new ApiError({
    status: res.status,
    code,
    serverMessage: str(errBody?.message) ?? str(errBody?.error),
    message: friendlyMessage(res.status, errBody),
    details: errBody?.issues,
  });
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) =>
    request<T>(path, query ? { query } : {}),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ?? {} }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, body === undefined ? { method: 'DELETE' } : { method: 'DELETE', body }),
};

/**
 * Normalise list responses. Accepts a bare array, `{ items }`, `{ data }` or `{ [key]: [] }`.
 */
export function asList<T>(raw: unknown, key?: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const k of [key, 'items', 'data', 'results'].filter(Boolean) as string[]) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
  }
  return [];
}

/** Message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong.';
}
