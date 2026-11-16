/**
 * Shallow repository clone cache for indexing (design §7, `repo.index` job).
 *
 * Security properties:
 * - The installation token is sent only as an `http.<origin>/.extraheader`
 *   supplied through GIT_CONFIG_* environment variables: it never appears in
 *   the remote URL, in `.git/config`, in argv (visible via `ps`) or in logs.
 * - User/system git config is ignored, credential helpers and hooks are
 *   disabled, symlinks are checked out as plain files and LFS smudging is off,
 *   because repository content is untrusted.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { redactSecrets } from '@gmp/core';

export interface EnsureRepoCloneOptions {
  /** GitHub web URL (GITHUB_WEB_URL); default https://github.com. */
  webUrl?: string;
  /** Per git command timeout (default 10 minutes). */
  timeoutMs?: number;
  /** git executable (default `git` on PATH). */
  gitBinary?: string;
  /** Fetch depth (default 1). */
  depth?: number;
}

export class GitCommandError extends Error {
  override name = 'GitCommandError';
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

const FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Conservative ref validation (branch, tag, `refs/...` or sha); rejects option-like and traversal input. */
export function isSafeGitRef(ref: string): boolean {
  if (!ref || ref.length > 255) return false;
  if (!/^[A-Za-z0-9._/+-]+$/.test(ref)) return false;
  if (ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.'))
    return false;
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('.lock')) return false;
  return true;
}

const locks = new Map<string, Promise<unknown>>();

/** Serialises work per clone directory within this process. */
async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(dir) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(dir, settled);
  try {
    return await run;
  } finally {
    if (locks.get(dir) === settled) locks.delete(dir);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Options applied to every git invocation (repository content is untrusted). */
const HARDENING_CONFIG: readonly string[] = [
  `core.hooksPath=${devNull}`,
  'core.symlinks=false',
  'core.fsmonitor=false',
  'credential.helper=',
  'advice.detachedHead=false',
  'protocol.version=2',
  'protocol.file.allow=user',
  'submodule.recurse=false',
];

interface GitRunner {
  (args: string[], cwd: string): Promise<string>;
}

function makeRunner(opts: {
  gitBinary: string;
  timeoutMs: number;
  extraHeader: { key: string; value: string } | null;
  secrets: string[];
}): GitRunner {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? devNull,
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_LFS_SKIP_SMUDGE: '1',
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
  };
  if (opts.extraHeader) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = opts.extraHeader.key;
    env.GIT_CONFIG_VALUE_0 = opts.extraHeader.value;
  }
  const scrub = (text: string): string => {
    let out = text;
    for (const s of opts.secrets) if (s) out = out.split(s).join('[REDACTED]');
    return redactSecrets(out).text;
  };
  const hardening = HARDENING_CONFIG.flatMap((c) => ['-c', c]);

  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        opts.gitBinary,
        [...hardening, ...args],
        { cwd, env, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === 'number' ? error.code : null;
            const cleanStderr = scrub(String(stderr ?? ''))
              .trim()
              .slice(0, 2000);
            const reason = error.killed ? 'timed out' : `exited with code ${code ?? 'unknown'}`;
            reject(
              new GitCommandError(
                `git ${args[0] ?? ''} ${reason}${cleanStderr ? `: ${cleanStderr}` : ''}`,
                code,
                cleanStderr,
              ),
            );
            return;
          }
          resolve(String(stdout));
        },
      );
    });
}

/**
 * Ensures `<cacheDir>/<owner>/<repo>` contains a shallow (depth 1) checkout of
 * `ref` (branch, tag, `refs/...` or commit sha) and returns its absolute path.
 * Re-uses the existing clone and only fetches the requested ref.
 */
export async function ensureRepoClone(
  cacheDir: string,
  installationToken: string,
  fullName: string,
  ref: string,
  options: EnsureRepoCloneOptions = {},
): Promise<string> {
  if (!FULL_NAME_RE.test(fullName) || fullName.split('/').some((s) => s === '.' || s === '..')) {
    throw new TypeError('fullName must be "owner/repo"');
  }
  if (!isSafeGitRef(ref)) throw new TypeError('Invalid git ref');
  if (!cacheDir) throw new TypeError('cacheDir is required');

  const webUrl = new URL(options.webUrl ?? 'https://github.com');
  if (webUrl.username || webUrl.password)
    throw new TypeError('webUrl must not contain credentials');
  const base = webUrl.href.replace(/\/+$/, '');
  const remoteUrl = `${base}/${fullName}.git`;

  const root = path.resolve(cacheDir);
  const [owner, name] = fullName.split('/') as [string, string];
  const dir = path.join(root, owner, name);
  if (!dir.startsWith(root + path.sep)) throw new TypeError('Resolved clone path escapes cacheDir');

  const isHttp = webUrl.protocol === 'https:' || webUrl.protocol === 'http:';
  const basicAuth = installationToken
    ? Buffer.from(`x-access-token:${installationToken}`, 'utf8').toString('base64')
    : '';
  const git = makeRunner({
    gitBinary: options.gitBinary ?? 'git',
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    extraHeader:
      isHttp && installationToken
        ? { key: `http.${webUrl.origin}/.extraheader`, value: `AUTHORIZATION: basic ${basicAuth}` }
        : null,
    secrets: [installationToken, basicAuth],
  });
  const depth = Math.max(1, Math.floor(options.depth ?? 1));

  return withDirLock(dir, async () => {
    const gitDir = path.join(dir, '.git');
    if (!(await exists(gitDir))) {
      // A directory without .git is a leftover from an interrupted run.
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await git(['init', '--quiet'], dir);
      await git(['remote', 'add', 'origin', remoteUrl], dir);
    } else {
      await git(['remote', 'set-url', 'origin', remoteUrl], dir);
    }
    // Persist the hardening for anything else that might later run git in this clone.
    await git(['config', 'core.symlinks', 'false'], dir);

    await git(
      [
        'fetch',
        '--quiet',
        `--depth=${depth}`,
        '--no-tags',
        '--no-recurse-submodules',
        '--force',
        'origin',
        ref,
      ],
      dir,
    );
    await git(['checkout', '--quiet', '--force', '--detach', 'FETCH_HEAD'], dir);
    await git(['clean', '-ffdxq'], dir);
    return dir;
  });
}

/** Returns the commit sha currently checked out in a clone created by {@link ensureRepoClone}. */
export async function getCloneHeadSha(
  dir: string,
  options: Pick<EnsureRepoCloneOptions, 'gitBinary'> = {},
): Promise<string> {
  const git = makeRunner({
    gitBinary: options.gitBinary ?? 'git',
    timeoutMs: 30_000,
    extraHeader: null,
    secrets: [],
  });
  return (await git(['rev-parse', 'HEAD'], dir)).trim();
}
