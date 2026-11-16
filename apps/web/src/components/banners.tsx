import { Link } from 'react-router-dom';
import type { AiStatus } from '../api/types.ts';
import { formatUsd } from '../lib/format.ts';
import { Alert } from './ui.tsx';

export function AiBudgetBanner({
  status,
  isAdmin,
}: {
  status: Pick<AiStatus, 'spentUsd' | 'capUsd'> | undefined;
  isAdmin: boolean;
}) {
  return (
    <Alert
      tone="warning"
      title="AI budget reached for this month"
      action={
        isAdmin ? (
          <Link to="/settings/ai" className="text-sm font-medium underline">
            Adjust budget
          </Link>
        ) : undefined
      }
    >
      New reports are produced from automated analysis only until the budget resets
      {status?.capUsd !== undefined
        ? ` (spent ${formatUsd(status.spentUsd)} of ${formatUsd(status.capUsd)})`
        : ''}
      . Verified facts are still checked; AI-written summaries and potential concerns are paused.
    </Alert>
  );
}

export function AiDisabledBanner({ isAdmin, reason }: { isAdmin: boolean; reason?: string }) {
  return (
    <Alert
      tone="info"
      title="AI analysis is turned off"
      action={
        isAdmin ? (
          <Link to="/settings/ai" className="text-sm font-medium underline">
            AI settings
          </Link>
        ) : undefined
      }
    >
      {reason ??
        'Reports are produced from automated analysis of the code and GitHub data only. Summaries are shorter and no AI-suggested concerns are shown.'}
    </Alert>
  );
}

/** Shows the relevant AI banner (budget exhausted takes priority) or nothing. */
export function AiStatusBanners({ ai, isAdmin }: { ai: AiStatus | undefined; isAdmin: boolean }) {
  if (!ai) return null;
  if (ai.enabled && ai.budgetExhausted) return <AiBudgetBanner status={ai} isAdmin={isAdmin} />;
  if (!ai.enabled) return <AiDisabledBanner isAdmin={isAdmin} />;
  return null;
}
