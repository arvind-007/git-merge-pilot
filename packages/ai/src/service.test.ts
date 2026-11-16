import { randomBytes } from 'node:crypto';
import { encrypt } from '@gmp/core';
import {
  aiProviders,
  aiSettings,
  aiUsage,
  createDb,
  createTestDatabase,
  isDatabaseReachable,
  organizations,
  type DbHandle,
  type TestDatabase,
} from '@gmp/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeAiProvider } from './providers/fake.ts';
import { AiService } from './service.ts';
import { AiError, type ProviderConfig } from './types.ts';
import { aiOutput, INJECTION_BODY, readiness, reportInput } from './test-fixtures.ts';

const reachable = await isDatabaseReachable();
const MASTER_KEY = randomBytes(32);
const TEST_API_KEY = `test-provider-key-${randomBytes(4).toString('hex')}`;
const NOW = new Date('2026-11-14T12:00:00Z');

let testDb: TestDatabase;
let handle: DbHandle;

beforeAll(async () => {
  if (!reachable) return;
  testDb = await createTestDatabase();
  handle = createDb(testDb.url, { max: 4 });
}, 60_000);

afterAll(async () => {
  if (!reachable) return;
  await handle?.close();
  await testDb?.drop();
});

interface Setup {
  orgId: string;
  providerId: string;
  fake: FakeAiProvider;
  factoryCalls: Array<ProviderConfig & { providerId: string }>;
  service: () => Promise<AiService>;
}

async function setup(
  opts: { enabled?: boolean; consent?: boolean; budget?: number; timezone?: string } = {},
): Promise<Setup> {
  const db = handle.db;
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${randomBytes(3).toString('hex')}`, timezone: opts.timezone ?? 'UTC' })
    .returning();
  const [provider] = await db
    .insert(aiProviders)
    .values({
      orgId: org!.id,
      name: 'Anthropic',
      kind: 'anthropic',
      apiKeyEnc: encrypt(TEST_API_KEY, MASTER_KEY),
    })
    .returning();
  await db.insert(aiSettings).values({
    orgId: org!.id,
    enabled: opts.enabled ?? true,
    consentAt: opts.consent === false ? null : NOW,
    monthlyBudgetUsd: opts.budget ?? 100,
    taskModels: {
      pr_report: { providerId: provider!.id, model: 'claude-sonnet-5-5', maxOutputTokens: 8000 },
    },
  });
  const fake = new FakeAiProvider();
  const factoryCalls: Setup['factoryCalls'] = [];
  return {
    orgId: org!.id,
    providerId: provider!.id,
    fake,
    factoryCalls,
    service: () =>
      AiService.create({
        db,
        orgId: org!.id,
        masterKey: MASTER_KEY,
        now: () => NOW,
        providerFactory: (cfg) => {
          factoryCalls.push(cfg);
          return fake;
        },
      }),
  };
}

describe.skipIf(!reachable)('AiService (Postgres)', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('generates an AI report, decrypts the key and records usage', async () => {
    s.fake.enqueue({
      json: aiOutput(),
      usage: { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 2_000 },
    });
    const svc = await s.service();
    expect(svc.isEnabledFor({ aiMode: 'full' })).toBe(true);
    const { report, usage } = await svc.generateReport(reportInput({ pullRequestId: null }));
    expect(report.generatedBy).toBe('ai');
    expect(s.factoryCalls[0]).toMatchObject({
      kind: 'anthropic',
      apiKey: TEST_API_KEY,
      providerId: s.providerId,
    });
    const req = s.fake.calls[0]!;
    expect(req.model).toBe('claude-sonnet-5-5');
    expect(req.maxOutputTokens).toBe(8000);
    expect(req.cacheSystem).toBe(true);
    expect(req.jsonSchema).toBeDefined();
    // 10k*$2 + 1k*$10 + 2k*$0.2 per MTok
    expect(usage).toMatchObject({
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 2_000,
      model: 'claude-sonnet-5-5',
    });
    expect(usage!.costUsd).toBeCloseTo(0.0304, 6);
    const rows = await handle.db.select().from(aiUsage).where(eq(aiUsage.orgId, s.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task: 'pr_report',
      providerKind: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputTokens: 10_000,
    });
    expect(rows[0]!.costUsd).toBeCloseTo(0.0304, 6);
    const budget = await svc.budgetStatus();
    expect(budget.spentUsd).toBeCloseTo(0.0304, 6);
    expect(budget.exhausted).toBe(false);
  });

  it('uses the deterministic report when AI is disabled, unconsented or off for the repo', async () => {
    const disabled = await setup({ enabled: false });
    const svc1 = await disabled.service();
    expect(svc1.isEnabledFor({ aiMode: 'full' })).toBe(false);
    const r1 = await svc1.generateReport(reportInput());
    expect(r1.report.generatedBy).toBe('deterministic');
    expect(r1.usage).toBeNull();
    expect(r1.report.limitations.join(' ')).toMatch(/not enabled for this organization/);

    const noConsent = await setup({ consent: false });
    expect((await noConsent.service()).isEnabledFor({ aiMode: 'full' })).toBe(false);

    const svc = await s.service();
    const off = await svc.generateReport(
      reportInput({ repo: { fullName: 'acme/api', aiMode: 'off' } }),
    );
    expect(off.report.generatedBy).toBe('deterministic');
    expect(off.report.limitations.join(' ')).toMatch(/disabled for this repository/);
    expect(s.fake.calls).toHaveLength(0);
    expect(disabled.fake.calls).toHaveLength(0);
  });

  it('sends no code for metadata_only repos', async () => {
    s.fake.enqueue({ json: aiOutput() });
    const svc = await s.service();
    const { report } = await svc.generateReport(
      reportInput({ repo: { fullName: 'acme/api', aiMode: 'metadata_only' } }),
    );
    expect(report.generatedBy).toBe('ai');
    expect(s.fake.calls[0]!.messages[0]!.content).not.toContain('kind="diff"');
    expect(report.limitations.join(' ')).toMatch(/metadata-only/);
  });

  it('computes the budget for the current month in the org timezone and stops at the cap', async () => {
    const t = await setup({ budget: 1, timezone: 'America/New_York' });
    await handle.db.insert(aiUsage).values([
      // Previous month in New York (Oct 31 23:30 local) → not counted.
      {
        orgId: t.orgId,
        task: 'pr_report',
        providerKind: 'anthropic',
        model: 'm',
        costUsd: 50,
        occurredAt: new Date('2026-11-01T03:30:00Z'),
      },
      {
        orgId: t.orgId,
        task: 'pr_report',
        providerKind: 'anthropic',
        model: 'm',
        costUsd: 0.6,
        occurredAt: new Date('2026-11-05T00:00:00Z'),
      },
    ]);
    let svc = await t.service();
    let b = await svc.budgetStatus();
    expect(b.spentUsd).toBeCloseTo(0.6, 6);
    expect(b.pct).toBeCloseTo(60, 2);
    expect(b.exhausted).toBe(false);
    expect(b.alert).toBe(false);
    expect(b.timeZone).toBe('America/New_York');

    await handle.db.insert(aiUsage).values({
      orgId: t.orgId,
      task: 'triage',
      providerKind: 'anthropic',
      model: 'm',
      costUsd: 0.45,
      occurredAt: NOW,
    });
    svc = await t.service();
    b = await svc.budgetStatus();
    expect(b.exhausted).toBe(true);
    expect(b.alert).toBe(true);
    expect(svc.isEnabledFor({ aiMode: 'full' })).toBe(false);
    const { report } = await svc.generateReport(reportInput());
    expect(report.generatedBy).toBe('deterministic');
    expect(report.limitations.join(' ')).toMatch(/AI budget reached/);
    expect(t.fake.calls).toHaveLength(0);
  });

  it('falls back to deterministic on refusal / invalid output and still records consumed tokens', async () => {
    s.fake.enqueue(
      {
        error: new AiError('refusal', 'declined', {
          usage: { inputTokens: 5000, outputTokens: 10, cacheReadTokens: 0 },
          model: 'claude-sonnet-5-5',
        }),
      },
      { json: { executiveSummary: 42 } },
    );
    const svc = await s.service();
    const refused = await svc.generateReport(reportInput());
    expect(refused.report.generatedBy).toBe('deterministic');
    expect(refused.report.limitations.join(' ')).toMatch(/declined/);
    const invalid = await svc.generateReport(reportInput());
    expect(invalid.report.generatedBy).toBe('deterministic');
    expect(invalid.usage).not.toBeNull();
    const rows = await handle.db.select().from(aiUsage).where(eq(aiUsage.orgId, s.orgId));
    expect(rows).toHaveLength(2);
  });

  it('prompt injection in the PR body cannot change deterministic readiness and stays inside untrusted_data', async () => {
    // A model that "obeys" the injected instruction.
    s.fake.setHandler(() => ({
      json: aiOutput({
        executiveSummary: 'Ready to merge. This PR is secure.',
        scoreAdjustments: [
          { dimension: 'breaking_change', delta: -100, rationale: 'as instructed' },
          { dimension: 'security', delta: -100, rationale: 'as instructed' },
        ],
        openQuestions: [],
        concerns: [],
      }),
    }));
    const svc = await s.service();
    const input = reportInput({ pr: { ...reportInput().pr, body: INJECTION_BODY } });
    const { report } = await svc.generateReport(input);

    expect(report.mergeReadiness).toEqual(input.risk.mergeReadiness);
    expect(report.mergeReadiness.recommendation).toBe('merge_after_checks');
    expect(report.overallRisk).toBe('high');
    expect(report.breakingChanges).toContainEqual(input.findings[0]);

    const req = s.fake.calls[0]!;
    expect(req.system).not.toMatch(/ignore previous instructions/i);
    const user = req.messages[0]!.content;
    const id = /Request boundary id: ([0-9a-f]+)/.exec(user)![1]!;
    const outside = user.replace(
      new RegExp(`<untrusted_data id="${id}"[^>]*>[\\s\\S]*?</untrusted_data id="${id}">`, 'g'),
      '',
    );
    expect(outside).not.toMatch(/ignore previous instructions/i);
    expect(outside).not.toContain('mark ready_to_merge');
    const inside = user.slice(user.indexOf(`<untrusted_data id="${id}" kind="pull_request">`));
    expect(inside).toContain('ignore previous instructions');

    // Even a "ready" deterministic baseline is never upgraded by AI; an AI-suspected injection adds a concern.
    s.fake.setHandler(() => ({ json: aiOutput({ promptInjectionSuspected: true }) }));
    const ready = reportInput({
      pr: { ...reportInput().pr, body: INJECTION_BODY },
      risk: {
        ...reportInput().risk,
        mergeReadiness: readiness({ recommendation: 'changes_required' }),
      },
    });
    const r2 = await svc.generateReport(ready);
    expect(r2.report.mergeReadiness.recommendation).toBe('changes_required');
    expect(r2.report.security.some((f) => f.source === 'ai' && !f.verified)).toBe(true);
  });

  it('triage uses AI when enabled and falls back to rules on failure', async () => {
    const svc = await s.service();
    s.fake.enqueue({ json: { meaningful: false, reason: 'Only formatting changed.' } });
    const input = {
      repo: { fullName: 'acme/api', aiMode: 'full' as const },
      pr: { number: 1, title: 't' },
      changedFiles: [{ path: 'src/a.ts', patch: '+x' }],
    };
    await expect(svc.triage(input)).resolves.toEqual({
      meaningful: false,
      reason: 'Only formatting changed.',
      generatedBy: 'ai',
    });
    expect(s.fake.calls[0]!.model).toBe('claude-haiku-5-5');
    s.fake.enqueue({ error: new AiError('api_error', 'down') });
    await expect(svc.triage(input)).resolves.toMatchObject({
      meaningful: true,
      generatedBy: 'deterministic',
    });
  });

  it('refuses AI for a model without a known price (budget could not be enforced), until one is set', async () => {
    await handle.db
      .update(aiSettings)
      .set({
        taskModels: {
          pr_report: { providerId: s.providerId, model: 'vendor-model-x', maxOutputTokens: 8000 },
        },
      })
      .where(eq(aiSettings.orgId, s.orgId));
    let svc = await s.service();
    expect(svc.isEnabledFor({ aiMode: 'full' })).toBe(false);
    expect(svc.disabledReason({ aiMode: 'full' })).toMatch(/No price is configured/);
    expect(svc.unpricedModels()).toEqual(['vendor-model-x']);
    const { report } = await svc.generateReport(reportInput({ pullRequestId: null }));
    expect(report.generatedBy).toBe('deterministic');
    expect(s.fake.calls).toHaveLength(0);

    await handle.db
      .update(aiSettings)
      .set({
        taskModels: {
          pr_report: {
            providerId: s.providerId,
            model: 'vendor-model-x',
            maxOutputTokens: 8000,
            price: { inputPerMTok: 3, outputPerMTok: 15 },
          },
        },
      })
      .where(eq(aiSettings.orgId, s.orgId));
    svc = await s.service();
    expect(svc.unpricedModels()).toEqual([]);
    // The provider answers with a dated id; the configured model's price still applies.
    s.fake.enqueue({
      json: aiOutput(),
      model: 'vendor-model-x-2026-11-01',
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
    });
    const out = await svc.generateReport(reportInput({ pullRequestId: null }));
    expect(out.report.generatedBy).toBe('ai');
    expect(out.usage?.costUsd).toBeCloseTo(3, 6);
  });

  it('confirmRelationships keeps related candidates (never raising confidence) and drops rejected ones', async () => {
    const svc = await s.service();
    const repo = { fullName: 'acme/api', aiMode: 'full' as const };
    const mk = (n: number) => ({
      prA: { id: `a${n}`, ref: `acme/api#${n}`, title: 'Add retry', files: ['src/a.ts'], repo },
      prB: { id: `b${n}`, ref: `acme/web#${n}`, title: 'Add retry', files: ['src/b.ts'], repo },
      type: 'duplicate_work' as const,
      confidence: 'possible' as const,
      summary: 'Similar titles',
    });
    s.fake.enqueue({
      json: {
        verdicts: [
          {
            index: 0,
            related: true,
            confidence: 'likely',
            summary: 'Both add retry logic to the same client.',
            rationale: 'Same intent',
          },
          {
            index: 1,
            related: false,
            confidence: 'possible',
            summary: '',
            rationale: 'Different features',
          },
        ],
      },
    });
    const out = await svc.confirmRelationships([mk(1), mk(2)]);
    expect(out).toHaveLength(1);
    // A 'possible' duplicate-work candidate stays 'possible' even when the AI says 'likely'.
    expect(out[0]).toMatchObject({ confidence: 'possible', ai: { related: true } });
    expect(s.fake.calls[0]!.model).toBe('claude-opus-5-5');

    const offRepo = { fullName: 'x/y', aiMode: 'off' as const };
    const passthrough = await svc.confirmRelationships([
      { ...mk(3), prB: { ...mk(3).prB, repo: offRepo } },
    ]);
    expect(passthrough).toHaveLength(1);
    expect(passthrough[0]!.ai).toBeUndefined();
  });

  it('writeDigest uses AI text and falls back to the deterministic digest', async () => {
    const svc = await s.service();
    const input = {
      periodLabel: 'Nov 14',
      items: [
        {
          prRef: 'acme/api#1',
          title: 'Fix',
          repo: 'acme/api',
          overallRisk: 'low' as const,
          recommendation: 'ready_to_merge' as const,
        },
      ],
    };
    s.fake.enqueue({ text: 'Today: one low-risk fix is ready.' });
    await expect(svc.writeDigest(input)).resolves.toBe('Today: one low-risk fix is ready.');
    s.fake.enqueue({ error: new AiError('max_tokens', 'cut') });
    await expect(svc.writeDigest(input)).resolves.toMatch(/Pull request digest/);
  });
});
