/** repo.discover and repo.index (design §11). */
import { lstat, open, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  detectLanguage,
  extractContracts,
  extractSymbols,
  isGeneratedPath,
  isLockFile,
  isSourceLanguage,
  type Contract,
  type ExtractedSymbol,
} from '@gmp/analysis';
import {
  codeContracts,
  codeSymbols,
  repositories,
  repositoryProfiles,
  type NewCodeContract,
  type NewCodeSymbol,
  type RepositoryProfileData,
} from '@gmp/db';
import { eq } from 'drizzle-orm';
import type { WorkerContext } from '../deps.ts';
import { GitHubAccessError } from '../github.ts';
import { singletonKeys } from '../queues.ts';
import { loadRepoState } from '../repo-state.ts';
import { chunk, errorText } from '../util.ts';
import { reconcileRepository } from './scheduled.ts';
import { skipped, type Handler } from './types.ts';

export const handleRepoDiscover: Handler<'repo.discover'> = async (ctx, data) => {
  const state = await loadRepoState(ctx.db, data.repositoryId);
  if (!state) return skipped('repository_not_found');
  const { repo } = state;
  if (!repo.monitoringEnabled) return skipped('monitoring_disabled');
  if (repo.archived) return skipped('archived');

  let profile;
  try {
    // Discover GitHub's current default branch (rows created from webhooks only have a guess).
    profile = await ctx.github.discoverRepository(repo);
  } catch (err) {
    if (err instanceof GitHubAccessError) return skipped('github_access', { error: err.message });
    throw err;
  }
  const discovered = profile as unknown as RepositoryProfileData;
  await ctx.db
    .insert(repositoryProfiles)
    .values({ repositoryId: repo.id, discovered, headSha: profile.headSha })
    .onConflictDoUpdate({
      target: repositoryProfiles.repositoryId,
      set: { discovered, headSha: profile.headSha },
    });
  await ctx.db
    .update(repositories)
    .set({
      lastDiscoveredAt: ctx.now(),
      ...(profile.defaultBranch ? { defaultBranch: profile.defaultBranch } : {}),
    })
    .where(eq(repositories.id, repo.id));

  const indexedRef = await currentIndexRef(ctx, repo.id);
  const needsIndex = data.force || !indexedRef || indexedRef !== profile.headSha;
  if (needsIndex && profile.headSha) {
    await ctx.queue.send(
      'repo.index',
      { repositoryId: repo.id, ref: profile.headSha, ...(data.force ? { force: true } : {}) },
      { singletonKey: singletonKeys.repo(repo.id) },
    );
  }
  // A repository that was just added, re-enabled or not polled recently gets its open PRs
  // imported now instead of after the next 15-minute reconcile.
  let prSyncs = 0;
  const polled = repo.lastPolledAt?.getTime() ?? 0;
  if (ctx.now().getTime() - polled >= INITIAL_IMPORT_STALE_MS) {
    try {
      prSyncs = await reconcileRepository(ctx, repo.id);
    } catch (err) {
      ctx.logger.warn(
        { err: errorText(err), repositoryId: repo.id },
        'initial pull request import failed; reconcile will retry',
      );
    }
  }
  return {
    status: 'completed',
    headSha: profile.headSha,
    indexQueued: Boolean(needsIndex),
    prSyncs,
  };
};

/** repo.discover imports open PRs when the repository was not polled for this long. */
const INITIAL_IMPORT_STALE_MS = 15 * 60_000;

async function currentIndexRef(ctx: WorkerContext, repositoryId: string): Promise<string | null> {
  const [sym] = await ctx.db
    .select({ ref: codeSymbols.refSha })
    .from(codeSymbols)
    .where(eq(codeSymbols.repositoryId, repositoryId))
    .limit(1);
  if (sym) return sym.ref;
  const [con] = await ctx.db
    .select({ ref: codeContracts.refSha })
    .from(codeContracts)
    .where(eq(codeContracts.repositoryId, repositoryId))
    .limit(1);
  return con?.ref ?? null;
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  'bower_components',
  '.gradle',
  '.idea',
  '.terraform',
]);

/** Lists repository files (relative, forward slashes) up to `max`, skipping vendored/build dirs. */
export async function listRepoFiles(
  root: string,
  max: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        files.push(relative(root, full).split(sep).join('/'));
        if (files.length >= max) return { files: files.sort(), truncated: true };
      }
    }
  }
  return { files: files.sort(), truncated: false };
}

async function readText(path: string, maxBytes: number): Promise<string | null> {
  const st = await lstat(path);
  if (!st.isFile() || st.size > maxBytes) return null;
  const fh = await open(path, 'r');
  try {
    const buf = await fh.readFile();
    if (buf.subarray(0, 8192).includes(0)) return null; // binary
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

export interface IndexedFileResult {
  symbols: ExtractedSymbol[];
  contracts: Contract[];
}

/** Extracts symbols (supported languages) and contracts from one file. */
export function indexFile(path: string, source: string): IndexedFileResult {
  const lang = detectLanguage(path);
  const symbols = isSourceLanguage(lang) ? safe(() => extractSymbols(lang, source)) : [];
  const contracts = safe(() => extractContracts(path, source));
  return { symbols, contracts };
}

function safe<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

const MAX_SYMBOLS = 200_000;
const MAX_CONTRACTS = 100_000;

export const handleRepoIndex: Handler<'repo.index'> = async (ctx, data) => {
  const state = await loadRepoState(ctx.db, data.repositoryId);
  if (!state) return skipped('repository_not_found');
  const { repo } = state;
  if (!repo.monitoringEnabled) return skipped('monitoring_disabled');
  if (repo.archived) return skipped('archived');

  const ref = data.ref ?? repo.defaultBranch;
  const indexed = await currentIndexRef(ctx, repo.id);
  if (!data.force && indexed && indexed === ref) {
    return { status: 'unchanged', refSha: indexed };
  }
  let clone;
  try {
    clone = await ctx.github.cloneRepository(repo, ref);
  } catch (err) {
    if (err instanceof GitHubAccessError) return skipped('github_access', { error: err.message });
    throw err;
  }
  if (!data.force && indexed === clone.headSha) return { status: 'unchanged', refSha: indexed };

  const { files, truncated } = await listRepoFiles(clone.dir, ctx.limits.maxIndexFiles);
  const symbolRows: NewCodeSymbol[] = [];
  const contractRows: NewCodeContract[] = [];
  for (const path of files) {
    if (isLockFile(path) || isGeneratedPath(path)) continue;
    if (detectLanguage(path) === 'unknown' && !/\.(sql|env|ya?ml|json|toml)$/i.test(path)) continue;
    const source = await readText(join(clone.dir, path), ctx.limits.maxIndexFileBytes).catch(
      () => null,
    );
    if (source === null) continue;
    const res = indexFile(path, source);
    for (const s of res.symbols) {
      if (symbolRows.length >= MAX_SYMBOLS) break;
      symbolRows.push({
        orgId: repo.orgId,
        repositoryId: repo.id,
        refSha: clone.headSha,
        path,
        name: s.qualifiedName || s.name,
        kind: s.kind,
        signature: s.signature.slice(0, 1000),
        exported: s.exported,
        startLine: s.startLine,
        endLine: s.endLine,
      });
    }
    for (const c of res.contracts) {
      if (contractRows.length >= MAX_CONTRACTS) break;
      contractRows.push({
        orgId: repo.orgId,
        repositoryId: repo.id,
        refSha: clone.headSha,
        kind: c.kind,
        identifier: c.identifier.slice(0, 1000),
        role: c.role,
        path,
        line: c.line,
      });
    }
  }

  await ctx.db.transaction(async (tx) => {
    await tx.delete(codeSymbols).where(eq(codeSymbols.repositoryId, repo.id));
    await tx.delete(codeContracts).where(eq(codeContracts.repositoryId, repo.id));
    for (const part of chunk(symbolRows, 1000)) await tx.insert(codeSymbols).values(part);
    for (const part of chunk(contractRows, 1000)) await tx.insert(codeContracts).values(part);
  });
  return {
    status: 'completed',
    refSha: clone.headSha,
    files: files.length,
    truncated,
    symbols: symbolRows.length,
    contracts: contractRows.length,
  };
};
