import type {
  AiMode,
  AiTask,
  ChannelKind,
  FindingCategory,
  NotificationKind,
  Recommendation,
  RelationshipConfidence,
  RelationshipType,
  RiskDimension,
  RiskLevel,
  Severity,
} from '../api/types.ts';

export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  ready_to_merge: 'Ready to merge',
  merge_after_checks: 'Merge after checks',
  needs_clarification: 'Needs clarification',
  changes_required: 'Changes required',
  escalate: 'Escalate',
};

export const RECOMMENDATION_HINT: Record<Recommendation, string> = {
  ready_to_merge: 'Automated checks found nothing blocking this pull request.',
  merge_after_checks: 'Can merge once the listed checks or approvals are complete.',
  needs_clarification: 'There are open questions the author should answer first.',
  changes_required: 'Checks are failing or a reviewer requested changes.',
  escalate: 'A critical problem was found. Involve a senior engineer before merging.',
};

export const RISK_LABEL: Record<RiskLevel, string> = {
  critical: 'Critical risk',
  high: 'High risk',
  medium: 'Medium risk',
  low: 'Low risk',
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export const DIMENSION_LABEL: Record<RiskDimension, string> = {
  security: 'Security',
  breaking_change: 'Breaking changes',
  integration: 'Integration',
  regression: 'Regression',
  database: 'Database',
  deployment: 'Deployment',
};

export const DIMENSION_HINT: Record<RiskDimension, string> = {
  security: 'Could this change expose data or weaken protections?',
  breaking_change: 'Could this change break other code or users that depend on it?',
  integration: 'Does it affect other services, APIs or shared components?',
  regression: 'How likely is it to break something that works today?',
  database: 'Does it change database structure or data?',
  deployment: 'Does releasing it need special steps, config or ordering?',
};

export const CATEGORY_LABEL: Record<FindingCategory, string> = {
  security: 'Security',
  breaking_change: 'Breaking change',
  integration: 'Integration',
  testing: 'Testing',
  deployment: 'Deployment',
  database: 'Database',
  regression: 'Regression',
  other: 'Other',
};

export const RELATIONSHIP_LABEL: Record<RelationshipType, string> = {
  same_file: 'Edits the same files',
  same_symbol: 'Changes the same code',
  contract_change: 'API / contract dependency',
  shared_table: 'Touches the same database table',
  shared_config: 'Changes the same configuration',
  duplicate_work: 'Possible duplicate work',
  depends_on: 'Depends on',
};

export const CONFIDENCE_LABEL: Record<RelationshipConfidence, string> = {
  confirmed: 'Confirmed',
  likely: 'Likely',
  possible: 'Possible',
};

export const CONFIDENCE_HINT: Record<RelationshipConfidence, string> = {
  confirmed: 'Verified from the code changes (for example, overlapping edits).',
  likely: 'Strong signals from the code changes, but not a direct overlap.',
  possible: 'A weaker signal; worth a quick check with both authors.',
};

export const AI_MODE_LABEL: Record<AiMode, string> = {
  full: 'Full',
  metadata_only: 'Metadata only',
  off: 'Off',
};

export const AI_MODE_HINT: Record<AiMode, string> = {
  full: 'PR text, file paths and the changed lines of code (after secret redaction and excluded paths).',
  metadata_only: 'PR text, file paths and names of changed functions — no code is sent.',
  off: 'Nothing from this repository is sent to the AI provider. Reports use automated analysis only.',
};

export const AI_TASK_LABEL: Record<AiTask, string> = {
  triage: 'Triage (is this update meaningful?)',
  pr_report: 'PR report',
  deep_analysis: 'Deep analysis (cross-PR, high risk)',
  digest: 'Daily digest',
};

export const DEFAULT_TASK_MODELS: Record<AiTask, { anthropic: string; maxOutputTokens: number }> = {
  triage: { anthropic: 'claude-haiku-5-5', maxOutputTokens: 1024 },
  pr_report: { anthropic: 'claude-sonnet-5-5', maxOutputTokens: 8000 },
  deep_analysis: { anthropic: 'claude-opus-5-5', maxOutputTokens: 8000 },
  digest: { anthropic: 'claude-haiku-5-5', maxOutputTokens: 2048 },
};

export const CHANNEL_LABEL: Record<ChannelKind, string> = {
  email: 'Email',
  slack: 'Slack',
  in_app: 'In-app',
};

export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  pr_analyzed: 'PR analyzed',
  high_risk: 'High-risk PR',
  security_finding: 'Security finding',
  breaking_change: 'Breaking change',
  overlap_detected: 'Overlapping work',
  pr_updated_meaningfully: 'PR meaningfully updated',
  clarification_needed: 'Clarification needed',
  digest: 'Daily digest',
  budget_alert: 'AI budget alert',
  webhook_failure: 'Webhook failure',
};

const rtf =
  typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

/** "3 hours ago" style; returns "—" for missing/invalid dates. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const sec = Math.round((t - now) / 1000);
  const abs = Math.abs(sec);
  if (!rtf) return new Date(t).toLocaleString();
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (abs < 30 * 86_400) return rtf.format(Math.round(sec / 86_400), 'day');
  return new Date(t).toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '—' : new Date(t).toLocaleString();
}

export function formatUsd(v: number | null | undefined): string {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

export function formatNumber(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '0';
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** All IANA timezones the browser knows about, with a small fallback list. */
export function timezoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    const list = intl.supportedValuesOf?.('timeZone');
    if (list && list.length) return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    // fall through
  }
  return [
    'UTC',
    'Europe/London',
    'Europe/Berlin',
    'America/New_York',
    'America/Los_Angeles',
    'Asia/Kolkata',
    'Asia/Tokyo',
    'Australia/Sydney',
  ];
}

/** Split a textarea into trimmed, non-empty lines. */
export function linesToList(text: string): string[] {
  return text
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}
