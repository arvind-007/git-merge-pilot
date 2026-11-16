/** In-memory GitHubGateway for handler tests (no network). */
import type {
  CompareResult,
  PrCheckSnapshot,
  PrFileSnapshot,
  PrSnapshot,
  PrSummary,
  RepositoryProfile,
} from '@gmp/github';
import type { GitHubGateway, RepoClone, RepoTarget } from '../github.ts';

/** Unified diff (single hunk, full context) between two texts, via line LCS. */
export function makePatch(before: string, after: string): string {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i++;
      j++;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      lines.push(`-${a[i]}`);
      i++;
    } else {
      lines.push(`+${b[j]}`);
      j++;
    }
  }
  return [`@@ -${n === 0 ? 0 : 1},${n} +${m === 0 ? 0 : 1},${m} @@`, ...lines].join('\n');
}

export interface FakeFile {
  path: string;
  before?: string | null;
  after?: string | null;
  previousPath?: string;
}

export function fileSnapshot(f: FakeFile): PrFileSnapshot {
  const before = f.before ?? '';
  const after = f.after ?? '';
  const status =
    f.before == null
      ? 'added'
      : f.after == null
        ? 'removed'
        : f.previousPath
          ? 'renamed'
          : 'modified';
  const patch = makePatch(before, after);
  const additions = patch.split('\n').filter((l) => l.startsWith('+')).length;
  const deletions = patch.split('\n').filter((l) => l.startsWith('-')).length;
  return {
    path: f.path,
    previousPath: f.previousPath ?? null,
    status,
    additions,
    deletions,
    changes: additions + deletions,
    patch,
    sha: null,
    blobUrl: null,
  };
}

export interface FakePrSpec {
  repo: RepoTarget;
  number: number;
  githubId?: number;
  title: string;
  body?: string | null;
  headSha: string;
  baseSha: string;
  files: FakeFile[];
  state?: 'open' | 'closed' | 'merged';
  checks?: PrCheckSnapshot[];
  reviewDecision?: PrSnapshot['reviewDecision'];
  mergeableState?: string | null;
  draft?: boolean;
  authorLogin?: string;
}

const now = '2026-11-14T10:00:00Z';

export class FakeGitHub implements GitHubGateway {
  readonly snapshots = new Map<string, PrSnapshot>();
  readonly contents = new Map<string, string>();
  readonly compares = new Map<string, CompareResult>();
  readonly profiles = new Map<string, RepositoryProfile>();
  readonly clones = new Map<string, RepoClone>();
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  private key(repo: RepoTarget, number: number) {
    return `${repo.fullName}#${number}`;
  }

  /** Registers (or replaces) a PR state; file contents are served for base/head shas. */
  setPr(spec: FakePrSpec): PrSnapshot {
    const files = spec.files.map(fileSnapshot);
    for (const f of spec.files) {
      if (f.before != null)
        this.contents.set(`${spec.baseSha}:${f.previousPath ?? f.path}`, f.before);
      if (f.after != null) this.contents.set(`${spec.headSha}:${f.path}`, f.after);
    }
    const additions = files.reduce((s, f) => s + f.additions, 0);
    const deletions = files.reduce((s, f) => s + f.deletions, 0);
    const state = spec.state ?? 'open';
    const snap: PrSnapshot = {
      pullRequest: {
        githubId: spec.githubId ?? 900_000 + spec.number,
        number: spec.number,
        title: spec.title,
        body: spec.body ?? null,
        state,
        draft: spec.draft ?? false,
        authorLogin: spec.authorLogin ?? 'dev-one',
        assignees: [],
        requestedReviewers: [],
        labels: [],
        baseRef: 'main',
        headRef: `feature/${spec.number}`,
        headSha: spec.headSha,
        baseSha: spec.baseSha,
        headRepoFullName: spec.repo.fullName,
        isCrossRepository: false,
        mergeable: true,
        mergeableState: spec.mergeableState ?? 'clean',
        mergeCommitSha: null,
        additions,
        deletions,
        changedFiles: files.length,
        commitsCount: 1,
        commentsCount: 0,
        reviewCommentsCount: 0,
        htmlUrl: `https://github.example/${spec.repo.fullName}/pull/${spec.number}`,
        openedAt: now,
        updatedAt: now,
        closedAt: state === 'open' ? null : now,
        mergedAt: state === 'merged' ? now : null,
      },
      files,
      filesTruncated: false,
      commits: [
        {
          sha: spec.headSha,
          message: spec.title,
          authorLogin: spec.authorLogin ?? 'dev-one',
          authorName: null,
          committedAt: now,
        },
      ],
      commitsTruncated: false,
      reviews: [],
      reviewCommentsCount: 0,
      checks: spec.checks ?? [],
      reviewDecision: spec.reviewDecision ?? null,
      mergeableState: spec.mergeableState ?? 'clean',
      linkedIssues: [],
      codeScanningAlerts: {
        available: false,
        reason: 'not permitted',
        alerts: [],
        truncated: false,
      },
      dependabotAlerts: { available: false, reason: 'not permitted', alerts: [], truncated: false },
      limitations: [],
      fetchedAt: now,
    };
    this.snapshots.set(this.key(spec.repo, spec.number), snap);
    return snap;
  }

  setCompare(base: string, head: string, result: Partial<CompareResult>): void {
    this.compares.set(`${base}...${head}`, {
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      totalCommits: 1,
      mergeBaseSha: base,
      commits: [],
      files: [],
      filesTruncated: false,
      htmlUrl: null,
      ...result,
    });
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  async fetchPullRequestSnapshot(repo: RepoTarget, number: number): Promise<PrSnapshot> {
    this.calls.push({ method: 'fetchPullRequestSnapshot', args: [repo.fullName, number] });
    const snap = this.snapshots.get(this.key(repo, number));
    if (!snap) throw Object.assign(new Error('Not Found'), { status: 404 });
    return structuredClone(snap);
  }

  async compareCommits(repo: RepoTarget, base: string, head: string): Promise<CompareResult> {
    this.calls.push({ method: 'compareCommits', args: [repo.fullName, base, head] });
    const hit = this.compares.get(`${base}...${head}`);
    if (hit) return structuredClone(hit);
    // Default: base is the merge base (PR base...head), history otherwise unknown.
    return {
      status: 'diverged',
      aheadBy: 0,
      behindBy: 0,
      totalCommits: 0,
      mergeBaseSha: base,
      commits: [],
      files: [],
      filesTruncated: false,
      htmlUrl: null,
    };
  }

  async getFileContent(repo: RepoTarget, path: string, ref: string): Promise<string | null> {
    this.calls.push({ method: 'getFileContent', args: [repo.fullName, path, ref] });
    return this.contents.get(`${ref}:${path}`) ?? null;
  }

  async listOpenPullRequests(repo: RepoTarget): Promise<PrSummary[]> {
    this.calls.push({ method: 'listOpenPullRequests', args: [repo.fullName] });
    const out: PrSummary[] = [];
    for (const [key, s] of this.snapshots) {
      if (!key.startsWith(`${repo.fullName}#`) || s.pullRequest.state !== 'open') continue;
      const m = s.pullRequest;
      out.push({
        githubId: m.githubId,
        number: m.number,
        title: m.title,
        state: m.state,
        draft: m.draft,
        authorLogin: m.authorLogin,
        labels: m.labels,
        baseRef: m.baseRef,
        headRef: m.headRef,
        headSha: m.headSha,
        baseSha: m.baseSha,
        htmlUrl: m.htmlUrl,
        openedAt: m.openedAt,
        updatedAt: m.updatedAt,
      });
    }
    return out;
  }

  async discoverRepository(repo: RepoTarget): Promise<RepositoryProfile> {
    this.calls.push({ method: 'discoverRepository', args: [repo.fullName] });
    const p = this.profiles.get(repo.fullName);
    if (!p) throw Object.assign(new Error('Not Found'), { status: 404 });
    return structuredClone(p);
  }

  async cloneRepository(repo: RepoTarget, ref: string): Promise<RepoClone> {
    this.calls.push({ method: 'cloneRepository', args: [repo.fullName, ref] });
    const c = this.clones.get(repo.fullName);
    if (!c) throw Object.assign(new Error('Not Found'), { status: 404 });
    return c;
  }
}
