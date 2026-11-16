import nock from 'nock';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  APP_PERMISSIONS,
  MANIFEST_EVENTS,
  WEBHOOK_EVENTS,
  buildAppManifest,
  convertManifestCode,
} from './manifest.ts';

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

describe('buildAppManifest', () => {
  it('builds a read-only manifest with callback URLs derived from PUBLIC_URL', () => {
    const { manifest, postUrl } = buildAppManifest({
      publicUrl: 'https://gmp.example.com/',
      appName: 'git-merge-pilot',
    });
    expect(postUrl).toBe('https://github.com/settings/apps/new');
    expect(manifest.name).toBe('git-merge-pilot');
    expect(manifest.url).toBe('https://gmp.example.com');
    expect(manifest.hook_attributes).toEqual({
      url: 'https://gmp.example.com/api/github/webhook',
      active: true,
    });
    expect(manifest.redirect_url).toBe('https://gmp.example.com/api/github/manifest/callback');
    expect(manifest.setup_url).toBe('https://gmp.example.com/api/github/install/callback');
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions).toEqual({
      metadata: 'read',
      contents: 'read',
      pull_requests: 'read',
      issues: 'read',
      checks: 'read',
      statuses: 'read',
      actions: 'read',
      security_events: 'read',
      vulnerability_alerts: 'read',
    });
    // Never any write/admin permission.
    for (const level of Object.values(manifest.default_permissions)) expect(level).toBe('read');
    expect(manifest.default_events).toEqual([
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'issue_comment',
      'check_run',
      'check_suite',
      'status',
      'push',
      'repository',
    ]);
  });

  it('handles every listed event (installation events are implicit for Apps)', () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual(
      [...MANIFEST_EVENTS, 'installation', 'installation_repositories'].sort(),
    );
    expect(Object.keys(APP_PERMISSIONS)).toHaveLength(9);
  });

  it('targets an organization, GHES web URL, state and smee override', () => {
    const { manifest, postUrl } = buildAppManifest({
      publicUrl: 'http://localhost:3000',
      appName: '  git-merge-pilot for a very long organization name  ',
      org: 'My-Org',
      webUrl: 'https://ghe.example.com/',
      state: 'abc/123',
      webhookUrl: 'https://smee.io/xyz',
    });
    expect(postUrl).toBe(
      'https://ghe.example.com/organizations/My-Org/settings/apps/new?state=abc%2F123',
    );
    expect(manifest.hook_attributes.url).toBe('https://smee.io/xyz');
    expect(manifest.redirect_url).toBe('http://localhost:3000/api/github/manifest/callback');
    expect(manifest.name.length).toBeLessThanOrEqual(34);
    expect(manifest.name.startsWith('git-merge-pilot')).toBe(true);
  });

  it('rejects invalid input', () => {
    expect(() => buildAppManifest({ publicUrl: 'not a url', appName: 'x' })).toThrow(/publicUrl/);
    expect(() => buildAppManifest({ publicUrl: 'ftp://x', appName: 'x' })).toThrow(/http/);
    expect(() => buildAppManifest({ publicUrl: 'https://x', appName: '   ' })).toThrow(/appName/);
    expect(() =>
      buildAppManifest({ publicUrl: 'https://x', appName: 'a', org: '../evil' }),
    ).toThrow(/org/);
    expect(() => buildAppManifest({ publicUrl: 'https://x', appName: 'a', org: '-bad' })).toThrow(
      /org/,
    );
  });
});

describe('convertManifestCode', () => {
  const conversion = {
    id: 12345,
    slug: 'git-merge-pilot-acme',
    node_id: 'A_1',
    name: 'git-merge-pilot (acme)',
    owner: { login: 'acme-org', id: 1, type: 'Organization' },
    client_id: 'Iv1.abc',
    client_secret: 'client-secret-value',
    webhook_secret: 'webhook-secret-value',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----\n',
    html_url: 'https://github.com/apps/git-merge-pilot-acme',
    permissions: { contents: 'read', metadata: 'read' },
    events: ['pull_request', 'push'],
  };

  it('exchanges the code for credentials', async () => {
    const scope = nock('https://api.github.com')
      .post('/app-manifests/abc123/conversions')
      .reply(201, conversion);
    const result = await convertManifestCode('abc123');
    expect(result).toEqual({
      appId: 12345,
      slug: 'git-merge-pilot-acme',
      name: 'git-merge-pilot (acme)',
      clientId: 'Iv1.abc',
      clientSecret: 'client-secret-value',
      pem: conversion.pem,
      webhookSecret: 'webhook-secret-value',
      htmlUrl: 'https://github.com/apps/git-merge-pilot-acme',
      ownerLogin: 'acme-org',
      permissions: { contents: 'read', metadata: 'read' },
      events: ['pull_request', 'push'],
    });
    scope.done();
  });

  it('uses a configurable API URL (GHES)', async () => {
    const scope = nock('https://ghe.example.com')
      .post('/api/v3/app-manifests/c0de/conversions')
      .reply(201, conversion);
    const result = await convertManifestCode('c0de', { apiUrl: 'https://ghe.example.com/api/v3/' });
    expect(result.appId).toBe(12345);
    scope.done();
  });

  it('rejects malformed codes without calling GitHub', async () => {
    await expect(convertManifestCode('../../user')).rejects.toThrow(/Invalid manifest code/);
    await expect(convertManifestCode('')).rejects.toThrow(/Invalid manifest code/);
  });

  it('propagates GitHub errors and rejects incomplete responses', async () => {
    nock('https://api.github.com')
      .post('/app-manifests/expired/conversions')
      .reply(404, { message: 'Not Found' });
    await expect(convertManifestCode('expired')).rejects.toMatchObject({ status: 404 });
    nock('https://api.github.com')
      .post('/app-manifests/partial/conversions')
      .reply(201, { ...conversion, pem: undefined });
    await expect(convertManifestCode('partial')).rejects.toThrow(/incomplete/);
  });
});
