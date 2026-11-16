import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyses,
  auditLog,
  findings,
  isDatabaseReachable,
  prRelationships,
  pullRequests,
  repositories,
} from '@gmp/db';
import { accessibleRepositoryIds } from './access.ts';
import {
  as,
  createMember,
  createTestApp,
  setupAdmin,
  type Session,
  type TestApp,
} from './test/helpers.ts';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('projects CRUD and member isolation', () => {
  let t: TestApp;
  let admin: Session;
  let member: Session;
  let repoA: string;
  let repoB: string;
  let prA: string;
  let prB: string;

  beforeAll(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
    member = await createMember(t, admin, 'member@example.test');
    const db = t.db.handle.db;
    const repos = await db
      .insert(repositories)
      .values([
        { orgId: admin.orgId, githubId: 101, owner: 'acme', name: 'alpha', fullName: 'acme/alpha' },
        { orgId: admin.orgId, githubId: 102, owner: 'acme', name: 'beta', fullName: 'acme/beta' },
      ])
      .returning();
    repoA = repos[0]!.id;
    repoB = repos[1]!.id;
    const prs = await db
      .insert(pullRequests)
      .values([
        {
          orgId: admin.orgId,
          repositoryId: repoA,
          githubId: 9001,
          number: 1,
          title: 'Alpha change',
          baseRef: 'main',
          headRef: 'feat-a',
          headSha: 'a'.repeat(40),
          htmlUrl: 'https://github.com/acme/alpha/pull/1',
          authorLogin: 'dev-a',
        },
        {
          orgId: admin.orgId,
          repositoryId: repoB,
          githubId: 9002,
          number: 2,
          title: 'Beta secret change',
          baseRef: 'main',
          headRef: 'feat-b',
          headSha: 'b'.repeat(40),
          htmlUrl: 'https://github.com/acme/beta/pull/2',
          authorLogin: 'dev-b',
        },
      ])
      .returning();
    prA = prs[0]!.id;
    prB = prs[1]!.id;
    const [an] = await db
      .insert(analyses)
      .values({
        orgId: admin.orgId,
        pullRequestId: prA,
        headSha: 'a'.repeat(40),
        status: 'completed',
        overallRisk: 'high',
        recommendation: 'merge_after_checks',
        confidence: 70,
        generatedBy: 'deterministic',
        completedAt: new Date(),
      })
      .returning();
    await db.insert(findings).values({
      orgId: admin.orgId,
      analysisId: an!.id,
      pullRequestId: prA,
      fingerprint: 'fp1',
      category: 'security',
      severity: 'high',
      title: 'Hardcoded credential',
      verified: true,
      data: {
        fingerprint: 'fp1',
        category: 'security',
        severity: 'high',
        title: 'Hardcoded credential',
        description: 'A credential appears in source.',
        evidence: [{ repo: 'acme/alpha', path: 'src/a.ts', line: 3, source: 'diff' }],
        verified: true,
        source: 'rule',
      },
    });
    const [lo, hi] = [prA, prB].sort();
    await db.insert(prRelationships).values({
      orgId: admin.orgId,
      prAId: lo!,
      prBId: hi!,
      type: 'same_file',
      confidence: 'likely',
      summary: 'Both touch config',
    });
  });
  afterAll(async () => t?.close());

  let projectId: string;
  let otherProjectId: string;

  it('creates, lists, updates and validates projects (admin)', async () => {
    const create = await as(t, admin)('POST', '/api/projects', {
      name: 'Payments',
      description: 'Payment services',
      repositoryIds: [repoA],
      memberIds: [member.userId],
      settings: { riskThresholds: { critical: 85, high: 65, medium: 35 }, analysisDepth: 'deep' },
    });
    expect(create.statusCode).toBe(201);
    projectId = create.json().id;
    expect(create.json()).toMatchObject({
      name: 'Payments',
      paused: false,
      repositoryCount: 1,
      memberCount: 1,
    });

    const dup = await as(t, admin)('POST', '/api/projects', { name: 'payments' });
    expect(dup.statusCode).toBe(409);

    const badThresholds = await as(t, admin)('POST', '/api/projects', {
      name: 'Bad',
      settings: { riskThresholds: { critical: 10, high: 50 } },
    });
    expect(badThresholds.statusCode).toBe(400);

    const other = await as(t, admin)('POST', '/api/projects', {
      name: 'Internal',
      repositoryIds: [repoB],
    });
    expect(other.statusCode).toBe(201);
    otherProjectId = other.json().id;

    const list = await as(t, admin)('GET', '/api/projects');
    expect(list.json().map((p: { name: string }) => p.name)).toEqual(['Internal', 'Payments']);
    const payments = list.json().find((p: { id: string }) => p.id === projectId);
    expect(payments).toMatchObject({ openPrCount: 1, riskCounts: { high: 1 } });

    const patch = await as(t, admin)('PATCH', `/api/projects/${projectId}`, {
      description: 'Updated',
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().description).toBe('Updated');

    const pause = await as(t, admin)('POST', `/api/projects/${projectId}/pause`);
    expect(pause.json().paused).toBe(true);
    const resume = await as(t, admin)('POST', `/api/projects/${projectId}/resume`);
    expect(resume.json().paused).toBe(false);
    expect(t.queue.byName('reconcile.poll').length).toBeGreaterThanOrEqual(1);

    const detail = await as(t, admin)('GET', `/api/projects/${projectId}`);
    expect(detail.json().repositories.map((r: { fullName: string }) => r.fullName)).toEqual([
      'acme/alpha',
    ]);
    expect(detail.json().members.map((m: { email: string }) => m.email)).toEqual([
      'member@example.test',
    ]);

    const actions = (await t.db.handle.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'project.created',
        'project.updated',
        'project.paused',
        'project.resumed',
      ]),
    );
  });

  it('only exposes member projects, repositories and PRs to members', async () => {
    const m = as(t, member);
    const projectsRes = await m('GET', '/api/projects');
    expect(projectsRes.json().map((p: { id: string }) => p.id)).toEqual([projectId]);
    expect((await m('GET', `/api/projects/${otherProjectId}`)).statusCode).toBe(404);
    expect((await m('GET', `/api/projects/${otherProjectId}/overview`)).statusCode).toBe(404);

    const repos = await m('GET', '/api/repositories');
    expect(repos.json().map((r: { fullName: string }) => r.fullName)).toEqual(['acme/alpha']);
    expect((await m('GET', `/api/repositories/${repoB}`)).statusCode).toBe(404);

    const prs = await m('GET', '/api/pull-requests');
    expect(prs.json().map((p: { title: string }) => p.title)).toEqual(['Alpha change']);
    expect(prs.json()[0]).toMatchObject({
      overallRisk: 'high',
      findingCounts: { high: 1 },
      projectIds: [projectId],
    });
    expect((await m('GET', `/api/pull-requests/${prB}`)).statusCode).toBe(404);
    expect((await m('GET', `/api/pull-requests?projectId=${otherProjectId}`)).statusCode).toBe(404);

    // The relationship to an inaccessible PR is hidden from the member.
    const detail = await m('GET', `/api/pull-requests/${prA}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().relationships).toEqual([]);
    expect(detail.json().findings).toHaveLength(1);
    expect(JSON.stringify(await m('GET', '/api/overview').then((r) => r.json()))).not.toContain(
      'Beta secret change',
    );
    expect(JSON.stringify(await m('GET', '/api/risk-center').then((r) => r.json()))).not.toContain(
      'Beta secret',
    );
    const devs = await m('GET', '/api/developers');
    expect(devs.json().map((d: { login: string }) => d.login)).toEqual(['dev-a']);

    // Admin sees both and the relationship.
    const adminDetail = await as(t, admin)('GET', `/api/pull-requests/${prA}`);
    expect(adminDetail.json().relationships).toHaveLength(1);
    expect(adminDetail.json().relationships[0].otherPr.title).toBe('Beta secret change');

    const ids = await accessibleRepositoryIds(t.db.handle.db, {
      id: member.userId,
      orgId: member.orgId,
      email: 'member@example.test',
      name: 'member',
      role: 'member',
      timezone: null,
    });
    expect(ids).toEqual([repoA]);
  });

  it('forbids members from admin mutations', async () => {
    const m = as(t, member);
    expect((await m('POST', '/api/projects', { name: 'Nope' })).statusCode).toBe(403);
    expect((await m('PATCH', `/api/projects/${projectId}`, { name: 'Renamed' })).statusCode).toBe(
      403,
    );
    expect((await m('DELETE', `/api/projects/${projectId}`)).statusCode).toBe(403);
    expect((await m('POST', `/api/pull-requests/${prA}/reanalyze`)).statusCode).toBe(403);
    expect((await m('PATCH', `/api/repositories/${repoA}`, { aiMode: 'off' })).statusCode).toBe(
      403,
    );
  });

  it('manages project repositories and members, then deletes the project', async () => {
    const a = as(t, admin);
    const addRepo = await a('POST', `/api/projects/${projectId}/repositories`, {
      repositoryId: repoB,
    });
    expect(addRepo.json()).toMatchObject({ ok: true, added: 1 });
    expect((await as(t, member)('GET', `/api/pull-requests/${prB}`)).statusCode).toBe(200);
    const removeRepo = await a('DELETE', `/api/projects/${projectId}/repositories`, {
      repositoryId: repoB,
    });
    expect(removeRepo.json()).toMatchObject({ removed: 1 });
    expect((await as(t, member)('GET', `/api/pull-requests/${prB}`)).statusCode).toBe(404);

    const removeMember = await a('DELETE', `/api/projects/${projectId}/members`, {
      userId: member.userId,
    });
    expect(removeMember.json()).toMatchObject({ removed: 1 });
    expect((await as(t, member)('GET', '/api/projects')).json()).toEqual([]);
    const addMember = await a('POST', `/api/projects/${projectId}/members`, {
      userId: member.userId,
    });
    expect(addMember.json()).toMatchObject({ added: 1 });

    const reanalyze = await a('POST', `/api/pull-requests/${prA}/reanalyze`);
    expect(reanalyze.statusCode).toBe(202);
    expect(t.queue.byName('pr.analyze')).toHaveLength(1);
    expect(t.queue.byName('pr.analyze')[0]!.data).toMatchObject({
      pullRequestId: prA,
      force: true,
    });
    await t.db.handle.db
      .update(pullRequests)
      .set({ state: 'merged' })
      .where(eq(pullRequests.id, prA));
    const closedReanalyze = await a('POST', `/api/pull-requests/${prA}/reanalyze`);
    expect(closedReanalyze.statusCode).toBe(409);
    expect(closedReanalyze.json()).toMatchObject({ code: 'pull_request_not_open' });
    expect(t.queue.byName('pr.analyze')).toHaveLength(1);
    await t.db.handle.db
      .update(pullRequests)
      .set({ state: 'open' })
      .where(eq(pullRequests.id, prA));

    const overview = await a('GET', `/api/projects/${projectId}/overview`);
    expect(overview.json()).toMatchObject({
      riskCounts: { high: 1 },
      recommendationCounts: { merge_after_checks: 1 },
    });

    const del = await a('DELETE', `/api/projects/${projectId}`);
    expect(del.statusCode).toBe(200);
    expect((await a('GET', `/api/projects/${projectId}`)).statusCode).toBe(404);
    expect((await a('GET', '/api/projects/not-a-uuid')).statusCode).toBe(400);
  });

  it('updates repository settings and enqueues rediscovery', async () => {
    const a = as(t, admin);
    const patch = await a('PATCH', `/api/repositories/${repoA}`, {
      aiMode: 'metadata_only',
      excludePaths: ['secrets/**', 'secrets/**'],
      profileOverrides: { frameworks: ['fastify'] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ aiMode: 'metadata_only', excludePaths: ['secrets/**'] });
    const detail = await a('GET', `/api/repositories/${repoA}`);
    expect(detail.json().profile.overrides).toEqual({ frameworks: ['fastify'] });
    const re = await a('POST', `/api/repositories/${repoA}/rediscover`);
    expect(re.statusCode).toBe(202);
    expect(t.queue.byName('repo.discover').at(-1)!.data).toMatchObject({
      repositoryId: repoA,
      reason: 'manual',
    });
    const bad = await a('PATCH', `/api/repositories/${repoA}`, { aiMode: 'everything' });
    expect(bad.statusCode).toBe(400);
  });
});
