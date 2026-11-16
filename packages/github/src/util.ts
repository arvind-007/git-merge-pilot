/**
 * Small internal helpers shared across the package: defensive accessors for
 * untrusted JSON (webhook payloads, API responses), HTTP error inspection and
 * a bounded-concurrency mapper.
 */

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function obj(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `login` of a GitHub user-ish object, or null. */
export function login(value: unknown): string | null {
  return str(obj(value)?.login);
}

/** Unique, order-preserving list of non-empty strings. */
export function uniqueStrings(values: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string' || v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Normalises any timestamp-ish value to an ISO-8601 string, or null. */
export function isoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value !== '') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Push payloads use epoch seconds for repository.pushed_at.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

/** HTTP status of an Octokit RequestError (or any error carrying `status`). */
export function httpStatus(err: unknown): number | null {
  if (!isObject(err) && !(err instanceof Error)) return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/** True when the error is a GitHub 404 Not Found. */
export function isNotFoundError(err: unknown): boolean {
  return httpStatus(err) === 404;
}

/**
 * True when the error means "this optional endpoint is not available to us":
 * missing permission, feature disabled (e.g. Advanced Security off), not found,
 * or gone. Used for graceful degradation of optional data.
 */
export function isUnavailableError(err: unknown): boolean {
  const status = httpStatus(err);
  return status === 403 || status === 404 || status === 410 || status === 451;
}

/** Short, secret-free description of an error for `limitations` notes. */
export function describeError(err: unknown): string {
  const status = httpStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split('\n')[0]?.slice(0, 200) ?? '';
  return status !== null ? `HTTP ${status}: ${firstLine}` : firstLine;
}

/** Maps `items` with at most `concurrency` promises in flight, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Decodes an Octokit response body that may be a string, ArrayBuffer or typed array. */
export function bodyToString(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder('utf-8').decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  return null;
}
