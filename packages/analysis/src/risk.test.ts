import { MergeReadinessSchema, RISK_DIMENSIONS, RiskScoreSchema, type Finding } from '@gmp/core';
import { describe, expect, it } from 'vitest';
import { analyzeChanges } from './changes.ts';
import { makeFinding } from './findings.ts';
import { initParsers } from './parsers.ts';
import { normalizeCheckStatus, scoreRisk } from './risk.ts';
import { makePatch } from './test-helpers/make-patch.ts';
import type { ChangeFacts, Relationship, ScoreRiskInput } from './types.ts';

await initParsers();

const smallFacts = (): ChangeFacts =>
  analyzeChanges({
    repo: 'r',
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        patch: makePatch('export const a = 1;\n', 'export const a = 2;\n'),
      },
      { path: 'src/a.test.ts', status: 'modified', patch: makePatch('t(1)\n', 't(2)\n') },
    ],
  });

const finding = (over: Partial<Finding> & Pick<Finding, 'category' | 'severity'>): Finding =>
  makeFinding({
    ruleId: over.ruleId ?? 'x',
    category: over.category,
    severity: over.severity,
    title: over.title ?? `${over.severity} ${over.category}`,
    description: 'd',
    evidence: [{ repo: 'r', path: 'src/a.ts', line: 1, source: 'diff' }],
    identity: [over.title ?? `${over.category}${over.severity}`],
    verified: over.verified ?? true,
    source: over.source ?? 'rule',
  });

const base = (over: Partial<ScoreRiskInput> = {}): ScoreRiskInput => ({
  facts: smallFacts(),
  findings: [],
  relationships: [],
  checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
  reviewDecision: 'APPROVED',
  mergeableState: 'clean',
  ...over,
});

describe('normalizeCheckStatus', () => {
  it.each([
    [{ status: 'completed', conclusion: 'success' }, 'pass'],
    [{ status: 'completed', conclusion: 'skipped' }, 'pass'],
    [{ status: 'completed', conclusion: 'failure' }, 'fail'],
    [{ status: 'completed', conclusion: 'timed_out' }, 'fail'],
    [{ status: 'in_progress' }, 'pending'],
    [{ status: 'queued' }, 'pending'],
    [{ status: 'success' }, 'pass'],
    [{ status: 'error' }, 'fail'],
    [{ status: 'pending' }, 'pending'],
    [{ status: 'weird' }, 'unknown'],
  ])('%j → %s', (c, expected) => {
    expect(normalizeCheckStatus({ name: 'x', ...c })).toBe(expected);
  });
});

describe('scoreRisk', () => {
  it('produces a valid score for every dimension with rationale', () => {
    const r = scoreRisk(base());
    expect(r.riskScores.map((s) => s.dimension)).toEqual([...RISK_DIMENSIONS]);
    for (const s of r.riskScores) {
      expect(() => RiskScoreSchema.parse(s)).not.toThrow();
      expect(s.rationale.length).toBeGreaterThan(10);
    }
    expect(() => MergeReadinessSchema.parse(r.mergeReadiness)).not.toThrow();
    expect(r.overallRisk).toBe('low');
    expect(r.mergeReadiness.recommendation).toBe('ready_to_merge');
    expect(r.mergeReadiness.blockers).toEqual([]);
    // never claims the change is secure
    expect(r.riskScores.find((s) => s.dimension === 'security')?.rationale).toContain(
      'not a guarantee',
    );
  });

  it('applies level thresholds and project overrides', () => {
    const f = [finding({ category: 'breaking_change', severity: 'high' })];
    const r = scoreRisk(base({ findings: f }));
    const br = r.riskScores.find((s) => s.dimension === 'breaking_change')!;
    expect(br.score).toBe(65);
    expect(br.level).toBe('high');
    expect(br.evidence[0]).toMatchObject({ path: 'src/a.ts' });
    const strict = scoreRisk(
      base({
        findings: f,
        projectSettings: { riskThresholds: { critical: 60, high: 40, medium: 20 } },
      }),
    );
    expect(strict.riskScores.find((s) => s.dimension === 'breaking_change')?.level).toBe(
      'critical',
    );
    // invalid thresholds fall back to defaults
    const bad = scoreRisk(
      base({ findings: f, projectSettings: { riskThresholds: { critical: 10, high: 90 } } }),
    );
    expect(bad.riskScores.find((s) => s.dimension === 'breaking_change')?.level).toBe('high');
  });

  it('bumps overall to at least high for verified high security findings, not for unverified ones', () => {
    const verified = scoreRisk(
      base({ findings: [finding({ category: 'security', severity: 'high' })] }),
    );
    expect(verified.overallRisk).toBe('high');
    const unverified = scoreRisk(
      base({
        findings: [
          finding({ category: 'security', severity: 'high', verified: false, source: 'ai' }),
        ],
      }),
    );
    expect(unverified.riskScores.find((s) => s.dimension === 'security')?.score).toBe(46);
    expect(unverified.overallRisk).toBe('medium');
  });

  it('database dimension reflects destructive migrations', () => {
    const facts = analyzeChanges({
      repo: 'r',
      files: [
        {
          path: 'db/migrations/1.sql',
          status: 'added',
          patch: makePatch('', 'DROP TABLE carts;\n'),
        },
      ],
    });
    const r = scoreRisk(base({ facts }));
    const db = r.riskScores.find((s) => s.dimension === 'database')!;
    expect(db.level).toBe('critical');
    expect(db.rationale).toContain('drop_table carts');
    expect(db.evidence.some((e) => e.path === 'db/migrations/1.sql')).toBe(true);
    expect(r.riskScores.find((s) => s.dimension === 'deployment')?.rationale).toContain(
      'migrations',
    );
  });

  it('regression dimension flags missing tests and large diffs', () => {
    const big = Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    const facts = analyzeChanges({
      repo: 'r',
      files: [{ path: 'src/big.ts', status: 'added', patch: makePatch('', big) }],
    });
    const reg = scoreRisk(base({ facts })).riskScores.find((s) => s.dimension === 'regression')!;
    expect(reg.score).toBe(45);
    expect(reg.rationale).toContain('no test changes');
  });

  it('deployment dimension lists new required settings', () => {
    const facts = analyzeChanges({
      repo: 'r',
      files: [
        {
          path: 'src/c.ts',
          status: 'modified',
          patch: makePatch(
            'export const a = 1;\n',
            'export const a = process.env.STRIPE_REGION;\n',
          ),
        },
      ],
    });
    const r = scoreRisk(base({ facts }));
    expect(r.riskScores.find((s) => s.dimension === 'deployment')?.rationale).toContain(
      'STRIPE_REGION',
    );
    expect(r.mergeReadiness.recommendation).toBe('merge_after_checks');
    expect(r.mergeReadiness.blockers.join(' ')).toContain('STRIPE_REGION');
  });
});

describe('merge readiness — first match wins', () => {
  const crit = finding({ category: 'security', severity: 'critical', title: 'Secret committed' });

  it('escalate on verified critical security, even with failing checks', () => {
    const r = scoreRisk(
      base({
        findings: [crit],
        checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
        reviewDecision: 'CHANGES_REQUESTED',
      }),
    );
    expect(r.mergeReadiness.recommendation).toBe('escalate');
    expect(r.mergeReadiness.blockers[0]).toContain('Secret committed');
    expect(r.mergeReadiness.blockers).toContain('Check failing: ci');
  });

  it('critical breaking change escalates unless mitigated', () => {
    const br = finding({
      category: 'breaking_change',
      severity: 'critical',
      title: 'Table dropped',
    });
    expect(scoreRisk(base({ findings: [br] })).mergeReadiness.recommendation).toBe('escalate');
    expect(
      scoreRisk(base({ findings: [br], mitigatedFingerprints: [br.fingerprint] })).mergeReadiness
        .recommendation,
    ).not.toBe('escalate');
  });

  it('changes_required on failing required checks, CHANGES_REQUESTED or conflicts; optional checks ignored', () => {
    expect(
      scoreRisk(base({ checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] }))
        .mergeReadiness.recommendation,
    ).toBe('changes_required');
    expect(
      scoreRisk(base({ reviewDecision: 'CHANGES_REQUESTED' })).mergeReadiness.recommendation,
    ).toBe('changes_required');
    expect(scoreRisk(base({ mergeableState: 'dirty' })).mergeReadiness.recommendation).toBe(
      'changes_required',
    );
    expect(
      scoreRisk(
        base({
          checks: [{ name: 'lint', status: 'completed', conclusion: 'failure', required: false }],
        }),
      ).mergeReadiness.recommendation,
    ).toBe('ready_to_merge');
  });

  it('needs_clarification for open questions or unverified high concerns', () => {
    expect(
      scoreRisk(base({ openQuestions: ['Is the old endpoint still used by the mobile app?'] }))
        .mergeReadiness.recommendation,
    ).toBe('needs_clarification');
    const ai = finding({
      category: 'integration',
      severity: 'high',
      verified: false,
      source: 'ai',
    });
    expect(scoreRisk(base({ findings: [ai] })).mergeReadiness.recommendation).toBe(
      'needs_clarification',
    );
  });

  it('merge_after_checks for pending checks, missing approval, draft, cross-PR dependencies', () => {
    expect(
      scoreRisk(base({ checks: [{ name: 'ci', status: 'in_progress' }] })).mergeReadiness,
    ).toMatchObject({
      recommendation: 'merge_after_checks',
      blockers: ['Waiting for 1 check(s): ci'],
    });
    expect(
      scoreRisk(base({ reviewDecision: 'REVIEW_REQUIRED' })).mergeReadiness.recommendation,
    ).toBe('merge_after_checks');
    expect(scoreRisk(base({ draft: true })).mergeReadiness.recommendation).toBe(
      'merge_after_checks',
    );
    const rel: Relationship = {
      prAId: 'a',
      prBId: 'b',
      sourcePrId: 'a',
      type: 'contract_change',
      confidence: 'likely',
      summary: 's',
      evidence: [],
      needsAiConfirmation: false,
    };
    expect(scoreRisk(base({ relationships: [rel] })).mergeReadiness.recommendation).toBe(
      'merge_after_checks',
    );
    const possible = { ...rel, confidence: 'possible' as const };
    expect(scoreRisk(base({ relationships: [possible] })).mergeReadiness.recommendation).toBe(
      'ready_to_merge',
    );
  });

  it('readiness checks describe CI, review, conflicts, security and breaking status', () => {
    const r = scoreRisk(base({ reviewDecision: null, mergeableState: 'unknown', checks: [] }));
    const byName = Object.fromEntries(r.mergeReadiness.checks.map((c) => [c.name, c.status]));
    expect(byName).toMatchObject({
      'CI checks': 'unknown',
      'Code review': 'unknown',
      'Merge conflicts': 'unknown',
      'Security findings': 'pass',
      'Breaking changes': 'pass',
    });
    // Nothing verified the change: no CI and no approval is never "ready to merge".
    expect(r.mergeReadiness.recommendation).toBe('merge_after_checks');
    expect(r.mergeReadiness.blockers).toEqual([
      'No approving review yet.',
      'No CI checks reported for this commit: confirm the change was built and tested.',
    ]);
    expect(r.mergeReadiness.rationale).not.toContain('checks are passing');
  });

  it('an approval without branch protection counts, and the rationale states facts', () => {
    const r = scoreRisk(base({ reviewDecision: null, approvedReviews: 1 }));
    expect(r.mergeReadiness.recommendation).toBe('ready_to_merge');
    expect(r.mergeReadiness.rationale).toBe(
      'No blocking issues detected: 1 of 1 reported check(s) passing, the PR is approved, overall risk is low.',
    );
  });
});
