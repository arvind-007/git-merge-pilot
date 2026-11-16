import { AiService, type BudgetStatus } from '@gmp/ai';
import type { AiMode } from '@gmp/core';
import type { ServerContext } from './context.ts';

export interface AiStatus {
  enabled: boolean;
  budgetExhausted: boolean;
  spentUsd: number;
  capUsd: number;
  pct: number;
  alert: boolean;
  /** Why AI is not used (null when it is). */
  reason: string | null;
}

export async function createAiService(ctx: ServerContext, orgId: string): Promise<AiService> {
  return AiService.create({
    db: ctx.db,
    orgId,
    logger: ctx.logger.child({ component: 'ai', orgId }),
    providerFactory: ctx.aiProviderFactory,
    masterKey: ctx.config.masterKey,
    now: ctx.now,
  });
}

export function budgetJson(b: BudgetStatus) {
  return {
    spentUsd: Math.round(b.spentUsd * 10000) / 10000,
    capUsd: b.capUsd,
    pct: Math.round(b.pct * 10) / 10,
    exhausted: b.exhausted,
    alert: b.alert,
    alertThresholdPct: b.alertThresholdPct,
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    timeZone: b.timeZone,
  };
}

/** AI status banner data for an org (optionally for a repo's ai_mode). Never throws. */
export async function aiStatusForOrg(
  ctx: ServerContext,
  orgId: string,
  aiMode?: AiMode | null,
): Promise<AiStatus> {
  try {
    const svc = await createAiService(ctx, orgId);
    const budget = await svc.budgetStatus();
    const target = aiMode === undefined ? null : { aiMode };
    return {
      enabled: svc.isEnabledFor(target),
      budgetExhausted: budget.exhausted,
      spentUsd: budget.spentUsd,
      capUsd: budget.capUsd,
      pct: budget.pct,
      alert: budget.alert,
      reason: svc.disabledReason(target),
    };
  } catch (err) {
    ctx.logger.warn({ err }, 'could not compute AI status');
    return {
      enabled: false,
      budgetExhausted: false,
      spentUsd: 0,
      capUsd: 0,
      pct: 0,
      alert: false,
      reason: 'AI status unavailable',
    };
  }
}
