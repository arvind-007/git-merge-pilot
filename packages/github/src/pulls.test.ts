import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createOctokit } from './client.ts';
import {
  compareCommits,
  fetchPullRequestSnapshot,
  getFileContent,
  listOpenPullRequests,
  mergeLinkedIssues,
} from './pulls.ts';
import { isNotFoundError } from './util.ts';

const API = 'https://api.github.com';
const HEAD = '1111111111111111111111111111111111111111';
const BASE = '0000000000000000000000000000000000000000';

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

function octokit() {
  return createOctokit({ auth: 'test-token', throttle: false, retries: 0 });
}

const prPayload = {
  id: 880017,
  number: 17,
  state: 'open',
  title: 'Add pagination',
  body: 'Fixes #12. Also resolves other-org/lib#5.',
  draft: false,
  user: { login: 'dev-alice' },
  assignees: [{ login: 'dev-bob' }],
  requested_reviewers: [{ login: 'dev-carol' }],
  requested_teams: [{ slug: 'backend' }],
  labels: [{ name: 'api' }],
  head: { ref: 'feature/pagination', sha: HEAD, repo: { full_name: 'contrib/widgets' } },
  base: { ref: 'main', sha: BASE, repo: { full_name: 'acme-org/widgets' } },
  merged: false,
  mergeable: true,
  mergeable_state: 'blocked',
  merge_commit_sha: 'abc',
  additions: 120,
  deletions: 15,
  changed_files: 3,
  commits: 2,
  comments: 4,
  review_comments: 6,
  html_url: 'https://github.com/acme-org/widgets/pull/17',
  created_at: '2026-11-13T08:00:00Z',
  updated_at: '2026-11-14T09:30:00Z',
  closed_at: null,
  merged_at: null,
};

function mockSnapshotCore(scope: nock.Scope, opts: { graphql?: 'ok' | 'error' } = {}) {
  const prBase = '/repos/acme-org/widgets';
  scope
    .get(`${prBase}/pulls/17`)
    .reply(200, prPayload)
    .get(`${prBase}/pulls/17/files`)
    .query({ per_page: '100' })
    .reply(
      200,
      [
        {
          filename: 'src/api.ts',
          status: 'modified',
          additions: 100,
          deletions: 10,
          changes: 110,
          patch: '@@ -1 +1 @@\n-a\n+b',
          sha: 'blob1',
          blob_url: 'https://github.com/b1',
        },
        {
          filename: 'src/new-name.ts',
          previous_filename: 'src/old-name.ts',
          status: 'renamed',
          additions: 0,
          deletions: 0,
          changes: 0,
          sha: 'blob2',
        },
      ],
      { link: `<${API}${prBase}/pulls/17/files?per_page=100&page=2>; rel="next"` },
    )
    .get(`${prBase}/pulls/17/files`)
    .query({ per_page: '100', page: '2' })
    .reply(200, [
      {
        filename: 'img/logo.png',
        status: 'removed',
        additions: 0,
        deletions: 0,
        changes: 0,
        sha: 'blob3',
      },
    ])
    .get(`${prBase}/pulls/17/commits`)
    .query({ per_page: '100' })
    .reply(200, [
      {
        sha: 'c1',
        commit: {
          message: 'feat: x',
          author: { name: 'Alice', date: '2026-11-13T08:00:00Z' },
          committer: { date: '2026-11-13T08:01:00Z' },
        },
        author: { login: 'dev-alice' },
      },
      {
        sha: 'c2',
        commit: { message: 'fix: y', author: { name: 'Alice', date: '2026-11-13T09:00:00Z' } },
        author: null,
      },
    ])
    .get(`${prBase}/pulls/17/reviews`)
    .query({ per_page: '100' })
    .reply(200, [
      {
        id: 1,
        user: { login: 'dev-carol' },
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-11-14T10:00:00Z',
        body: 'please fix',
        commit_id: HEAD,
      },
    ])
    .get(`${prBase}/commits/${HEAD}/check-runs`)
    .query({ filter: 'latest', per_page: '100' })
    .reply(200, {
      total_count: 2,
      check_runs: [
        {
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://gh/run/1',
          started_at: '2026-11-14T09:00:00Z',
          completed_at: '2026-11-14T09:05:00Z',
          app: { slug: 'github-actions' },
        },
        {
          name: 'lint',
          status: 'in_progress',
          conclusion: null,
          details_url: 'https://ci/lint',
          app: { slug: 'github-actions' },
        },
      ],
    })
    .get(`${prBase}/commits/${HEAD}/statuses`)
    .query({ per_page: '100' })
    .reply(200, [
      {
        context: 'ci/legacy',
        state: 'failure',
        target_url: 'https://ci/2',
        created_at: '2026-11-14T09:10:00Z',
        updated_at: '2026-11-14T09:10:00Z',
      },
      {
        context: 'ci/legacy',
        state: 'pending',
        target_url: 'https://ci/1',
        created_at: '2026-11-14T09:00:00Z',
      },
      {
        context: 'deploy/preview',
        state: 'pending',
        target_url: null,
        created_at: '2026-11-14T09:00:00Z',
      },
    ]);

  if (opts.graphql === 'error') {
    scope.post('/graphql').reply(502, 'bad gateway');
  } else {
    scope
      .post('/graphql', (body: { query?: string; variables?: Record<string, unknown> }) => {
        return (
          !!body?.query?.includes('closingIssuesReferences') &&
          body.query.includes('reviewDecision') &&
          body.variables?.owner === 'acme-org' &&
          body.variables.repo === 'widgets' &&
          body.variables.number === 17
        );
      })
      .reply(200, {
        data: {
          repository: {
            pullRequest: {
              reviewDecision: 'CHANGES_REQUESTED',
              closingIssuesReferences: {
                nodes: [
                  {
                    number: 12,
                    title: 'Pagination missing',
                    url: 'https://github.com/acme-org/widgets/issues/12',
                    repository: { nameWithOwner: 'acme-org/widgets' },
                  },
                  {
                    number: 99,
                    title: 'Cross repo',
                    url: 'https://github.com/acme-org/platform/issues/99',
                    repository: { nameWithOwner: 'acme-org/platform' },
                  },
                ],
              },
            },
          },
        },
      });
  }
}

describe('fetchPullRequestSnapshot', () => {
  it('fetches and maps everything, degrading gracefully on 403/404 security endpoints', async () => {
    const scope = nock(API);
    mockSnapshotCore(scope);
    scope
      .get('/repos/acme-org/widgets/code-scanning/alerts')
      .query({ ref: 'refs/pull/17/merge', state: 'open', per_page: '100' })
      .reply(403, {
        message: 'Advanced Security must be enabled for this repository to use code scanning.',
      })
      .get('/repos/acme-org/widgets/dependabot/alerts')
      .query({ state: 'open', per_page: '100' })
      .reply(200, [
        {
          number: 3,
          state: 'open',
          html_url: 'https://github.com/acme-org/widgets/security/dependabot/3',
          created_at: '2026-11-01T00:00:00Z',
          dependency: {
            package: { ecosystem: 'npm', name: 'lodash' },
            manifest_path: 'package-lock.json',
          },
          security_advisory: {
            ghsa_id: 'GHSA-xxxx',
            cve_id: 'CVE-2026-1',
            summary: 'Prototype pollution',
            severity: 'high',
          },
          security_vulnerability: {
            severity: 'high',
            first_patched_version: { identifier: '4.17.21' },
          },
        },
      ]);

    const snap = await fetchPullRequestSnapshot(octokit(), 'acme-org', 'widgets', 17);

    expect(snap.pullRequest).toMatchObject({
      number: 17,
      state: 'open',
      authorLogin: 'dev-alice',
      requestedReviewers: ['dev-carol', 'team:backend'],
      headSha: HEAD,
      baseSha: BASE,
      isCrossRepository: true,
      headRepoFullName: 'contrib/widgets',
      mergeable: true,
      commentsCount: 4,
      reviewCommentsCount: 6,
    });
    expect(snap.files.map((f) => f.path)).toEqual([
      'src/api.ts',
      'src/new-name.ts',
      'img/logo.png',
    ]);
    expect(snap.files[0]?.patch).toContain('+b');
    expect(snap.files[1]).toMatchObject({
      previousPath: 'src/old-name.ts',
      status: 'renamed',
      patch: null,
    });
    expect(snap.files[2]).toMatchObject({ status: 'removed', sha: null });
    expect(snap.filesTruncated).toBe(false);
    expect(snap.commits).toEqual([
      {
        sha: 'c1',
        message: 'feat: x',
        authorLogin: 'dev-alice',
        authorName: 'Alice',
        committedAt: '2026-11-13T08:01:00.000Z',
      },
      {
        sha: 'c2',
        message: 'fix: y',
        authorLogin: null,
        authorName: 'Alice',
        committedAt: '2026-11-13T09:00:00.000Z',
      },
    ]);
    expect(snap.commitsTruncated).toBe(false);
    expect(snap.reviews).toEqual([
      {
        githubId: 1,
        reviewerLogin: 'dev-carol',
        state: 'CHANGES_REQUESTED',
        submittedAt: '2026-11-14T10:00:00.000Z',
        body: 'please fix',
        commitId: HEAD,
      },
    ]);
    expect(snap.reviewCommentsCount).toBe(6);
    expect(snap.checks).toEqual([
      {
        kind: 'check_run',
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        url: 'https://gh/run/1',
        startedAt: '2026-11-14T09:00:00.000Z',
        completedAt: '2026-11-14T09:05:00.000Z',
        appSlug: 'github-actions',
      },
      {
        kind: 'check_run',
        name: 'lint',
        status: 'in_progress',
        conclusion: null,
        url: 'https://ci/lint',
        startedAt: null,
        completedAt: null,
        appSlug: 'github-actions',
      },
      {
        kind: 'status',
        name: 'ci/legacy',
        status: 'completed',
        conclusion: 'failure',
        url: 'https://ci/2',
        startedAt: '2026-11-14T09:10:00.000Z',
        completedAt: '2026-11-14T09:10:00.000Z',
        appSlug: null,
      },
      {
        kind: 'status',
        name: 'deploy/preview',
        status: 'pending',
        conclusion: null,
        url: null,
        startedAt: '2026-11-14T09:00:00.000Z',
        completedAt: null,
        appSlug: null,
      },
    ]);
    expect(snap.reviewDecision).toBe('CHANGES_REQUESTED');
    expect(snap.mergeableState).toBe('blocked');
    expect(snap.linkedIssues).toEqual([
      {
        number: 12,
        title: 'Pagination missing',
        url: 'https://github.com/acme-org/widgets/issues/12',
        closing: true,
      },
      {
        number: 99,
        repo: 'acme-org/platform',
        title: 'Cross repo',
        url: 'https://github.com/acme-org/platform/issues/99',
        closing: true,
      },
      { number: 5, repo: 'other-org/lib', closing: true },
    ]);
    expect(snap.codeScanningAlerts).toMatchObject({ available: false, alerts: [] });
    expect(snap.codeScanningAlerts.reason).toMatch(/^HTTP 403/);
    expect(snap.dependabotAlerts.available).toBe(true);
    expect(snap.dependabotAlerts.alerts[0]).toMatchObject({
      number: 3,
      severity: 'high',
      packageName: 'lodash',
      ecosystem: 'npm',
      ghsaId: 'GHSA-xxxx',
      cveId: 'CVE-2026-1',
      fixedIn: '4.17.21',
      tool: 'dependabot',
    });
    expect(snap.limitations).toEqual([]);
    scope.done();
  });

  it('maps code-scanning alerts and handles a 404 Dependabot endpoint plus GraphQL failure', async () => {
    const scope = nock(API);
    mockSnapshotCore(scope, { graphql: 'error' });
    scope
      .get('/repos/acme-org/widgets/code-scanning/alerts')
      .query(true)
      .reply(200, [
        {
          number: 8,
          state: 'open',
          html_url: 'https://github.com/acme-org/widgets/security/code-scanning/8',
          created_at: '2026-11-14T00:00:00Z',
          rule: {
            id: 'js/sql-injection',
            severity: 'error',
            security_severity_level: 'critical',
            description: 'Database query built from user-controlled sources',
          },
          tool: { name: 'CodeQL' },
          most_recent_instance: {
            location: { path: 'src/api.ts', start_line: 42 },
            message: { text: 'msg' },
          },
        },
      ])
      .get('/repos/acme-org/widgets/dependabot/alerts')
      .query(true)
      .reply(404, { message: 'Not Found' });

    const snap = await fetchPullRequestSnapshot(octokit(), 'acme-org', 'widgets', 17);
    expect(snap.codeScanningAlerts.alerts).toEqual([
      {
        number: 8,
        state: 'open',
        severity: 'critical',
        ruleId: 'js/sql-injection',
        title: 'Database query built from user-controlled sources',
        path: 'src/api.ts',
        startLine: 42,
        url: 'https://github.com/acme-org/widgets/security/code-scanning/8',
        tool: 'CodeQL',
        createdAt: '2026-11-14T00:00:00.000Z',
      },
    ]);
    expect(snap.dependabotAlerts).toMatchObject({
      available: false,
      reason: 'HTTP 404: Not Found',
    });
    expect(snap.reviewDecision).toBeNull();
    // Falls back to closing keywords parsed from the body.
    expect(snap.linkedIssues).toEqual([
      { number: 12, closing: true },
      { number: 5, repo: 'other-org/lib', closing: true },
    ]);
    expect(snap.limitations.some((l) => l.includes('GraphQL'))).toBe(true);
    scope.done();
  });

  it('respects maxFiles and opt-outs for security endpoints', async () => {
    const scope = nock(API);
    mockSnapshotCore(scope);
    const snap = await fetchPullRequestSnapshot(octokit(), 'acme-org', 'widgets', 17, {
      maxFiles: 2,
      includeCodeScanning: false,
      includeDependabot: false,
    });
    expect(snap.files).toHaveLength(2);
    expect(snap.filesTruncated).toBe(true);
    expect(snap.limitations[0]).toMatch(/Only 2 of 3 changed files/);
    expect(snap.codeScanningAlerts).toEqual({
      available: false,
      reason: 'not requested',
      alerts: [],
      truncated: false,
    });
    // The second files page is never requested.
    expect(scope.pendingMocks()).toEqual([expect.stringContaining('/pulls/17/files')]);
    nock.cleanAll();
  });

  it('throws when the PR itself cannot be read', async () => {
    nock(API).get('/repos/acme-org/widgets/pulls/404').reply(404, { message: 'Not Found' });
    const err = await fetchPullRequestSnapshot(octokit(), 'acme-org', 'widgets', 404).catch(
      (e: unknown) => e,
    );
    expect(isNotFoundError(err)).toBe(true);
  });

  it('degrades when check runs are forbidden', async () => {
    const scope = nock(API)
      .get('/repos/o/r/pulls/1')
      .reply(200, { ...prPayload, number: 1, body: null })
      .get('/repos/o/r/pulls/1/files')
      .query(true)
      .reply(200, [])
      .get('/repos/o/r/pulls/1/commits')
      .query(true)
      .reply(200, [])
      .get('/repos/o/r/pulls/1/reviews')
      .query(true)
      .reply(200, [])
      .get(`/repos/o/r/commits/${HEAD}/check-runs`)
      .query(true)
      .reply(403, { message: 'Resource not accessible by integration' })
      .get(`/repos/o/r/commits/${HEAD}/statuses`)
      .query(true)
      .reply(200, [])
      .post('/graphql')
      .reply(200, {
        data: {
          repository: {
            pullRequest: { reviewDecision: null, closingIssuesReferences: { nodes: [] } },
          },
        },
      });
    const snap = await fetchPullRequestSnapshot(octokit(), 'o', 'r', 1, {
      includeCodeScanning: false,
      includeDependabot: false,
    });
    expect(snap.checks).toEqual([]);
    expect(snap.commitsTruncated).toBe(true); // PR says 2 commits, API returned 0
    expect(snap.limitations.some((l) => l.startsWith('Check runs unavailable (HTTP 403'))).toBe(
      true,
    );
    scope.done();
  });
});

describe('mergeLinkedIssues', () => {
  it('dedupes same-repo refs case-insensitively, keeping the first (richer) entry', () => {
    expect(
      mergeLinkedIssues(
        'Acme/Widgets',
        [{ number: 1, title: 'T', closing: true }],
        [
          { number: 1, repo: 'acme/widgets', closing: true },
          { number: 2, closing: true },
        ],
      ),
    ).toEqual([
      { number: 1, title: 'T', closing: true },
      { number: 2, closing: true },
    ]);
  });
});

describe('compareCommits', () => {
  it('maps the compare response', async () => {
    const scope = nock(API)
      .get(`/repos/o/r/compare/${BASE}...${HEAD}`)
      .reply(200, {
        status: 'ahead',
        ahead_by: 2,
        behind_by: 0,
        total_commits: 2,
        html_url: 'https://github.com/o/r/compare/x...y',
        merge_base_commit: { sha: BASE },
        commits: [
          {
            sha: 'c1',
            commit: { message: 'm', author: { name: 'A', date: '2026-11-14T00:00:00Z' } },
            author: { login: 'a' },
          },
        ],
        files: [
          {
            filename: 'a.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: '@@',
          },
        ],
      });
    const res = await compareCommits(octokit(), 'o', 'r', BASE, HEAD);
    expect(res).toMatchObject({
      status: 'ahead',
      aheadBy: 2,
      behindBy: 0,
      totalCommits: 2,
      mergeBaseSha: BASE,
      filesTruncated: false,
    });
    expect(res.files[0]).toMatchObject({ path: 'a.ts', patch: '@@' });
    expect(res.commits[0]?.sha).toBe('c1');
    scope.done();
  });

  it('throws a 404 when a sha disappeared (force push)', async () => {
    nock(API)
      .get(/\/repos\/o\/r\/compare\/.*/)
      .reply(404, { message: 'No common ancestor' });
    const err = await compareCommits(octokit(), 'o', 'r', 'gone', HEAD).catch((e: unknown) => e);
    expect(isNotFoundError(err)).toBe(true);
  });
});

describe('getFileContent', () => {
  const contentPath = (uri: string) => decodeURIComponent(uri.split('?')[0] ?? '');

  it('returns raw text, requesting the raw media type at the ref', async () => {
    const scope = nock(API)
      .get((uri) => contentPath(uri) === '/repos/o/r/contents/src/dir name/a.ts')
      .query({ ref: 'main' })
      .matchHeader('accept', /application\/vnd\.github\.v3\.raw/)
      .reply(200, 'export const x = 1;\n', {
        'content-type': 'application/vnd.github.raw; charset=utf-8',
      });
    expect(await getFileContent(octokit(), 'o', 'r', 'src/dir name/a.ts', 'main')).toBe(
      'export const x = 1;\n',
    );
    scope.done();
  });

  it('decodes binary-typed responses and enforces maxBytes', async () => {
    nock(API)
      .get((uri) => contentPath(uri) === '/repos/o/r/contents/README.md')
      .query(true)
      .reply(200, Buffer.from('héllo'), { 'content-type': 'application/vnd.github.raw' });
    expect(await getFileContent(octokit(), 'o', 'r', '/README.md', 'sha1')).toBe('héllo');
    nock(API)
      .get((uri) => contentPath(uri) === '/repos/o/r/contents/big.txt')
      .query(true)
      .reply(200, 'x'.repeat(100), { 'content-type': 'text/plain' });
    expect(
      await getFileContent(octokit(), 'o', 'r', 'big.txt', 'sha1', { maxBytes: 10 }),
    ).toBeNull();
  });

  it('returns null for missing files and directories; rejects traversal', async () => {
    nock(API)
      .get((uri) => contentPath(uri) === '/repos/o/r/contents/missing.txt')
      .query(true)
      .reply(404, { message: 'Not Found' });
    expect(await getFileContent(octokit(), 'o', 'r', 'missing.txt', 'main')).toBeNull();
    nock(API)
      .get((uri) => contentPath(uri) === '/repos/o/r/contents/src')
      .query(true)
      .reply(200, [{ name: 'a.ts', type: 'file' }]);
    expect(await getFileContent(octokit(), 'o', 'r', 'src', 'main')).toBeNull();
    expect(await getFileContent(octokit(), 'o', 'r', '../secrets', 'main')).toBeNull();
  });

  it('rethrows non-404 errors', async () => {
    nock(API)
      .get(/contents/)
      .query(true)
      .reply(500, { message: 'boom' });
    await expect(getFileContent(octokit(), 'o', 'r', 'a', 'main')).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe('listOpenPullRequests', () => {
  it('paginates and summarises open PRs', async () => {
    const scope = nock(API)
      .get('/repos/o/r/pulls')
      .query({ state: 'open', sort: 'updated', direction: 'desc', per_page: '100' })
      .reply(200, [{ ...prPayload, number: 1 }], {
        link: `<${API}/repos/o/r/pulls?state=open&sort=updated&direction=desc&per_page=100&page=2>; rel="next"`,
      })
      .get('/repos/o/r/pulls')
      .query({ state: 'open', sort: 'updated', direction: 'desc', per_page: '100', page: '2' })
      .reply(200, [{ ...prPayload, number: 2, draft: true }]);
    const prs = await listOpenPullRequests(octokit(), 'o', 'r');
    expect(prs.map((p) => p.number)).toEqual([1, 2]);
    expect(prs[1]).toEqual({
      githubId: 880017,
      number: 2,
      title: 'Add pagination',
      state: 'open',
      draft: true,
      authorLogin: 'dev-alice',
      labels: ['api'],
      baseRef: 'main',
      headRef: 'feature/pagination',
      headSha: HEAD,
      baseSha: BASE,
      htmlUrl: 'https://github.com/acme-org/widgets/pull/17',
      openedAt: '2026-11-13T08:00:00.000Z',
      updatedAt: '2026-11-14T09:30:00.000Z',
    });
    scope.done();
  });
});
