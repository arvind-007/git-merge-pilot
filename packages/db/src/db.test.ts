import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  createTestDatabase,
  migrate,
  schema,
  type DbHandle,
  type TestDatabase,
} from './index.ts';

const {
  organizations,
  users,
  repositories,
  githubApps,
  installations,
  pullRequests,
  prRelationships,
  notifications,
  systemState,
  aiSettings,
  projects,
  projectRepositories,
} = schema;

let testDb: TestDatabase;
let handle: DbHandle;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDb(testDb.url, { max: 4 });
}, 60_000);

afterAll(async () => {
  await handle?.close();
  await testDb?.drop();
});

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
}

describe('migrations', () => {
  it('created every table', async () => {
    const res = await handle.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    const tables = res.rows.map((r) => r.table_name);
    for (const t of [
      'organizations',
      'users',
      'sessions',
      'invites',
      'system_state',
      'github_apps',
      'installations',
      'repositories',
      'repository_profiles',
      'projects',
      'project_repositories',
      'project_members',
      'pull_requests',
      'pr_files',
      'pr_commits',
      'pr_reviews',
      'pr_checks',
      'webhook_deliveries',
      'pr_events',
      'analyses',
      'findings',
      'pr_relationships',
      'code_symbols',
      'code_contracts',
      'ai_providers',
      'ai_settings',
      'ai_usage',
      'notification_channels',
      'notification_rules',
      'notifications',
      'audit_log',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('is re-runnable, including concurrently', async () => {
    await migrate(testDb.url);
    await Promise.all([migrate(testDb.url), migrate(testDb.url)]);
    const res = await handle.pool.query(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(res.rows[0].n).toBe(1);
  });
});

describe('org + user + repo', () => {
  it('inserts and reads back an organization, user, installation and repository', async () => {
    const [org] = await handle.db.insert(organizations).values({ name: 'Test Org' }).returning();
    expect(org!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(org!.timezone).toBe('UTC');
    expect(org!.settings).toEqual({});
    expect(org!.createdAt).toBeInstanceOf(Date);

    const [user] = await handle.db
      .insert(users)
      .values({
        orgId: org!.id,
        email: 'pm@example.com',
        name: 'PM',
        passwordHash: 'argon2-hash',
        role: 'admin',
      })
      .returning();
    expect(user!.role).toBe('admin');
    expect(user!.disabled).toBe(false);

    const [app] = await handle.db
      .insert(githubApps)
      .values({
        orgId: org!.id,
        appId: 123456,
        slug: 'gmp-test',
        name: 'gmp test',
        clientId: 'Iv1.test',
        clientSecretEnc: 'v1:a:b:c',
        privateKeyEnc: 'v1:a:b:c',
        webhookSecretEnc: 'v1:a:b:c',
        htmlUrl: 'https://github.com/apps/gmp-test',
      })
      .returning();
    const [inst] = await handle.db
      .insert(installations)
      .values({
        orgId: org!.id,
        githubAppId: app!.id,
        installationId: 9_007_199_254,
        accountLogin: 'acme',
        accountType: 'Organization',
      })
      .returning();
    expect(inst!.installationId).toBe(9_007_199_254);

    const [repo] = await handle.db
      .insert(repositories)
      .values({
        orgId: org!.id,
        installationId: inst!.id,
        githubId: 555_000_111,
        owner: 'acme',
        name: 'api',
        fullName: 'acme/api',
        excludePaths: ['vendor/**'],
      })
      .returning();
    expect(repo!.monitoringEnabled).toBe(true);
    expect(repo!.aiMode).toBe('full');
    expect(repo!.excludePaths).toEqual(['vendor/**']);
    expect(repo!.githubId).toBe(555_000_111);

    const found = await handle.db.query.repositories.findFirst({
      where: and(eq(repositories.orgId, org!.id), eq(repositories.fullName, 'acme/api')),
      with: { installation: true, organization: true },
    });
    expect(found?.installation?.accountLogin).toBe('acme');
    expect(found?.organization.name).toBe('Test Org');

    // Email uniqueness is case-insensitive per org.
    const dup = handle.db
      .insert(users)
      .values({ orgId: org!.id, email: 'PM@Example.com', name: 'Dup', passwordHash: 'x' });
    expect(await pgCode(dup)).toBe('23505');

    // Uninstalling keeps repository history (SET NULL).
    await handle.db.delete(installations).where(eq(installations.id, inst!.id));
    const [afterUninstall] = await handle.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repo!.id));
    expect(afterUninstall!.installationId).toBeNull();

    // Deleting the org cascades to tenant tables.
    await handle.db.delete(organizations).where(eq(organizations.id, org!.id));
    const left = await handle.db.select().from(repositories).where(eq(repositories.orgId, org!.id));
    expect(left).toHaveLength(0);
  });
});

describe('constraints', () => {
  it('enforces pr_relationships ordering, notification dedup and system_state singleton', async () => {
    const [org] = await handle.db.insert(organizations).values({ name: 'C Org' }).returning();
    const [repo] = await handle.db
      .insert(repositories)
      .values({ orgId: org!.id, githubId: 1, owner: 'o', name: 'r', fullName: 'o/r' })
      .returning();
    const mkPr = (n: number) =>
      handle.db
        .insert(pullRequests)
        .values({
          orgId: org!.id,
          repositoryId: repo!.id,
          githubId: 1000 + n,
          number: n,
          title: `PR ${n}`,
          baseRef: 'main',
          headRef: `f${n}`,
          headSha: 'a'.repeat(40),
          htmlUrl: `https://github.com/o/r/pull/${n}`,
        })
        .returning();
    const [[p1], [p2]] = await Promise.all([mkPr(1), mkPr(2)]);
    const [lo, hi] = [p1!.id, p2!.id].sort();

    expect(await pgCode(mkPr(1))).toBe('23505'); // unique (repository_id, number)

    await handle.db.insert(prRelationships).values({
      orgId: org!.id,
      prAId: lo!,
      prBId: hi!,
      type: 'same_file',
      confidence: 'likely',
      summary: 's',
    });
    const reversed = handle.db.insert(prRelationships).values({
      orgId: org!.id,
      prAId: hi!,
      prBId: lo!,
      type: 'same_symbol',
      confidence: 'likely',
      summary: 's',
    });
    expect(await pgCode(reversed)).toBe('23514'); // check violation

    const note = {
      orgId: org!.id,
      kind: 'high_risk',
      title: 't',
      dedupKey: 'pr:1:high',
      channelKind: 'slack' as const,
    };
    await handle.db.insert(notifications).values(note);
    // user_id NULL must still dedupe (NULLS NOT DISTINCT).
    expect(await pgCode(handle.db.insert(notifications).values(note))).toBe('23505');
    const inserted = await handle.db
      .insert(notifications)
      .values(note)
      .onConflictDoNothing()
      .returning();
    expect(inserted).toHaveLength(0);

    await handle.db.insert(systemState).values({ setupTokenHash: 'h' });
    expect(await pgCode(handle.db.insert(systemState).values({}))).toBe('23505');

    const [settings] = await handle.db.insert(aiSettings).values({ orgId: org!.id }).returning();
    expect(settings!.enabled).toBe(false);
    expect(settings!.monthlyBudgetUsd).toBe(100);
    expect(settings!.alertThresholdPct).toBe(80);
    expect(settings!.maxInputTokensPerCall).toBe(120000);

    const [project] = await handle.db
      .insert(projects)
      .values({ orgId: org!.id, name: 'P' })
      .returning();
    await handle.db
      .insert(projectRepositories)
      .values({ projectId: project!.id, repositoryId: repo!.id });
    expect(
      await pgCode(
        handle.db
          .insert(projectRepositories)
          .values({ projectId: project!.id, repositoryId: repo!.id }),
      ),
    ).toBe('23505');

    // updated_at is bumped on update.
    const before = project!.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    const [updated] = await handle.db
      .update(projects)
      .set({ paused: true })
      .where(eq(projects.id, project!.id))
      .returning();
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(before.getTime());

    const count = await handle.db.execute(
      sql`select count(*) as n from pull_requests where org_id = ${org!.id}`,
    );
    expect(Number(count.rows[0]!.n)).toBe(2);
  });
});

describe('createDb', () => {
  it('close() is idempotent', async () => {
    const h = createDb(testDb.url, { max: 1 });
    await h.db.execute(sql`select 1`);
    await h.close();
    await h.close();
    expect(h.pool.ended).toBe(true);
  });

  it('pg is importable for raw access', () => {
    expect(typeof pg.Pool).toBe('function');
  });
});
