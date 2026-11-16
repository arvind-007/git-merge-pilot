/**
 * Integration tests against real Postgres (docker-compose.dev.yml). Uses a dedicated database
 * `gmp_test_notify`, recreated and migrated with @gmp/db on every run.
 */
import { randomBytes } from 'node:crypto';
import { encryptJson, setMasterKey } from '@gmp/core';
import {
  analyses,
  createDb,
  findings,
  isDatabaseReachable,
  migrate,
  notificationChannels,
  notificationRules,
  notifications,
  organizations,
  prRelationships,
  projectMembers,
  projectRepositories,
  projects,
  pullRequests,
  repositories,
  testDatabaseBaseUrl,
  users,
  type DbHandle,
  type NewPullRequest,
} from '@gmp/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelSendError } from './channels/email.ts';
import { buildDigest } from './digest.ts';
import { dispatch, markNotificationRead, resolveRule, slackDedupKey } from './dispatch.ts';
import { flushPending } from './flush.ts';
import { renderDigest } from './render.ts';
import type { ChannelSenders, EmailMessage, NotificationEvent, SlackMessage } from './types.ts';

const DB_NAME = 'gmp_test_notify';
const baseUrl = testDatabaseBaseUrl();
const reachable = await isDatabaseReachable(baseUrl);
if (!reachable) {
  console.warn(
    `[notify] Postgres not reachable at the test URL; skipping DB tests. Run: docker compose -f docker-compose.dev.yml up -d`,
  );
}

let handle: DbHandle;
const HOOK = ['https://hooks.slack.com', 'services', 'T1', 'B1', 'fake'].join('/');

beforeAll(async () => {
  if (!reachable) return;
  setMasterKey(randomBytes(32));
  const admin = createDb(baseUrl, { max: 1 });
  try {
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`));
    await admin.db.execute(sql.raw(`CREATE DATABASE "${DB_NAME}"`));
  } finally {
    await admin.close();
  }
  const u = new URL(baseUrl);
  u.pathname = `/${DB_NAME}`;
  await migrate(u.toString());
  handle = createDb(u.toString(), { max: 6 });
}, 60_000);

afterAll(async () => {
  await handle?.close();
  setMasterKey(null);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
async function seedOrg(timezone = 'UTC') {
  const db = handle.db;
  const n = ++seq;
  const [org] = await db
    .insert(organizations)
    .values({ name: `Org ${n}`, timezone })
    .returning();
  const mk = (email: string, role: 'admin' | 'member', disabled = false) => ({
    orgId: org!.id,
    email: `${email}-${n}@example.test`,
    name: email,
    passwordHash: 'x',
    role,
    disabled,
  });
  const [admin, member, outsider, disabledAdmin] = await db
    .insert(users)
    .values([
      mk('admin', 'admin'),
      mk('member', 'member'),
      mk('outsider', 'member'),
      mk('gone', 'admin', true),
    ])
    .returning();
  const [p1, p2] = await db
    .insert(projects)
    .values([
      { orgId: org!.id, name: 'Payments' },
      { orgId: org!.id, name: 'Web' },
    ])
    .returning();
  await db.insert(projectMembers).values({ projectId: p1!.id, userId: member!.id });
  const [r1, r2] = await db
    .insert(repositories)
    .values([
      { orgId: org!.id, githubId: n * 100 + 1, owner: 'acme', name: 'api', fullName: 'acme/api' },
      { orgId: org!.id, githubId: n * 100 + 2, owner: 'acme', name: 'web', fullName: 'acme/web' },
    ])
    .returning();
  await db.insert(projectRepositories).values([
    { projectId: p1!.id, repositoryId: r1!.id },
    { projectId: p2!.id, repositoryId: r2!.id },
  ]);
  const channels = await db
    .insert(notificationChannels)
    .values([
      { orgId: org!.id, kind: 'in_app', name: 'In-app' },
      {
        orgId: org!.id,
        kind: 'email',
        name: 'SMTP',
        configEnc: encryptJson({
          host: 'smtp.example.test',
          port: 587,
          secure: false,
          from: 'alerts@example.test',
        }),
      },
      {
        orgId: org!.id,
        kind: 'slack',
        name: 'Slack',
        configEnc: encryptJson({ webhookUrl: HOOK }),
      },
    ])
    .returning();
  const [inApp, email, slack] = channels;
  return {
    org: org!,
    admin: admin!,
    member: member!,
    outsider: outsider!,
    disabledAdmin: disabledAdmin!,
    p1: p1!,
    p2: p2!,
    r1: r1!,
    r2: r2!,
    ch: { inApp: inApp!, email: email!, slack: slack! },
  };
}

type Seed = Awaited<ReturnType<typeof seedOrg>>;

let prSeq = 0;
async function seedPr(s: Seed, repositoryId: string, over: Partial<NewPullRequest> = {}) {
  const n = ++prSeq;
  const [pr] = await handle.db
    .insert(pullRequests)
    .values({
      orgId: s.org.id,
      repositoryId,
      githubId: 10_000 + n,
      number: n,
      title: `PR ${n}`,
      baseRef: 'main',
      headRef: `feature-${n}`,
      headSha: `sha${n}`,
      htmlUrl: `https://github.com/acme/repo/pull/${n}`,
      authorLogin: 'dev',
      openedAt: new Date('2026-11-01T00:00:00Z'),
      ...over,
    })
    .returning();
  return pr!;
}

function event(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: 'high_risk',
    severity: 'high',
    title: 'PR #1 is high risk',
    body: 'Risk rose from medium to high.',
    url: '/pull-requests/x',
    dedupKey: `k-${randomBytes(4).toString('hex')}`,
    ...over,
  };
}

async function rowsFor(orgId: string) {
  return handle.db.select().from(notifications).where(eq(notifications.orgId, orgId));
}

function fakeSenders() {
  const email: Array<{ to: string | string[]; msg: EmailMessage }> = [];
  const slack: SlackMessage[] = [];
  const senders: ChannelSenders = {
    email: async (_cfg, msg) => {
      email.push({ to: msg.to, msg });
    },
    slack: async (_url, msg) => {
      slack.push(msg);
    },
  };
  return { senders, email, slack };
}

// ---------------------------------------------------------------------------

describe.skipIf(!reachable)('dispatch', () => {
  it('without rules uses the built-in default: in-app to users with project access, high+ only', async () => {
    const s = await seedOrg();
    const res = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      event: event({ projectId: s.p1.id }),
    });
    expect(res).toMatchObject({ ruleId: null, inserted: 2, duplicates: 0 });
    const rows = await rowsFor(s.org.id);
    expect(rows.map((r) => r.userId).sort()).toEqual([s.admin.id, s.member.id].sort());
    expect(rows.every((r) => r.channelKind === 'in_app' && r.status === 'sent' && r.sentAt)).toBe(
      true,
    );

    const low = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      event: event({ projectId: s.p1.id, severity: 'medium' }),
    });
    expect(low.skipped).toBe('below_min_severity');

    // Org-level event (no project) → admins only.
    const org = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      event: event({ kind: 'webhook_failure', projectId: null }),
    });
    expect(org.inserted).toBe(1);
  });

  it('dedups by dedup key per channel kind and recipient (ON CONFLICT DO NOTHING)', async () => {
    const s = await seedOrg();
    await handle.db.insert(notificationRules).values({
      orgId: s.org.id,
      minSeverity: 'low',
      channelIds: [s.ch.inApp.id, s.ch.email.id, s.ch.slack.id],
    });
    const e = event({ projectId: s.p1.id, dedupKey: 'high_risk:pr1:sha1' });
    const first = await dispatch({ db: handle.db, orgId: s.org.id, event: e });
    // in-app ×2 users, email ×2 users, slack ×1 channel
    expect(first).toMatchObject({ inserted: 5, duplicates: 0 });
    const again = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      event: { ...e, title: 'changed title' },
    });
    expect(again).toMatchObject({ inserted: 0, duplicates: 5 });
    // Concurrent duplicates also collapse to one set of rows.
    const e2 = event({ projectId: s.p1.id, dedupKey: 'race' });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => dispatch({ db: handle.db, orgId: s.org.id, event: e2 })),
    );
    expect(results.reduce((a, r) => a + r.inserted, 0)).toBe(5);
    const rows = await rowsFor(s.org.id);
    expect(rows).toHaveLength(10);
    const slackRow = rows.find(
      (r) => r.channelKind === 'slack' && r.dedupKey.startsWith('high_risk:pr1:sha1'),
    );
    expect(slackRow?.dedupKey).toBe(slackDedupKey('high_risk:pr1:sha1', s.ch.slack.id));
    expect(slackRow?.userId).toBeNull();
    expect(
      rows.find((r) => r.channelKind === 'email' && r.dedupKey === 'high_risk:pr1:sha1')?.title,
    ).toBe('PR #1 is high risk');
  });

  it('project rule overrides the org default rule', async () => {
    const s = await seedOrg();
    const [orgRule] = await handle.db
      .insert(notificationRules)
      .values({ orgId: s.org.id, minSeverity: 'low', channelIds: [s.ch.email.id, s.ch.slack.id] })
      .returning();
    const [projRule] = await handle.db
      .insert(notificationRules)
      .values({
        orgId: s.org.id,
        projectId: s.p1.id,
        minSeverity: 'critical',
        channelIds: [s.ch.inApp.id],
      })
      .returning();

    expect((await resolveRule(handle.db, s.org.id, s.p1.id))?.id).toBe(projRule!.id);
    expect((await resolveRule(handle.db, s.org.id, s.p2.id))?.id).toBe(orgRule!.id);
    expect((await resolveRule(handle.db, s.org.id, null))?.id).toBe(orgRule!.id);

    // P1 medium → project rule requires critical.
    const r1 = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      event: event({ projectId: s.p1.id, severity: 'medium' }),
    });
    expect(r1).toMatchObject({ ruleId: projRule!.id, skipped: 'below_min_severity', inserted: 0 });
    // P1 critical → in-app only (project rule channels).
    const r2 = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      event: event({ projectId: s.p1.id, severity: 'critical' }),
    });
    expect(r2).toMatchObject({ ruleId: projRule!.id, inserted: 2 });
    // P2 medium → org rule: email to admin only (no P2 members) + one slack row, no in-app.
    const r3 = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      event: event({ projectId: s.p2.id, severity: 'medium' }),
    });
    expect(r3).toMatchObject({ ruleId: orgRule!.id, inserted: 2 });
    const p2rows = (await rowsFor(s.org.id)).filter((r) => r.projectId === s.p2.id);
    expect(p2rows.map((r) => r.channelKind).sort()).toEqual(['email', 'slack']);
    expect(p2rows.find((r) => r.channelKind === 'email')?.userId).toBe(s.admin.id);
    expect(p2rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('filters by subscribed events, digest flag, disabled channels and foreign projects', async () => {
    const s = await seedOrg();
    const other = await seedOrg();
    await handle.db.insert(notificationRules).values({
      orgId: s.org.id,
      minSeverity: 'info',
      events: ['security_finding'],
      digestEnabled: false,
      channelIds: [s.ch.slack.id],
    });
    expect(
      (await dispatch({ db: handle.db, orgId: s.org.id, event: event({ projectId: s.p1.id }) }))
        .skipped,
    ).toBe('event_not_subscribed');
    expect(
      (
        await dispatch({
          db: handle.db,
          orgId: s.org.id,
          event: event({ kind: 'digest', severity: 'info', projectId: s.p1.id }),
        })
      ).skipped,
    ).toBe('digest_disabled');
    expect(
      (await dispatch({ db: handle.db, orgId: s.org.id, event: event({ projectId: other.p1.id }) }))
        .skipped,
    ).toBe('project_not_found');
    await expect(
      dispatch({ db: handle.db, orgId: s.org.id, event: event({ kind: 'nope' as never }) }),
    ).rejects.toThrow(/invalid event/);

    // Slack channel disabled → falls back to in-app so the event is never silently dropped.
    await handle.db
      .update(notificationChannels)
      .set({ enabled: false })
      .where(eq(notificationChannels.id, s.ch.slack.id));
    const r = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      event: event({ kind: 'security_finding', severity: 'low', projectId: s.p1.id }),
    });
    expect(r.inserted).toBe(2);
    expect((await rowsFor(s.org.id)).every((x) => x.channelKind === 'in_app')).toBe(true);
  });

  it('redacts secrets and drops unsafe URLs before storing', async () => {
    const s = await seedOrg();
    const token = ['ghp', 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'].join('_');
    await dispatch({
      db: handle.db,
      orgId: s.org.id,
      event: event({
        projectId: null,
        kind: 'budget_alert',
        body: `leaked ${token}`,
        url: 'javascript:alert(1)',
      }),
    });
    const [row] = await rowsFor(s.org.id);
    expect(row!.body).not.toContain(token);
    expect(row!.url).toBeNull();
  });

  it('marks in-app notifications read only for their owner', async () => {
    const s = await seedOrg();
    await dispatch({ db: handle.db, orgId: s.org.id, event: event({ projectId: s.p1.id }) });
    const mine = (await rowsFor(s.org.id)).find((r) => r.userId === s.member.id)!;
    expect(await markNotificationRead(handle.db, s.org.id, s.admin.id, mine.id)).toBe(false);
    expect(await markNotificationRead(handle.db, s.org.id, s.member.id, mine.id)).toBe(true);
    expect(await markNotificationRead(handle.db, s.org.id, s.member.id, mine.id)).toBe(false);
  });
});

describe.skipIf(!reachable)('quiet hours', () => {
  it('defers non-critical external deliveries to the end of quiet hours in the rule timezone', async () => {
    const s = await seedOrg();
    await handle.db.insert(notificationRules).values({
      orgId: s.org.id,
      minSeverity: 'low',
      channelIds: [s.ch.inApp.id, s.ch.email.id, s.ch.slack.id],
      timezone: 'Asia/Kolkata',
      quietStart: '22:00',
      quietEnd: '07:00',
    });
    const now = new Date('2026-11-14T18:00:00Z'); // 23:30 IST
    const end = new Date('2026-11-15T01:30:00Z'); // 07:00 IST next day

    const res = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      now,
      event: event({ projectId: s.p1.id, severity: 'high', dedupKey: 'quiet-high' }),
    });
    expect(res.deferredUntil?.toISOString()).toBe(end.toISOString());
    const rows = (await rowsFor(s.org.id)).filter((r) => r.dedupKey.startsWith('quiet-high'));
    const external = rows.filter((r) => r.channelKind !== 'in_app');
    expect(external).toHaveLength(3);
    expect(
      external.every(
        (r) => r.status === 'deferred' && r.sendAfter?.toISOString() === end.toISOString(),
      ),
    ).toBe(true);
    // In-app is visible immediately.
    expect(rows.filter((r) => r.channelKind === 'in_app').every((r) => r.status === 'sent')).toBe(
      true,
    );

    // Critical bypasses quiet hours.
    const crit = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      now,
      event: event({ projectId: s.p1.id, severity: 'critical', dedupKey: 'quiet-crit' }),
    });
    expect(crit.deferredUntil).toBeNull();
    const critRows = (await rowsFor(s.org.id)).filter(
      (r) => r.dedupKey.startsWith('quiet-crit') && r.channelKind !== 'in_app',
    );
    expect(
      critRows.every((r) => r.status === 'pending' && r.sendAfter?.getTime() === now.getTime()),
    ).toBe(true);

    // flushPending: only critical is due now; deferred rows go out after quiet hours end.
    const f = fakeSenders();
    expect(
      await flushPending({
        db: handle.db,
        orgId: s.org.id,
        now,
        senders: f.senders,
        publicUrl: 'https://gmp.example.test',
      }),
    ).toBe(3);
    expect(f.email.map((e) => e.to).sort()).toEqual([s.admin.email, s.member.email].sort());
    expect(f.email[0]!.msg.text).toContain('https://gmp.example.test/pull-requests/x');
    expect(
      await flushPending({
        db: handle.db,
        orgId: s.org.id,
        now: new Date(end.getTime() - 1000),
        senders: f.senders,
      }),
    ).toBe(0);
    expect(
      await flushPending({ db: handle.db, orgId: s.org.id, now: end, senders: f.senders }),
    ).toBe(3);
    expect(f.slack).toHaveLength(2);
    const after = (await rowsFor(s.org.id)).filter((r) => r.channelKind !== 'in_app');
    expect(after.every((r) => r.status === 'sent' && r.sentAt)).toBe(true);
  });
});

describe.skipIf(!reachable)('flushPending', () => {
  async function setup() {
    const s = await seedOrg();
    await handle.db.insert(notificationRules).values({
      orgId: s.org.id,
      minSeverity: 'low',
      channelIds: [s.ch.slack.id],
    });
    return s;
  }

  it('retries with backoff, records attempts and fails after maxAttempts', async () => {
    const s = await setup();
    const t0 = new Date('2026-11-14T10:00:00Z');
    await dispatch({
      db: handle.db,
      orgId: s.org.id,
      now: t0,
      event: event({ projectId: s.p1.id }),
    });
    let calls = 0;
    const senders = {
      slack: async () => {
        calls++;
        throw new ChannelSendError('slack', 'Slack webhook responded 503', { status: 503 });
      },
    };
    expect(
      await flushPending({ db: handle.db, orgId: s.org.id, now: t0, senders, maxAttempts: 3 }),
    ).toBe(0);
    let [row] = await rowsFor(s.org.id);
    expect(row).toMatchObject({
      status: 'pending',
      error: 'attempt 1/3: Slack webhook responded 503',
    });
    expect(row!.sendAfter!.getTime()).toBe(t0.getTime() + 60_000);

    // Not due yet.
    await flushPending({
      db: handle.db,
      orgId: s.org.id,
      now: new Date(t0.getTime() + 30_000),
      senders,
      maxAttempts: 3,
    });
    expect(calls).toBe(1);

    const t1 = new Date(t0.getTime() + 60_000);
    await flushPending({ db: handle.db, orgId: s.org.id, now: t1, senders, maxAttempts: 3 });
    [row] = await rowsFor(s.org.id);
    expect(row!.error).toMatch(/^attempt 2\/3/);
    expect(row!.sendAfter!.getTime()).toBe(t1.getTime() + 5 * 60_000);

    await flushPending({
      db: handle.db,
      orgId: s.org.id,
      now: new Date(t1.getTime() + 5 * 60_000),
      senders,
      maxAttempts: 3,
    });
    [row] = await rowsFor(s.org.id);
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.error).toMatch(/^attempt 3\/3/);
    expect(calls).toBe(3);
    // Failed rows are never retried.
    await flushPending({
      db: handle.db,
      orgId: s.org.id,
      now: new Date(t1.getTime() + 3_600_000),
      senders,
      maxAttempts: 3,
    });
    expect(calls).toBe(3);
  });

  it('marks permanent errors and removed/disabled channels as failed immediately', async () => {
    const s = await setup();
    const now = new Date('2026-11-14T10:00:00Z');
    await dispatch({
      db: handle.db,
      orgId: s.org.id,
      now,
      event: event({ projectId: s.p1.id, dedupKey: 'perm' }),
    });
    const senders = {
      slack: async () => {
        throw new ChannelSendError('slack', 'Slack webhook responded 404: no_service', {
          status: 404,
          retryable: false,
        });
      },
    };
    await flushPending({ db: handle.db, orgId: s.org.id, now, senders });
    let [row] = await rowsFor(s.org.id);
    expect(row).toMatchObject({
      status: 'failed',
      error: 'attempt 1/5 (permanent): Slack webhook responded 404: no_service',
    });

    await dispatch({
      db: handle.db,
      orgId: s.org.id,
      now,
      event: event({ projectId: s.p1.id, dedupKey: 'disabled' }),
    });
    await handle.db
      .update(notificationChannels)
      .set({ enabled: false })
      .where(eq(notificationChannels.id, s.ch.slack.id));
    const f = fakeSenders();
    expect(await flushPending({ db: handle.db, orgId: s.org.id, now, senders: f.senders })).toBe(0);
    [row] = (await rowsFor(s.org.id)).filter((r) => r.dedupKey.startsWith('disabled'));
    expect(row!.status).toBe('failed');
    expect(row!.error).toContain('channel was removed, disabled or changed kind');
    expect(f.slack).toHaveLength(0);
  });

  it('never double-sends under concurrent flushes and only touches its own org', async () => {
    const s = await setup();
    const other = await setup();
    const now = new Date('2026-11-14T10:00:00Z');
    for (let i = 0; i < 12; i++) {
      await dispatch({
        db: handle.db,
        orgId: s.org.id,
        now,
        event: event({ projectId: s.p1.id, dedupKey: `c${i}` }),
      });
    }
    await dispatch({
      db: handle.db,
      orgId: other.org.id,
      now,
      event: event({ projectId: other.p1.id, dedupKey: 'x' }),
    });
    const titles: string[] = [];
    const senders = {
      slack: async (_u: string, m: SlackMessage) => {
        await new Promise((r) => setTimeout(r, 5));
        titles.push(m.title ?? '');
      },
    };
    const counts = await Promise.all(
      [1, 2, 3].map(() => flushPending({ db: handle.db, orgId: s.org.id, now, senders, limit: 5 })),
    );
    let total = counts.reduce((a, b) => a + b, 0);
    while (total < 12) {
      const n = await flushPending({
        db: handle.db,
        orgId: s.org.id,
        now: new Date(now.getTime() + 11 * 60_000),
        senders,
      });
      if (n === 0) break;
      total += n;
    }
    expect(total).toBe(12);
    expect(titles).toHaveLength(12);
    const [otherRow] = await rowsFor(other.org.id);
    expect(otherRow!.status).toBe('pending');
  });
});

describe.skipIf(!reachable)('buildDigest', () => {
  it('collects per-project activity for the window', async () => {
    const s = await seedOrg('Europe/Berlin');
    const since = new Date('2026-11-13T08:00:00Z');
    const until = new Date('2026-11-14T08:00:00Z');
    const inside = new Date('2026-11-13T12:00:00Z');
    const before = new Date('2026-11-10T12:00:00Z');

    const newPr = await seedPr(s, s.r1.id, { title: 'New <b>feature</b>', openedAt: inside });
    const merged = await seedPr(s, s.r1.id, {
      state: 'merged',
      openedAt: before,
      mergedAt: inside,
    });
    const risky = await seedPr(s, s.r1.id, { openedAt: before, reviewDecision: 'REVIEW_REQUIRED' });
    const draft = await seedPr(s, s.r1.id, {
      openedAt: before,
      draft: true,
      reviewDecision: 'REVIEW_REQUIRED',
    });
    const approved = await seedPr(s, s.r1.id, { openedAt: before, reviewDecision: 'APPROVED' });
    const requested = await seedPr(s, s.r1.id, { openedAt: before, requestedReviewers: ['rev'] });
    const otherProjectPr = await seedPr(s, s.r2.id, { openedAt: before });
    const oldMerged = await seedPr(s, s.r1.id, {
      state: 'merged',
      openedAt: before,
      mergedAt: before,
    });

    // Latest completed analysis decides risk: risky = high now (older analysis was low).
    const [oldA] = await handle.db
      .insert(analyses)
      .values({
        orgId: s.org.id,
        pullRequestId: risky.id,
        headSha: 'a1',
        status: 'completed',
        overallRisk: 'low',
        completedAt: before,
      })
      .returning();
    const [newA] = await handle.db
      .insert(analyses)
      .values({
        orgId: s.org.id,
        pullRequestId: risky.id,
        headSha: 'a2',
        status: 'completed',
        overallRisk: 'high',
        recommendation: 'merge_after_checks',
        completedAt: inside,
      })
      .returning();
    // A newer failed analysis must not override.
    await handle.db.insert(analyses).values({
      orgId: s.org.id,
      pullRequestId: risky.id,
      headSha: 'a3',
      status: 'failed',
      overallRisk: 'low',
    });
    // approved PR was high-risk earlier but its latest completed analysis is low.
    await handle.db.insert(analyses).values([
      {
        orgId: s.org.id,
        pullRequestId: approved.id,
        headSha: 'b1',
        status: 'completed',
        overallRisk: 'critical',
        completedAt: before,
      },
      {
        orgId: s.org.id,
        pullRequestId: approved.id,
        headSha: 'b2',
        status: 'completed',
        overallRisk: 'low',
        completedAt: inside,
      },
    ]);

    const finding = (fp: string, over: Record<string, unknown> = {}) => ({
      orgId: s.org.id,
      analysisId: newA!.id,
      pullRequestId: risky.id,
      fingerprint: fp,
      category: 'security' as const,
      severity: 'high' as const,
      title: `Finding ${fp}`,
      data: {} as never,
      lifecycle: 'new' as const,
      verified: true,
      createdAt: inside,
      ...over,
    });
    await handle.db.insert(findings).values([
      finding('f-new'),
      finding('f-low', { severity: 'low' }),
      finding('f-unchanged', { lifecycle: 'unchanged' }),
      finding('f-old', { createdAt: before }),
      finding('f-breaking', { category: 'breaking_change' }),
      // Same fingerprint recorded as new in an older analysis too → deduped.
      { ...finding('f-new'), analysisId: oldA!.id },
    ]);

    const [a, b] = [risky.id, otherProjectPr.id].sort();
    const [c, d] = [newPr.id, requested.id].sort();
    await handle.db.insert(prRelationships).values([
      {
        orgId: s.org.id,
        prAId: a!,
        prBId: b!,
        type: 'contract_change',
        confidence: 'confirmed',
        summary: 'API change used by web',
        createdAt: inside,
      },
      {
        orgId: s.org.id,
        prAId: c!,
        prBId: d!,
        type: 'duplicate_work',
        confidence: 'possible',
        summary: 'maybe dup',
        createdAt: inside,
      },
    ]);

    const data = await buildDigest({
      db: handle.db,
      orgId: s.org.id,
      since,
      until,
      publicUrl: 'https://gmp.example.test/',
    });
    expect(data.timezone).toBe('Europe/Berlin');
    expect(data.projects.map((p) => p.projectName)).toEqual(['Payments', 'Web']);
    const pay = data.projects[0]!;
    expect(pay.newPrs.map((p) => p.id)).toEqual([newPr.id]);
    expect(pay.mergedPrs.map((p) => p.id)).toEqual([merged.id]);
    expect(pay.mergedPrs.map((p) => p.id)).not.toContain(oldMerged.id);
    expect(pay.highRiskPrs.map((p) => p.id)).toEqual([risky.id]);
    expect(pay.highRiskPrs[0]).toMatchObject({
      risk: 'high',
      recommendation: 'merge_after_checks',
      appUrl: `https://gmp.example.test/pull-requests/${risky.id}`,
    });
    expect(pay.securityFindings.map((f) => f.title)).toEqual(['Finding f-new']);
    expect(pay.overlaps).toHaveLength(1);
    expect(pay.overlaps[0]).toMatchObject({ type: 'contract_change', confidence: 'confirmed' });
    expect(pay.awaitingReview.map((p) => p.id).sort()).toEqual([risky.id, requested.id].sort());
    expect(pay.awaitingReview.map((p) => p.id)).not.toContain(draft.id);
    expect(pay.awaitingReview.map((p) => p.id)).not.toContain(approved.id);

    const web = data.projects[1]!;
    expect(web.overlaps).toHaveLength(1); // cross-project overlap shows in both projects
    expect(web.newPrs).toHaveLength(0);
    expect(data.totals).toMatchObject({
      newPrs: 1,
      mergedPrs: 1,
      highRiskPrs: 1,
      securityFindings: 1,
      overlaps: 2,
      awaitingReview: 2,
    });

    // Single project + paused filtering + truncation.
    await handle.db.update(projects).set({ paused: true }).where(eq(projects.id, s.p2.id));
    const onlyActive = await buildDigest({
      db: handle.db,
      orgId: s.org.id,
      since,
      until,
      maxItemsPerSection: 1,
    });
    expect(onlyActive.projects.map((p) => p.projectName)).toEqual(['Payments']);
    expect(onlyActive.projects[0]!.awaitingReview).toHaveLength(1);
    expect(onlyActive.projects[0]!.counts.awaitingReview).toBe(2);
    const explicit = await buildDigest({
      db: handle.db,
      orgId: s.org.id,
      projectId: s.p2.id,
      since,
      until,
    });
    expect(explicit.projects.map((p) => p.projectName)).toEqual(['Web']);

    // Org isolation: another org sees nothing of this one.
    const other = await seedOrg();
    const empty = await buildDigest({ db: handle.db, orgId: other.org.id, since, until });
    expect(empty.totals).toMatchObject({ newPrs: 0, overlaps: 0 });

    // Rendering escapes PR titles from the DB.
    const html = renderDigest(data, 'email_html');
    expect(html).toContain('New &lt;b&gt;feature&lt;/b&gt;');
    expect(html).not.toContain('<b>feature');

    await expect(
      buildDigest({ db: handle.db, orgId: s.org.id, since: until, until: since }),
    ).rejects.toThrow(RangeError);
  });

  it('digest dispatch works end-to-end with the digest flag', async () => {
    const s = await seedOrg();
    await handle.db
      .insert(notificationRules)
      .values({ orgId: s.org.id, minSeverity: 'critical', channelIds: [s.ch.slack.id] });
    const now = new Date('2026-11-14T09:00:00Z');
    const data = await buildDigest({
      db: handle.db,
      orgId: s.org.id,
      since: new Date(now.getTime() - 86_400_000),
      until: now,
    });
    const res = await dispatch({
      db: handle.db,
      orgId: s.org.id,
      now,
      event: {
        kind: 'digest',
        severity: 'info',
        projectId: null,
        title: 'Daily digest',
        body: renderDigest(data, 'text'),
        dedupKey: 'digest:2026-11-14',
      },
    });
    // Digest bypasses minSeverity.
    expect(res.inserted).toBe(1);
    const f = fakeSenders();
    expect(await flushPending({ db: handle.db, orgId: s.org.id, now, senders: f.senders })).toBe(1);
    expect(f.slack[0]!.text).toContain('git-merge-pilot daily digest');
    const rows = await handle.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.orgId, s.org.id), eq(notifications.status, 'sent')));
    expect(rows).toHaveLength(1);
  });
});
