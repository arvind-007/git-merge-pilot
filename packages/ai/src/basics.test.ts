import { describe, expect, it, vi } from 'vitest';
import { monthWindow, timeZoneOffsetMs } from './budget.ts';
import { createPathMatcher, isPathExcluded } from './glob.ts';
import { parseJsonFromText } from './json.ts';
import {
  estimateCostUsd,
  hasModelPrice,
  normalizeModelId,
  resetPricingWarnings,
  stripModelDate,
} from './pricing.ts';

describe('estimateCostUsd', () => {
  it('prices known models per million tokens', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0 };
    expect(estimateCostUsd('claude-haiku-5-5', u)).toBeCloseTo(0.6, 6);
    expect(estimateCostUsd('claude-sonnet-5-5', u)).toBeCloseTo(12, 6);
    expect(estimateCostUsd('claude-opus-5-5', u)).toBeCloseTo(24, 6);
  });

  it('bills cache reads at ~10% of input and cache writes at 125%', () => {
    const read = estimateCostUsd('claude-sonnet-5-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(read).toBeCloseTo(0.2, 6);
    const write = estimateCostUsd('claude-sonnet-5-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    });
    expect(write).toBeCloseTo(2.5, 6);
  });

  it('normalizes gateway prefixes', () => {
    expect(normalizeModelId('anthropic/claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(
      estimateCostUsd('anthropic/claude-haiku-5-5', {
        inputTokens: 1e6,
        outputTokens: 0,
        cacheReadTokens: 0,
      }),
    ).toBeCloseTo(0.1, 6);
  });

  it('costs unknown models 0 with a warning (once), or the configured fallback', () => {
    resetPricingWarnings();
    const warn = vi.fn();
    const logger = { warn } as never;
    const u = { inputTokens: 500_000, outputTokens: 100_000, cacheReadTokens: 0 };
    expect(estimateCostUsd('llama-local', u, { logger })).toBe(0);
    expect(estimateCostUsd('llama-local', u, { logger })).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(
      estimateCostUsd('other-model', u, {
        logger,
        fallback: { inputPerMTok: 1, outputPerMTok: 2 },
      }),
    ).toBeCloseTo(0.7, 6);
  });
});

describe('exclude_paths glob matching', () => {
  it('matches basename patterns at any depth', () => {
    const m = createPathMatcher(['*.pem', 'node_modules', '.env*']);
    expect(m('certs/server.pem')).toBe(true);
    expect(m('server.pem')).toBe(true);
    expect(m('a/node_modules/x/index.js')).toBe(true);
    expect(m('config/.env.production')).toBe(true);
    expect(m('src/index.ts')).toBe(false);
  });

  it('anchors patterns containing a slash and supports ** / braces / classes', () => {
    const m = createPathMatcher([
      'secrets/**',
      'docs/*.md',
      'src/**/*.{gen,generated}.ts',
      'build/[0-9]*',
    ]);
    expect(m('secrets/prod/key.json')).toBe(true);
    expect(m('app/secrets/x')).toBe(false);
    expect(m('docs/readme.md')).toBe(true);
    expect(m('docs/sub/readme.md')).toBe(false);
    expect(m('src/a/b/types.gen.ts')).toBe(true);
    expect(m('src/types.generated.ts')).toBe(true);
    expect(m('src/types.ts')).toBe(false);
    expect(m('build/1.js')).toBe(true);
    expect(m('build/a.js')).toBe(false);
  });

  it('treats a directory pattern as covering its subtree and honours negation', () => {
    const m = createPathMatcher(['vendor/', '!vendor/keep/**', '# comment', '']);
    expect(m('vendor/lib/a.js')).toBe(true);
    expect(m('vendor/keep/a.js')).toBe(false);
    expect(isPathExcluded('./vendor/x', ['vendor'])).toBe(true);
    expect(isPathExcluded('anything', [])).toBe(false);
  });
});

describe('parseJsonFromText', () => {
  it('parses bare, fenced and embedded JSON', () => {
    expect(parseJsonFromText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonFromText('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonFromText('Result: {"a":{"b":"}"}} trailing')).toEqual({ a: { b: '}' } });
    expect(parseJsonFromText('not json')).toBeUndefined();
  });
});

describe('monthWindow', () => {
  it('uses the calendar month in the org timezone', () => {
    // 2026-11-01 03:00 UTC is still October 31 in New York.
    const w = monthWindow(new Date('2026-11-01T03:00:00Z'), 'America/New_York');
    expect(w.start.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });

  it('handles positive offsets and year rollover', () => {
    const w = monthWindow(new Date('2026-12-31T20:00:00Z'), 'Asia/Kolkata');
    // 2027-01-01 01:30 IST → January window.
    expect(w.start.toISOString()).toBe('2026-12-31T18:30:00.000Z');
    expect(w.end.toISOString()).toBe('2027-01-31T18:30:00.000Z');
  });

  it('falls back to UTC for unknown zones', () => {
    const w = monthWindow(new Date('2026-11-14T12:00:00Z'), 'Not/AZone');
    expect(w.timeZone).toBe('UTC');
    expect(w.start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(timeZoneOffsetMs(new Date('2026-07-01T00:00:00Z'), 'Europe/Berlin')).toBe(2 * 3600_000);
  });
});

describe('model price lookup', () => {
  it('strips dated snapshot suffixes before lookup', () => {
    expect(stripModelDate('gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(stripModelDate('claude-sonnet-5-5-20261001')).toBe('claude-sonnet-5-5');
    expect(stripModelDate('claude-opus-5-5@20261001')).toBe('claude-opus-5-5');
    expect(hasModelPrice('claude-sonnet-5-5-20261001')).toBe(true);
    expect(hasModelPrice('gpt-4o-2024-08-06')).toBe(false);
    expect(
      hasModelPrice('gpt-4o-2024-08-06', { 'gpt-4o': { inputPerMTok: 1, outputPerMTok: 2 } }),
    ).toBe(true);
  });
});

describe('relationship message', () => {
  it('withholds a static summary that names an excluded path', async () => {
    const { buildRelationshipMessage } = await import('./tasks.ts');
    const repoA = { fullName: 'acme/a', aiMode: 'full' as const, excludePaths: ['secret/**'] };
    const repoB = { fullName: 'acme/b', aiMode: 'full' as const };
    const msg = buildRelationshipMessage([
      {
        prA: {
          id: 'a',
          ref: 'acme/a#1',
          title: 'x',
          files: ['secret/key.ts', 'src/a.ts'],
          repo: repoA,
        },
        prB: { id: 'b', ref: 'acme/b#2', title: 'y', files: ['src/b.ts'], repo: repoB },
        type: 'duplicate_work',
        confidence: 'possible',
        summary: 'Both touch secret/key.ts',
      },
    ]);
    expect(msg.user).not.toContain('secret/key.ts');
    expect(msg.user).toContain('src/a.ts');
  });
});

describe('AI assessment re-application', () => {
  it('keeps open questions stricter and rewrites the readiness sentence', async () => {
    const { reapplyAiAssessment, refreshSummaryReadiness, aiAssessmentOf } =
      await import('./merge.ts');
    const risk = {
      riskScores: [
        {
          dimension: 'integration' as const,
          score: 20,
          level: 'low' as const,
          rationale: 'r',
          evidence: [],
        },
      ],
      overallRisk: 'low' as const,
      mergeReadiness: {
        recommendation: 'ready_to_merge' as const,
        blockers: [],
        checks: [],
        rationale: 'ok',
      },
    };
    const out = reapplyAiAssessment(
      risk,
      {
        openQuestions: ['Is the old API still used?'],
        scoreAdjustments: [{ dimension: 'integration', delta: 15, rationale: 'callers' }],
      },
      [],
    );
    expect(out.mergeReadiness.recommendation).toBe('needs_clarification');
    expect(out.riskScores[0]!.score).toBe(35);
    expect(out.overallRisk).toBe('medium');
    expect(
      refreshSummaryReadiness(
        'AI text.\n\nAutomated checks: overall risk low; merge readiness: Ready to merge.',
        out.overallRisk,
        out.mergeReadiness,
      ),
    ).toBe(
      'AI text.\n\nAutomated checks: overall risk medium; merge readiness: Needs clarification.',
    );
    expect(
      refreshSummaryReadiness(
        'PR #1 changes 2 files. Overall risk is low. Merge readiness: Ready to merge.',
        out.overallRisk,
        out.mergeReadiness,
      ),
    ).toBe(
      'PR #1 changes 2 files. Overall risk is medium. Merge readiness: Needs clarification. Before merging: Open question (AI, unverified): Is the old API still used?.',
    );
    // Older reports without a stored assessment: reconstructed from blockers and rationales.
    const legacy = aiAssessmentOf({
      generatedBy: 'ai',
      mergeReadiness: out.mergeReadiness,
      riskScores: out.riskScores,
    } as never);
    expect(legacy).toEqual({
      openQuestions: ['Is the old API still used?'],
      scoreAdjustments: [{ dimension: 'integration', delta: 15, rationale: 'callers' }],
    });
  });
});
