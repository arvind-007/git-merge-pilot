import type { FastifyRequest } from 'fastify';
import { redactSecretsDeep, isSensitiveKey } from '@gmp/core';
import { auditLog, type DbOrTx } from '@gmp/db';

export interface AuditInput {
  orgId: string;
  userId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  data?: Record<string, unknown>;
}

/** Drops secret-looking keys and redacts secret-looking values. Audit data never holds secrets. */
export function sanitizeAuditData(data: Record<string, unknown>): Record<string, unknown> {
  const strip = (v: unknown, depth: number): unknown => {
    if (depth > 6) return '[truncated]';
    if (Array.isArray(v)) return v.slice(0, 100).map((x) => strip(x, depth + 1));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (isSensitiveKey(k)) {
          out[k] = '[REDACTED]';
          continue;
        }
        out[k] = strip(val, depth + 1);
      }
      return out;
    }
    if (typeof v === 'string' && v.length > 2000) return `${v.slice(0, 2000)}…`;
    return v;
  };
  return redactSecretsDeep(strip(data, 0) as Record<string, unknown>).value;
}

export async function writeAudit(db: DbOrTx, input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    orgId: input.orgId,
    userId: input.userId,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    ip: input.ip ?? null,
    data: sanitizeAuditData(input.data ?? {}),
  });
}

/** Audit helper bound to the signed-in user of `req`. */
export async function auditFromRequest(
  db: DbOrTx,
  req: FastifyRequest,
  action: string,
  target: { type?: string; id?: string | null } = {},
  data: Record<string, unknown> = {},
): Promise<void> {
  const user = req.auth?.user;
  if (!user) return;
  await writeAudit(db, {
    orgId: user.orgId,
    userId: user.id,
    action,
    targetType: target.type ?? null,
    targetId: target.id ?? null,
    ip: req.ip,
    data,
  });
}
