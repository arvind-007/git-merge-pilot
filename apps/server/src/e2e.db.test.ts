/**
 * End-to-end integration test (design §15) against real Postgres:
 *
 *   setup via the server API → stored GitHub App credentials → installation sync (GitHub API
 *   mocked with nock) → signed pull_request webhooks POSTed to the server → server jobs handed to
 *   the real worker handlers (real Octokit gateway, nock-mocked GitHub REST/GraphQL, fake AI
 *   provider) → findings, relationships, readiness and notifications → synchronize webhook with a
 *   fix → incremental analysis resolves the secret finding.
 *
 * No real network calls: nock blocks every non-mocked host.
 */
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAiProvider, type AiCompletionRequest } from '@gmp/ai';
import { encrypt, type Finding } from '@gmp/core';
import {
  analyses,
  findings,
  githubApps,
  isDatabaseReachable,
  notifications,
  prRelationships,
  pullRequests,
  repositories,
  webhookDeliveries,
} from '@gmp/db';
import {
  createGitHubGateway,
  createWorker,
  RecordingJobQueue,
  type QueueName,
  type Worker,
} from '@gmp/worker';
import { QUEUES } from './queue.ts';
import { as, createTestApp, setupAdmin, type Session, type TestApp } from './test/helpers.ts';

const reachable = await isDatabaseReachable();

const API = 'https://api.github.com';
const OWNER = 'example-org';
const PROVIDER_REPO = 'orders-service';
const CONSUMER_REPO = 'storefront';
const INSTALLATION_ID = 7_654_321;
const APP_ID = 424_242;
const WEBHOOK_SECRET = randomBytes(24).toString('hex');
// Built at runtime so this file does not itself look like a leaked credential.
const FAKE_AWS_KEY = ['AKIA', 'Z7Q3X5LMN2PR4T6V'].join('');

const BASE_SHA = 'b'.repeat(40);
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const CONSUMER_BASE = 'c'.repeat(40);
const CONSUMER_HEAD = 'd'.repeat(40);

// ---------------------------------------------------------------------------
// Source fixtures (generic code; no real project names)
// ---------------------------------------------------------------------------

const ORDERS_BASE = `import { Router } from 'express';
import { db } from './db';

export const router = Router();

export function getOrder(id: string) {
  return db.orders.find(id);
}

router.get('/api/orders/:id', async (req, res) => {
  res.json(await getOrder(req.params.id));
});
`;

const ORDERS_V1 = `import { Router } from 'express';
import { db } from './db';

export const router = Router();

export function getOrder(id: string, includeItems: boolean) {
  return db.orders.find(id, { includeItems });
}

router.get('/api/v2/orders/:id', async (req, res) => {
  res.json(await getOrder(req.params.id, true));
});
`;

const CONFIG_BASE = `export const config = {
  region: process.env.AWS_REGION ?? 'us-east-1',
};
`;

const CONFIG_V1 = `export const config = {
  region: process.env.AWS_REGION ?? 'us-east-1',
  accessKeyId: '${FAKE_AWS_KEY}',
};
`;

const CONFIG_V2 = `export const config = {
  region: process.env.AWS_REGION ?? 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
};
`;

const CLIENT_BASE = `export async function listOrders() {
  const res = await fetch('/api/orders');
  return res.json();
}
`;

const CLIENT_HEAD = `export async function listOrders() {
  const res = await fetch('/api/orders');
  return res.json();
}

export async function loadOrder(id: string) {
  const res = await fetch(\`/api/orders/\${id}\`);
  return res.json();
}
`;

// ---------------------------------------------------------------------------
// Fake GitHub HTTP API (served by nock)
// ---------------------------------------------------------------------------

/** Unified diff (single hunk, full context) between two texts, via line LCS. */
function makePatch(before: string, after: string): string {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i++]}`);
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      lines.push(`-${a[i++]}`);
    } else {
      lines.push(`+${b[j++]}`);
    }
  }
  return [
    `@@ -${a.length === 0 ? 0 : 1},${a.length} +${b.length === 0 ? 0 : 1},${b.length} @@`,
    ...lines,
  ].join('\n');
}

interface FakeFile {
  path: string;
  before: string | null;
  after: string;
}

interface FakePr {
  repo: string;
  number: number;
  githubId: number;
  title: string;
  body: string;
  author: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  files: FakeFile[];
  commits: Array<{ sha: string; message: string }>;
}

interface FakeRepo {
  name: string;
  githubId: number;
}

class FakeGitHubApi {
  readonly repos: FakeRepo[] = [
    { name: PROVIDER_REPO, githubId: 9_100_001 },
    { name: CONSUMER_REPO, githubId: 9_100_002 },
  ];
  readonly prs = new Map<string, FakePr>();
  /** `${repo}@${sha}:${path}` → file content. */
  readonly contents = new Map<string, string>();
  /** `${repo}:${base}...${head}` → compare files. */
  readonly compares = new Map<string, FakeFile[]>();
  readonly requests: string[] = [];
  readonly unmatched: string[] = [];

  setPr(pr: FakePr): void {
    this.prs.set(`${pr.repo}#${pr.number}`, pr);
    for (const f of pr.files) {
      if (f.before !== null) this.contents.set(`${pr.repo}@${pr.baseSha}:${f.path}`, f.before);
      this.contents.set(`${pr.repo}@${pr.headSha}:${f.path}`, f.after);
    }
  }

  repoJson(name: string) {
    const r = this.repos.find((x) => x.name === name)!;
    return {
      id: r.githubId,
      node_id: `R_${r.githubId}`,
      name,
      full_name: `${OWNER}/${name}`,
      private: true,
      archived: false,
      default_branch: 'main',
      owner: { login: OWNER, type: 'Organization' },
      html_url: `https://github.com/${OWNER}/${name}`,
    };
  }

  prJson(pr: FakePr) {
    const additions = pr.files.reduce(
      (n, f) =>
        n +
        makePatch(f.before ?? '', f.after)
          .split('\n')
          .filter((l) => l.startsWith('+')).length,
      0,
    );
    return {
      id: pr.githubId,
      number: pr.number,
      state: 'open',
      title: pr.title,
      body: pr.body,
      draft: false,
      user: { login: pr.author },
      assignees: [],
      requested_reviewers: [],
      requested_teams: [],
      labels: [],
      head: { ref: pr.headRef, sha: pr.headSha, repo: this.repoJson(pr.repo) },
      base: { ref: 'main', sha: pr.baseSha, repo: this.repoJson(pr.repo) },
      merged: false,
      mergeable: true,
      mergeable_state: 'clean',
      additions,
      deletions: 0,
      changed_files: pr.files.length,
      commits: pr.commits.length,
      comments: 0,
      review_comments: 0,
      html_url: `https://github.com/${OWNER}/${pr.repo}/pull/${pr.number}`,
      created_at: '2026-11-14T09:00:00Z',
      updated_at: '2026-11-14T10:00:00Z',
      closed_at: null,
      merged_at: null,
    };
  }

  fileJson(f: FakeFile) {
    const patch = makePatch(f.before ?? '', f.after);
    const additions = patch.split('\n').filter((l) => l.startsWith('+')).length;
    const deletions = patch.split('\n').filter((l) => l.startsWith('-')).length;
    return {
      filename: f.path,
      status: f.before === null ? 'added' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      patch,
      sha: randomBytes(20).toString('hex'),
    };
  }

  /** Routes one request; returns [status, body, headers?]. */
  handle(method: string, uri: string, body: unknown): [number, unknown, Record<string, string>?] {
    const url = new URL(uri, API);
    const path = decodeURIComponent(url.pathname);
    this.requests.push(`${method} ${path}`);
    let m: RegExpMatchArray | null;

    if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      return [
        201,
        {
          token: `ghs_${randomBytes(18).toString('hex')}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' },
          repository_selection: 'selected',
        },
      ];
    }
    if (method === 'GET' && path === '/app/installations') {
      return [
        200,
        [
          {
            id: INSTALLATION_ID,
            app_id: APP_ID,
            account: { login: OWNER, type: 'Organization', id: 1 },
            repository_selection: 'selected',
            permissions: { contents: 'read', pull_requests: 'read', metadata: 'read' },
            suspended_at: null,
            target_type: 'Organization',
          },
        ],
      ];
    }
    if (method === 'GET' && path === '/installation/repositories') {
      return [
        200,
        {
          total_count: this.repos.length,
          repositories: this.repos.map((r) => this.repoJson(r.name)),
        },
      ];
    }
    if (method === 'POST' && path === '/graphql') {
      const vars = (body as { variables?: { repo?: string; number?: number } }).variables ?? {};
      const pr = this.prs.get(`${vars.repo}#${vars.number}`);
      if (!pr) return [200, { data: { repository: { pullRequest: null } } }];
      return [
        200,
        {
          data: {
            repository: {
              pullRequest: { reviewDecision: null, closingIssuesReferences: { nodes: [] } },
            },
          },
        },
      ];
    }

    m = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m || m[1] !== OWNER || !this.repos.some((r) => r.name === m![2])) {
      this.unmatched.push(`${method} ${path}`);
      return [404, { message: 'Not Found' }];
    }
    const repo = m[2]!;
    const rest = m[3] ?? '';
    const page = Number(url.searchParams.get('page') ?? '1');

    if (method === 'GET' && (m = rest.match(/^\/pulls\/(\d+)(\/[a-z]+)?$/))) {
      const pr = this.prs.get(`${repo}#${m[1]}`);
      if (!pr) return [404, { message: 'Not Found' }];
      const sub = m[2] ?? '';
      if (sub === '') return [200, this.prJson(pr)];
      if (page > 1) return [200, []];
      if (sub === '/files') return [200, pr.files.map((f) => this.fileJson(f))];
      if (sub === '/commits') {
        return [
          200,
          pr.commits.map((c) => ({
            sha: c.sha,
            commit: {
              message: c.message,
              author: { name: pr.author, date: '2026-11-14T09:30:00Z' },
            },
            author: { login: pr.author },
          })),
        ];
      }
      if (sub === '/reviews') return [200, []];
    }
    if (
      method === 'GET' &&
      (m = rest.match(/^\/commits\/([0-9a-f]{40})\/(check-runs|statuses)$/))
    ) {
      if (m[2] === 'statuses') return [200, page > 1 ? [] : []];
      return [
        200,
        {
          total_count: 1,
          check_runs: [
            {
              name: 'test',
              status: 'completed',
              conclusion: 'success',
              html_url: `https://github.com/${OWNER}/${repo}/runs/1`,
              started_at: '2026-11-14T09:40:00Z',
              completed_at: '2026-11-14T09:45:00Z',
              app: { slug: 'github-actions' },
            },
          ],
        },
      ];
    }
    if (method === 'GET' && (rest === '/code-scanning/alerts' || rest === '/dependabot/alerts')) {
      return [403, { message: 'Resource not accessible by integration' }];
    }
    if (method === 'GET' && (m = rest.match(/^\/contents\/(.+)$/))) {
      const ref = url.searchParams.get('ref') ?? '';
      const content = this.contents.get(`${repo}@${ref}:${m[1]}`);
      if (content === undefined) return [404, { message: 'Not Found' }];
      return [200, content, { 'content-type': 'application/vnd.github.raw; charset=utf-8' }];
    }
    if (method === 'GET' && (m = rest.match(/^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/))) {
      const files = this.compares.get(`${repo}:${m[1]}...${m[2]}`);
      if (!files) return [404, { message: 'Not Found' }];
      return [
        200,
        {
          status: 'ahead',
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          merge_base_commit: { sha: m[1] },
          commits: [
            {
              sha: m[2],
              commit: { message: 'fix', author: { name: 'dev', date: '2026-11-14T11:00:00Z' } },
            },
          ],
          files: files.map((f) => this.fileJson(f)),
          html_url: `https://github.com/${OWNER}/${repo}/compare/${m[1]}...${m[2]}`,
        },
      ];
    }
    this.unmatched.push(`${method} ${path}`);
    return [404, { message: 'Not Found' }];
  }
}

// ---------------------------------------------------------------------------
// Fake AI provider
// ---------------------------------------------------------------------------

function fakeAi(): FakeAiProvider {
  return new FakeAiProvider((req: AiCompletionRequest) => {
    switch (req.jsonSchemaName) {
      case 'pr_report':
        return {
          json: {
            executiveSummary: 'This change moves the order lookup endpoint and adds credentials.',
            businessImpact: 'Clients that load single orders will stop working until updated.',
            technicalSummary: 'Changes getOrder() and the order route; adds AWS config.',
            concerns: [],
            scoreAdjustments: [],
            recommendedActions: ['Coordinate the release with the storefront team.'],
            openQuestions: [],
            deploymentNotes: '',
            rollbackNotes: '',
            confidence: { score: 70, rationale: 'Small, focused diff.' },
            promptInjectionSuspected: false,
          },
        };
      case 'triage':
        return { json: { meaningful: true, reason: 'Credentials handling changed.' } };
      case 'relationships':
        return { json: { verdicts: [] } };
      default:
        return { text: 'Digest narrative.' };
    }
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const WORKER_FLOW: QueueName[] = [
  'webhook.process',
  'pr.sync',
  'pr.analyze',
  'pr.readiness',
  'overlap.recompute',
  'notify.flush',
];

describe.skipIf(!reachable)(
  'end-to-end: webhook → worker → analysis (real Postgres)',
  { timeout: 60_000 },
  () => {
    let t: TestApp;
    let admin: Session;
    let worker: Worker;
    let workerQueue: RecordingJobQueue;
    let gh: FakeGitHubApi;
    let ai: FakeAiProvider;
    let cacheDir: string;
    const skippedJobs: string[] = [];

    /** Hands server-enqueued jobs to the worker and drains follow-ups until idle. */
    async function pump(): Promise<Array<{ queue: QueueName; status: string; reason?: string }>> {
      const results: Array<{ queue: QueueName; status: string; reason?: string }> = [];
      for (const job of t.queue.jobs.splice(0)) {
        await workerQueue.send(job.name as QueueName, job.data as never, job.options);
      }
      for (let i = 0; i < 200; i++) {
        const idx = workerQueue.jobs.findIndex((j) => WORKER_FLOW.includes(j.queue));
        if (idx < 0) {
          // repo.discover / repo.index need a real git clone; they are covered by worker tests.
          for (const j of workerQueue.jobs.splice(0)) skippedJobs.push(j.queue);
          return results;
        }
        const [job] = workerQueue.jobs.splice(idx, 1);
        const r = await worker.run(job!.queue, job!.data);
        results.push({
          queue: job!.queue,
          status: r.status,
          ...(r.reason ? { reason: r.reason } : {}),
        });
      }
      throw new Error('worker queue did not drain');
    }

    function sign(body: string): string {
      return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
    }

    async function postWebhook(event: string, payload: object, deliveryId: string) {
      const body = JSON.stringify(payload);
      return t.app.inject({
        method: 'POST',
        url: '/api/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': event,
          'x-github-delivery': deliveryId,
          'x-hub-signature-256': sign(body),
        },
        payload: body,
      });
    }

    function prWebhook(pr: FakePr, action: string, extra: Record<string, unknown> = {}) {
      return {
        action,
        number: pr.number,
        pull_request: gh.prJson(pr),
        repository: gh.repoJson(pr.repo),
        installation: { id: INSTALLATION_ID },
        sender: { login: pr.author },
        ...extra,
      };
    }

    async function prRow(repoName: string, number: number) {
      const [row] = await t.db.handle.db
        .select({ pr: pullRequests })
        .from(pullRequests)
        .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
        .where(and(eq(repositories.name, repoName), eq(pullRequests.number, number)))
        .limit(1);
      return row?.pr ?? null;
    }

    const providerPr = (): FakePr => ({
      repo: PROVIDER_REPO,
      number: 42,
      githubId: 5_000_042,
      title: 'Move order lookup to v2 and configure AWS',
      body: 'Moves the single-order endpoint to /api/v2 and adds S3 configuration.',
      author: 'dev-one',
      headRef: 'feature/orders-v2',
      baseSha: BASE_SHA,
      headSha: H1,
      files: [
        { path: 'src/orders.ts', before: ORDERS_BASE, after: ORDERS_V1 },
        { path: 'src/config.ts', before: CONFIG_BASE, after: CONFIG_V1 },
      ],
      commits: [{ sha: H1, message: 'feat: orders v2' }],
    });

    beforeAll(async () => {
      nock.disableNetConnect();
      nock.enableNetConnect(/^(127\.0\.0\.1|localhost)(:\d+)?$/);
      gh = new FakeGitHubApi();
      const scope = nock(API).persist();
      for (const method of ['get', 'post'] as const) {
        // nock 15 passes the fetch Request as the only argument (a 2-arity function would be
        // treated as callback-style).
        scope[method](/.*/).reply(async (req: Request) => {
          const text = method === 'post' ? await req.text() : '';
          const body: unknown = text ? JSON.parse(text) : undefined;
          return gh.handle(method.toUpperCase(), req.url, body) as [number, string | object];
        });
      }

      t = await createTestApp();
      admin = await setupAdmin(t);
      cacheDir = await mkdtemp(join(tmpdir(), 'gmp-e2e-'));
      ai = fakeAi();
      workerQueue = new RecordingJobQueue();
      worker = createWorker({
        db: t.db.handle.db,
        github: createGitHubGateway({
          db: t.db.handle.db,
          apiUrl: t.config.githubApiUrl,
          webUrl: t.config.githubWebUrl,
          repoCacheDir: cacheDir,
          masterKey: t.config.masterKey,
        }),
        queue: workerQueue,
        publicUrl: t.config.publicUrl,
        masterKey: t.config.masterKey,
        aiProviderFactory: () => ai,
        scanners: { gitleaks: false, semgrep: false },
      });
    }, 120_000);

    afterAll(async () => {
      nock.cleanAll();
      nock.enableNetConnect();
      await t?.close();
      if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
    });

    it('completes setup through the API with stored GitHub App credentials', async () => {
      const api = as(t, admin);

      // Simulate the manifest flow having stored the App credentials (encrypted with MASTER_KEY).
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      await t.db.handle.db.insert(githubApps).values({
        orgId: admin.orgId,
        appId: APP_ID,
        slug: 'git-merge-pilot-e2e',
        name: 'git-merge-pilot e2e',
        clientId: 'Iv1.e2e',
        clientSecretEnc: encrypt('client-secret-e2e', t.config.masterKey),
        privateKeyEnc: encrypt(privateKey, t.config.masterKey),
        webhookSecretEnc: encrypt(WEBHOOK_SECRET, t.config.masterKey),
        htmlUrl: 'https://github.com/apps/git-merge-pilot-e2e',
        ownerLogin: OWNER,
      });

      const status = await api('GET', '/api/github/status');
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ connected: true });

      const sync = await api('POST', '/api/github/sync-installations');
      expect(sync.statusCode, sync.body).toBe(200);
      expect(sync.json()).toMatchObject({ installations: 1, addedRepositories: 2 });
      expect(t.queue.byName(QUEUES.repoDiscover)).toHaveLength(2);
      t.queue.jobs.length = 0;

      const repos = await api('GET', '/api/repositories');
      const repoList = repos.json() as Array<{ id: string; name: string }>;
      expect(repoList.map((r) => r.name).sort()).toEqual([PROVIDER_REPO, CONSUMER_REPO].sort());

      const project = await api('POST', '/api/projects', {
        name: 'Commerce',
        repositoryIds: repoList.map((r) => r.id),
      });
      expect(project.statusCode, project.body).toBe(201);

      const provider = await api('POST', '/api/settings/ai/providers', {
        name: 'Primary',
        kind: 'anthropic',
        apiKey: 'test-api-key-not-real',
      });
      expect(provider.statusCode, provider.body).toBe(201);
      const providerId = (provider.json() as { id: string }).id;
      const model = (m: string) => ({ providerId, model: m, maxOutputTokens: 4000 });
      const aiSettings = await api('PUT', '/api/settings/ai', {
        enabled: true,
        consent: true,
        monthlyBudgetUsd: 50,
        taskModels: {
          triage: model('claude-haiku-5-5'),
          pr_report: model('claude-sonnet-5-5'),
          deep_analysis: model('claude-opus-5-5'),
          digest: model('claude-haiku-5-5'),
        },
      });
      expect(aiSettings.statusCode, aiSettings.body).toBe(200);

      const done = await api('POST', '/api/setup/complete');
      expect(done.statusCode, done.body).toBe(200);
      const setup = await t.app.inject({ method: 'GET', url: '/api/setup/status' });
      expect(setup.json()).toMatchObject({ completed: true });
    });

    it('rejects an unsigned webhook', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/github/webhook',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': 'unsigned-1',
          'x-hub-signature-256': 'sha256=deadbeef',
        },
        payload: '{}',
      });
      expect(res.statusCode).toBe(401);
    });

    it('analyses a consumer PR and a breaking provider PR with a hardcoded secret', async () => {
      // Open PR in the consumer repository that calls the order endpoint.
      const consumer: FakePr = {
        repo: CONSUMER_REPO,
        number: 7,
        githubId: 5_000_007,
        title: 'Show order details page',
        body: 'Adds a single-order view.',
        author: 'dev-two',
        headRef: 'feature/order-page',
        baseSha: CONSUMER_BASE,
        headSha: CONSUMER_HEAD,
        files: [{ path: 'src/api/orders.ts', before: CLIENT_BASE, after: CLIENT_HEAD }],
        commits: [{ sha: CONSUMER_HEAD, message: 'feat: order page' }],
      };
      gh.setPr(consumer);
      const c = await postWebhook('pull_request', prWebhook(consumer, 'opened'), 'e2e-consumer-1');
      expect(c.statusCode, c.body).toBe(202);
      await pump();
      const consumerRow = await prRow(CONSUMER_REPO, 7);
      expect(consumerRow).not.toBeNull();

      // Provider PR: changed exported signature, moved route, hardcoded AWS key.
      const pr = providerPr();
      gh.setPr(pr);
      const payload = prWebhook(pr, 'opened');
      const first = await postWebhook('pull_request', payload, 'e2e-provider-opened');
      const second = await postWebhook('pull_request', payload, 'e2e-provider-opened');
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ ok: true, duplicate: false });
      expect(second.statusCode).toBe(202);
      expect(second.json()).toMatchObject({ ok: true, duplicate: true });
      const stored = await t.db.handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.deliveryId, 'e2e-provider-opened'));
      expect(stored).toHaveLength(1);
      expect(t.queue.byName(QUEUES.webhookProcess)).toHaveLength(1);

      const results = await pump();
      expect(results.filter((r) => r.queue === 'pr.analyze').map((r) => r.status)).toContain(
        'completed',
      );
      const [delivery] = await t.db.handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.deliveryId, 'e2e-provider-opened'));
      expect(delivery!.status).toBe('processed');

      const prA = await prRow(PROVIDER_REPO, 42);
      expect(prA).not.toBeNull();
      const [analysis] = await t.db.handle.db
        .select()
        .from(analyses)
        .where(and(eq(analyses.pullRequestId, prA!.id), eq(analyses.headSha, H1)))
        .orderBy(desc(analyses.createdAt));
      expect(analysis).toMatchObject({ status: 'completed', kind: 'full', generatedBy: 'ai' });
      expect(analysis!.recommendation).not.toBe('ready_to_merge');
      expect(['high', 'critical']).toContain(analysis!.overallRisk);

      const rows = await t.db.handle.db
        .select()
        .from(findings)
        .where(eq(findings.analysisId, analysis!.id));
      const data = rows.map((r) => r.data as Finding);
      const breaking = data.filter((f) => f.category === 'breaking_change');
      const security = data.filter((f) => f.category === 'security');
      expect(breaking.length).toBeGreaterThan(0);
      expect(security.length).toBeGreaterThan(0);
      for (const f of [...breaking, ...security]) {
        expect(f.verified).toBe(true);
        expect(f.evidence.length).toBeGreaterThan(0);
      }
      // Signature change of getOrder and removal of the v1 route are both reported.
      expect(breaking.some((f) => /getOrder/.test(JSON.stringify(f)))).toBe(true);
      expect(breaking.some((f) => /\/api\/orders/.test(JSON.stringify(f)))).toBe(true);
      const secret = security.find((f) => f.evidence.some((e) => e.path === 'src/config.ts'));
      expect(secret).toBeDefined();
      expect(['critical', 'high']).toContain(secret!.severity);
      // The secret itself is never stored in evidence.
      expect(JSON.stringify(data)).not.toContain(FAKE_AWS_KEY);

      // Cross-repo relationship: provider PR changes the route the consumer PR calls.
      const rels = await t.db.handle.db.select().from(prRelationships);
      const rel = rels.find(
        (r) =>
          [r.prAId, r.prBId].includes(prA!.id) &&
          [r.prAId, r.prBId].includes(consumerRow!.id) &&
          r.active,
      );
      expect(rel).toBeDefined();
      expect(rel!.type).toBe('contract_change');
      expect(['confirmed', 'likely']).toContain(rel!.confidence);

      // Notifications were written for the org.
      const notes = await t.db.handle.db
        .select()
        .from(notifications)
        .where(eq(notifications.orgId, admin.orgId));
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.some((n) => n.pullRequestId === prA!.id)).toBe(true);

      // The server API exposes the worker's results.
      const detail = await as(t, admin)('GET', `/api/pull-requests/${prA!.id}`);
      expect(detail.statusCode, detail.body).toBe(200);
      const body = detail.json() as {
        analysis: { recommendation: string } | null;
        findings: unknown[];
        relationships: unknown[];
      };
      expect(body.analysis?.recommendation).toBe(analysis!.recommendation);
      expect(body.findings.length).toBe(rows.filter((r) => r.lifecycle !== 'resolved').length);
      expect(body.relationships.length).toBeGreaterThan(0);

      // Only the deterministic + AI path ran against mocked endpoints.
      expect(gh.unmatched).toEqual([]);
      expect(ai.calls.some((call) => call.jsonSchemaName === 'pr_report')).toBe(true);
    });

    it('incremental analysis after a synchronize with a fix resolves the secret finding', async () => {
      const before = await prRow(PROVIDER_REPO, 42);
      const [first] = await t.db.handle.db
        .select()
        .from(analyses)
        .where(and(eq(analyses.pullRequestId, before!.id), eq(analyses.headSha, H1)));

      const pr = providerPr();
      pr.headSha = H2;
      pr.files = [
        { path: 'src/orders.ts', before: ORDERS_BASE, after: ORDERS_V1 },
        { path: 'src/config.ts', before: CONFIG_BASE, after: CONFIG_V2 },
      ];
      pr.commits = [
        { sha: H1, message: 'feat: orders v2' },
        { sha: H2, message: 'fix: read AWS key from the environment' },
      ];
      gh.setPr(pr);
      gh.compares.set(`${PROVIDER_REPO}:${H1}...${H2}`, [
        { path: 'src/config.ts', before: CONFIG_V1, after: CONFIG_V2 },
      ]);

      const res = await postWebhook(
        'pull_request',
        prWebhook(pr, 'synchronize', { before: H1, after: H2 }),
        'e2e-provider-sync',
      );
      expect(res.statusCode, res.body).toBe(202);
      await pump();

      const [second] = await t.db.handle.db
        .select()
        .from(analyses)
        .where(and(eq(analyses.pullRequestId, before!.id), eq(analyses.headSha, H2)))
        .orderBy(desc(analyses.createdAt));
      expect(second).toMatchObject({
        status: 'completed',
        kind: 'incremental',
        previousAnalysisId: first!.id,
      });

      const rows = await t.db.handle.db
        .select()
        .from(findings)
        .where(eq(findings.analysisId, second!.id));
      const resolvedSecrets = rows.filter(
        (r) =>
          r.lifecycle === 'resolved' &&
          r.category === 'security' &&
          (r.data as Finding).evidence.some((e) => e.path === 'src/config.ts'),
      );
      expect(resolvedSecrets.length).toBeGreaterThan(0);
      // The breaking changes are still present and carried over unchanged.
      expect(
        rows.some((r) => r.category === 'breaking_change' && r.lifecycle === 'unchanged'),
      ).toBe(true);
      expect(gh.unmatched).toEqual([]);
      expect(gh.requests.some((r) => r.includes(`/compare/${H1}...${H2}`))).toBe(true);
    });
  },
);
