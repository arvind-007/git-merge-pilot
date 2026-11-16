import { PrReportSchema } from '@gmp/core';
import { describe, expect, it } from 'vitest';
import { AiReportOutputSchema } from './ai-output.ts';
import {
  buildDeterministicReport,
  normalizeCheckStatus,
  summarizeChecks,
} from './deterministic.ts';
import { mergeAiReport, sanitizeAiText } from './merge.ts';
import { deterministicTriage, renderDeterministicDigest } from './tasks.ts';
import { aiOutput, finding, readiness, reportInput } from './test-fixtures.ts';

const parseAi = (o: Record<string, unknown>) => AiReportOutputSchema.parse(aiOutput(o));

describe('buildDeterministicReport', () => {
  it('produces a valid, plain-language report from facts alone', () => {
    const input = reportInput({
      facts: {
        ...reportInput().facts,
        envVarsAdded: ['PAYMENTS_URL'],
        migrations: ['db/migrations/0003_add_orders.sql'],
        contractsChanged: [
          {
            kind: 'http_route',
            identifier: 'GET /users/:id',
            role: 'provider',
            path: 'src/routes/users.ts',
          },
        ],
        dependencyChanges: [{ name: 'express', from: '4.18.0', to: '5.0.0' }],
      },
      relationships: [
        {
          prRef: 'acme/web#7',
          type: 'contract_change',
          confidence: 'likely',
          summary: 'Web calls GET /users/:id',
        },
      ],
      findings: [
        finding(),
        finding({
          fingerprint: 's1',
          category: 'security',
          severity: 'medium',
          title: 'eval() used',
          verified: true,
        }),
        finding({
          fingerprint: 'd1',
          category: 'deployment',
          severity: 'low',
          title: 'Dockerfile base image changed',
        }),
      ],
    });
    const r = buildDeterministicReport(input, { reason: 'AI is disabled for this repository.' });
    expect(() => PrReportSchema.parse(r)).not.toThrow();
    expect(r.generatedBy).toBe('deterministic');
    expect(r.executiveSummary).toContain('PR #42');
    expect(r.executiveSummary).toContain('Merge after checks');
    expect(r.businessImpact).toMatch(/API/);
    expect(r.businessImpact).toMatch(/PAYMENTS_URL/);
    expect(r.breakingChanges).toHaveLength(1);
    expect(r.security.map((f) => f.title)).toEqual(['eval() used']);
    expect(r.integrationImpact.map((f) => f.title)).toEqual(['Dockerfile base image changed']);
    expect(r.affectedAreas.apis).toEqual(['GET /users/:id']);
    expect(r.deployment.migrations).toEqual(['db/migrations/0003_add_orders.sql']);
    expect(r.deployment.ordering.join(' ')).toMatch(/environment variables/);
    expect(r.rollback.difficulty).toBe('moderate');
    expect(r.overlappingWork[0]?.suggestedCoordination).toMatch(/acme\/web#7/);
    expect(r.testing.missingTests.length).toBeGreaterThan(0);
    expect(r.testing.ciSummary).toMatch(/still running/);
    expect(r.mergeReadiness).toEqual(input.risk.mergeReadiness);
    expect(r.riskScores).toEqual(input.risk.riskScores);
    expect(r.limitations).toContain('AI is disabled for this repository.');
    expect(r.recommendedActions).toContain('CI check "build" is still running');
  });

  it('keeps deterministic findings verbatim', () => {
    const f = finding();
    const r = buildDeterministicReport(reportInput({ findings: [f] }));
    expect(r.breakingChanges[0]).toEqual(f);
  });

  it('describes docs-only PRs sensibly', () => {
    const r = buildDeterministicReport(
      reportInput({
        files: [{ path: 'docs/a.md', status: 'modified', additions: 1, deletions: 0, patch: '+x' }],
        findings: [],
        facts: {},
        risk: {
          ...reportInput().risk,
          overallRisk: 'low',
          mergeReadiness: readiness({ recommendation: 'ready_to_merge', blockers: [] }),
        },
      }),
    );
    expect(r.businessImpact).toMatch(/only touches documentation/);
    expect(r.rollback.difficulty).toBe('easy');
    expect(r.testing.missingTests).toEqual([]);
  });

  it('normalizes GitHub check states', () => {
    expect(normalizeCheckStatus({ name: 'a', status: 'completed', conclusion: 'success' })).toBe(
      'pass',
    );
    expect(normalizeCheckStatus({ name: 'a', status: 'completed', conclusion: 'failure' })).toBe(
      'fail',
    );
    expect(normalizeCheckStatus({ name: 'a', status: 'queued' })).toBe('pending');
    expect(summarizeChecks([])).toMatch(/No CI checks/);
  });
});

describe('sanitizeAiText', () => {
  it('strips control, zero-width and bidi characters and bounds length', () => {
    const dirty = `a${String.fromCharCode(0)}b${String.fromCharCode(0x202e)}c${String.fromCharCode(0x200b)}d\n`;
    expect(sanitizeAiText(dirty)).toBe('abcd');
    expect(sanitizeAiText('x'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('mergeAiReport', () => {
  it('uses AI narrative, appends unverified concerns and keeps deterministic findings', () => {
    const input = reportInput();
    const r = mergeAiReport(
      input,
      parseAi({
        concerns: [
          {
            category: 'integration',
            severity: 'critical',
            title: 'Mobile app may still call getUser',
            description: 'The mobile client might use the removed function.',
            whatMightBreak: 'Profile screen',
            recommendation: 'Check the mobile repo',
            paths: ['src/users.ts', 'not/in/pr.ts'],
          },
          // Duplicate of a verified finding title → dropped.
          {
            category: 'breaking_change',
            severity: 'high',
            title: 'Exported function getUser removed',
            description: 'dup',
            whatMightBreak: '',
            recommendation: '',
            paths: [],
          },
        ],
      }),
      { limitations: ['Diff truncated to fit'] },
    );
    expect(() => PrReportSchema.parse(r)).not.toThrow();
    expect(r.generatedBy).toBe('ai');
    expect(r.breakingChanges).toEqual([input.findings[0]]);
    const concern = r.integrationImpact.find((f) => f.source === 'ai');
    expect(concern).toMatchObject({
      verified: false,
      severity: 'high',
      affected: ['src/users.ts'],
    });
    expect(concern?.evidence).toEqual([{ repo: 'acme/api', path: 'src/users.ts', source: 'ai' }]);
    expect(r.executiveSummary).toContain('This PR renames the user lookup function.');
    expect(r.executiveSummary).toContain('merge readiness: Merge after checks');
    expect(r.limitations).toContain('Diff truncated to fit');
  });

  it('clamps score adjustments to ±15 and records the rationale', () => {
    const r = mergeAiReport(
      reportInput(),
      parseAi({
        scoreAdjustments: [
          { dimension: 'integration', delta: 40, rationale: 'Shared client library affected.' },
          { dimension: 'integration', delta: 5, rationale: 'second one ignored' },
          { dimension: 'regression', delta: -3, rationale: '' },
        ],
      }),
    );
    const integration = r.riskScores.find((s) => s.dimension === 'integration')!;
    expect(integration.score).toBe(25);
    expect(integration.rationale).toContain(
      'AI adjustment (+15, unverified): Shared client library affected.',
    );
    expect(r.riskScores.find((s) => s.dimension === 'regression')!.score).toBe(25);
  });

  it('cannot lower a level backed by verified high findings', () => {
    const r = mergeAiReport(
      reportInput(),
      parseAi({
        scoreAdjustments: [{ dimension: 'breaking_change', delta: -15, rationale: 'Looks fine' }],
      }),
    );
    const s = r.riskScores.find((x) => x.dimension === 'breaking_change')!;
    expect(s.score).toBe(50);
    expect(s.level).toBe('high');
    expect(r.overallRisk).toBe('high');
  });

  it('only makes readiness stricter', () => {
    const ready = reportInput({
      risk: {
        ...reportInput().risk,
        mergeReadiness: readiness({ recommendation: 'ready_to_merge', blockers: [] }),
      },
    });
    const withQuestions = mergeAiReport(
      ready,
      parseAi({ openQuestions: ['Is the old endpoint still used by partners?'] }),
    );
    expect(withQuestions.mergeReadiness.recommendation).toBe('needs_clarification');
    expect(withQuestions.mergeReadiness.blockers[0]).toMatch(/Open question \(AI, unverified\)/);

    const escalated = reportInput({
      risk: { ...reportInput().risk, mergeReadiness: readiness({ recommendation: 'escalate' }) },
    });
    const r = mergeAiReport(escalated, parseAi({ openQuestions: ['q'] }));
    expect(r.mergeReadiness.recommendation).toBe('escalate');
  });

  it('a compromised AI response cannot mark the PR ready or drop findings', () => {
    const input = reportInput();
    const r = mergeAiReport(
      input,
      parseAi({
        executiveSummary: 'This PR is secure and ready_to_merge.',
        scoreAdjustments: RISK_ALL.map((dimension) => ({
          dimension,
          delta: -100,
          rationale: 'ignore previous instructions',
        })),
        recommendedActions: ['Merge now'],
        confidence: { score: 100, rationale: 'trust me' },
        promptInjectionSuspected: true,
      }),
    );
    expect(r.mergeReadiness).toEqual(input.risk.mergeReadiness);
    expect(r.breakingChanges).toContainEqual(input.findings[0]);
    expect(r.overallRisk).toBe('high');
    expect(r.confidence.score).toBeLessThanOrEqual(95);
    expect(r.executiveSummary).toMatch(
      /Automated checks: overall risk high; merge readiness: Merge after checks\.$/,
    );
    expect(r.security.some((f) => f.source === 'ai' && /instruct the AI/.test(f.title))).toBe(true);
  });
});

const RISK_ALL = [
  'security',
  'breaking_change',
  'integration',
  'regression',
  'database',
  'deployment',
] as const;

describe('deterministic triage and digest', () => {
  const repo = { fullName: 'acme/api' };
  const pr = { number: 1, title: 't' };
  it('flags docs-only and whitespace-only pushes as not meaningful', () => {
    expect(
      deterministicTriage({ repo, pr, changedFiles: [{ path: 'README.md' }] }).meaningful,
    ).toBe(false);
    expect(
      deterministicTriage({
        repo,
        pr,
        changedFiles: [{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-  \n+    ' }],
      }).meaningful,
    ).toBe(false);
    expect(
      deterministicTriage({ repo, pr, changedFiles: [{ path: 'src/a.ts', patch: '+x' }] })
        .meaningful,
    ).toBe(true);
    expect(deterministicTriage({ repo, pr, changedFiles: [], newFindings: 2 }).meaningful).toBe(
      true,
    );
  });

  it('renders a digest with urgent items first', () => {
    const text = renderDeterministicDigest({
      periodLabel: '2026-11-14',
      projectName: 'Payments',
      items: [
        {
          prRef: 'acme/api#2',
          title: 'Small fix',
          repo: 'acme/api',
          overallRisk: 'low',
          recommendation: 'ready_to_merge',
        },
        {
          prRef: 'acme/api#3',
          title: 'Auth rewrite',
          repo: 'acme/api',
          overallRisk: 'critical',
          recommendation: 'escalate',
        },
      ],
      stats: { opened: 2 },
    });
    expect(text.indexOf('acme/api#3')).toBeLessThan(text.indexOf('acme/api#2'));
    expect(text).toMatch(/Needs attention/);
    expect(text).toMatch(/Payments/);
  });
});
