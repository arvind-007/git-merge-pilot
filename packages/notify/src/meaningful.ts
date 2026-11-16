import {
  riskLevelRank,
  severityAtLeast,
  type RelationshipConfidence,
  type RiskLevel,
  type Severity,
} from '@gmp/core';

export interface MeaningfulChangeInput {
  previousRisk: RiskLevel | null | undefined;
  currentRisk: RiskLevel | null | undefined;
  /** Findings that are new in this analysis (lifecycle `new`). */
  newFindings: ReadonlyArray<{ severity: Severity }>;
  /** Relationships that did not exist (or were inactive/lower confidence) before. */
  newRelationships: ReadonlyArray<{ confidence: RelationshipConfidence }>;
}

export interface MeaningfulChange {
  meaningful: boolean;
  reasons: Array<'risk_increased' | 'new_high_finding' | 'new_relationship'>;
}

/**
 * Design §10 "meaningful-change only": notify when the risk level rises, a new high/critical
 * finding appears, or a new confirmed/likely relationship appears. A first analysis (no previous
 * risk) counts as a rise when it lands at high or above.
 */
export function isMeaningfulChange(input: MeaningfulChangeInput): MeaningfulChange {
  const reasons: MeaningfulChange['reasons'] = [];
  if (input.currentRisk) {
    const prev = input.previousRisk ? riskLevelRank(input.previousRisk) : riskLevelRank('medium');
    if (riskLevelRank(input.currentRisk) > prev) reasons.push('risk_increased');
  }
  if (input.newFindings.some((f) => severityAtLeast(f.severity, 'high')))
    reasons.push('new_high_finding');
  if (
    input.newRelationships.some((r) => r.confidence === 'confirmed' || r.confidence === 'likely')
  ) {
    reasons.push('new_relationship');
  }
  return { meaningful: reasons.length > 0, reasons };
}
