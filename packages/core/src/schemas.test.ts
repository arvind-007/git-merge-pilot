import { describe, expect, it } from 'vitest';
import {
  FindingSchema,
  PrReportSchema,
  RISK_LEVELS,
  TaskModelsSchema,
  emptyAffectedAreas,
  maxRiskLevel,
  riskLevelFromScore,
  severityAtLeast,
  compareSeverityDesc,
  type Finding,
  type PrReport,
} from './index.ts';

const finding: Finding = {
  fingerprint: 'abc123',
  category: 'security',
  severity: 'high',
  title: 'Hardcoded credential',
  description: 'A password appears to be written directly in the code.',
  evidence: [{ repo: 'acme/api', path: 'src/db.ts', line: 10, source: 'diff' }],
  verified: true,
  source: 'rule',
  ruleId: 'secret.generic',
};

export const sampleReport: PrReport = {
  executiveSummary: 'Adds login rate limiting.',
  businessImpact: 'Reduces account takeover risk.',
  technicalSummary: 'New middleware in auth module.',
  affectedAreas: { ...emptyAffectedAreas(), modules: ['auth'] },
  breakingChanges: [],
  security: [finding],
  integrationImpact: [],
  overlappingWork: [
    { prRef: 'acme/api#12', type: 'same_file', confidence: 'likely', summary: 'Both edit auth.ts' },
  ],
  testing: {
    testsAdded: ['auth.test.ts'],
    testsModified: [],
    missingTests: [],
    ciSummary: '3/3 checks passed',
  },
  deployment: { migrations: [], envChanges: [], configChanges: [], ordering: [], notes: '' },
  rollback: { difficulty: 'easy', notes: 'Revert the PR.' },
  recommendedActions: ['Rotate the credential.'],
  riskScores: [
    {
      dimension: 'security',
      score: 65,
      level: 'high',
      rationale: 'Hardcoded credential',
      evidence: finding.evidence,
    },
  ],
  overallRisk: 'high',
  mergeReadiness: {
    recommendation: 'changes_required',
    blockers: ['Hardcoded credential'],
    checks: [{ name: 'ci', status: 'pass', detail: 'ok' }],
    rationale: 'Security finding must be resolved.',
  },
  confidence: { score: 80, rationale: 'Deterministic evidence.' },
  generatedBy: 'deterministic',
  limitations: ['AI disabled for this repo'],
};

describe('schemas', () => {
  it('accepts a valid finding and report', () => {
    expect(FindingSchema.parse(finding)).toEqual(finding);
    expect(PrReportSchema.parse(sampleReport)).toEqual(sampleReport);
  });

  it('rejects invalid enums and score ranges', () => {
    expect(FindingSchema.safeParse({ ...finding, severity: 'severe' }).success).toBe(false);
    const bad = { ...sampleReport, confidence: { score: 101, rationale: '' } };
    expect(PrReportSchema.safeParse(bad).success).toBe(false);
    const badEvidence = { ...finding, evidence: [{ repo: 'x', source: 'guess' }] };
    expect(FindingSchema.safeParse(badEvidence).success).toBe(false);
  });

  it('requires all report sections', () => {
    const { limitations: _omit, ...rest } = sampleReport;
    expect(PrReportSchema.safeParse(rest).success).toBe(false);
  });

  it('validates task model config', () => {
    const ok = TaskModelsSchema.safeParse({
      pr_report: {
        providerId: '3f1c2b4a-1d2e-4f5a-8b6c-7d8e9f0a1b2c',
        model: 'claude-sonnet-5-5',
        maxOutputTokens: 8000,
      },
    });
    expect(ok.success).toBe(true);
    expect(TaskModelsSchema.safeParse({ unknown_task: {} }).success).toBe(false);
  });
});

describe('enum helpers', () => {
  it('maps scores to levels per design thresholds', () => {
    expect(riskLevelFromScore(80)).toBe('critical');
    expect(riskLevelFromScore(79.9)).toBe('high');
    expect(riskLevelFromScore(60)).toBe('high');
    expect(riskLevelFromScore(30)).toBe('medium');
    expect(riskLevelFromScore(29)).toBe('low');
  });

  it('orders severities and levels', () => {
    expect(severityAtLeast('critical', 'high')).toBe(true);
    expect(severityAtLeast('medium', 'high')).toBe(false);
    expect(
      ['low', 'critical', 'info', 'high'].sort((a, b) =>
        compareSeverityDesc(a as never, b as never),
      ),
    ).toEqual(['critical', 'high', 'low', 'info']);
    expect(maxRiskLevel(['low', 'high', 'medium'])).toBe('high');
    expect(maxRiskLevel([])).toBe('low');
    expect(RISK_LEVELS).toHaveLength(4);
  });
});
