import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGitHubClient, createOctokit } from './client.ts';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const API = 'https://api.github.com';
const FAST = { retryAfterBaseMs: 1, throttle: true } as const;

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

function tokenReply(token = 'ghs_installationtokenvalue000000000000000') {
  return {
    token,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    permissions: { contents: 'read' },
    repository_selection: 'selected',
  };
}

describe('createGitHubClient', () => {
  it('validates credentials', () => {
    expect(() => createGitHubClient({ appId: 'abc', privateKey })).toThrow(/appId/);
    expect(() => createGitHubClient({ appId: 1, privateKey: 'nope' })).toThrow(/privateKey/);
  });

  it('mints and caches installation tokens; installation Octokit is cached per id', async () => {
    const client = createGitHubClient({ appId: 12345, privateKey }, FAST);
    expect(client.installationOctokit(42)).toBe(client.installationOctokit(42));
    expect(client.installationOctokit(42)).not.toBe(client.installationOctokit(43));
    expect(() => client.installationOctokit(0)).toThrow(/installationId/);

    const scope = nock(API)
      .post('/app/installations/42/access_tokens')
      .matchHeader('authorization', /^bearer [\w-]+\.[\w-]+\.[\w-]+$/i)
      .once()
      .reply(201, tokenReply())
      .get('/repos/o/r')
      .times(2)
      .matchHeader('authorization', 'token ghs_installationtokenvalue000000000000000')
      .reply(200, { id: 1, full_name: 'o/r' });

    const octokit = client.installationOctokit(42);
    await octokit.rest.repos.get({ owner: 'o', repo: 'r' });
    await octokit.rest.repos.get({ owner: 'o', repo: 'r' });
    const token = await client.getInstallationToken(42);
    expect(token.token).toBe('ghs_installationtokenvalue000000000000000');
    expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());
    scope.done(); // only one token request despite three uses
  });

  it('evicts least-recently-used installation Octokits', () => {
    const client = createGitHubClient(
      { appId: 1, privateKey },
      { ...FAST, maxCachedInstallations: 2 },
    );
    const a = client.installationOctokit(1);
    client.installationOctokit(2);
    client.installationOctokit(1); // touch 1
    client.installationOctokit(3); // evicts 2
    expect(client.installationOctokit(1)).toBe(a);
    client.forgetInstallation(1);
    expect(client.installationOctokit(1)).not.toBe(a);
  });

  it('lists installations (paginated) and their repositories', async () => {
    const client = createGitHubClient({ appId: 12345, privateKey }, FAST);
    const scope = nock(API)
      .get('/app/installations')
      .query({ per_page: '100' })
      .reply(
        200,
        [
          {
            id: 1,
            app_id: 12345,
            account: { login: 'acme-org', type: 'Organization' },
            repository_selection: 'all',
            permissions: { contents: 'read' },
            events: ['push'],
            suspended_at: null,
            html_url: 'https://github.com/organizations/acme-org/settings/installations/1',
          },
        ],
        { link: `<${API}/app/installations?per_page=100&page=2>; rel="next"` },
      )
      .get('/app/installations')
      .query({ per_page: '100', page: '2' })
      .reply(200, [
        {
          id: 2,
          account: { login: 'dev-alice', type: 'User' },
          repository_selection: 'selected',
          suspended_at: '2026-11-01T00:00:00Z',
        },
      ])
      .post('/app/installations/1/access_tokens')
      .reply(201, tokenReply())
      .get('/installation/repositories')
      .query({ per_page: '100' })
      .reply(200, {
        total_count: 1,
        repositories: [
          {
            id: 555001,
            name: 'widgets',
            full_name: 'acme-org/widgets',
            owner: { login: 'acme-org' },
            private: true,
            default_branch: 'trunk',
            archived: false,
            disabled: false,
            fork: false,
            html_url: 'https://github.com/acme-org/widgets',
            language: 'TypeScript',
            pushed_at: '2026-11-14T00:00:00Z',
            updated_at: '2026-11-14T00:00:00Z',
          },
        ],
      });

    const installs = await client.listInstallations();
    expect(installs).toHaveLength(2);
    expect(installs[0]).toMatchObject({
      installationId: 1,
      appId: 12345,
      accountLogin: 'acme-org',
      accountType: 'Organization',
      repositorySelection: 'all',
      permissions: { contents: 'read' },
      suspendedAt: null,
    });
    expect(installs[1]).toMatchObject({
      installationId: 2,
      accountType: 'User',
      suspendedAt: '2026-11-01T00:00:00.000Z',
    });

    const repos = await client.listInstallationRepos(1);
    expect(repos).toEqual([
      {
        githubId: 555001,
        owner: 'acme-org',
        name: 'widgets',
        fullName: 'acme-org/widgets',
        private: true,
        defaultBranch: 'trunk',
        archived: false,
        disabled: false,
        fork: false,
        htmlUrl: 'https://github.com/acme-org/widgets',
        language: 'TypeScript',
        pushedAt: '2026-11-14T00:00:00.000Z',
        updatedAt: '2026-11-14T00:00:00.000Z',
      },
    ]);
    scope.done();
  });

  it('getInstallation returns null on 404; getApp maps the app', async () => {
    const client = createGitHubClient({ appId: 12345, privateKey }, FAST);
    const scope = nock(API)
      .get('/app/installations/999')
      .reply(404, { message: 'Not Found' })
      .get('/app')
      .reply(200, {
        id: 12345,
        slug: 'gmp',
        name: 'gmp',
        owner: { login: 'acme-org' },
        html_url: 'https://github.com/apps/gmp',
        permissions: { metadata: 'read' },
        events: ['push'],
      });
    expect(await client.getInstallation(999)).toBeNull();
    expect(await client.getApp()).toEqual({
      appId: 12345,
      slug: 'gmp',
      name: 'gmp',
      ownerLogin: 'acme-org',
      htmlUrl: 'https://github.com/apps/gmp',
      permissions: { metadata: 'read' },
      events: ['push'],
    });
    scope.done();
  });

  it('uses a configurable base URL (GitHub Enterprise Server)', async () => {
    const client = createGitHubClient(
      { appId: 7, privateKey, apiUrl: 'https://ghe.example.com/api/v3/' },
      FAST,
    );
    expect(client.apiUrl).toBe('https://ghe.example.com/api/v3');
    const scope = nock('https://ghe.example.com')
      .post('/api/v3/app/installations/5/access_tokens')
      .reply(201, tokenReply())
      .get('/api/v3/repos/o/r')
      .reply(200, { id: 1 });
    await client.installationOctokit(5).rest.repos.get({ owner: 'o', repo: 'r' });
    scope.done();
  });
});

describe('createOctokit plugins', () => {
  it('retries transient 5xx failures', async () => {
    const octokit = createOctokit({ auth: 'tok', ...FAST, retries: 2 });
    const scope = nock(API)
      .get('/repos/o/r')
      .reply(502, 'bad gateway')
      .get('/repos/o/r')
      .reply(200, { id: 1 });
    const { data } = await octokit.rest.repos.get({ owner: 'o', repo: 'r' });
    expect(data.id).toBe(1);
    scope.done();
  });

  it('does not retry 404s', async () => {
    const octokit = createOctokit({ auth: 'tok', ...FAST });
    const scope = nock(API).get('/repos/o/missing').once().reply(404, { message: 'Not Found' });
    await expect(octokit.rest.repos.get({ owner: 'o', repo: 'missing' })).rejects.toMatchObject({
      status: 404,
    });
    scope.done();
  });

  it('waits out a primary rate limit and retries', async () => {
    const octokit = createOctokit({ auth: 'tok', ...FAST, throttleId: 'rate-limit-test' });
    const reset = Math.floor(Date.now() / 1000);
    const scope = nock(API)
      .get('/repos/o/r')
      .reply(
        403,
        { message: 'API rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      )
      .get('/repos/o/r')
      .reply(200, { id: 2 });
    const { data } = await octokit.rest.repos.get({ owner: 'o', repo: 'r' });
    expect(data.id).toBe(2);
    scope.done();
  });

  it('gives up on a rate limit that would wait too long', async () => {
    const octokit = createOctokit({
      auth: 'tok',
      ...FAST,
      maxRateLimitWaitSeconds: 5,
      throttleId: 'rate-limit-long',
    });
    const reset = Math.floor(Date.now() / 1000) + 3600;
    nock(API)
      .get('/repos/o/r')
      .reply(
        403,
        { message: 'API rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
      );
    await expect(octokit.rest.repos.get({ owner: 'o', repo: 'r' })).rejects.toMatchObject({
      status: 403,
    });
  });
});
