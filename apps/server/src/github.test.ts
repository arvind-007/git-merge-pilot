import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { decrypt, encrypt } from '@gmp/core';
import {
  githubApps,
  installations,
  isDatabaseReachable,
  repositories,
  webhookDeliveries,
} from '@gmp/db';
import {
  signWebhookPayload,
  type GitHubClient,
  type InstallationInfo,
  type InstallationRepository,
  type ManifestConversion,
} from '@gmp/github';
import { buildServer } from './app.ts';
import { startPgBossQueue } from './queue.ts';
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

const WEBHOOK_SECRET = 'whsec-test-0123456789abcdef';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----\n';

const conversion: ManifestConversion = {
  appId: 424242,
  slug: 'gmp-test-app',
  name: 'gmp test app',
  clientId: 'Iv1.testclientid',
  clientSecret: 'client-secret-value-123',
  pem: PEM,
  webhookSecret: WEBHOOK_SECRET,
  htmlUrl: 'https://github.com/apps/gmp-test-app',
  ownerLogin: 'acme',
  permissions: { contents: 'read' },
  events: ['pull_request'],
};

const installInfo: InstallationInfo = {
  installationId: 777,
  appId: 424242,
  accountLogin: 'acme',
  accountType: 'Organization',
  repositorySelection: 'selected',
  permissions: { contents: 'read', pull_requests: 'read' },
  events: ['pull_request'],
  suspendedAt: null,
  htmlUrl: null,
};

function repo(id: number, name: string): InstallationRepository {
  return {
    githubId: id,
    owner: 'acme',
    name,
    fullName: `acme/${name}`,
    private: true,
    defaultBranch: 'main',
    archived: false,
    disabled: false,
    fork: false,
    htmlUrl: `https://github.com/acme/${name}`,
    language: 'TypeScript',
    pushedAt: null,
    updatedAt: null,
  };
}

function fakeClient(
  repos: () => InstallationRepository[],
): (creds: { privateKey: string }) => GitHubClient {
  return (creds) => {
    expect(creds.privateKey).toBe(PEM);
    return {
      appId: 424242,
      apiUrl: 'https://api.github.com',
      appOctokit: () => {
        throw new Error('not used');
      },
      installationOctokit: () => {
        throw new Error('not used');
      },
      getInstallationToken: async () => ({ token: 'x', expiresAt: new Date().toISOString() }),
      getApp: async () => {
        throw new Error('not used');
      },
      listInstallations: async () => [installInfo],
      getInstallation: async () => installInfo,
      listInstallationRepos: async () => repos(),
      forgetInstallation: () => {},
    } as GitHubClient;
  };
}

describe.skipIf(!reachable)('GitHub status with a smee relay', () => {
  const SMEE = 'https://smee.io/secretChannel0123456789';
  let t: TestApp;
  let admin: Session;
  beforeAll(async () => {
    t = await createTestApp({
      configOverrides: { SMEE_URL: SMEE, WEB_URL: 'http://localhost:5173' },
    });
    admin = await setupAdmin(t);
  });
  afterAll(async () => t?.close());

  it('never returns the smee channel URL, to admins or members', async () => {
    const member = await createMember(t, admin, 'member-smee@example.com');
    for (const s of [admin, member]) {
      const res = await as(t, s)('GET', '/api/github/status');
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('secretChannel0123456789');
      expect(res.json()).toMatchObject({ smeeEnabled: true, webhookUrl: 'https://smee.io/…' });
    }
  });

  it('redirects GitHub callbacks to WEB_URL when it differs from PUBLIC_URL', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/github/install/callback?installation_id=1',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^http:\/\/localhost:5173\/login\?next=/);
    const forbidden = await t.app.inject({
      method: 'GET',
      url: '/api/github/install/callback?installation_id=1',
      cookies: { gmp_session: admin.cookie },
    });
    expect(forbidden.headers.location).toMatch(/^http:\/\/localhost:5173\/(setup|settings)/);
  });
});

describe.skipIf(!reachable)('GitHub App manifest + install flow', () => {
  let t: TestApp;
  let admin: Session;
  let currentRepos = [repo(1, 'api'), repo(2, 'web')];
  const codes: string[] = [];

  beforeAll(async () => {
    t = await createTestApp({
      github: {
        convertManifestCode: async (code) => {
          codes.push(code);
          return conversion;
        },
        createClient: fakeClient(() => currentRepos),
      },
    });
    admin = await setupAdmin(t);
  });
  afterAll(async () => t?.close());

  it('builds a read-only manifest and stores credentials encrypted on callback', async () => {
    const res = await as(t, admin)('POST', '/api/github/manifest', {
      org: 'acme',
      returnTo: 'setup',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.postUrl).toMatch(
      /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/,
    );
    expect(body.manifest.hook_attributes.url).toBe('http://localhost:3000/api/github/webhook');
    expect(body.manifest.redirect_url).toBe('http://localhost:3000/api/github/manifest/callback');
    expect(Object.values(body.manifest.default_permissions).every((v) => v === 'read')).toBe(true);
    const stateCookie = res.cookies.find((c) => c.name === 'gmp_gh_state')!;
    expect(stateCookie.httpOnly).toBe(true);

    // Wrong state is rejected.
    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/github/manifest/callback?code=abc&state=wrong',
      cookies: { gmp_session: admin.cookie, gmp_gh_state: stateCookie.value },
    });
    expect(bad.statusCode).toBe(302);
    expect(bad.headers.location).toContain('error=invalid_state');
    expect(codes).toHaveLength(0);

    const cb = await t.app.inject({
      method: 'GET',
      url: `/api/github/manifest/callback?code=abc123&state=${encodeURIComponent(body.state)}`,
      cookies: { gmp_session: admin.cookie, gmp_gh_state: stateCookie.value },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/setup?github=created&step=2');
    expect(codes).toEqual(['abc123']);

    const [row] = await t.db.handle.db.select().from(githubApps);
    expect(row!.appId).toBe(424242);
    for (const enc of [row!.clientSecretEnc, row!.privateKeyEnc, row!.webhookSecretEnc]) {
      expect(enc.startsWith('v1:')).toBe(true);
    }
    expect(JSON.stringify(row)).not.toContain('client-secret-value');
    expect(JSON.stringify(row)).not.toContain(WEBHOOK_SECRET);
    expect(decrypt(row!.webhookSecretEnc, t.config.masterKey)).toBe(WEBHOOK_SECRET);
  });

  it('requires a session for the callback', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/github/manifest/callback?code=x&state=y',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?next=/);
  });

  it('syncs installations and repositories on install callback and enqueues discovery', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/github/install/callback?installation_id=777&setup_action=install',
      cookies: { gmp_session: admin.cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/setup?github=installed&step=3');
    const inst = await t.db.handle.db.select().from(installations);
    expect(inst).toHaveLength(1);
    expect(inst[0]).toMatchObject({ installationId: 777, accountLogin: 'acme' });
    const repos = await t.db.handle.db.select().from(repositories).orderBy(repositories.fullName);
    expect(repos.map((r) => r.fullName)).toEqual(['acme/api', 'acme/web']);
    expect(repos.every((r) => r.installationId === inst[0]!.id && r.monitoringEnabled)).toBe(true);
    const jobs = t.queue.byName('repo.discover');
    expect(jobs.map((j) => (j.data as { repositoryId: string }).repositoryId).sort()).toEqual(
      repos.map((r) => r.id).sort(),
    );

    // Second sync after a repo was removed from the installation detaches it.
    currentRepos = [repo(1, 'api')];
    const sync = await as(t, admin)('POST', '/api/github/sync-installations');
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({
      installations: 1,
      repositories: 1,
      addedRepositories: 0,
      detachedRepositories: 1,
    });
    const [web] = await t.db.handle.db
      .select()
      .from(repositories)
      .where(eq(repositories.githubId, 2));
    expect(web).toMatchObject({ installationId: null, monitoringEnabled: false });
    expect(t.queue.byName('repo.discover')).toHaveLength(2);

    const available = await as(t, admin)('GET', '/api/github/repositories');
    expect(available.json()).toEqual([
      expect.objectContaining({
        fullName: 'acme/api',
        installationId: 777,
        monitoringEnabled: true,
      }),
    ]);
  });

  it('reports status without exposing secrets, and disconnects', async () => {
    const res = await as(t, admin)('GET', '/api/github/status');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      connected: true,
      app: {
        appId: 424242,
        slug: 'gmp-test-app',
        webhookSecretConfigured: true,
        privateKeyConfigured: true,
      },
      installUrl: 'https://github.com/apps/gmp-test-app/installations/new',
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(WEBHOOK_SECRET);
    expect(text).not.toContain('client-secret-value');
    expect(text).not.toContain('PRIVATE KEY');

    const del = await as(t, admin)('DELETE', '/api/github/app');
    expect(del.json()).toMatchObject({ ok: true, removed: 1 });
    expect(await t.db.handle.db.select().from(githubApps)).toHaveLength(0);
    // Repositories (and their history) survive the disconnect.
    expect(await t.db.handle.db.select().from(repositories)).toHaveLength(2);
  });
});

describe.skipIf(!reachable)('webhook endpoint', () => {
  let t: TestApp;
  let admin: Session;
  const payload = JSON.stringify({
    action: 'opened',
    installation: { id: 777 },
    repository: { full_name: 'acme/api' },
    pull_request: { number: 5, title: 'Has a \u0000 NUL' },
  });

  function post(body: string, headers: Record<string, string>) {
    return t.app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: { 'content-type': 'application/json', ...headers },
      payload: body,
    });
  }

  beforeAll(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
  });
  afterAll(async () => t?.close());

  it('rejects deliveries when no app is configured', async () => {
    const res = await post(payload, {
      'x-hub-signature-256': signWebhookPayload(WEBHOOK_SECRET, payload),
      'x-github-delivery': 'd-0',
      'x-github-event': 'pull_request',
    });
    expect(res.statusCode).toBe(401);
  });

  it('verifies signatures, stores deliveries idempotently and enqueues once', async () => {
    await t.db.handle.db.insert(githubApps).values({
      orgId: admin.orgId,
      appId: 1,
      slug: 's',
      name: 'n',
      clientId: 'c',
      clientSecretEnc: encrypt('x', t.config.masterKey),
      privateKeyEnc: encrypt(PEM, t.config.masterKey),
      webhookSecretEnc: encrypt(WEBHOOK_SECRET, t.config.masterKey),
      htmlUrl: 'https://github.com/apps/s',
    });

    const tampered = await post(payload.replace('opened', 'closed'), {
      'x-hub-signature-256': signWebhookPayload(WEBHOOK_SECRET, payload),
      'x-github-delivery': 'd-1',
      'x-github-event': 'pull_request',
    });
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json().code).toBe('invalid_signature');
    const wrongSecret = await post(payload, {
      'x-hub-signature-256': signWebhookPayload('other-secret', payload),
      'x-github-delivery': 'd-1',
      'x-github-event': 'pull_request',
    });
    expect(wrongSecret.statusCode).toBe(401);
    const missing = await post(payload, {
      'x-github-delivery': 'd-1',
      'x-github-event': 'pull_request',
    });
    expect(missing.statusCode).toBe(401);
    expect(await t.db.handle.db.select().from(webhookDeliveries)).toHaveLength(0);

    const headers = {
      'x-hub-signature-256': signWebhookPayload(WEBHOOK_SECRET, payload),
      'x-github-delivery': 'delivery-abc',
      'x-github-event': 'pull_request',
    };
    const first = await post(payload, headers);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ ok: true, duplicate: false });
    const second = await post(payload, headers);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ ok: true, duplicate: true });

    const rows = await t.db.handle.db.select().from(webhookDeliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: admin.orgId,
      deliveryId: 'delivery-abc',
      event: 'pull_request',
      action: 'opened',
      installationId: 777,
      repositoryFullName: 'acme/api',
      status: 'queued',
    });
    expect((rows[0]!.payload as { pull_request: { title: string } }).pull_request.title).toBe(
      'Has a  NUL',
    );
    const jobs = t.queue.byName('webhook.process');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual({
      webhookDeliveryId: rows[0]!.id,
      deliveryId: 'delivery-abc',
      event: 'pull_request',
      orgId: admin.orgId,
    });

    // A delivery whose processing permanently failed is re-enqueued on GitHub "Redeliver".
    await t.db.handle.db
      .update(webhookDeliveries)
      .set({ status: 'failed', error: 'boom' })
      .where(eq(webhookDeliveries.deliveryId, 'delivery-abc'));
    const redelivered = await post(payload, headers);
    expect(redelivered.statusCode).toBe(202);
    expect(redelivered.json()).toMatchObject({ ok: true, duplicate: true });
    expect(t.queue.byName('webhook.process')).toHaveLength(2);
    const [afterRedeliver] = await t.db.handle.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, 'delivery-abc'));
    expect(afterRedeliver).toMatchObject({ status: 'queued', error: null });
    // Queued deliveries stay deduplicated.
    await post(payload, headers);
    expect(t.queue.byName('webhook.process')).toHaveLength(2);
  });

  it('accepts form-encoded payloads and ignores unhandled events without enqueuing', async () => {
    const ping = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 });
    const res = await post(ping, {
      'x-hub-signature-256': signWebhookPayload(WEBHOOK_SECRET, ping),
      'x-github-delivery': 'ping-1',
      'x-github-event': 'ping',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ignored: true });
    const [row] = await t.db.handle.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, 'ping-1'));
    expect(row!.status).toBe('ignored');

    const form = `payload=${encodeURIComponent(payload)}`;
    const formRes = await t.app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-hub-signature-256': signWebhookPayload(WEBHOOK_SECRET, form),
        'x-github-delivery': 'form-1',
        'x-github-event': 'pull_request',
      },
      payload: form,
    });
    expect(formRes.statusCode).toBe(202);
    expect(t.queue.byName('webhook.process')).toHaveLength(3);
  });

  it('does not require CSRF or a session, and other routes still parse JSON', async () => {
    const body = JSON.stringify({ action: 'created', installation: { id: 1 } });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signWebhookPayload(WEBHOOK_SECRET, body),
        'x-github-delivery': 'inst-1',
        'x-github-event': 'installation',
      },
      cookies: { gmp_session: admin.cookie },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const project = await as(t, admin)('POST', '/api/projects', { name: 'Still JSON' });
    expect(project.statusCode).toBe(201);
  });
});

describe.skipIf(!reachable)('webhook with real pg-boss queue', () => {
  it('enqueues webhook.process into pg-boss', async () => {
    const db = await createServerTestDb();
    const config = testConfig(db.url);
    const q = await startPgBossQueue(db.url);
    const app = await buildServer({
      config,
      db: db.handle.db,
      queue: q.queue,
      webDist: null,
      rateLimit: false,
    });
    try {
      const [org] = await db.handle.db
        .execute(sql`INSERT INTO organizations (name) VALUES ('o') RETURNING id`)
        .then((r) => (r as unknown as { rows: Array<{ id: string }> }).rows);
      await db.handle.db.insert(githubApps).values({
        orgId: org!.id,
        appId: 2,
        slug: 's',
        name: 'n',
        clientId: 'c',
        clientSecretEnc: encrypt('x', config.masterKey),
        privateKeyEnc: encrypt(PEM, config.masterKey),
        webhookSecretEnc: encrypt(WEBHOOK_SECRET, config.masterKey),
        htmlUrl: 'https://github.com/apps/s',
      });
      const body = JSON.stringify({ action: 'opened', pull_request: { number: 1 } });
      for (let i = 0; i < 2; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/github/webhook',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': signWebhookPayload(WEBHOOK_SECRET, body),
            'x-github-delivery': 'real-queue-1',
            'x-github-event': 'pull_request',
          },
          payload: body,
        });
        expect(res.statusCode).toBe(202);
      }
      const jobs = await q.boss.findJobs<{ deliveryId: string }>('webhook.process');
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.data.deliveryId).toBe('real-queue-1');
      const stats = await q.queue.stats();
      expect(stats.map((s) => s.name)).toContain('pr.analyze');
    } finally {
      await app.close();
      await q.stop();
      await db.drop();
    }
  }, 60_000);
});
