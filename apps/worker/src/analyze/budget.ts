import type { AiService } from '@gmp/ai';
import { aiSettings } from '@gmp/db';
import { dispatch } from '@gmp/notify';
import { eq } from 'drizzle-orm';
import type { WorkerContext } from '../deps.ts';
import { errorText } from '../util.ts';

/**
 * Sends one org-level `budget_alert` per month when spend crosses the alert threshold, and
 * another when the cap is reached (AI calls are then skipped, so this must be visible).
 */
export async function maybeBudgetAlert(
  ctx: WorkerContext,
  orgId: string,
  ai: AiService,
): Promise<void> {
  try {
    const [settings] = await ctx.db
      .select({ enabled: aiSettings.enabled })
      .from(aiSettings)
      .where(eq(aiSettings.orgId, orgId))
      .limit(1);
    if (!settings?.enabled) return;
    const b = await ai.budgetStatus();
    if (!b.alert && !b.exhausted) return;
    const month = b.periodStart.toISOString().slice(0, 7);
    const spent = `$${b.spentUsd.toFixed(2)} of $${b.capUsd.toFixed(2)}`;
    await dispatch({
      db: ctx.db,
      orgId,
      now: ctx.now(),
      event: {
        kind: 'budget_alert',
        severity: 'high',
        projectId: null,
        title: b.exhausted
          ? 'AI budget reached: reports now use automated analysis only'
          : `AI budget alert: ${Math.round(b.pct)}% of the monthly budget used`,
        body: b.exhausted
          ? `This month's AI spend is ${spent}. AI calls are skipped until the budget resets or is raised; reports are produced from automated analysis only.`
          : `This month's AI spend is ${spent} (alert threshold ${b.alertThresholdPct}%).`,
        url: `${ctx.publicUrl}/settings/ai`,
        dedupKey: `budget_alert:${orgId}:${month}:${b.exhausted ? 'exhausted' : 'threshold'}`,
      },
    });
  } catch (err) {
    ctx.logger.warn({ err: errorText(err) }, 'budget alert check failed');
  }
}
