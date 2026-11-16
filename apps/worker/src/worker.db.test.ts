/**
 * Handler-level integration tests against a real, migrated Postgres database (`gmp_test_worker`)
 * with a fake GitHub gateway and a fake AI provider. No network calls are made.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAiProvider, type AiCompletionRequest } from '@gmp/ai';
import { encrypt, setMasterKey, type PrReport } from '@gmp/core';
import {
  aiProviders,
  aiSettings,
  aiUsage,
  analyses,
  codeContracts,
  codeSymbols,
  createDb,
  findings,
  githubApps,
  installations,
  isDatabaseReachable,
  migrate,
  notificationRules,
  notifications,
  organizations,
  prEvents,
  prRelationships,
  projectRepositories,
  projects,
  pullRequests,
  repositories,
  sessions,
  testDatabaseBaseUrl,
  users,
  webhookDeliveries,
  type DbHandle,
  type Repository,
} from '@gmp/db';
import type { PrSnapshot } from '@gmp/github';
import { and, desc, eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordingJobQueue, QUEUE_NAMES, createBossJobQueue, type QueueName } from './queues.ts';
import { FakeGitHub, fileSnapshot } from './test-support/fake-github.ts';
import { createWorker, type Worker } from './worker.ts';
import { reconcileRepository } from './handlers/scheduled.ts';

const BASE_URL = testDatabaseBaseUrl();
const reachable = await isDatabaseReachable(BASE_URL);
const DB_NAME = 'gmp_test_worker';
const MASTER_KEY = randomBytes(32);
const NOW = new Date('2026-11-14T12:00:00Z');
const PUBLIC_URL = 'http://gmp.test';

let dbUrl = '';
let handle: DbHandle;

async function adminQuery(sql: string): Promise<void> {
  const admin = createDb(BASE_URL, { max: 1 });
  try {
    await admin.pool.query(sql);
  } finally {
    await admin.close();
  }
}

beforeAll(async () => {
  if (!reachable) return;
  setMasterKey(MASTER_KEY);
  await adminQuery(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE "${DB_NAME}"`);
  const u = new URL(BASE_URL);
  u.pathname = `/${DB_NAME}`;
  dbUrl = u.toString();
  await migrate(dbUrl);
  handle = createDb(dbUrl, { max: 6 });
}, 120_000);

afterAll(async () => {
  if (!reachable) return;
  await handle?.close();
  await adminQuery(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
  setMasterKey(null);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const rand = () => randomBytes(3).toString('hex');

function aiReport(summary: string) {
  return {
    executiveSummary: summary,
    businessImpact: 'Callers of the user lookup must be updated.',
    technicalSummary: 'Renames the user lookup function and adds helpers.',
    concerns: [],
    scoreAdjustments: [],
    recommendedActions: ['Search other services for usages of the old function.'],
    openQuestions: [],
    deploymentNotes: '',
    rollbackNotes: '',
    confidence: { score: 75, rationale: 'Small diff.' },
    promptInjectionSuspected: false,
  };
}

function fakeAi(): FakeAiProvider {
  return new FakeAiProvider((req: AiCompletionRequest) => {
    switch (req.jsonSchemaName) {
      case 'pr_report':
        return { json: aiReport('AI summary of the pull request.') };
      case 'triage':
        return { json: { meaningful: true, reason: 'Code behaviour changed.' } };
      case 'relationships':
        return { json: { verdicts: [] } };
      default:
        return { text: 'AI digest narrative.' };
    }
  });
}

interface World {
  orgId: string;
  adminId: string;
  repo: Repository;
  projectId: string;
  installationNumericId: number;
  github: FakeGitHub;
  ai: FakeAiProvider;
  queue: RecordingJobQueue;
  worker: Worker;
}

async function createWorld(opts: { paused?: boolean; budgetUsd?: number } = {}): Promise<World> {
  const db = handle.db;
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${rand()}`, timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const [admin] = await db
    .insert(users)
    .values({
      orgId,
      email: `admin-${rand()}@example.test`,
      name: 'Admin',
      passwordHash: 'not-a-real-hash',
      role: 'admin',
    })
    .returning();
  const [app] = await db
    .insert(githubApps)
    .values({
      orgId,
      appId: 100_000 + Math.floor(Math.random() * 1_000_000),
      slug: `gmp-${rand()}`,
      name: 'git-merge-pilot test',
      clientId: 'client-id',
      clientSecretEnc: encrypt('client-secret'),
      privateKeyEnc: encrypt('not-a-key'),
      webhookSecretEnc: encrypt('webhook-secret'),
      htmlUrl: 'https://github.example/apps/test',
    })
    .returning();
  const installationNumericId = 1_000_000 + Math.floor(Math.random() * 1_000_000);
  const [inst] = await db
    .insert(installations)
    .values({
      orgId,
      githubAppId: app!.id,
      installationId: installationNumericId,
      accountLogin: 'example-org',
      accountType: 'Organization',
    })
    .returning();
  const name = `service-${rand()}`;
  const [repo] = await db
    .insert(repositories)
    .values({
      orgId,
      installationId: inst!.id,
      githubId: 2_000_000 + Math.floor(Math.random() * 1_000_000),
      owner: 'example-org',
      name,
      fullName: `example-org/${name}`,
      defaultBranch: 'main',
      lastDiscoveredAt: NOW,
    })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ orgId, name: `project-${rand()}`, paused: opts.paused ?? false })
    .returning();
  await db.insert(projectRepositories).values({ projectId: project!.id, repositoryId: repo!.id });
  // Notify on everything so tests can observe meaningful-change notifications.
  await db.insert(notificationRules).values({
    orgId,
    projectId: null,
    minSeverity: 'info',
    events: [],
    digestEnabled: true,
    digestHour: 0,
    timezone: 'UTC',
  });
  const [provider] = await db
    .insert(aiProviders)
    .values({
      orgId,
      name: 'Anthropic',
      kind: 'anthropic',
      apiKeyEnc: encrypt(`test-key-${rand()}`),
    })
    .returning();
  const model = (m: string) => ({ providerId: provider!.id, model: m, maxOutputTokens: 4000 });
  await db.insert(aiSettings).values({
    orgId,
    enabled: true,
    consentAt: NOW,
    monthlyBudgetUsd: opts.budgetUsd ?? 100,
    taskModels: {
      pr_report: model('claude-sonnet-5-5'),
      triage: model('claude-haiku-5-5'),
      deep_analysis: model('claude-opus-5-5'),
      digest: model('claude-haiku-5-5'),
    },
  });

  const github = new FakeGitHub();
  const ai = fakeAi();
  const queue = new RecordingJobQueue();
  const worker = createWorker({
    db,
    github,
    queue,
    publicUrl: PUBLIC_URL,
    masterKey: MASTER_KEY,
    now: () => NOW,
    aiProviderFactory: () => ai,
    scanners: { gitleaks: false, semgrep: false },
  });
  return {
    orgId,
    adminId: admin!.id,
    repo: repo!,
    projectId: project!.id,
    installationNumericId,
    github,
    ai,
    queue,
    worker,
  };
}

const PR_FLOW: QueueName[] = ['pr.sync', 'pr.analyze', 'pr.readiness', 'overlap.recompute'];

/** Runs queued jobs (FIFO) for the given queues until none are left. */
async function drain(w: World, queues: QueueName[] = PR_FLOW) {
  const results: Array<{ queue: QueueName; status: string; reason?: string }> = [];
  for (let i = 0; i < 100; i++) {
    const idx = w.queue.jobs.findIndex((j) => queues.includes(j.queue));
    if (idx < 0) return results;
    const [job] = w.queue.jobs.splice(idx, 1);
    const r = await w.worker.run(job!.queue, job!.data);
    results.push({
      queue: job!.queue,
      status: r.status,
      ...(r.reason ? { reason: r.reason } : {}),
    });
  }
  throw new Error('queue did not drain');
}

function prPayload(w: World, snap: PrSnapshot, action = 'opened') {
  const m = snap.pullRequest;
  const repo = {
    id: w.repo.githubId,
    name: w.repo.name,
    full_name: w.repo.fullName,
    private: true,
    owner: { login: w.repo.owner, type: 'Organization' },
    html_url: `https://github.example/${w.repo.fullName}`,
    default_branch: 'main',
    archived: false,
  };
  return {
    action,
    number: m.number,
    pull_request: {
      id: m.githubId,
      number: m.number,
      state: 'open',
      title: m.title,
      body: m.body,
      user: { login: m.authorLogin },
      created_at: m.openedAt,
      updated_at: m.updatedAt,
      closed_at: null,
      merged_at: null,
      assignees: [],
      requested_reviewers: [],
      requested_teams: [],
      labels: [],
      draft: false,
      head: { ref: m.headRef, sha: m.headSha, repo },
      base: { ref: m.baseRef, sha: m.baseSha, repo },
      html_url: m.htmlUrl,
      merged: false,
      mergeable_state: 'clean',
      additions: m.additions,
      deletions: m.deletions,
      changed_files: m.changedFiles,
      commits: 1,
    },
    repository: repo,
    installation: { id: w.installationNumericId },
    sender: { login: m.authorLogin },
  };
}

async function storeDelivery(w: World, event: string, payload: Record<string, unknown>) {
  const deliveryId = `delivery-${rand()}`;
  await handle.db.insert(webhookDeliveries).values({
    deliveryId,
    event,
    action: typeof payload.action === 'string' ? payload.action : null,
    installationId: w.installationNumericId,
    repositoryFullName: w.repo.fullName,
    payload,
    status: 'queued',
    receivedAt: NOW,
  });
  return deliveryId;
}

async function prByNumber(repositoryId: string, number: number) {
  const [pr] = await handle.db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.number, number)))
    .limit(1);
  return pr ?? null;
}

async function analysesOf(pullRequestId: string) {
  return handle.db
    .select()
    .from(analyses)
    .where(eq(analyses.pullRequestId, pullRequestId))
    .orderBy(desc(analyses.createdAt));
}

async function findingsOf(analysisId: string) {
  return handle.db.select().from(findings).where(eq(findings.analysisId, analysisId));
}

async function notificationsOf(orgId: string) {
  return handle.db.select().from(notifications).where(eq(notifications.orgId, orgId));
}

// Source fixtures: generic code, no real project names.
const USERS_BASE = `export function getUser(id: string) {
  return db.find(id);
}

export function listUsers() {
  return db.all();
}
`;

const USERS_PR1_V1 = `export function findUser(id: string) {
  return db.find(id);
}

export function listUsers() {
  return db.all();
}

export function runScript(code: string) {
  return eval(code);
}
`;

const USERS_PR1_V2 = `export function findUser(id: string) {
  return db.find(id);
}

export function listUsers() {
  return db.all();
}
`;

const CRYPTO_V2 = `import { createHash } from 'node:crypto';

export function checksum(input: string) {
  return createHash('md5').update(input).digest('hex');
}
`;

const USERS_PR2 = `export function getUser(id: string, opts?: { cache?: boolean }) {
  return db.find(id);
}

export function listUsers() {
  return db.all({ limit: 100 });
}
`;

const BASE_SHA = 'b'.repeat(40);
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!reachable)('@gmp/worker handlers (real Postgres)', () => {
  let w: World;
  let pr1Id = '';
  let firstAnalysisId = '';

  beforeAll(async () => {
    w = await createWorld();
  });

  it('first analysis: webhook → pr.sync → pr.analyze with AI report, findings and notifications', async () => {
    const snap = w.github.setPr({
      repo: w.repo,
      number: 1,
      title: 'Rename user lookup and add script runner',
      headSha: H1,
      baseSha: BASE_SHA,
      files: [{ path: 'src/users.ts', before: USERS_BASE, after: USERS_PR1_V1 }],
    });
    const deliveryId = await storeDelivery(w, 'pull_request', prPayload(w, snap));

    const res = await w.worker.run('webhook.process', { deliveryId });
    expect(res.status).toBe('completed');
    const [delivery] = await handle.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId));
    expect(delivery!.status).toBe('processed');
    expect(delivery!.orgId).toBe(w.orgId);
    const pr = await prByNumber(w.repo.id, 1);
    expect(pr).not.toBeNull();
    pr1Id = pr!.id;
    expect(w.queue.jobs.map((j) => j.queue)).toEqual(['pr.sync']);

    // Re-delivering the same webhook job is a no-op.
    expect((await w.worker.run('webhook.process', { deliveryId })).status).toBe('unchanged');
    const events = await handle.db.select().from(prEvents).where(eq(prEvents.pullRequestId, pr1Id));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('pr_opened');

    const steps = await drain(w);
    expect(steps.map((s) => `${s.queue}:${s.status}`)).toEqual([
      'pr.sync:completed',
      'pr.analyze:completed',
      'overlap.recompute:completed',
    ]);
    // pr.analyze reused the snapshot fetched by pr.sync.
    expect(w.github.count('fetchPullRequestSnapshot')).toBe(1);

    const [analysis] = await analysesOf(pr1Id);
    firstAnalysisId = analysis!.id;
    expect(analysis).toMatchObject({
      status: 'completed',
      kind: 'full',
      headSha: H1,
      generatedBy: 'ai',
      previousAnalysisId: null,
    });
    const report = analysis!.report as PrReport;
    expect(report.executiveSummary.startsWith('AI summary of the pull request.')).toBe(true);
    expect(analysis!.overallRisk).toBe(report.overallRisk);
    expect(analysis!.aiUsage?.inputTokens).toBeGreaterThan(0);

    const rows = await findingsOf(firstAnalysisId);
    expect(rows.every((r) => r.lifecycle === 'new')).toBe(true);
    expect(rows.some((r) => r.category === 'breaking_change' && r.title.includes('getUser'))).toBe(
      true,
    );
    expect(rows.some((r) => r.data.ruleId === 'code_eval')).toBe(true);

    const notes = await notificationsOf(w.orgId);
    expect(notes.some((n) => n.kind === 'pr_analyzed' && n.userId === w.adminId)).toBe(true);
    expect(notes.some((n) => n.kind === 'security_finding')).toBe(true);
    expect(notes.every((n) => n.url?.startsWith(`${PUBLIC_URL}/pull-requests/`))).toBe(true);
  });

  it('duplicate pr.analyze for the same head is idempotent', async () => {
    const before = {
      analyses: (await analysesOf(pr1Id)).length,
      findings: (await findingsOf(firstAnalysisId)).length,
      notifications: (await notificationsOf(w.orgId)).length,
      aiCalls: w.ai.calls.length,
    };
    const res = await w.worker.run('pr.analyze', { pullRequestId: pr1Id, headSha: H1 });
    expect(res).toMatchObject({ status: 'unchanged', analysisId: firstAnalysisId });
    expect((await analysesOf(pr1Id)).length).toBe(before.analyses);
    expect((await findingsOf(firstAnalysisId)).length).toBe(before.findings);
    expect((await notificationsOf(w.orgId)).length).toBe(before.notifications);
    expect(w.ai.calls.length).toBe(before.aiCalls);
    expect(w.queue.jobs).toHaveLength(0);
  });

  it('incremental analysis after a new commit marks findings new / unchanged / resolved', async () => {
    w.github.setPr({
      repo: w.repo,
      number: 1,
      title: 'Rename user lookup and add script runner',
      headSha: H2,
      baseSha: BASE_SHA,
      files: [
        { path: 'src/users.ts', before: USERS_BASE, after: USERS_PR1_V2 },
        { path: 'src/checksum.ts', before: null, after: CRYPTO_V2 },
      ],
    });
    w.github.setCompare(H1, H2, {
      status: 'ahead',
      files: [
        fileSnapshot({ path: 'src/users.ts', before: USERS_PR1_V1, after: USERS_PR1_V2 }),
        fileSnapshot({ path: 'src/checksum.ts', before: null, after: CRYPTO_V2 }),
      ],
    });
    expect((await w.worker.run('pr.sync', { pullRequestId: pr1Id })).status).toBe('completed');
    const job = w.queue.take('pr.analyze')[0];
    expect(job?.data).toEqual({ pullRequestId: pr1Id, headSha: H2 });
    const result = await w.worker.run('pr.analyze', job!.data);
    // A new finding makes triage certain (rule-based, no AI call); the narrative is regenerated.
    expect(result).toMatchObject({ status: 'completed', kind: 'incremental', generatedBy: 'ai' });
    expect(result.triage).toMatch(/new finding/);
    await drain(w);

    const [latest] = await handle.db
      .select()
      .from(analyses)
      .where(and(eq(analyses.pullRequestId, pr1Id), eq(analyses.headSha, H2)));
    expect(latest).toMatchObject({
      kind: 'incremental',
      status: 'completed',
      previousAnalysisId: firstAnalysisId,
    });

    const rows = await findingsOf(latest!.id);
    const by = (l: string) => rows.filter((r) => r.lifecycle === l);
    expect(by('new').some((r) => r.data.ruleId === 'weak_crypto')).toBe(true);
    expect(by('unchanged').some((r) => r.category === 'breaking_change')).toBe(true);
    expect(by('resolved').some((r) => r.data.ruleId === 'code_eval')).toBe(true);
  });

  it('detects overlap between two PRs editing the same lines and refreshes the other PR', async () => {
    w.github.setPr({
      repo: w.repo,
      number: 2,
      title: 'Limit the user list',
      headSha: H3,
      baseSha: BASE_SHA,
      files: [{ path: 'src/users.ts', before: USERS_BASE, after: USERS_PR2 }],
    });
    expect((await w.worker.run('pr.sync', { repositoryId: w.repo.id, number: 2 })).status).toBe(
      'completed',
    );
    const steps = await drain(w);
    expect(steps.map((s) => s.queue)).toEqual(['pr.analyze', 'overlap.recompute', 'pr.readiness']);
    const pr2 = await prByNumber(w.repo.id, 2);
    const [a, b] = [pr1Id, pr2!.id].sort();
    const rels = await handle.db
      .select()
      .from(prRelationships)
      .where(and(eq(prRelationships.prAId, a!), eq(prRelationships.prBId, b!)));
    const sameFile = rels.find((r) => r.type === 'same_file');
    expect(sameFile).toMatchObject({ confidence: 'confirmed', active: true });

    const [pr2Analysis] = await analysesOf(pr2!.id);
    const report2 = pr2Analysis!.report as PrReport;
    expect(report2.overlappingWork.some((o) => o.prRef === `${w.repo.fullName}#1`)).toBe(true);

    // PR 1 was refreshed by pr.readiness and now lists PR 2.
    const [readiness] = await handle.db
      .select()
      .from(analyses)
      .where(and(eq(analyses.pullRequestId, pr1Id), eq(analyses.kind, 'readiness_only')));
    expect(readiness?.status).toBe('completed');
    const report1 = readiness!.report as PrReport;
    expect(report1.overlappingWork.some((o) => o.prRef === `${w.repo.fullName}#2`)).toBe(true);
    expect((await findingsOf(readiness!.id)).length).toBeGreaterThan(0);

    const notes = await notificationsOf(w.orgId);
    expect(notes.some((n) => n.kind === 'overlap_detected' && n.pullRequestId === pr2!.id)).toBe(
      true,
    );
  });

  it('closing a PR deactivates its relationships', async () => {
    const snap = w.github.setPr({
      repo: w.repo,
      number: 2,
      title: 'Limit the user list',
      headSha: H3,
      baseSha: BASE_SHA,
      state: 'closed',
      files: [{ path: 'src/users.ts', before: USERS_BASE, after: USERS_PR2 }],
    });
    const payload = prPayload(w, snap, 'closed');
    const closedPr: Record<string, unknown> = {
      ...payload.pull_request,
      state: 'closed',
      closed_at: '2026-11-14T11:00:00Z',
      updated_at: '2026-11-14T11:00:00Z',
    };
    const deliveryId = await storeDelivery(w, 'pull_request', {
      ...payload,
      pull_request: closedPr,
    });
    expect((await w.worker.run('webhook.process', { deliveryId })).status).toBe('completed');
    const pr2 = await prByNumber(w.repo.id, 2);
    expect(pr2!.state).toBe('closed');
    const active = await handle.db
      .select()
      .from(prRelationships)
      .where(and(eq(prRelationships.orgId, w.orgId), eq(prRelationships.active, true)));
    expect(active).toHaveLength(0);
    // The formerly related PR 1 gets its readiness/overlap section refreshed.
    expect(
      w.queue.jobs.some(
        (j) =>
          j.queue === 'pr.readiness' && 'pullRequestId' in j.data && j.data.pullRequestId === pr1Id,
      ),
    ).toBe(true);
    await drain(w);
    const [refreshed] = await handle.db
      .select()
      .from(analyses)
      .where(and(eq(analyses.pullRequestId, pr1Id), eq(analyses.kind, 'readiness_only')));
    expect((refreshed!.report as PrReport).overlappingWork).toEqual([]);
  });

  it('reuses the AI narrative when AI triage judges new commits not meaningful', async () => {
    const H5 = '5'.repeat(40);
    w.github.setPr({
      repo: w.repo,
      number: 1,
      title: 'Rename user lookup and add script runner',
      headSha: H5,
      baseSha: BASE_SHA,
      files: [
        { path: 'src/users.ts', before: USERS_BASE, after: USERS_PR1_V2 },
        { path: 'src/checksum.ts', before: null, after: CRYPTO_V2 },
        { path: 'docs/users.md', before: null, after: '# Users\n\nLookup notes.\n' },
      ],
    });
    w.github.setCompare(H2, H5, {
      status: 'ahead',
      files: [
        fileSnapshot({ path: 'docs/users.md', before: null, after: '# Users\n\nLookup notes.\n' }),
      ],
    });
    const [prev] = await handle.db
      .select()
      .from(analyses)
      .where(
        and(
          eq(analyses.pullRequestId, pr1Id),
          eq(analyses.headSha, H2),
          eq(analyses.kind, 'incremental'),
        ),
      );
    const reportCalls = () => w.ai.calls.filter((c) => c.jsonSchemaName === 'pr_report').length;
    const before = reportCalls();
    w.ai.enqueue({ json: { meaningful: false, reason: 'Only documentation changed.' } });

    const result = await w.worker.run('pr.analyze', { pullRequestId: pr1Id });
    expect(result).toMatchObject({ status: 'completed', kind: 'incremental', generatedBy: 'ai' });
    expect(w.ai.calls.at(-1)?.jsonSchemaName).toBe('triage');
    expect(reportCalls()).toBe(before);
    const [latest] = await handle.db
      .select()
      .from(analyses)
      .where(and(eq(analyses.pullRequestId, pr1Id), eq(analyses.headSha, H5)));
    const report = latest!.report as PrReport;
    expect(report.executiveSummary).toBe((prev!.report as PrReport).executiveSummary);
    expect(report.limitations.some((l) => l.includes('judged minor'))).toBe(true);
    const rows = await findingsOf(latest!.id);
    expect(rows.filter((r) => r.lifecycle === 'new')).toHaveLength(0);
    await drain(w);
  });

  it('reconcile.poll enqueues pr.sync for PRs missing locally', async () => {
    w.github.setPr({
      repo: w.repo,
      number: 3,
      title: 'Docs tweak',
      headSha: '4'.repeat(40),
      baseSha: BASE_SHA,
      files: [{ path: 'README.md', before: 'a\n', after: 'b\n' }],
    });
    w.queue.clear();
    const sent = await reconcileRepository(w.worker.ctx, w.repo.id);
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(
      w.queue.jobs.some((j) => j.queue === 'pr.sync' && 'number' in j.data && j.data.number === 3),
    ).toBe(true);
    const [repo] = await handle.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, w.repo.id));
    expect(repo!.lastPolledAt?.toISOString()).toBe(NOW.toISOString());
    w.queue.clear();
  });

  it('digest.daily dispatches once per day per rule', async () => {
    const first = await w.worker.run('digest.daily', {});
    expect(first.sent).toBeGreaterThanOrEqual(1);
    const digests = (await notificationsOf(w.orgId)).filter((n) => n.kind === 'digest');
    expect(digests.length).toBeGreaterThanOrEqual(1);
    const second = await w.worker.run('digest.daily', {});
    expect(second.sent).toBe(0);
  });

  it('skips repositories whose projects are all paused', async () => {
    const p = await createWorld({ paused: true });
    const snap = p.github.setPr({
      repo: p.repo,
      number: 7,
      title: 'Paused work',
      headSha: H1,
      baseSha: BASE_SHA,
      files: [{ path: 'src/users.ts', before: USERS_BASE, after: USERS_PR1_V1 }],
    });
    const deliveryId = await storeDelivery(p, 'pull_request', prPayload(p, snap));
    expect((await p.worker.run('webhook.process', { deliveryId })).status).toBe('ignored');
    const [delivery] = await handle.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId));
    expect(delivery).toMatchObject({ status: 'ignored', error: 'projects paused' });
    expect(await prByNumber(p.repo.id, 7)).toBeNull();
    expect(p.queue.jobs).toHaveLength(0);

    // A queued analysis for an existing PR is skipped as well.
    const [pr] = await handle.db
      .insert(pullRequests)
      .values({
        orgId: p.orgId,
        repositoryId: p.repo.id,
        githubId: 9_007,
        number: 7,
        title: 'Paused work',
        baseRef: 'main',
        headRef: 'feature/7',
        headSha: H1,
        htmlUrl: 'https://github.example/pr/7',
      })
      .returning();
    const res = await p.worker.run('pr.analyze', { pullRequestId: pr!.id });
    expect(res).toMatchObject({ status: 'skipped', reason: 'projects_paused' });
    expect(await analysesOf(pr!.id)).toHaveLength(0);
    expect(p.github.calls).toHaveLength(0);
  });

  it('falls back to the deterministic report when the AI budget is exhausted', async () => {
    const b = await createWorld({ budgetUsd: 1 });
    await handle.db.insert(aiUsage).values({
      orgId: b.orgId,
      task: 'pr_report',
      providerKind: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 5,
      occurredAt: NOW,
    });
    b.github.setPr({
      repo: b.repo,
      number: 11,
      title: 'Rename user lookup',
      headSha: H1,
      baseSha: BASE_SHA,
      files: [{ path: 'src/users.ts', before: USERS_BASE, after: USERS_PR1_V1 }],
    });
    await b.worker.run('pr.sync', { repositoryId: b.repo.id, number: 11 });
    await drain(b);
    const pr = await prByNumber(b.repo.id, 11);
    const [analysis] = await analysesOf(pr!.id);
    expect(analysis).toMatchObject({ status: 'completed', generatedBy: 'deterministic' });
    expect(analysis!.aiUsage).toBeNull();
    const report = analysis!.report as PrReport;
    expect(report.limitations.some((l) => /budget/i.test(l))).toBe(true);
    expect(b.ai.calls.filter((c) => c.jsonSchemaName === 'pr_report')).toHaveLength(0);
    const notes = await notificationsOf(b.orgId);
    expect(notes.some((n) => n.kind === 'budget_alert')).toBe(true);
  });

  it('repo.discover stores the profile and repo.index replaces the code index', async () => {
    const r = await createWorld();
    const dir = await mkdtemp(join(tmpdir(), 'gmp-index-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
      await writeFile(
        join(dir, 'src', 'routes.ts'),
        `import express from 'express';\nconst app = express();\napp.get('/api/users/:id', (req, res) => res.json({}));\nexport function handler() { return fetch('/api/orders'); }\n`,
      );
      await writeFile(
        join(dir, 'node_modules', 'dep', 'index.js'),
        'export function ignored() {}\n',
      );
      const sha = 'c'.repeat(40);
      r.github.clones.set(r.repo.fullName, { dir, headSha: sha });
      r.github.profiles.set(r.repo.fullName, {
        languages: { TypeScript: 100 },
        primaryLanguage: 'TypeScript',
        frameworks: ['express'],
        buildTools: [],
        packageManagers: ['npm'],
        testFrameworks: [],
        ciSystems: [],
        ciWorkflows: [],
        securityTools: [],
        infrastructure: [],
        codeowners: null,
        codeownersFiles: [],
        codeownersRules: [],
        prTemplate: null,
        prTemplates: [],
        contributing: null,
        securityPolicy: null,
        architectureDocs: [],
        docsDirs: [],
        adrDirs: [],
        packages: [],
        monorepoTools: [],
        isMonorepo: false,
        manifests: [],
        defaultBranch: 'main',
        ref: 'main',
        headSha: sha,
        treeTruncated: false,
        limitations: [],
        discoveredAt: NOW.toISOString(),
      });
      expect((await r.worker.run('repo.discover', { repositoryId: r.repo.id })).status).toBe(
        'completed',
      );
      const [job] = r.queue.take('repo.index');
      expect(job?.data).toEqual({ repositoryId: r.repo.id, ref: sha });
      const indexed = await r.worker.run('repo.index', job!.data);
      expect(indexed.status).toBe('completed');
      const symbols = await handle.db
        .select()
        .from(codeSymbols)
        .where(eq(codeSymbols.repositoryId, r.repo.id));
      expect(symbols.some((s) => s.name === 'handler' && s.refSha === sha)).toBe(true);
      expect(symbols.some((s) => s.name === 'ignored')).toBe(false);
      const contracts = await handle.db
        .select()
        .from(codeContracts)
        .where(eq(codeContracts.repositoryId, r.repo.id));
      expect(contracts.some((c) => c.kind === 'http_route' && c.role === 'provider')).toBe(true);
      // Same ref again: unchanged.
      expect((await r.worker.run('repo.index', job!.data)).status).toBe('unchanged');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retention.cleanup clears old webhook payloads and expired sessions', async () => {
    const old = new Date(NOW.getTime() - 40 * 86_400_000);
    const deliveryId = `old-${rand()}`;
    await handle.db.insert(webhookDeliveries).values({
      deliveryId,
      event: 'ping',
      payload: { zen: 'old' },
      status: 'processed',
      receivedAt: old,
    });
    await handle.db.insert(sessions).values({
      userId: w.adminId,
      tokenHash: `hash-${rand()}`,
      csrfToken: 'csrf',
      expiresAt: old,
    });
    const res = await w.worker.run('retention.cleanup', {});
    expect(res.webhookPayloadsCleared).toBeGreaterThanOrEqual(1);
    expect(res.sessionsDeleted).toBeGreaterThanOrEqual(1);
    const [d] = await handle.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId));
    expect(d!.payload).toBeNull();
  });

  it('invalid payloads are rejected without throwing', async () => {
    expect(await w.worker.run('pr.analyze', { pullRequestId: 'not-a-uuid' })).toMatchObject({
      status: 'skipped',
      reason: 'invalid_payload',
    });
  });

  it('start() creates every queue and schedule on pg-boss and processes a job', async () => {
    const boss = new PgBoss({ connectionString: dbUrl, schema: 'pgboss_test' });
    boss.on('error', () => undefined);
    await boss.start();
    const worker = createWorker({
      db: handle.db,
      github: new FakeGitHub(),
      queue: createBossJobQueue(boss),
      publicUrl: PUBLIC_URL,
      masterKey: MASTER_KEY,
      now: () => NOW,
    });
    try {
      await worker.start(boss, { queues: ['retention.cleanup'] });
      const queues = await boss.getQueues();
      const names = queues.map((q) => q.name).filter((n) => !n.startsWith('__pgboss'));
      expect(names.sort()).toEqual([...QUEUE_NAMES].sort());
      const pr = queues.find((q) => q.name === 'pr.analyze');
      expect(pr).toMatchObject({ policy: 'stately', retryLimit: 5, retryBackoff: true });
      const schedules = await boss.getSchedules();
      expect(schedules.map((s) => `${s.name} ${s.cron}`).sort()).toEqual([
        'digest.daily */15 * * * *',
        'notify.flush * * * * *',
        'reconcile.poll */15 * * * *',
        'retention.cleanup 17 3 * * *',
      ]);
      const id = await createBossJobQueue(boss).send('retention.cleanup', {});
      expect(id).toBeTruthy();
      let state = '';
      for (let i = 0; i < 60 && state !== 'completed' && state !== 'failed'; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const [job] = await boss.findJobs('retention.cleanup', { id: id! });
        state = job?.state ?? '';
      }
      expect(state).toBe('completed');
    } finally {
      await worker.stop();
      await boss.stop({ graceful: false, timeout: 2_000 });
    }
  }, 30_000);
});

describe.skipIf(!reachable)('@gmp/worker review fixes (real Postgres)', () => {
  const HA = 'a'.repeat(40);
  const HB = 'c'.repeat(40);

  it('skips an analysis job for a head that is no longer the PR head (superseded)', async () => {
    const w = await createWorld();
    w.github.setPr({
      repo: w.repo,
      number: 20,
      title: 'Two quick pushes',
      headSha: HA,
      baseSha: BASE_SHA,
      files: [{ path: 'src/users.ts', before: USERS_BASE, after: USERS_PR2 }],
    });
    await w.worker.run('pr.sync', { repositoryId: w.repo.id, number: 20 });
    const jobA = w.queue.take('pr.analyze')[0]!;
    w.github.setPr({
      repo: w.repo,
      number: 20,
      title: 'Two quick pushes',
      headSha: HB,
      baseSha: BASE_SHA,
      files: [{ path: 'src/users.ts', before: USERS_BASE, after: USERS_PR1_V2 }],
    });
    const pr = await prByNumber(w.repo.id, 20);
    await w.worker.run('pr.sync', { pullRequestId: pr!.id });
    // The cached snapshot of A must not move the PR back, and A is not analysed.
    const res = await w.worker.run('pr.analyze', jobA.data);
    expect(res).toMatchObject({ status: 'skipped', reason: 'superseded' });
    expect((await prByNumber(w.repo.id, 20))!.headSha).toBe(HB);
    expect((await analysesOf(pr!.id)).some((a) => a.headSha === HA)).toBe(false);
    await drain(w);
    const [latest] = await analysesOf(pr!.id);
    expect(latest).toMatchObject({ headSha: HB, status: 'completed' });
  });

  it('readiness refresh keeps AI open questions (needs_clarification) and a consistent summary', async () => {
    const w = await createWorld();
    w.github.setPr({
      repo: w.repo,
      number: 21,
      title: 'Change list limit',
      headSha: HA,
      baseSha: BASE_SHA,
      reviewDecision: 'APPROVED',
      checks: [
        {
          kind: 'check_run',
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          url: null,
          startedAt: null,
          completedAt: null,
          appSlug: null,
        },
      ],
      files: [{ path: 'src/users.ts', before: USERS_BASE, after: USERS_PR2 }],
    });
    w.ai.enqueue({
      json: {
        ...aiReport('AI summary.'),
        openQuestions: ['Is the old limit relied on by clients?'],
      },
    });
    await w.worker.run('pr.sync', { repositoryId: w.repo.id, number: 21 });
    await drain(w);
    const pr = await prByNumber(w.repo.id, 21);
    const [full] = await analysesOf(pr!.id);
    expect(full!.recommendation).toBe('needs_clarification');
    expect((full!.report as PrReport).aiAssessment?.openQuestions).toHaveLength(1);

    const res = await w.worker.run('pr.readiness', { pullRequestId: pr!.id });
    expect(res).toMatchObject({ status: 'completed', recommendation: 'needs_clarification' });
    const [readiness] = await handle.db
      .select()
      .from(analyses)
      .where(and(eq(analyses.pullRequestId, pr!.id), eq(analyses.kind, 'readiness_only')));
    const report = readiness!.report as PrReport;
    expect(report.mergeReadiness.blockers.some((b) => b.includes('old limit'))).toBe(true);
    expect(report.executiveSummary).toContain('merge readiness: Needs clarification.');
  });

  it('a review comment webhook does not wipe the stored mergeable state', async () => {
    const w = await createWorld();
    const snap = w.github.setPr({
      repo: w.repo,
      number: 22,
      title: 'Conflicting change',
      headSha: HA,
      baseSha: BASE_SHA,
      mergeableState: 'dirty',
      files: [{ path: 'src/users.ts', before: USERS_BASE, after: USERS_PR2 }],
    });
    await w.worker.run('pr.sync', { repositoryId: w.repo.id, number: 22 });
    w.queue.clear();
    const payload = prPayload(w, snap);
    const {
      mergeable_state: _m,
      additions: _a,
      deletions: _d,
      changed_files: _c,
      ...simple
    } = payload.pull_request;
    const deliveryId = await storeDelivery(w, 'pull_request_review_comment', {
      ...payload,
      action: 'created',
      pull_request: { ...simple, updated_at: '2026-11-14T11:59:00Z' },
      comment: {
        id: 5_001,
        user: { login: 'reviewer' },
        body: 'nit',
        created_at: '2026-11-14T11:59:00Z',
        updated_at: '2026-11-14T11:59:00Z',
        path: 'src/users.ts',
        line: 2,
      },
    });
    expect((await w.worker.run('webhook.process', { deliveryId })).status).toBe('completed');
    expect((await prByNumber(w.repo.id, 22))!.mergeableState).toBe('dirty');
  });

  it('reconcile retries a failed analysis after the cooldown, not before', async () => {
    const w = await createWorld();
    w.github.setPr({
      repo: w.repo,
      number: 23,
      title: 'Outage victim',
      headSha: HA,
      baseSha: BASE_SHA,
      files: [{ path: 'README.md', before: 'a\n', after: 'b\n' }],
    });
    await w.worker.run('pr.sync', { repositoryId: w.repo.id, number: 23 });
    w.queue.clear();
    const pr = await prByNumber(w.repo.id, 23);
    await handle.db.insert(analyses).values({
      orgId: w.orgId,
      pullRequestId: pr!.id,
      headSha: HA,
      kind: 'full',
      status: 'failed',
      error: 'GitHub unavailable',
      completedAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    const syncsFor = () =>
      w.queue.jobs.filter(
        (j) =>
          j.queue === 'pr.sync' && 'pullRequestId' in j.data && j.data.pullRequestId === pr!.id,
      ).length;
    await reconcileRepository(w.worker.ctx, w.repo.id);
    expect(syncsFor()).toBe(0);
    w.queue.clear();
    await handle.db
      .update(analyses)
      .set({ completedAt: new Date(NOW.getTime() - 2 * 60 * 60_000) })
      .where(eq(analyses.pullRequestId, pr!.id));
    await reconcileRepository(w.worker.ctx, w.repo.id);
    expect(syncsFor()).toBe(1);
  });

  it('imports repositories added to the installation and their open PRs right away', async () => {
    const w = await createWorld();
    const githubId = 3_000_000 + Math.floor(Math.random() * 1_000_000);
    const name = `newsvc-${rand()}`;
    const deliveryId = await storeDelivery(w, 'installation_repositories', {
      action: 'added',
      installation: { id: w.installationNumericId, account: { login: 'example-org' } },
      repository_selection: 'all',
      repositories_added: [{ id: githubId, name, full_name: `example-org/${name}`, private: true }],
      repositories_removed: [],
      sender: { login: 'org-owner' },
    });
    expect((await w.worker.run('webhook.process', { deliveryId })).status).toBe('completed');
    const [row] = await handle.db
      .select()
      .from(repositories)
      .where(and(eq(repositories.orgId, w.orgId), eq(repositories.githubId, githubId)));
    expect(row).toMatchObject({ fullName: `example-org/${name}`, monitoringEnabled: true });
    const [discover] = w.queue.take('repo.discover');
    expect(discover?.data).toEqual({ repositoryId: row!.id });

    w.github.profiles.set(row!.fullName, {
      defaultBranch: 'trunk',
      headSha: 'd'.repeat(40),
    } as never);
    w.github.setPr({
      repo: row!,
      number: 1,
      title: 'Existing open PR',
      headSha: HA,
      baseSha: BASE_SHA,
      files: [{ path: 'README.md', before: 'a\n', after: 'b\n' }],
    });
    const res = await w.worker.run('repo.discover', discover!.data);
    expect(res).toMatchObject({ status: 'completed', prSyncs: 1 });
    expect(
      w.queue.jobs.some((j) => j.queue === 'pr.sync' && 'number' in j.data && j.data.number === 1),
    ).toBe(true);
    const [after] = await handle.db.select().from(repositories).where(eq(repositories.id, row!.id));
    expect(after!.defaultBranch).toBe('trunk');
  });
});
