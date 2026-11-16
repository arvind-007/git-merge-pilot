import { afterEach, describe, expect, it, vi } from 'vitest';
import { appInstallUrl, evidenceUrl, githubFileUrl, safeUrl, submitManifestForm } from './links.ts';

describe('safeUrl', () => {
  it('accepts http(s) and app-relative URLs', () => {
    expect(safeUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1');
    expect(safeUrl('/pull-requests/1')).toBe('/pull-requests/1');
  });
  it('rejects dangerous or malformed URLs', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl(' JavaScript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<script>')).toBeNull();
    expect(safeUrl('//evil.example/x')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});

describe('GitHub links', () => {
  it('builds file links with line ranges', () => {
    expect(
      githubFileUrl({ repo: 'acme/api', ref: 'abc123', path: 'src/a b.ts', line: 10, endLine: 12 }),
    ).toBe('https://github.com/acme/api/blob/abc123/src/a%20b.ts#L10-L12');
    expect(
      githubFileUrl({
        webUrl: 'https://ghe.example/',
        repo: 'o/r',
        ref: 'main',
        path: 'x.go',
        line: 3,
      }),
    ).toBe('https://ghe.example/o/r/blob/main/x.go#L3');
  });

  it('prefers a safe evidence url, falls back to a blob link, rejects unsafe ones', () => {
    expect(
      evidenceUrl({ repo: 'o/r', source: 'github', url: 'https://github.com/o/r/pull/2' }, {}),
    ).toBe('https://github.com/o/r/pull/2');
    expect(
      evidenceUrl(
        { repo: 'o/r', path: 'a.ts', line: 5, source: 'diff', url: 'javascript:alert(1)' },
        { ref: 'sha1' },
      ),
    ).toBe('https://github.com/o/r/blob/sha1/a.ts#L5');
    expect(evidenceUrl({ repo: 'o/r', path: 'a.ts', source: 'diff' }, {})).toBeNull();
  });

  it('links removed-code evidence at the base commit, and honours an evidence ref', () => {
    const ctx = { ref: 'head1', baseRef: 'base1' };
    expect(
      evidenceUrl(
        { repo: 'o/r', path: 'src/routes/users.ts', line: 12, source: 'diff', side: 'base' },
        ctx,
      ),
    ).toBe('https://github.com/o/r/blob/base1/src/routes/users.ts#L12');
    expect(
      evidenceUrl(
        { repo: 'o/r', path: 'a.ts', line: 3, source: 'diff', side: 'base', ref: 'mergebase' },
        ctx,
      ),
    ).toBe('https://github.com/o/r/blob/mergebase/a.ts#L3');
    expect(evidenceUrl({ repo: 'o/r', path: 'a.ts', line: 3, source: 'diff' }, ctx)).toBe(
      'https://github.com/o/r/blob/head1/a.ts#L3',
    );
  });

  it('builds the install link from the app html url', () => {
    expect(appInstallUrl('https://github.com/apps/my-gmp')).toBe(
      'https://github.com/apps/my-gmp/installations/new',
    );
    expect(appInstallUrl('javascript:x')).toBeNull();
  });
});

describe('submitManifestForm', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs a form with the manifest JSON to GitHub', () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, 'submit')
      .mockImplementation(() => undefined);
    const manifest = {
      name: 'git-merge-pilot',
      url: 'https://gmp.example',
      default_permissions: { contents: 'read' },
    };
    const form = submitManifestForm('https://github.com/settings/apps/new?state=s1', manifest);
    expect(form.method).toBe('post');
    expect(form.action).toBe('https://github.com/settings/apps/new?state=s1');
    const input = form.querySelector<HTMLInputElement>('input[name="manifest"]');
    expect(JSON.parse(input?.value ?? '')).toEqual(manifest);
    expect(submit).toHaveBeenCalledOnce();
  });

  it('refuses non-http targets', () => {
    expect(() => submitManifestForm('javascript:alert(1)', {})).toThrow();
    expect(() => submitManifestForm('/relative', {})).toThrow();
  });
});
