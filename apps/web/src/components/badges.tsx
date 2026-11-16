import { AlertTriangle, BadgeCheck, CircleHelp, Loader2 } from 'lucide-react';
import type {
  AiMode,
  AnalysisStatus,
  PrState,
  Recommendation,
  RelationshipConfidence,
  RiskLevel,
  Severity,
} from '../api/types.ts';
import {
  AI_MODE_LABEL,
  CONFIDENCE_HINT,
  CONFIDENCE_LABEL,
  RECOMMENDATION_HINT,
  RECOMMENDATION_LABEL,
  RISK_LABEL,
  SEVERITY_LABEL,
} from '../lib/format.ts';
import { Badge, type Tone } from './ui.tsx';

export const RISK_TONE: Record<RiskLevel, Tone> = {
  critical: 'red',
  high: 'orange',
  medium: 'amber',
  low: 'green',
};
export const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: 'red',
  high: 'orange',
  medium: 'amber',
  low: 'blue',
  info: 'gray',
};
const RECOMMENDATION_TONE: Record<Recommendation, Tone> = {
  ready_to_merge: 'green',
  merge_after_checks: 'blue',
  needs_clarification: 'amber',
  changes_required: 'orange',
  escalate: 'red',
};
const CONFIDENCE_TONE: Record<RelationshipConfidence, Tone> = {
  confirmed: 'red',
  likely: 'amber',
  possible: 'gray',
};

export function RiskBadge({
  level,
  short = false,
}: {
  level: RiskLevel | null | undefined;
  short?: boolean;
}) {
  if (!level) return <Badge tone="gray">Not analyzed</Badge>;
  return (
    <Badge tone={RISK_TONE[level]}>
      {short ? level[0]!.toUpperCase() + level.slice(1) : RISK_LABEL[level]}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>;
}

export function RecommendationBadge({ value }: { value: Recommendation | null | undefined }) {
  if (!value) return <Badge tone="gray">No recommendation yet</Badge>;
  return (
    <Badge tone={RECOMMENDATION_TONE[value]} title={RECOMMENDATION_HINT[value]}>
      {RECOMMENDATION_LABEL[value]}
    </Badge>
  );
}

/** "Verified fact" (deterministic / GitHub data) vs "Potential concern" (AI inference). */
export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <Badge
      tone="indigo"
      icon={<BadgeCheck className="size-3.5" aria-hidden />}
      title="Found by automated analysis of the code or GitHub data."
    >
      Verified fact
    </Badge>
  ) : (
    <Badge
      tone="amber"
      icon={<CircleHelp className="size-3.5" aria-hidden />}
      title="Suggested by AI. Worth checking, but not confirmed."
    >
      Potential concern
    </Badge>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: RelationshipConfidence }) {
  return (
    <Badge tone={CONFIDENCE_TONE[confidence]} title={CONFIDENCE_HINT[confidence]}>
      {CONFIDENCE_LABEL[confidence]}
      <span className="sr-only">: {CONFIDENCE_HINT[confidence]}</span>
    </Badge>
  );
}

export function PrStateBadge({ state, draft }: { state: PrState; draft?: boolean }) {
  if (state === 'merged') return <Badge tone="violet">Merged</Badge>;
  if (state === 'closed') return <Badge tone="gray">Closed</Badge>;
  return draft ? <Badge tone="gray">Draft</Badge> : <Badge tone="green">Open</Badge>;
}

export function AnalysisStatusBadge({ status }: { status: AnalysisStatus | null | undefined }) {
  switch (status) {
    case 'queued':
      return (
        <Badge tone="gray" icon={<Loader2 className="size-3 animate-spin" aria-hidden />}>
          Queued
        </Badge>
      );
    case 'running':
      return (
        <Badge tone="blue" icon={<Loader2 className="size-3 animate-spin" aria-hidden />}>
          Analyzing
        </Badge>
      );
    case 'failed':
      return (
        <Badge tone="red" icon={<AlertTriangle className="size-3" aria-hidden />}>
          Analysis failed
        </Badge>
      );
    case 'skipped':
      return <Badge tone="gray">Skipped</Badge>;
    case 'completed':
      return <Badge tone="green">Analyzed</Badge>;
    default:
      return null;
  }
}

export function AiModeBadge({ mode }: { mode: AiMode }) {
  const tone: Tone = mode === 'full' ? 'indigo' : mode === 'metadata_only' ? 'blue' : 'gray';
  return <Badge tone={tone}>AI: {AI_MODE_LABEL[mode]}</Badge>;
}
