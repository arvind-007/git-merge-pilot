import { execFileSync, spawn } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitCommandError, ensureRepoClone, getCloneHeadSha, isSafeGitRef } from './clone.ts';

const TOKEN = 'ghs_TestInstallationToken0123456789abcdef';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

let work: string;
let remoteRoot: string;
let mainSha: string;
let featureSha: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    },
  )
    .toString()
    .trim();
}

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'gmp-clone-test-'));
  const src = path.join(work, 'src');
  mkdirSync(src);
  git(src, 'init', '-q');
  writeFileSync(path.join(src, 'README.md'), 'main v1\n');
  mkdirSync(path.join(src, 'lib'));
  writeFileSync(path.join(src, 'lib', 'a.ts'), 'export const a = 1;\n');
  symlinkSync('/etc/hosts', path.join(src, 'evil-link'));
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'first');
  writeFileSync(path.join(src, 'README.md'), 'main v2\n');
  git(src, 'commit', '-q', '-am', 'second');
  mainSha = git(src, 'rev-parse', 'HEAD');
  git(src, 'checkout', '-q', '-b', 'feature/x');
  writeFileSync(path.join(src, 'feature.txt'), 'feature\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'feature');
  featureSha = git(src, 'rev-parse', 'HEAD');
  git(src, 'checkout', '-q', 'main');

  remoteRoot = path.join(work, 'remote');
  mkdirSync(path.join(remoteRoot, 'acme-org'), { recursive: true });
  const bare = path.join(remoteRoot, 'acme-org', 'widgets.git');
  git(work, 'clone', '-q', '--bare', src, bare);
  git(bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  git(bare, 'config', 'http.receivepack', 'false');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('isSafeGitRef', () => {
  it('accepts branches, tags, refs and shas; rejects option-like and traversal refs', () => {
    for (const ok of [
      'main',
      'feature/x',
      'refs/pull/12/head',
      'v1.2.3',
      mainSha ?? 'a'.repeat(40),
      'release-2026_11',
    ]) {
      expect(isSafeGitRef(ok)).toBe(true);
    }
    for (const bad of [
      '',
      '-x',
      '--upload-pack=touch /tmp/p',
      '../etc',
      'a..b',
      'a b',
      'a;b',
      '/abs',
      'x/',
      'x.lock',
      'a//b',
      'x@{1}',
      'a:b',
    ]) {
      expect(isSafeGitRef(bad)).toBe(false);
    }
  });
});

describe('ensureRepoClone (file remote)', () => {
  it('shallow-fetches a branch, then other refs and shas, into <cache>/<owner>/<repo>', async () => {
    const cache = path.join(work, 'cache-file');
    const webUrl = `file://${remoteRoot}`;
    const dir = await ensureRepoClone(cache, TOKEN, 'acme-org/widgets', 'main', { webUrl });
    expect(dir).toBe(path.join(path.resolve(cache), 'acme-org', 'widgets'));
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('main v2\n');
    expect(await getCloneHeadSha(dir)).toBe(mainSha);
    expect(git(dir, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(git(dir, 'rev-list', '--count', 'HEAD')).toBe('1');

    // Symlinks from untrusted content are checked out as plain files.
    expect(lstatSync(path.join(dir, 'evil-link')).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(dir, 'evil-link'), 'utf8')).toBe('/etc/hosts');

    // Re-use: switch to another branch; untracked junk is cleaned.
    writeFileSync(path.join(dir, 'junk.tmp'), 'x');
    await ensureRepoClone(cache, TOKEN, 'acme-org/widgets', 'feature/x', { webUrl });
    expect(readFileSync(path.join(dir, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect(() => lstatSync(path.join(dir, 'junk.tmp'))).toThrow();
    expect(await getCloneHeadSha(dir)).toBe(featureSha);

    // By sha.
    await ensureRepoClone(cache, TOKEN, 'acme-org/widgets', mainSha, { webUrl });
    expect(await getCloneHeadSha(dir)).toBe(mainSha);

    // The token is never persisted.
    const config = readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(BASIC);
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(`${webUrl}/acme-org/widgets.git`);
  });

  it('serialises concurrent calls for the same repository', async () => {
    const cache = path.join(work, 'cache-concurrent');
    const webUrl = `file://${remoteRoot}`;
    const [a, b] = await Promise.all([
      ensureRepoClone(cache, TOKEN, 'acme-org/widgets', 'main', { webUrl }),
      ensureRepoClone(cache, TOKEN, 'acme-org/widgets', 'feature/x', { webUrl }),
    ]);
    expect(a).toBe(b);
    expect(await getCloneHeadSha(a)).toBe(featureSha);
  });

  it('recovers from a leftover directory without .git', async () => {
    const cache = path.join(work, 'cache-leftover');
    mkdirSync(path.join(cache, 'acme-org', 'widgets'), { recursive: true });
    writeFileSync(path.join(cache, 'acme-org', 'widgets', 'stale'), 'x');
    const dir = await ensureRepoClone(cache, TOKEN, 'acme-org/widgets', 'main', {
      webUrl: `file://${remoteRoot}`,
    });
    expect(() => lstatSync(path.join(dir, 'stale'))).toThrow();
    expect(await getCloneHeadSha(dir)).toBe(mainSha);
  });

  it('validates inputs before running git', async () => {
    const cache = path.join(work, 'cache-invalid');
    await expect(ensureRepoClone(cache, TOKEN, '../evil', 'main')).rejects.toThrow(/owner\/repo/);
    await expect(ensureRepoClone(cache, TOKEN, 'a/b/c', 'main')).rejects.toThrow(/owner\/repo/);
    await expect(ensureRepoClone(cache, TOKEN, 'acme/..', 'main')).rejects.toThrow(/owner\/repo/);
    await expect(ensureRepoClone(cache, TOKEN, 'acme/x', '--upload-pack=evil')).rejects.toThrow(
      /ref/,
    );
    await expect(
      ensureRepoClone(cache, TOKEN, 'acme/x', 'main', { webUrl: 'https://user:pw@github.com' }),
    ).rejects.toThrow(/credentials/);
  });

  it('reports git failures as GitCommandError', async () => {
    const cache = path.join(work, 'cache-missing-ref');
    const err = await ensureRepoClone(cache, TOKEN, 'acme-org/widgets', 'does-not-exist', {
      webUrl: `file://${remoteRoot}`,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    expect((err as GitCommandError).message).toMatch(/^git fetch exited with code/);
  });
});

describe('ensureRepoClone (smart HTTP with auth header)', () => {
  let server: http.Server;
  let baseUrl: string;
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const backend = path.join(
    execFileSync('git', ['--exec-path']).toString().trim(),
    'git-http-backend',
  );

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      if (
        req.headers.authorization !== `basic ${BASIC}` &&
        req.headers.authorization !== `Basic ${BASIC}`
      ) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' });
        res.end('unauthorized');
        return;
      }
      const u = new URL(req.url ?? '/', 'http://localhost');
      const child = spawn(backend, [], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: remoteRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          REQUEST_METHOD: req.method ?? 'GET',
          PATH_INFO: decodeURIComponent(u.pathname),
          QUERY_STRING: u.search.slice(1),
          CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
          HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
          GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
          REMOTE_ADDR: '127.0.0.1',
          REMOTE_USER: 'x-access-token',
        },
      });
      req.pipe(child.stdin);
      let buf = Buffer.alloc(0);
      let headersSent = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if (headersSent) {
          res.write(chunk);
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        let idx = buf.indexOf('\r\n\r\n');
        let sepLen = 4;
        if (idx === -1) {
          idx = buf.indexOf('\n\n');
          sepLen = 2;
        }
        if (idx === -1) return;
        let status = 200;
        for (const line of buf.subarray(0, idx).toString().split(/\r?\n/)) {
          const colon = line.indexOf(':');
          if (colon <= 0) continue;
          const key = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10);
          else res.setHeader(key, value);
        }
        res.writeHead(status);
        headersSent = true;
        res.write(buf.subarray(idx + sepLen));
      });
      child.stdout.on('end', () => res.end());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends the token only as an Authorization extraheader (never in URLs or config)', async () => {
    const cache = path.join(work, 'cache-http');
    const dir = await ensureRepoClone(cache, TOKEN, 'acme-org/widgets', 'feature/x', {
      webUrl: baseUrl,
    });
    expect(readFileSync(path.join(dir, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      expect(req.auth?.toLowerCase()).toBe(`basic ${BASIC.toLowerCase()}`);
      expect(req.url).not.toContain(TOKEN);
      expect(req.url.startsWith('/acme-org/widgets.git/')).toBe(true);
    }
    const config = readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain(BASIC);
    expect(config).not.toContain('extraheader');
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(`${baseUrl}/acme-org/widgets.git`);
  });

  it('fails without prompting when the token is wrong, and never leaks it in the error', async () => {
    const cache = path.join(work, 'cache-http-bad');
    const badToken = 'ghs_WrongToken9999999999999999999999999';
    const err = await ensureRepoClone(cache, badToken, 'acme-org/widgets', 'main', {
      webUrl: baseUrl,
      timeoutMs: 30_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    const message = (err as Error).message;
    expect(message).not.toContain(badToken);
    expect(message).not.toContain(Buffer.from(`x-access-token:${badToken}`).toString('base64'));
  });
});
