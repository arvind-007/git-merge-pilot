import type { Project, Repository } from '@gmp/db';
import { describe, expect, it } from 'vitest';
import { githubAlertFindings, selectContentFiles } from './analyze/inputs.ts';
import { analysisEvents } from './analyze/notify.ts';
import { slimFacts } from './analyze/relationships.ts';
import { SnapshotCache } from './deps.ts';
import { createBossJobQueue, PAYLOAD_SCHEMAS, RecordingJobQueue, singletonKeys } from './queues.ts';
import {
  effectiveProjectSettings,
  mergeProfile,
  monitorSkipReason,
  type RepoState,
} from './repo-state.ts';
import { fileSnapshot, makePatch } from './test-support/fake-github.ts';
import { countApprovals, mapLimit } from './util.ts';

const PR_ID = '6f1c2f43-8a39-4a8e-9a54-0d6f5f3f0a11';

describe('queues', () => {
  it('RecordingJobQueue drops duplicate singleton keys like a stately queue', async () => {
    const q = new RecordingJobQueue();
    const key = singletonKeys.prAnalyze(PR_ID, 'abc');
    expect(
      await q.send('pr.analyze', { pullRequestId: PR_ID }, { singletonKey: key }),
    ).toBeTruthy();
    expect(await q.send('pr.analyze', { pullRequestId: PR_ID }, { singletonKey: key })).toBeNull();
    expect(await q.send('pr.readiness', { pullRequestId: PR_ID })).toBeTruthy();
    expect(q.take('pr.analyze')).toHaveLength(1);
    expect(q.jobs.map((j) => j.queue)).toEqual(['pr.readiness']);
  });

  it('createBossJobQueue maps debounce to sendDebounced and keeps singleton keys', async () => {
    const calls: unknown[][] = [];
    const boss = {
      send: async (...args: unknown[]) => {
        calls.push(['send', ...args]);
        return 'id-1';
      },
      sendDebounced: async (...args: unknown[]) => {
        calls.push(['sendDebounced', ...args]);
        return 'id-2';
      },
    };
    const q = createBossJobQueue(boss as never);
    await q.send('pr.sync', { pullRequestId: PR_ID }, { singletonKey: 'k' });
    await q.send(
      'repo.discover',
      { repositoryId: PR_ID },
      { singletonKey: 'repo:x', debounceSeconds: 600 },
    );
    expect(calls[0]).toEqual(['send', 'pr.sync', { pullRequestId: PR_ID }, { singletonKey: 'k' }]);
    expect(calls[1]).toEqual([
      'sendDebounced',
      'repo.discover',
      { repositoryId: PR_ID },
      { singletonKey: 'repo:x' },
      600,
      'repo:x',
    ]);
  });

  it('payload schemas validate both pr.sync shapes and reject bad ids', () => {
    expect(PAYLOAD_SCHEMAS['pr.sync'].safeParse({ pullRequestId: PR_ID }).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['pr.sync'].safeParse({ repositoryId: PR_ID, number: 4 }).success).toBe(
      true,
    );
    expect(PAYLOAD_SCHEMAS['pr.sync'].safeParse({ repositoryId: PR_ID }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['pr.analyze'].safeParse({ pullRequestId: 'x' }).success).toBe(false);
  });
});

function state(projects: Array<Partial<Project>>, repo: Partial<Repository> = {}): RepoState {
  const full = projects.map(
    (p, i) => ({ id: `p${i}`, paused: false, settings: {}, ...p }) as Project,
  );
  return {
    repo: { monitoringEnabled: true, archived: false, ...repo } as Repository,
    profile: null,
    projects: full,
    activeProjects: full.filter((p) => !p.paused),
  };
}

describe('repo state', () => {
  it('skips when monitoring is off, archived, or every project is paused', () => {
    expect(monitorSkipReason(state([]))).toBeNull();
    expect(monitorSkipReason(state([{ paused: true }, { paused: false }]))).toBeNull();
    expect(monitorSkipReason(state([{ paused: true }]))).toBe('projects_paused');
    expect(monitorSkipReason(state([], { monitoringEnabled: false }))).toBe('monitoring_disabled');
    expect(monitorSkipReason(state([], { archived: true }))).toBe('archived');
  });

  it('uses the strictest risk thresholds of active projects', () => {
    const s = state([
      { settings: { riskThresholds: { high: 70, medium: 40 } } },
      { settings: { riskThresholds: { high: 50 } } },
      { paused: true, settings: { riskThresholds: { high: 10 } } },
    ]);
    expect(effectiveProjectSettings(s)).toEqual({ riskThresholds: { high: 50, medium: 40 } });
    expect(effectiveProjectSettings(state([]))).toBeNull();
  });

  it('profile overrides win over discovered values', () => {
    expect(
      mergeProfile({ frameworks: ['a'], packageManagers: ['npm'] }, { frameworks: ['b'] }),
    ).toEqual({ frameworks: ['b'], packageManagers: ['npm'] });
  });
});

describe('analysis inputs', () => {
  it('prioritises migrations and manifests, skips lock files and docs, respects the cap', () => {
    const f = (path: string, n = 1) => ({
      ...fileSnapshot({ path, before: 'a\n', after: 'b\n' }),
      additions: n,
    });
    const files = [
      f('src/big.ts', 50),
      f('src/small.ts', 1),
      f('db/migrations/001_init.sql'),
      f('package.json'),
      f('pnpm-lock.yaml', 900),
      f('README.md', 99),
    ];
    expect([...selectContentFiles(files, 3)]).toEqual([
      'db/migrations/001_init.sql',
      'package.json',
      'src/big.ts',
    ]);
    expect(selectContentFiles(files, 10).has('pnpm-lock.yaml')).toBe(false);
    expect(selectContentFiles(files, 10).has('README.md')).toBe(false);
  });

  it('slimFacts drops per-file hunks', () => {
    const facts = { files: [{ path: 'a' }], stats: { files: 1, additions: 1, deletions: 0 } };
    expect(slimFacts(facts as never).files).toEqual([]);
  });
});

describe('test support and utils', () => {
  it('makePatch produces a parseable single-hunk diff', () => {
    expect(makePatch('a\nb\nc\n', 'a\nB\nc\n')).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
    expect(makePatch('', 'x\n')).toBe('@@ -0,0 +1,1 @@\n+x');
  });

  it('mapLimit preserves order with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 6, 4]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('SnapshotCache expires entries after the TTL', () => {
    const c = new SnapshotCache(2);
    c.set('a', 1, 0);
    expect(c.get('a', 100, 50)).toBe(1);
    expect(c.get('a', 100, 200)).toBeUndefined();
    c.set('x', 1, 0);
    c.set('y', 2, 0);
    c.set('z', 3, 0);
    expect(c.get('x', 100, 1)).toBeUndefined();
  });
});

describe('githubAlertFindings', () => {
  const alert = (over: Record<string, unknown>) => ({
    number: 1,
    state: 'open',
    severity: 'critical',
    ruleId: 'js/sql-injection',
    title: 'SQL injection',
    path: 'src/db.ts',
    startLine: 2,
    url: null,
    tool: 'CodeQL',
    ...over,
  });
  const snap = (codeScanning: unknown[], dependabot: unknown[] = []) =>
    ({
      files: [
        fileSnapshot({ path: 'src/db.ts', before: 'a\nb\nc\n', after: 'a\nB\nc\n' }),
        fileSnapshot({ path: 'package.json', before: '{}\n', after: '{ }\n' }),
      ],
      codeScanningAlerts: { available: true, reason: null, alerts: codeScanning, truncated: false },
      dependabotAlerts: { available: true, reason: null, alerts: dependabot, truncated: false },
    }) as unknown as Parameters<typeof githubAlertFindings>[1];

  it('attributes only alerts on lines the PR adds; others are unverified context (≤ medium)', () => {
    const onAdded = githubAlertFindings('acme/api', snap([alert({ startLine: 2 })]));
    expect(onAdded[0]).toMatchObject({ verified: true, severity: 'critical' });
    const elsewhere = githubAlertFindings('acme/api', snap([alert({ startLine: 3 })]));
    expect(elsewhere[0]).toMatchObject({ verified: false, severity: 'medium' });
  });

  it('never treats a Dependabot alert (default branch) as a verified PR risk', () => {
    const out = githubAlertFindings(
      'acme/api',
      snap(
        [],
        [
          alert({
            path: null,
            startLine: null,
            manifestPath: 'package.json',
            packageName: 'lodash',
          }),
        ],
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ verified: false, severity: 'medium' });
    expect(out[0]!.title).toContain('lodash');
  });
});

describe('countApprovals', () => {
  it('counts reviewers whose latest decisive review approves', () => {
    expect(
      countApprovals([
        { reviewerLogin: 'a', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' },
        { reviewerLogin: 'a', state: 'COMMENTED', submittedAt: '2026-01-02T00:00:00Z' },
        { reviewerLogin: 'b', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' },
        { reviewerLogin: 'b', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-03T00:00:00Z' },
        { reviewerLogin: null, state: 'APPROVED', submittedAt: null },
      ]),
    ).toBe(1);
    expect(countApprovals([])).toBe(0);
  });
});

describe('analysisEvents overlap redaction', () => {
  it('carries a redacted variant when the other PR is in another repository', () => {
    const state = { repo: { id: 'repo-a', fullName: 'acme/a' }, activeProjects: [], projects: [] };
    const pr = { id: 'pr-a', number: 3, title: 'T', headSha: 'f'.repeat(40) };
    const report = {
      overallRisk: 'low',
      executiveSummary: 's',
      mergeReadiness: { recommendation: 'ready_to_merge', blockers: [], rationale: '' },
    };
    const rel = {
      prAId: 'pr-a',
      prBId: 'pr-b',
      sourcePrId: 'pr-a',
      type: 'contract_change',
      confidence: 'likely',
      summary: 'acme/secret#9 edits src/internal/payments/client.ts',
      evidence: [],
      needsAiConfirmation: false,
    };
    const events = analysisEvents(
      {
        state,
        pr,
        report,
        previousRisk: 'low',
        isFirst: false,
        newFindings: [],
        appearedRelationships: [rel],
        refOf: (id: string) => (id === 'pr-b' ? 'acme/secret#9' : id),
        repositoryOf: (id: string) => (id === 'pr-b' ? 'repo-b' : 'repo-a'),
      } as unknown as Parameters<typeof analysisEvents>[0],
      'http://gmp.test',
    );
    const overlap = events.find((e) => e.kind === 'overlap_detected')!;
    expect(overlap.otherRepositoryId).toBe('repo-b');
    expect(`${overlap.redacted!.title} ${overlap.redacted!.body}`).not.toContain('secret');
    expect(overlap.title).toContain('acme/secret#9');
  });
});
