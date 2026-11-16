import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAiProvider } from '@gmp/ai';
import {
  aiProviders,
  aiUsage,
  isDatabaseReachable,
  notificationChannels,
  notifications,
} from '@gmp/db';
import { buildServer } from './app.ts';
import { MemoryJobQueue } from './queue.ts';
import {
  as,
  createMember,
  createServerTestDb,
  createTestApp,
  setupAdmin,
  testConfig,
  type Session,
  type TestApp,
} from './test/helpers.ts';

const reachable = await isDatabaseReachable();
const API_KEY = 'sk-ant-api03-' + 'A'.repeat(90);
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX';

describe.skipIf(!reachable)('AI settings, notifications, users, system', () => {
  let t: TestApp;
  let admin: Session;
  const fake = new FakeAiProvider([{ text: 'OK' }]);
  const slackSent: Array<{ url: string; text: string }> = [];

  beforeAll(async () => {
    t = await createTestApp({
      aiProviderFactory: () => fake,
      notifyTestOptions: {
        senders: {
          slack: async (url, msg) => {
            slackSent.push({ url, text: msg.text });
          },
          email: async () => {},
        },
      },
    });
    admin = await setupAdmin(t);
  });
  afterAll(async () => t?.close());

  it('requires consent before enabling AI and records it', async () => {
    const a = as(t, admin);
    const initial = await a('GET', '/api/settings/ai');
    expect(initial.json()).toMatchObject({
      enabled: false,
      consentAt: null,
      monthlyBudgetUsd: 100,
    });
    expect(initial.json().budget).toMatchObject({ spentUsd: 0, capUsd: 100, exhausted: false });

    const noConsent = await a('PUT', '/api/settings/ai', { enabled: true });
    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.json().code).toBe('consent_required');

    const ok = await a('PUT', '/api/settings/ai', {
      enabled: true,
      consent: true,
      monthlyBudgetUsd: 50,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      enabled: true,
      consentBy: admin.userId,
      monthlyBudgetUsd: 50,
    });
    expect(ok.json().consentAt).toBeTruthy();

    const withdraw = await a('PUT', '/api/settings/ai', { consent: false });
    expect(withdraw.json()).toMatchObject({ enabled: false, consentAt: null });
    await a('PUT', '/api/settings/ai', { enabled: true, consent: true });
  });

  it('stores provider keys encrypted, never returns them, and tests providers', async () => {
    const a = as(t, admin);
    const created = await a('POST', '/api/settings/ai/providers', {
      name: 'Anthropic',
      kind: 'anthropic',
      apiKey: API_KEY,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Anthropic', apiKeyConfigured: true });
    expect(JSON.stringify(created.json())).not.toContain('sk-ant');
    const [row] = await t.db.handle.db.select().from(aiProviders);
    expect(row!.apiKeyEnc!.startsWith('v1:')).toBe(true);
    expect(row!.apiKeyEnc).not.toContain('sk-ant');

    const list = await a('GET', '/api/settings/ai/providers');
    expect(JSON.stringify(list.json())).not.toContain('sk-ant');

    const id = created.json().id as string;
    const models = await a('PUT', '/api/settings/ai', {
      taskModels: {
        pr_report: { providerId: id, model: 'claude-sonnet-5-5', maxOutputTokens: 4000 },
      },
    });
    expect(models.statusCode).toBe(200);
    const badModels = await a('PUT', '/api/settings/ai', {
      taskModels: {
        triage: {
          providerId: '3f1c2a3e-1111-4222-8333-444455556666',
          model: 'm',
          maxOutputTokens: 10,
        },
      },
    });
    expect(badModels.statusCode).toBe(400);

    const test = await a('POST', `/api/settings/ai/providers/${id}/test`, {});
    expect(test.json()).toMatchObject({ ok: true, model: 'claude-sonnet-5-5' });
    expect(fake.calls).toHaveLength(1);

    fake.enqueue({ error: new Error(`401 invalid x-api-key ${API_KEY}`) });
    const failed = await a('POST', `/api/settings/ai/providers/${id}/test`, {});
    expect(failed.json().ok).toBe(false);
    expect(failed.json().error).not.toContain(API_KEY);

    const rotate = await a('PATCH', `/api/settings/ai/providers/${id}`, {
      apiKey: 'sk-new-key-value-1234567890',
    });
    expect(rotate.json()).toMatchObject({ apiKeyConfigured: true });

    await t.db.handle.db.insert(aiUsage).values({
      orgId: admin.orgId,
      task: 'pr_report',
      providerKind: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 1.25,
    });
    const usage = await a('GET', '/api/usage');
    expect(usage.json().budget).toMatchObject({ spentUsd: 1.25, capUsd: 50 });
    expect(usage.json().byTask).toEqual([
      expect.objectContaining({ key: 'pr_report', inputTokens: 1000, costUsd: 1.25, calls: 1 }),
    ]);

    const del = await a('DELETE', `/api/settings/ai/providers/${id}`);
    expect(del.statusCode).toBe(200);
    const after = await a('GET', '/api/settings/ai');
    expect(after.json().taskModels).toEqual({});
  });

  it('manages notification channels with write-only secrets', async () => {
    const a = as(t, admin);
    const bad = await a('POST', '/api/settings/notification-channels', {
      kind: 'slack',
      name: 'Bad',
      config: { webhookUrl: 'http://insecure.example' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_channel_config');

    const ch = await a('POST', '/api/settings/notification-channels', {
      kind: 'slack',
      name: 'Team Slack',
      config: { webhookUrl: SLACK_URL },
    });
    expect(ch.statusCode).toBe(201);
    expect(ch.json()).toMatchObject({
      configured: true,
      config: { webhookConfigured: true, webhookHost: 'hooks.slack.com' },
    });
    expect(JSON.stringify(ch.json())).not.toContain('XXXXXXXX');
    const [row] = await t.db.handle.db.select().from(notificationChannels);
    expect(row!.configEnc).not.toContain('hooks.slack.com');

    const email = await a('POST', '/api/settings/notification-channels', {
      kind: 'email',
      name: 'SMTP',
      config: {
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        user: 'mailer',
        pass: 'smtp-password-1',
        from: 'gmp@example.test',
        to: ['ops@example.test'],
      },
    });
    expect(email.statusCode).toBe(201);
    expect(email.json().config).toMatchObject({
      username: 'mailer',
      passwordConfigured: true,
      testRecipient: 'ops@example.test',
    });
    expect(JSON.stringify(email.json())).not.toContain('smtp-password-1');
    // Updating without a password keeps the stored one.
    const patched = await a('PATCH', `/api/settings/notification-channels/${email.json().id}`, {
      config: { host: 'smtp2.example.test', password: '' },
    });
    expect(patched.json().config).toMatchObject({
      host: 'smtp2.example.test',
      passwordConfigured: true,
    });

    const test = await a('POST', `/api/settings/notification-channels/${ch.json().id}/test`, {});
    expect(test.json()).toEqual({ ok: true });
    expect(slackSent).toHaveLength(1);
    expect(slackSent[0]!.url).toBe(SLACK_URL);

    const rule = await a('POST', '/api/settings/notification-rules', {
      minSeverity: 'medium',
      channelIds: [ch.json().id],
      digestHour: 8,
      timezone: 'Europe/London',
      quietStart: '22:00',
      quietEnd: '07:00',
    });
    expect(rule.statusCode).toBe(201);
    expect(rule.json()).toMatchObject({ projectId: null, minSeverity: 'medium', digestHour: 8 });
    const dupRule = await a('POST', '/api/settings/notification-rules', {});
    expect(dupRule.statusCode).toBe(409);
    const halfQuiet = await a('PATCH', `/api/settings/notification-rules/${rule.json().id}`, {
      quietEnd: null,
    });
    expect(halfQuiet.statusCode).toBe(400);
    const badTz = await a('PATCH', `/api/settings/notification-rules/${rule.json().id}`, {
      timezone: 'Mars/Base',
    });
    expect(badTz.statusCode).toBe(400);

    await a('DELETE', `/api/settings/notification-channels/${ch.json().id}`);
    const rules = await a('GET', '/api/settings/notification-rules');
    expect(rules.json()[0].channelIds).toEqual([]);
  });

  it('serves the in-app inbox per user and marks items read', async () => {
    const member = await createMember(t, admin, 'inbox@example.test');
    const [mine] = await t.db.handle.db
      .insert(notifications)
      .values([
        {
          orgId: admin.orgId,
          userId: member.userId,
          kind: 'high_risk',
          severity: 'high',
          title: 'For member',
          dedupKey: 'k1',
          channelKind: 'in_app',
        },
        {
          orgId: admin.orgId,
          userId: admin.userId,
          kind: 'high_risk',
          severity: 'high',
          title: 'For admin',
          dedupKey: 'k2',
          channelKind: 'in_app',
        },
      ])
      .returning();
    const list = await as(t, member)('GET', '/api/notifications?unread=true');
    expect(list.json().map((n: { title: string }) => n.title)).toEqual(['For member']);
    const read = await as(t, member)('POST', `/api/notifications/${mine!.id}/read`);
    expect(read.statusCode).toBe(200);
    expect((await as(t, member)('GET', '/api/notifications?unread=true')).json()).toEqual([]);
    const notMine = await as(t, admin)('POST', `/api/notifications/${mine!.id}/read`);
    expect(notMine.statusCode).toBe(404);
  });

  it('reports system status and pages the audit log', async () => {
    const a = as(t, admin);
    const status = await a('GET', '/api/system/status');
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      database: { ok: true },
      webhooks: { backlog: 0, lastDeliveryAt: null },
      smeeEnabled: false,
      rateLimit: null,
    });
    expect(status.json().queues.map((q: { name: string }) => q.name)).toContain('webhook.process');

    const page1 = await a('GET', '/api/audit-log?limit=3');
    expect(page1.json().entries).toHaveLength(3);
    expect(page1.json().nextCursor).toBeTruthy();
    const page2 = await a('GET', `/api/audit-log?limit=3&before=${page1.json().nextCursor}`);
    const ids1 = page1.json().entries.map((e: { id: string }) => e.id);
    const ids2 = page2.json().entries.map((e: { id: string }) => e.id);
    expect(ids2.some((id: string) => ids1.includes(id))).toBe(false);
    const all = JSON.stringify((await a('GET', '/api/audit-log?limit=200')).json());
    expect(all).not.toContain('sk-ant');
    expect(all).not.toContain('smtp-password-1');
    expect(all).not.toContain(SLACK_URL);
  });
});

describe.skipIf(!reachable)('static SPA serving', () => {
  it('serves index.html for client routes and JSON 404 for unknown API routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmp-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>git-merge-pilot</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    const db = await createServerTestDb();
    const app = await buildServer({
      config: testConfig(db.url),
      db: db.handle.db,
      queue: new MemoryJobQueue(),
      webDist: dir,
      rateLimit: false,
    });
    try {
      const page = await app.inject({
        method: 'GET',
        url: '/projects/123',
        headers: { accept: 'text/html' },
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('git-merge-pilot');
      const root = await app.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(200);
      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
      const missingAsset = await app.inject({
        method: 'GET',
        url: '/assets/missing.js',
        headers: { accept: 'text/html' },
      });
      expect(missingAsset.statusCode).toBe(404);
      const api = await app.inject({
        method: 'GET',
        url: '/api/nope',
        headers: { accept: 'text/html' },
      });
      expect(api.statusCode).toBe(404);
      expect(api.json()).toMatchObject({ code: 'not_found' });
    } finally {
      await app.close();
      await db.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
