import { redactSecrets, type RiskLevel, type Severity } from '@gmp/core';

/** Error text safe to store/log: secrets redacted, length capped. */
export function errorText(err: unknown, max = 2_000): string {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : typeof err === 'string' ? err : 'Error';
  const text = redactSecrets(raw).text;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Runs `fn` over `items` with at most `limit` concurrent calls, preserving order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function riskSeverity(level: RiskLevel | null | undefined): Severity {
  return level ?? 'low';
}

export function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function shortSha(sha: string | null | undefined): string {
  return (sha ?? '').slice(0, 7);
}

export function prRef(fullName: string, number: number): string {
  return `${fullName}#${number}`;
}

export function prAppUrl(publicUrl: string, pullRequestId: string): string {
  return `${publicUrl}/pull-requests/${pullRequestId}`;
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

/**
 * Number of reviewers whose latest decisive review (APPROVED / CHANGES_REQUESTED / DISMISSED)
 * is an approval. Comments do not change a reviewer's decision.
 */
export function countApprovals(
  reviews: ReadonlyArray<{
    reviewerLogin: string | null;
    state: string;
    submittedAt: string | Date | null;
  }>,
): number {
  const latest = new Map<string, { state: string; at: number }>();
  for (const r of reviews) {
    const state = r.state.toUpperCase();
    if (!r.reviewerLogin || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state))
      continue;
    const at = r.submittedAt ? new Date(r.submittedAt).getTime() : 0;
    const prev = latest.get(r.reviewerLogin);
    if (!prev || at >= prev.at) latest.set(r.reviewerLogin, { state, at });
  }
  return [...latest.values()].filter((v) => v.state === 'APPROVED').length;
}
