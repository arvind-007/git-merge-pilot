import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createOctokit } from './client.ts';
import { discoverRepository, resolveCommitSha } from './discovery.ts';

const API = 'https://api.github.com';
const SHA = 'c0ffee0000000000000000000000000000000001';

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

function octokit() {
  return createOctokit({ auth: 'test-token', throttle: false, retries: 0 });
}

const tree = [
  { path: 'package.json', type: 'blob' },
  { path: 'pnpm-workspace.yaml', type: 'blob' },
  { path: 'pnpm-lock.yaml', type: 'blob' },
  { path: 'packages', type: 'tree' },
  { path: 'packages/api/package.json', type: 'blob' },
  { path: 'packages/api/src/index.ts', type: 'blob' },
  { path: '.github/workflows/codeql.yml', type: 'blob' },
  { path: '.github/dependabot.yml', type: 'blob' },
  { path: 'docs/CODEOWNERS', type: 'blob' },
  { path: 'docs/pull_request_template.md', type: 'blob' },
  { path: 'vendor-submodule', type: 'commit' },
];

const contents: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'root', devDependencies: { typescript: '^5' } }),
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'packages/api/package.json': JSON.stringify({
    name: '@acme/api',
    dependencies: { express: '^5' },
    devDependencies: { jest: '^29' },
  }),
  '.github/workflows/codeql.yml': 'steps:\n  - uses: github/codeql-action/analyze@v3\n',
  'docs/CODEOWNERS': '* @acme/owners\n',
};

function mockContents(scope: nock.Scope, ref: string, failPath?: string) {
  scope
    .get((uri) => uri.startsWith('/repos/acme-org/widgets/contents/'))
    .query({ ref })
    .times(Object.keys(contents).length)
    .reply((uri: unknown) => {
      // nock passes the path string (or a fetch Request for native fetch, depending on version).
      const raw = typeof uri === 'string' ? uri : new URL((uri as { url: string }).url).pathname;
      const path = decodeURIComponent(
        raw.split('?')[0]!.replace('/repos/acme-org/widgets/contents/', ''),
      );
      if (path === failPath) return [500, { message: 'boom' }];
      const body = contents[path];
      return body === undefined
        ? [404, { message: 'Not Found' }]
        : [200, body, { 'content-type': 'application/vnd.github.raw; charset=utf-8' }];
    });
}

describe('discoverRepository', () => {
  it('discovers the default branch profile via languages, sha, tree and contents APIs', async () => {
    const scope = nock(API)
      .get('/repos/acme-org/widgets')
      .reply(200, { id: 1, full_name: 'acme-org/widgets', default_branch: 'trunk' })
      .get('/repos/acme-org/widgets/languages')
      .reply(200, { TypeScript: 5000, Shell: 100 })
      .get('/repos/acme-org/widgets/commits/trunk')
      .matchHeader('accept', 'application/vnd.github.sha')
      .reply(200, SHA, { 'content-type': 'application/vnd.github.sha; charset=utf-8' })
      .get(`/repos/acme-org/widgets/git/trees/${SHA}`)
      .query({ recursive: 'true' })
      .reply(200, { sha: 'treesha', truncated: false, tree });
    mockContents(scope, SHA);

    const profile = await discoverRepository(octokit(), 'acme-org', 'widgets', undefined, {
      now: new Date('2026-11-14T00:00:00Z'),
    });

    expect(profile).toMatchObject({
      defaultBranch: 'trunk',
      ref: 'trunk',
      headSha: SHA,
      languages: { TypeScript: 5000, Shell: 100 },
      primaryLanguage: 'TypeScript',
      frameworks: ['express'],
      testFrameworks: ['jest'],
      packageManagers: ['pnpm'],
      ciSystems: ['github-actions'],
      ciWorkflows: ['.github/workflows/codeql.yml'],
      securityTools: ['codeql', 'dependabot'],
      codeowners: 'docs/CODEOWNERS',
      codeownersRules: [{ pattern: '*', owners: ['@acme/owners'] }],
      prTemplate: 'docs/pull_request_template.md',
      packages: [{ name: '@acme/api', path: 'packages/api', ecosystem: 'npm' }],
      monorepoTools: ['pnpm-workspace'],
      treeTruncated: false,
      limitations: [],
      discoveredAt: '2026-11-14T00:00:00.000Z',
    });
    expect(profile.manifests).toEqual(['package.json', 'packages/api/package.json']);
    scope.done();
  });

  it('uses an explicit sha without resolving it, notes truncation, unreadable files and missing languages', async () => {
    const scope = nock(API)
      .get('/repos/acme-org/widgets')
      .reply(200, { default_branch: 'main' })
      .get('/repos/acme-org/widgets/languages')
      .reply(403, { message: 'Resource not accessible by integration' })
      .get(`/repos/acme-org/widgets/git/trees/${SHA}`)
      .query({ recursive: 'true' })
      .reply(200, { truncated: true, tree });
    mockContents(scope, SHA, 'pnpm-workspace.yaml');

    const profile = await discoverRepository(octokit(), 'acme-org', 'widgets', SHA.toUpperCase());
    expect(profile.headSha).toBe(SHA);
    expect(profile.ref).toBe(SHA.toUpperCase());
    expect(profile.languages).toEqual({});
    expect(profile.treeTruncated).toBe(true);
    expect(profile.limitations).toEqual([
      'Languages unavailable (HTTP 403: Resource not accessible by integration)',
      '1 configuration file(s) could not be read',
      'Repository tree was truncated by GitHub; some files were not inspected',
    ]);
    // pnpm-workspace.yaml could not be read, but its presence still marks the workspace.
    expect(profile.monorepoTools).toEqual(['pnpm-workspace']);
    scope.done();
  });

  it('returns an empty profile for an empty repository (409)', async () => {
    const scope = nock(API)
      .get('/repos/acme-org/empty')
      .reply(200, { default_branch: 'main' })
      .get('/repos/acme-org/empty/languages')
      .reply(200, {})
      .get('/repos/acme-org/empty/commits/main')
      .reply(409, { message: 'Git Repository is empty.' });
    const profile = await discoverRepository(octokit(), 'acme-org', 'empty');
    expect(profile.headSha).toBe('');
    expect(profile.limitations).toEqual(['Repository is empty']);
    expect(profile.frameworks).toEqual([]);
    scope.done();
  });

  it('propagates a missing repository as a 404', async () => {
    nock(API).get('/repos/acme-org/nope').reply(404, { message: 'Not Found' });
    await expect(discoverRepository(octokit(), 'acme-org', 'nope')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('resolveCommitSha', () => {
  it('accepts a JSON commit response as a fallback', async () => {
    nock(API).get('/repos/o/r/commits/v1.0').reply(200, { sha: SHA });
    expect(await resolveCommitSha(octokit(), 'o', 'r', 'v1.0')).toBe(SHA);
  });
});
