import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sha256Hex, type PrReport } from '@gmp/core';
import { sanitizeAuditData } from './audit.ts';
import { HttpError, parseWith, toErrorResponse } from './errors.ts';
import { MemoryJobQueue, QUEUE_NAMES } from './queue.ts';
import { uuidArray } from './queries/prs.ts';
import { HIDDEN_PR_TEXT, repoOfRef, scopeReport } from './report-scope.ts';
import { maskSmeeUrl } from './routes/github.ts';
import { setupTokenMatches } from './setup-token.ts';
import { isValidTimezone } from './validation.ts';

describe('error mapping', () => {
  it('passes HttpError through with its code', () => {
    const r = toErrorResponse(new HttpError(409, 'conflict', 'Exists'), { isProduction: true });
    expect(r).toMatchObject({
      status: 409,
      body: { code: 'conflict', message: 'Exists' },
      log: false,
    });
  });

  it('hides internal error details in production and redacts them otherwise', () => {
    const err = new Error('boom ghp_' + 'a'.repeat(36));
    const prod = toErrorResponse(err, { isProduction: true });
    expect(prod.status).toBe(500);
    expect(prod.body.message).toBe('Something went wrong on the server.');
    expect(JSON.stringify(prod.body)).not.toContain('stack');
    const dev = toErrorResponse(err, { isProduction: false });
    expect(dev.body.message).not.toContain('ghp_aaaa');
  });

  it('maps postgres unique violations (wrapped by drizzle) to 409', () => {
    const wrapped = Object.assign(new Error('Failed query'), { cause: { code: '23505' } });
    expect(toErrorResponse(wrapped, { isProduction: true }).status).toBe(409);
  });

  it('maps zod failures to 400 with issues', () => {
    try {
      parseWith(z.object({ a: z.string() }), { a: 1 });
      expect.unreachable();
    } catch (err) {
      const r = toErrorResponse(err, { isProduction: true });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('validation_error');
      expect(r.body.issues).toEqual([expect.objectContaining({ path: 'a' })]);
    }
  });

  it('maps rate limit errors to a friendly 429', () => {
    const r = toErrorResponse({ statusCode: 429, message: 'x' }, { isProduction: true });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('rate_limited');
  });
});

describe('audit sanitization', () => {
  it('drops sensitive keys and redacts secret-looking values', () => {
    const out = sanitizeAuditData({
      apiKey: 'sk-live',
      nested: { password: 'p', note: 'token ghp_' + 'b'.repeat(36) },
      changes: { name: 'ok', inputTokens: 5 },
    });
    expect(out.apiKey).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).password).toBe('[REDACTED]');
    expect(String((out.nested as Record<string, unknown>).note)).not.toContain('ghp_bbbb');
    expect(out.changes).toMatchObject({ name: 'ok' });
  });
});

describe('helpers', () => {
  it('compares setup tokens by hash', () => {
    expect(setupTokenMatches(sha256Hex('abc'), 'abc')).toBe(true);
    expect(setupTokenMatches(sha256Hex('abc'), ' abc ')).toBe(true);
    expect(setupTokenMatches(sha256Hex('abc'), 'abd')).toBe(false);
    expect(setupTokenMatches(null, 'abc')).toBe(false);
  });

  it('validates time zones', () => {
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });

  it('builds uuid array literals and rejects injection', () => {
    expect(uuidArray(['3f1c2a3e-1111-4222-8333-444455556666'])).toBe(
      '{3f1c2a3e-1111-4222-8333-444455556666}',
    );
    expect(() => uuidArray(["x'}; drop table users; --"])).toThrow();
  });

  it('memory queue records jobs and covers every design queue', async () => {
    const q = new MemoryJobQueue();
    await q.send('repo.discover', { repositoryId: 'r' });
    expect(q.byName('repo.discover')).toHaveLength(1);
    expect(QUEUE_NAMES).toEqual(
      expect.arrayContaining([
        'webhook.process',
        'repo.discover',
        'repo.index',
        'pr.sync',
        'pr.analyze',
        'pr.readiness',
        'overlap.recompute',
        'notify.flush',
        'digest.daily',
        'reconcile.poll',
        'retention.cleanup',
      ]),
    );
  });
});

describe('queue definitions', () => {
  it('create queues with the same names and policies as the worker', async () => {
    const { QUEUE_NAMES, QUEUE_DEFAULTS } = await import('./queue.ts');
    const worker = await import('@gmp/worker/queues');
    expect([...QUEUE_NAMES].sort()).toEqual([...worker.QUEUE_NAMES].sort());
    for (const name of QUEUE_NAMES) {
      expect(QUEUE_DEFAULTS[name]).toEqual(worker.QUEUE_OPTIONS[name]);
    }
    expect(QUEUE_DEFAULTS['pr.analyze'].policy).toBe('stately');
  });
});

describe('report scoping (members only see PRs in their repositories)', () => {
  const report = {
    executiveSummary: 'Overlaps with acme/secret-billing#42 and acme/api#7.',
    businessImpact: '',
    technicalSummary: '',
    affectedAreas: {
      modules: [],
      services: [],
      apis: [],
      databaseTables: [],
      sharedComponents: [],
      integrations: [],
      configuration: [],
      infrastructure: [],
    },
    breakingChanges: [],
    security: [],
    integrationImpact: [],
    overlappingWork: [
      {
        prRef: 'acme/secret-billing#42',
        pullRequestId: 'hidden-pr',
        type: 'contract_change',
        confidence: 'likely',
        summary: 'acme/secret-billing#42 calls POST /charge from src/payments/client.ts',
        suggestedCoordination: 'Confirm acme/secret-billing#42 is compatible.',
      },
      {
        prRef: 'acme/api#7',
        type: 'same_file',
        confidence: 'confirmed',
        summary: 'Both edit src/a.ts',
      },
    ],
    testing: { testsAdded: [], testsModified: [], missingTests: [], ciSummary: '' },
    deployment: {
      migrations: [],
      envChanges: [],
      configChanges: [],
      ordering: ['Merge and deploy acme/secret-billing#42 first.'],
      notes: '',
    },
    rollback: { difficulty: 'easy', notes: '' },
    recommendedActions: [
      'Confirm acme/secret-billing#42 is compatible.',
      'Coordinate with acme/api#7',
    ],
    riskScores: [
      {
        dimension: 'integration',
        score: 40,
        level: 'medium',
        rationale: 'r',
        evidence: [
          { repo: 'acme/secret-billing', path: 'src/payments/client.ts', source: 'index' },
          { repo: 'acme/api', path: 'src/a.ts', source: 'diff' },
        ],
      },
    ],
    overallRisk: 'medium',
    mergeReadiness: {
      recommendation: 'merge_after_checks',
      blockers: [],
      checks: [],
      rationale: '',
    },
    confidence: { score: 50, rationale: '' },
    generatedBy: 'deterministic',
    limitations: [],
  } as unknown as PrReport;

  it('drops hidden PRs, their evidence and every mention of them', () => {
    const scoped = scopeReport(report, {
      visibleRepos: new Set(['acme/api']),
      visiblePullRequestIds: new Set(),
    });
    expect(scoped.overlappingWork.map((o) => o.prRef)).toEqual(['acme/api#7']);
    const text = JSON.stringify(scoped);
    expect(text).not.toContain('secret-billing');
    expect(text).toContain(HIDDEN_PR_TEXT);
    expect(scoped.riskScores[0]!.evidence).toHaveLength(1);
    expect(scoped.recommendedActions).toContain('Coordinate with acme/api#7');
  });

  it('keeps everything the reader may see', () => {
    const scoped = scopeReport(report, {
      visibleRepos: new Set(['acme/api', 'acme/secret-billing']),
      visiblePullRequestIds: new Set(['hidden-pr']),
    });
    expect(scoped).toBe(report);
    expect(repoOfRef('acme/api#7')).toBe('acme/api');
  });
});

describe('maskSmeeUrl', () => {
  it('keeps only the origin of the channel URL', () => {
    expect(maskSmeeUrl('https://smee.io/AbCdEf123')).toBe('https://smee.io/…');
    expect(maskSmeeUrl('not a url')).not.toContain('not a url');
  });
});
