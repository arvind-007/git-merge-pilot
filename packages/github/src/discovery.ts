/**
 * Repository discovery via the GitHub API (design §7): languages API + a
 * recursive git tree scan + contents of a bounded set of manifest/config files,
 * analysed by the pure {@link analyzeRepositoryTree}.
 */
import type { Octokit } from '@octokit/rest';
import { analyzeRepositoryTree, selectDiscoveryFiles } from './profile.ts';
import { getFileContent } from './pulls.ts';
import type { RepositoryProfile } from './types.ts';
import {
  arr,
  bodyToString,
  describeError,
  httpStatus,
  isUnavailableError,
  mapLimit,
  num,
  obj,
  str,
} from './util.ts';

export interface DiscoverRepositoryOptions {
  /** Max files whose content is fetched (default 150). */
  maxFiles?: number;
  /** Parallel content requests (default 8). */
  concurrency?: number;
  /** Skip files larger than this (default 1 MiB). */
  maxFileBytes?: number;
  now?: Date;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/** Resolves a branch/tag/sha to a commit sha (null for an empty repository). */
export async function resolveCommitSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  if (SHA_RE.test(ref)) return ref.toLowerCase();
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
      owner,
      repo,
      ref,
      headers: { accept: 'application/vnd.github.sha' },
    });
    const text = bodyToString(response.data)?.trim();
    if (text && SHA_RE.test(text)) return text.toLowerCase();
    const sha = str(obj(response.data)?.sha);
    if (sha) return sha;
    throw new Error(`Could not resolve ref "${ref}" to a commit`);
  } catch (err) {
    // 409 Conflict: "Git Repository is empty."
    if (httpStatus(err) === 409) return null;
    throw err;
  }
}

/**
 * Discovers a repository's profile at `ref` (default branch when omitted):
 * languages, frameworks, build tools, package managers, test frameworks, CI
 * workflows, security tooling, CODEOWNERS, PR templates, CONTRIBUTING,
 * docs/ADR directories and monorepo packages.
 */
export async function discoverRepository(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref?: string,
  options: DiscoverRepositoryOptions = {},
): Promise<RepositoryProfile> {
  const limitations: string[] = [];
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = str(obj(repoData)?.default_branch) ?? 'main';
  const targetRef = ref ?? defaultBranch;

  const [languages, headSha] = await Promise.all([
    octokit.rest.repos.listLanguages({ owner, repo }).then(
      ({ data }) => {
        const out: Record<string, number> = {};
        for (const [lang, bytes] of Object.entries(obj(data) ?? {})) {
          const n = num(bytes);
          if (n !== null) out[lang] = n;
        }
        return out;
      },
      (err: unknown) => {
        if (!isUnavailableError(err)) throw err;
        limitations.push(`Languages unavailable (${describeError(err)})`);
        return {} as Record<string, number>;
      },
    ),
    resolveCommitSha(octokit, owner, repo, targetRef),
  ]);

  if (headSha === null) {
    return analyzeRepositoryTree({
      paths: [],
      files: new Map(),
      languages,
      defaultBranch,
      ref: targetRef,
      headSha: '',
      limitations: [...limitations, 'Repository is empty'],
      ...(options.now ? { now: options.now } : {}),
    });
  }

  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: headSha,
    recursive: 'true',
  });
  const treeObj = obj(tree) ?? {};
  const paths: string[] = [];
  for (const entry of arr(treeObj.tree)) {
    const e = obj(entry);
    // blobs only: skip trees and submodules ("commit" entries)
    if (e && e.type === 'blob' && typeof e.path === 'string') paths.push(e.path);
  }
  const treeTruncated = treeObj.truncated === true;

  const selected = selectDiscoveryFiles(paths, options.maxFiles ?? 150);
  const files = new Map<string, string>();
  let failed = 0;
  await mapLimit(selected, options.concurrency ?? 8, async (path) => {
    try {
      const text = await getFileContent(octokit, owner, repo, path, headSha, {
        maxBytes: options.maxFileBytes ?? 1024 * 1024,
      });
      if (text !== null) files.set(path, text);
    } catch (err) {
      if (!isUnavailableError(err) && httpStatus(err) === null) throw err;
      failed++;
    }
  });
  if (failed > 0) limitations.push(`${failed} configuration file(s) could not be read`);

  return analyzeRepositoryTree({
    paths,
    files,
    languages,
    defaultBranch,
    ref: targetRef,
    headSha,
    treeTruncated,
    limitations,
    ...(options.now ? { now: options.now } : {}),
  });
}
