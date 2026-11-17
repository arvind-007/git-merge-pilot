import { describe, expect, it } from 'vitest';
import type { Finding, PrReport, PullRequestDetail, RiskScore } from '../api/types.ts';
import { oneLiner, riskShareLines, riskShareText } from './riskShare.ts';

const score = (
  dimension: RiskScore['dimension'],
  s: number,
  level: RiskScore['level'],
  rationale: string,
): RiskScore => ({
  dimension,
  score: s,
  level,
  rationale,
  evidence: [],
});

const finding = (severity: Finding['severity'], title: string): Finding => ({
  fingerprint: title,
  category: 'security',
  severity,
  title,
  description: '',
  evidence: [],
  verified: true,
  source: 'rule',
});

function report(overrides: Partial<PrReport> = {}): PrReport {
  return {
    riskScores: [
      score('security', 10, 'low', 'Nothing sensitive.'),
      score('database', 90, 'critical', 'Drops the orders.status column. Existing rows lose data.'),
      score('regression', 40, 'medium', 'Touches retry logic'),
    ],
    mergeReadiness: {
      recommendation: 'changes_required',
      blockers: ['CI is failing'],
      checks: [],
      rationale: '',
    },
    security: [
      finding('low', 'Debug logging left on'),
      finding('info', 'FYI only'),
      finding('high', 'Hard-coded API key'),
    ],
    breakingChanges: [finding('critical', 'Removed export getUser')],
    integrationImpact: [],
    ...overrides,
  } as PrReport;
}

describe('oneLiner', () => {
  it('keeps the first sentence on one line', () => {
    expect(oneLiner('First part.\n  Second part.')).toBe('First part.');
    expect(oneLiner('No   period\nhere')).toBe('No period here');
  });

  it('caps very long text', () => {
    const line = oneLiner('x'.repeat(400));
    expect(line.length).toBeLessThanOrEqual(160);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('riskShareLines', () => {
  it('lists non-low dimensions, blockers and findings above info, most severe first', () => {
    expect(riskShareLines(report())).toEqual([
      'Database (Critical): Drops the orders.status column.',
      'Regression (Medium): Touches retry logic',
      'Blocker: CI is failing',
      '[Critical] Removed export getUser',
      '[High] Hard-coded API key',
      '[Low] Debug logging left on',
    ]);
  });

  it('drops duplicate lines', () => {
    const r = report({
      security: [finding('high', 'Same issue')],
      breakingChanges: [finding('high', 'Same issue')],
    });
    expect(riskShareLines(r).filter((l) => l.includes('Same issue'))).toHaveLength(1);
  });
});

describe('riskShareText', () => {
  const detail = {
    pullRequest: {
      number: 42,
      title: 'Retry webhooks',
      htmlUrl: 'https://github.com/acme/api/pull/42',
    },
    repository: { fullName: 'acme/api' },
  } as PullRequestDetail;

  it('builds a chat-ready message with bullets and the PR link', () => {
    expect(riskShareText(detail, ['A', 'B'])).toBe(
      'PR #42: Retry webhooks (acme/api)\nRisks found:\n• A\n• B\n\nhttps://github.com/acme/api/pull/42',
    );
  });

  it('says so when there is nothing to share', () => {
    expect(riskShareText(detail, [])).toContain('No risks above "low"');
  });
});
