/**
 * Pull request data fetching (design §7): full PR snapshot, compare, file
 * content and open-PR listing. All functions take an already-authenticated
 * Octokit (usually `GitHubClient.installationOctokit(id)`).
 */
import type { Octokit } from '@octokit/rest';
import type {
  CompareResult,
  CompareStatus,
  LinkedIssue,
  OptionalAlerts,
  PrCheckSnapshot,
  PrCommitSnapshot,
  PrFileSnapshot,
  PrMeta,
  PrReviewSnapshot,
  PrSnapshot,
  PrSummary,
  ReviewDecision,
  SecurityAlertSummary,
} from './types.ts';
import {
  arr,
  bodyToString,
  bool,
  describeError,
  isNotFoundError,
  isUnavailableError,
  isoDate,
  login,
  num,
  obj,
  str,
  uniqueStrings,
} from './util.ts';
import { parseClosingReferences } from './webhooks.ts';

/** GitHub returns at most 3000 files for a PR. */
export const GITHUB_MAX_PR_FILES = 3000;
/** GitHub returns at most 250 commits for a PR. */
export const GITHUB_MAX_PR_COMMITS = 250;
/** GitHub's compare API returns at most 300 files. */
export const GITHUB_MAX_COMPARE_FILES = 300;

export interface FetchPullRequestSnapshotOptions {
  /** Cap on files fetched (default/max 3000). */
  maxFiles?: number;
  /** Fetch code-scanning alerts for the PR merge ref (default true). */
  includeCodeScanning?: boolean;
  /** Fetch open Dependabot alerts for the repository (default true). */
  includeDependabot?: boolean;
  /** Cap per alert type (default 200). */
  maxAlerts?: number;
  /** Cap on commit statuses read (default 500). */
  maxStatuses?: number;
}

// ---------------------------------------------------------------------------
// Mappers (exported for reuse by the worker / tests)
// ---------------------------------------------------------------------------

export function toPrFileSnapshot(raw: unknown): PrFileSnapshot {
  const f = obj(raw) ?? {};
  const status = str(f.status) ?? 'modified';
  return {
    path: str(f.filename) ?? '',
    previousPath: str(f.previous_filename),
    status,
    additions: num(f.additions) ?? 0,
    deletions: num(f.deletions) ?? 0,
    changes: num(f.changes) ?? 0,
    patch: str(f.patch),
    sha: status === 'removed' ? null : str(f.sha),
    blobUrl: str(f.blob_url),
  };
}

export function toPrCommitSnapshot(raw: unknown): PrCommitSnapshot {
  const c = obj(raw) ?? {};
  const commit = obj(c.commit) ?? {};
  const author = obj(commit.author);
  const committer = obj(commit.committer);
  return {
    sha: str(c.sha) ?? '',
    message: str(commit.message) ?? '',
    authorLogin: login(c.author),
    authorName: str(author?.name),
    committedAt: isoDate(committer?.date) ?? isoDate(author?.date),
  };
}

function toPrReviewSnapshot(raw: unknown): PrReviewSnapshot {
  const r = obj(raw) ?? {};
  return {
    githubId: num(r.id) ?? 0,
    reviewerLogin: login(r.user),
    state: (str(r.state) ?? 'COMMENTED').toUpperCase(),
    submittedAt: isoDate(r.submitted_at),
    body: str(r.body),
    commitId: str(r.commit_id),
  };
}

function prState(p: Record<string, unknown>): PrMeta['state'] {
  if (bool(p.merged) === true || str(p.merged_at) !== null) return 'merged';
  return str(p.state) === 'closed' ? 'closed' : 'open';
}

export function toPrMeta(raw: unknown): PrMeta {
  const p = obj(raw) ?? {};
  const head = obj(p.head) ?? {};
  const base = obj(p.base) ?? {};
  const headRepoFullName = str(obj(head.repo)?.full_name);
  const baseRepoFullName = str(obj(base.repo)?.full_name);
  return {
    githubId: num(p.id) ?? 0,
    number: num(p.number) ?? 0,
    title: str(p.title) ?? '',
    body: str(p.body),
    state: prState(p),
    draft: bool(p.draft) ?? false,
    authorLogin: login(p.user),
    assignees: uniqueStrings(arr(p.assignees).map(login)),
    requestedReviewers: uniqueStrings([
      ...arr(p.requested_reviewers).map(login),
      ...arr(p.requested_teams).map((t) => {
        const slug = str(obj(t)?.slug);
        return slug ? `team:${slug}` : null;
      }),
    ]),
    labels: uniqueStrings(arr(p.labels).map((l) => str(obj(l)?.name))),
    baseRef: str(base.ref) ?? '',
    headRef: str(head.ref) ?? '',
    headSha: str(head.sha) ?? '',
    baseSha: str(base.sha) ?? '',
    headRepoFullName,
    isCrossRepository:
      headRepoFullName !== null &&
      baseRepoFullName !== null &&
      headRepoFullName !== baseRepoFullName,
    mergeable: bool(p.mergeable),
    mergeableState: str(p.mergeable_state),
    mergeCommitSha: str(p.merge_commit_sha),
    additions: num(p.additions) ?? 0,
    deletions: num(p.deletions) ?? 0,
    changedFiles: num(p.changed_files) ?? 0,
    commitsCount: num(p.commits) ?? 0,
    commentsCount: num(p.comments) ?? 0,
    reviewCommentsCount: num(p.review_comments) ?? 0,
    htmlUrl: str(p.html_url) ?? '',
    openedAt: isoDate(p.created_at),
    updatedAt: isoDate(p.updated_at),
    closedAt: isoDate(p.closed_at),
    mergedAt: isoDate(p.merged_at),
  };
}

export function toPrSummary(raw: unknown): PrSummary {
  const m = toPrMeta(raw);
  return {
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
  };
}

function toCheckRun(raw: unknown): PrCheckSnapshot {
  const c = obj(raw) ?? {};
  return {
    kind: 'check_run',
    name: str(c.name) ?? 'check',
    status: str(c.status) ?? 'queued',
    conclusion: str(c.conclusion),
    url: str(c.html_url) ?? str(c.details_url),
    startedAt: isoDate(c.started_at),
    completedAt: isoDate(c.completed_at),
    appSlug: str(obj(c.app)?.slug),
  };
}

function toStatusCheck(raw: unknown): PrCheckSnapshot {
  const s = obj(raw) ?? {};
  const state = str(s.state) ?? 'pending';
  const done = state !== 'pending';
  return {
    kind: 'status',
    name: str(s.context) ?? 'status',
    status: done ? 'completed' : 'pending',
    conclusion: done ? state : null,
    url: str(s.target_url),
    startedAt: isoDate(s.created_at),
    completedAt: done ? isoDate(s.updated_at) : null,
    appSlug: null,
  };
}

function toCodeScanningAlert(raw: unknown): SecurityAlertSummary {
  const a = obj(raw) ?? {};
  const rule = obj(a.rule) ?? {};
  const instance = obj(a.most_recent_instance) ?? {};
  const location = obj(instance.location) ?? {};
  return {
    number: num(a.number) ?? 0,
    state: str(a.state) ?? 'open',
    severity: str(rule.security_severity_level) ?? str(rule.severity),
    ruleId: str(rule.id),
    title:
      str(rule.description) ??
      str(obj(instance.message)?.text) ??
      str(rule.name) ??
      'Code scanning alert',
    path: str(location.path),
    startLine: num(location.start_line),
    url: str(a.html_url),
    tool: str(obj(a.tool)?.name),
    createdAt: isoDate(a.created_at),
  };
}

function toDependabotAlert(raw: unknown): SecurityAlertSummary {
  const a = obj(raw) ?? {};
  const dep = obj(a.dependency) ?? {};
  const pkg = obj(dep.package) ?? {};
  const advisory = obj(a.security_advisory) ?? {};
  const vuln = obj(a.security_vulnerability) ?? {};
  return {
    number: num(a.number) ?? 0,
    state: str(a.state) ?? 'open',
    severity: str(vuln.severity) ?? str(advisory.severity),
    ruleId: str(advisory.ghsa_id),
    title: str(advisory.summary) ?? 'Dependabot alert',
    path: str(dep.manifest_path),
    startLine: null,
    url: str(a.html_url),
    tool: 'dependabot',
    packageName: str(pkg.name),
    ecosystem: str(pkg.ecosystem),
    manifestPath: str(dep.manifest_path),
    ghsaId: str(advisory.ghsa_id),
    cveId: str(advisory.cve_id),
    fixedIn: str(obj(vuln.first_patched_version)?.identifier),
    createdAt: isoDate(a.created_at),
  };
}

// ---------------------------------------------------------------------------
// Pagination helper with a cap
// ---------------------------------------------------------------------------

async function paginateCapped(
  octokit: Octokit,
  route: string,
  params: Record<string, unknown>,
  cap: number,
): Promise<{ items: unknown[]; truncated: boolean }> {
  const items: unknown[] = [];
  let truncated = false;
  for await (const response of octokit.paginate.iterator(route, { per_page: 100, ...params })) {
    const data = response.data as unknown;
    const page = Array.isArray(data) ? data : [];
    const room = cap - items.length;
    items.push(...page.slice(0, room));
    if (page.length > room) {
      truncated = true;
      break;
    }
    if (items.length >= cap) {
      // Stop without requesting the next page; it exists only if GitHub advertised one.
      const link = (response.headers as Record<string, unknown>).link;
      truncated = typeof link === 'string' && /rel="next"/.test(link);
      break;
    }
  }
  return { items, truncated };
}

async function optionalAlerts(
  label: string,
  fetcher: () => Promise<{ items: unknown[]; truncated: boolean }>,
  mapper: (raw: unknown) => SecurityAlertSummary,
  limitations: string[],
): Promise<OptionalAlerts> {
  try {
    const { items, truncated } = await fetcher();
    if (truncated)
      limitations.push(`${label}: only the first ${items.length} open alerts were read`);
    return { available: true, reason: null, alerts: items.map(mapper), truncated };
  } catch (err) {
    if (isUnavailableError(err)) {
      return { available: false, reason: describeError(err), alerts: [], truncated: false };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// GraphQL: reviewDecision + closing issue references
// ---------------------------------------------------------------------------

const PR_GRAPHQL_QUERY = /* GraphQL */ `
  query GmpPullRequestExtras($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewDecision
        closingIssuesReferences(first: 50) {
          nodes {
            number
            title
            url
            repository {
              nameWithOwner
            }
          }
        }
      }
    }
  }
`;

interface GraphqlExtras {
  reviewDecision: ReviewDecision | null;
  closingIssues: LinkedIssue[];
}

const REVIEW_DECISIONS = new Set<ReviewDecision>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'REVIEW_REQUIRED',
]);

async function fetchGraphqlExtras(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<GraphqlExtras> {
  const result = await octokit.graphql<unknown>(PR_GRAPHQL_QUERY, { owner, repo, number });
  const pr = obj(obj(obj(result)?.repository)?.pullRequest);
  if (!pr) throw new Error('pull request not found via GraphQL');
  const decision = str(pr.reviewDecision);
  const self = `${owner}/${repo}`.toLowerCase();
  const closingIssues: LinkedIssue[] = [];
  for (const node of arr(obj(pr.closingIssuesReferences)?.nodes)) {
    const n = obj(node);
    const issueNumber = num(n?.number);
    if (!n || issueNumber === null) continue;
    const nameWithOwner = str(obj(n.repository)?.nameWithOwner);
    const issue: LinkedIssue = { number: issueNumber, closing: true };
    if (nameWithOwner && nameWithOwner.toLowerCase() !== self) issue.repo = nameWithOwner;
    const title = str(n.title);
    const url = str(n.url);
    if (title !== null) issue.title = title;
    if (url !== null) issue.url = url;
    closingIssues.push(issue);
  }
  return {
    reviewDecision:
      decision && REVIEW_DECISIONS.has(decision as ReviewDecision)
        ? (decision as ReviewDecision)
        : null,
    closingIssues,
  };
}

/** Merges GraphQL closing references with body-parsed ones (GraphQL wins on duplicates). */
export function mergeLinkedIssues(
  ownerRepo: string,
  primary: LinkedIssue[],
  secondary: LinkedIssue[],
): LinkedIssue[] {
  const self = ownerRepo.toLowerCase();
  const key = (i: LinkedIssue) => `${(i.repo ?? self).toLowerCase()}#${i.number}`;
  const out: LinkedIssue[] = [];
  const seen = new Set<string>();
  for (const issue of [...primary, ...secondary]) {
    // Copy, dropping `repo` for same-repository references (and never mutating the input).
    const { repo: issueRepo, ...rest } = issue;
    const normalized: LinkedIssue =
      issueRepo && issueRepo.toLowerCase() !== self ? { ...rest, repo: issueRepo } : { ...rest };
    const k = key(normalized);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(normalized);
  }
  return out;
}

/** Keeps the most recent entry per check name (input must be newest-first per name). */
function latestByName(checks: PrCheckSnapshot[]): PrCheckSnapshot[] {
  const seen = new Set<string>();
  const out: PrCheckSnapshot[] = [];
  for (const c of checks) {
    const k = `${c.kind}:${c.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches everything git-merge-pilot needs about one PR (design §7). Required
 * data (PR, files, commits, reviews) throws on failure; optional data (checks,
 * statuses, GraphQL extras, security alerts) degrades gracefully with a note in
 * `limitations`.
 */
export async function fetchPullRequestSnapshot(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  options: FetchPullRequestSnapshotOptions = {},
): Promise<PrSnapshot> {
  const maxFiles = Math.min(
    Math.max(1, options.maxFiles ?? GITHUB_MAX_PR_FILES),
    GITHUB_MAX_PR_FILES,
  );
  const maxAlerts = Math.max(1, options.maxAlerts ?? 200);
  const maxStatuses = Math.max(1, options.maxStatuses ?? 500);
  const limitations: string[] = [];
  const base = { owner, repo };

  const { data: prData } = await octokit.rest.pulls.get({ ...base, pull_number: number });
  const pullRequest = toPrMeta(prData);
  const headSha = pullRequest.headSha;

  const [
    filesRes,
    commitsRes,
    reviewsRes,
    checkRunsRes,
    statusesRes,
    graphqlRes,
    codeScanning,
    dependabot,
  ] = await Promise.all([
    paginateCapped(
      octokit,
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
      { ...base, pull_number: number },
      maxFiles,
    ),
    paginateCapped(
      octokit,
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits',
      { ...base, pull_number: number },
      GITHUB_MAX_PR_COMMITS,
    ),
    paginateCapped(
      octokit,
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      { ...base, pull_number: number },
      1000,
    ),
    octokit
      .paginate(octokit.rest.checks.listForRef, {
        ...base,
        ref: headSha,
        filter: 'latest',
        per_page: 100,
      })
      .then(
        (runs) => ({ ok: true as const, runs: runs as unknown[] }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
    paginateCapped(
      octokit,
      'GET /repos/{owner}/{repo}/commits/{ref}/statuses',
      { ...base, ref: headSha },
      maxStatuses,
    ).then(
      (r) => ({ ok: true as const, ...r }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
    fetchGraphqlExtras(octokit, owner, repo, number).then(
      (r) => ({ ok: true as const, ...r }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
    options.includeCodeScanning === false
      ? Promise.resolve<OptionalAlerts>({
          available: false,
          reason: 'not requested',
          alerts: [],
          truncated: false,
        })
      : optionalAlerts(
          'Code scanning',
          () =>
            paginateCapped(
              octokit,
              'GET /repos/{owner}/{repo}/code-scanning/alerts',
              { ...base, ref: `refs/pull/${number}/merge`, state: 'open' },
              maxAlerts,
            ),
          toCodeScanningAlert,
          limitations,
        ),
    options.includeDependabot === false
      ? Promise.resolve<OptionalAlerts>({
          available: false,
          reason: 'not requested',
          alerts: [],
          truncated: false,
        })
      : optionalAlerts(
          'Dependabot',
          () =>
            paginateCapped(
              octokit,
              'GET /repos/{owner}/{repo}/dependabot/alerts',
              { ...base, state: 'open' },
              maxAlerts,
            ),
          toDependabotAlert,
          limitations,
        ),
  ]);

  const files = filesRes.items.map(toPrFileSnapshot);
  const filesTruncated =
    filesRes.truncated ||
    (files.length >= GITHUB_MAX_PR_FILES && pullRequest.changedFiles > files.length);
  if (filesTruncated) {
    limitations.push(
      `Only ${files.length} of ${pullRequest.changedFiles || 'many'} changed files could be read`,
    );
  }
  const commits = commitsRes.items.map(toPrCommitSnapshot);
  const commitsTruncated = pullRequest.commitsCount > commits.length;
  if (commitsTruncated) {
    limitations.push(
      `Only ${commits.length} of ${pullRequest.commitsCount} commits are available from GitHub`,
    );
  }
  const reviews = reviewsRes.items.map(toPrReviewSnapshot);

  const checks: PrCheckSnapshot[] = [];
  if (checkRunsRes.ok) {
    // `filter=latest` already returns the most recent run per name.
    checks.push(...latestByName(checkRunsRes.runs.map(toCheckRun)));
  } else if (isUnavailableError(checkRunsRes.err)) {
    limitations.push(`Check runs unavailable (${describeError(checkRunsRes.err)})`);
  } else {
    throw checkRunsRes.err;
  }
  if (statusesRes.ok) {
    // Statuses are returned newest first; keep the latest per context.
    checks.push(...latestByName(statusesRes.items.map(toStatusCheck)));
  } else if (isUnavailableError(statusesRes.err)) {
    limitations.push(`Commit statuses unavailable (${describeError(statusesRes.err)})`);
  } else {
    throw statusesRes.err;
  }

  const bodyIssues = parseClosingReferences(pullRequest.body);
  let reviewDecision: ReviewDecision | null = null;
  let linkedIssues: LinkedIssue[] = bodyIssues;
  if (graphqlRes.ok) {
    reviewDecision = graphqlRes.reviewDecision;
    linkedIssues = mergeLinkedIssues(`${owner}/${repo}`, graphqlRes.closingIssues, bodyIssues);
  } else {
    limitations.push(
      `Review decision and linked issues could not be read via GraphQL (${describeError(graphqlRes.err)}); linked issues parsed from the PR description only`,
    );
  }

  return {
    pullRequest,
    files,
    filesTruncated,
    commits,
    commitsTruncated,
    reviews,
    reviewCommentsCount: pullRequest.reviewCommentsCount,
    checks,
    reviewDecision,
    mergeableState: pullRequest.mergeableState,
    linkedIssues,
    codeScanningAlerts: codeScanning,
    dependabotAlerts: dependabot,
    limitations,
    fetchedAt: new Date().toISOString(),
  };
}

const COMPARE_STATUSES = new Set<CompareStatus>(['ahead', 'behind', 'identical', 'diverged']);

/**
 * Compares two commits (`base...head`, three-dot / merge-base semantics).
 * `status: 'ahead'` means head contains base (fast-forward), which is what
 * incremental analysis needs. Throws a 404 RequestError when either sha no
 * longer exists (e.g. after a force-push) — check with `isNotFoundError`.
 */
export async function compareCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<CompareResult> {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
  });
  const d = obj(data) ?? {};
  const rawStatus = str(d.status) as CompareStatus | null;
  const files = arr(d.files).map(toPrFileSnapshot);
  return {
    status: rawStatus && COMPARE_STATUSES.has(rawStatus) ? rawStatus : 'diverged',
    aheadBy: num(d.ahead_by) ?? 0,
    behindBy: num(d.behind_by) ?? 0,
    totalCommits: num(d.total_commits) ?? 0,
    mergeBaseSha: str(obj(d.merge_base_commit)?.sha),
    commits: arr(d.commits).map(toPrCommitSnapshot),
    files,
    filesTruncated: files.length >= GITHUB_MAX_COMPARE_FILES,
    htmlUrl: str(d.html_url),
  };
}

export interface GetFileContentOptions {
  /** Return null when the file is larger than this many bytes (default 5 MiB). */
  maxBytes?: number;
}

/**
 * Returns a file's text at `ref`, or null when it does not exist, is a
 * directory/submodule, or exceeds `maxBytes`.
 */
export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  options: GetFileContentOptions = {},
): Promise<string | null> {
  const cleanPath = path.replace(/^\/+/, '');
  if (!cleanPath || cleanPath.split('/').some((seg) => seg === '..')) return null;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: cleanPath,
      ref,
      mediaType: { format: 'raw' },
    });
    const text = bodyToString(response.data);
    if (text === null) return null; // directory listing (JSON array) or unexpected shape
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return null;
    return text;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

/** Lists all open PRs of a repository, most recently updated first. */
export async function listOpenPullRequests(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<PrSummary[]> {
  const items = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  });
  return (items as unknown[]).map(toPrSummary);
}
