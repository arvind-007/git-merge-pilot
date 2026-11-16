/**
 * Webhook signature verification and normalization (design §7, §14).
 *
 * `verifyWebhookSignature` must be called on the raw request body before any
 * JSON parsing. `normalizeWebhook` turns a (verified, parsed) payload into a
 * small, typed, defensive `NormalizedEvent`; it never throws on odd payloads and
 * returns null for events/actions git-merge-pilot does not act on.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LinkedIssue } from './types.ts';
import { arr, bool, isoDate, login, num, obj, str, uniqueStrings } from './util.ts';
import type { JsonObject } from './util.ts';

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/i;

/** Computes the `X-Hub-Signature-256` header value for a body. */
export function signWebhookPayload(secret: string, rawBody: string | Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * Verifies GitHub's `X-Hub-Signature-256` header (HMAC-SHA256 of the raw body)
 * with a constant-time comparison. Returns false for a missing/malformed header
 * or empty secret; never throws.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Uint8Array,
  signatureHeader: string | string[] | null | undefined,
): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (typeof header !== 'string') return false;
  const match = SIGNATURE_RE.exec(header.trim());
  if (!match?.[1]) return false;
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(match[1], 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// ---------------------------------------------------------------------------
// Normalized event types
// ---------------------------------------------------------------------------

export const NORMALIZED_EVENT_TYPES = [
  'pr_opened',
  'pr_updated',
  'pr_synchronized',
  'pr_edited',
  'pr_closed',
  'pr_merged',
  'pr_reopened',
  'review_submitted',
  'review_comment',
  'issue_comment',
  'check_updated',
  'status_updated',
  'push',
  'installation_changed',
  'installation_repos_changed',
  'repository_changed',
] as const;
export type NormalizedEventType = (typeof NORMALIZED_EVENT_TYPES)[number];

export type PullRequestEventType =
  | 'pr_opened'
  | 'pr_updated'
  | 'pr_synchronized'
  | 'pr_edited'
  | 'pr_closed'
  | 'pr_merged'
  | 'pr_reopened';

export interface WebhookRepository {
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  archived: boolean;
  htmlUrl: string | null;
}

export interface WebhookPullRequest {
  githubId: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  authorLogin: string | null;
  assignees: string[];
  /** Users as logins, teams as `team:<slug>`. */
  requestedReviewers: string[];
  labels: string[];
  baseRef: string;
  headRef: string;
  headSha: string;
  baseSha: string;
  /** owner/name of the head repository (differs from the base for forks). */
  headRepoFullName: string | null;
  mergeableState: string | null;
  merged: boolean;
  mergeCommitSha: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  commits: number | null;
  htmlUrl: string;
  openedAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  /** Closing-keyword references parsed from the PR body (GraphQL refs come from the snapshot). */
  linkedIssues: LinkedIssue[];
}

export interface WebhookReview {
  githubId: number;
  reviewerLogin: string | null;
  state: string;
  body: string | null;
  submittedAt: string | null;
  commitId: string | null;
  htmlUrl: string | null;
}

export interface WebhookComment {
  githubId: number;
  authorLogin: string | null;
  body: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Review comments only. */
  path: string | null;
  line: number | null;
  commitId: string | null;
}

export interface WebhookCheck {
  kind: 'check_run' | 'check_suite';
  githubId: number;
  name: string;
  headSha: string;
  status: string | null;
  conclusion: string | null;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  appSlug: string | null;
}

export interface WebhookStatus {
  sha: string;
  context: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
  branches: string[];
}

export interface WebhookPush {
  ref: string;
  /** Branch name for `refs/heads/*` pushes. */
  branch: string;
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  isDefaultBranch: boolean;
  commitCount: number;
  /** Union of added/modified/removed paths in the pushed commits (as reported by GitHub; may be partial). */
  changedPaths: string[];
  headCommitSha: string | null;
}

export interface WebhookInstallation {
  installationId: number;
  appId: number | null;
  accountLogin: string | null;
  accountType: string | null;
  repositorySelection: string | null;
  permissions: Record<string, string>;
  events: string[];
  suspendedAt: string | null;
}

export interface WebhookRepoRef {
  githubId: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
}

interface BaseEvent {
  /** Raw `X-GitHub-Event` name. */
  event: string;
  action: string | null;
  /** GitHub's numeric installation id, when present. */
  installationId: number | null;
  repository: WebhookRepository | null;
  senderLogin: string | null;
  /** Best-effort event time (ISO). */
  occurredAt: string;
  /** PR numbers (within `repository`) directly affected; empty when a lookup by sha is needed. */
  pullRequestNumbers: number[];
}

export interface PullRequestNormalizedEvent extends BaseEvent {
  type: PullRequestEventType;
  pullRequest: WebhookPullRequest;
  /** `edited` events: which fields changed (`title`, `body`, `base`). */
  changedFields: string[];
  /** `synchronize` events: previous/new head sha. */
  beforeSha: string | null;
  afterSha: string | null;
}

export interface ReviewNormalizedEvent extends BaseEvent {
  type: 'review_submitted';
  pullRequest: WebhookPullRequest;
  review: WebhookReview;
}

export interface ReviewCommentNormalizedEvent extends BaseEvent {
  type: 'review_comment';
  pullRequest: WebhookPullRequest;
  comment: WebhookComment;
}

export interface IssueCommentNormalizedEvent extends BaseEvent {
  type: 'issue_comment';
  pullRequestNumber: number;
  comment: WebhookComment;
}

export interface CheckNormalizedEvent extends BaseEvent {
  type: 'check_updated';
  check: WebhookCheck;
}

export interface StatusNormalizedEvent extends BaseEvent {
  type: 'status_updated';
  status: WebhookStatus;
}

export interface PushNormalizedEvent extends BaseEvent {
  type: 'push';
  push: WebhookPush;
}

export interface InstallationNormalizedEvent extends BaseEvent {
  type: 'installation_changed';
  installation: WebhookInstallation;
  /** Repositories listed in the payload (on `created`; may be empty). */
  repositories: WebhookRepoRef[];
}

export interface InstallationReposNormalizedEvent extends BaseEvent {
  type: 'installation_repos_changed';
  installation: WebhookInstallation;
  repositorySelection: string | null;
  repositoriesAdded: WebhookRepoRef[];
  repositoriesRemoved: WebhookRepoRef[];
}

export interface RepositoryNormalizedEvent extends BaseEvent {
  type: 'repository_changed';
  repository: WebhookRepository;
  /** e.g. `{ default_branch: { from: 'master' } }` on edits, `{ repository: { name: { from } } }` on rename. */
  changes: JsonObject;
}

export type NormalizedEvent =
  | PullRequestNormalizedEvent
  | ReviewNormalizedEvent
  | ReviewCommentNormalizedEvent
  | IssueCommentNormalizedEvent
  | CheckNormalizedEvent
  | StatusNormalizedEvent
  | PushNormalizedEvent
  | InstallationNormalizedEvent
  | InstallationReposNormalizedEvent
  | RepositoryNormalizedEvent;

export interface NormalizeWebhookOptions {
  /** Fallback event time (tests). */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

export function parseWebhookRepository(raw: unknown): WebhookRepository | null {
  const r = obj(raw);
  if (!r) return null;
  const githubId = num(r.id);
  const fullName = str(r.full_name);
  if (githubId === null || !fullName || !fullName.includes('/')) return null;
  const [ownerFromName, nameFromName] = fullName.split('/') as [string, string];
  return {
    githubId,
    owner: login(r.owner) ?? ownerFromName,
    name: str(r.name) ?? nameFromName,
    fullName,
    private: bool(r.private) ?? false,
    defaultBranch: str(r.default_branch) ?? str(r.master_branch),
    archived: bool(r.archived) ?? false,
    htmlUrl: str(r.html_url),
  };
}

function parseRepoRef(raw: unknown): WebhookRepoRef | null {
  const r = obj(raw);
  const githubId = num(r?.id);
  const fullName = str(r?.full_name);
  if (!r || githubId === null || !fullName || !fullName.includes('/')) return null;
  const [owner, name] = fullName.split('/') as [string, string];
  return {
    githubId,
    fullName,
    owner,
    name: str(r.name) ?? name,
    private: bool(r.private) ?? false,
  };
}

const CLOSING_KEYWORDS_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)?#(\d+)|https?:\/\/[^\s/]+\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)\/issues\/(\d+))/gi;

/**
 * Parses GitHub closing keywords (`fixes #12`, `closes org/repo#3`,
 * `resolves https://github.com/org/repo/issues/4`) from a PR body.
 * `repo` is set only for cross-repository references.
 */
export function parseClosingReferences(body: string | null | undefined): LinkedIssue[] {
  if (!body) return [];
  const out: LinkedIssue[] = [];
  const seen = new Set<string>();
  // Strip fenced code blocks and HTML comments (PR templates) to avoid false positives.
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  for (const m of text.matchAll(CLOSING_KEYWORDS_RE)) {
    const ref = m[1] ?? '';
    let repo: string | undefined;
    let number: number;
    if (m[4]) {
      repo = m[3];
      number = Number(m[4]);
    } else {
      number = Number(m[2]);
      const hash = ref.indexOf('#');
      if (hash > 0) repo = ref.slice(0, hash);
    }
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const key = `${repo?.toLowerCase() ?? ''}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo ? { number, repo, closing: true } : { number, closing: true });
  }
  return out;
}

export function parseWebhookPullRequest(raw: unknown): WebhookPullRequest | null {
  const p = obj(raw);
  if (!p) return null;
  const number = num(p.number);
  const githubId = num(p.id);
  const head = obj(p.head) ?? {};
  const base = obj(p.base) ?? {};
  const headSha = str(head.sha);
  const baseSha = str(base.sha);
  if (number === null || githubId === null || !headSha || !baseSha) return null;
  const merged = bool(p.merged) === true || str(p.merged_at) !== null;
  const rawState = str(p.state);
  const state: WebhookPullRequest['state'] = merged
    ? 'merged'
    : rawState === 'closed'
      ? 'closed'
      : 'open';
  const body = str(p.body);
  return {
    githubId,
    number,
    title: str(p.title) ?? '',
    body,
    state,
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
    headSha,
    baseSha,
    headRepoFullName: str(obj(head.repo)?.full_name),
    mergeableState: str(p.mergeable_state),
    merged,
    mergeCommitSha: str(p.merge_commit_sha),
    additions: num(p.additions),
    deletions: num(p.deletions),
    changedFiles: num(p.changed_files),
    commits: num(p.commits),
    htmlUrl: str(p.html_url) ?? '',
    openedAt: isoDate(p.created_at),
    updatedAt: isoDate(p.updated_at),
    closedAt: isoDate(p.closed_at),
    mergedAt: isoDate(p.merged_at),
    linkedIssues: parseClosingReferences(body),
  };
}

function parseComment(raw: unknown): WebhookComment | null {
  const c = obj(raw);
  const githubId = num(c?.id);
  if (!c || githubId === null) return null;
  return {
    githubId,
    authorLogin: login(c.user),
    body: str(c.body),
    htmlUrl: str(c.html_url),
    createdAt: isoDate(c.created_at),
    updatedAt: isoDate(c.updated_at),
    path: str(c.path),
    line: num(c.line) ?? num(c.original_line),
    commitId: str(c.commit_id),
  };
}

function parseInstallation(raw: unknown): WebhookInstallation | null {
  const i = obj(raw);
  const installationId = num(i?.id);
  if (!i || installationId === null) return null;
  const account = obj(i.account);
  const permissions: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(i.permissions) ?? {})) {
    if (typeof v === 'string') permissions[k] = v;
  }
  return {
    installationId,
    appId: num(i.app_id),
    accountLogin: str(account?.login) ?? str(account?.slug),
    accountType: str(account?.type),
    repositorySelection: str(i.repository_selection),
    permissions,
    events: arr(i.events).filter((e): e is string => typeof e === 'string'),
    suspendedAt: isoDate(i.suspended_at),
  };
}

function pullNumbersFrom(list: unknown, repoId: number | null): number[] {
  const out: number[] = [];
  for (const item of arr(list)) {
    const pr = obj(item);
    const n = num(pr?.number);
    if (n === null) continue;
    // check_run.pull_requests may include PRs from other repos (forks); keep only those whose base is this repo.
    const baseRepoId = num(obj(obj(pr?.base)?.repo)?.id);
    if (repoId !== null && baseRepoId !== null && baseRepoId !== repoId) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

const PR_ACTION_TYPES: Record<string, PullRequestEventType> = {
  opened: 'pr_opened',
  reopened: 'pr_reopened',
  synchronize: 'pr_synchronized',
  edited: 'pr_edited',
};

const INSTALLATION_ACTIONS = new Set([
  'created',
  'deleted',
  'suspend',
  'unsuspend',
  'new_permissions_accepted',
]);

const REPOSITORY_ACTIONS = new Set([
  'created',
  'deleted',
  'archived',
  'unarchived',
  'edited',
  'renamed',
  'transferred',
  'publicized',
  'privatized',
]);

// ---------------------------------------------------------------------------
// normalizeWebhook
// ---------------------------------------------------------------------------

/**
 * Normalizes a GitHub webhook (event name from `X-GitHub-Event` + parsed JSON
 * payload) into a {@link NormalizedEvent}, or null when the event/action is not
 * relevant (e.g. `ping`, tag pushes, comments on plain issues) or malformed.
 */
export function normalizeWebhook(
  event: string,
  payload: unknown,
  options: NormalizeWebhookOptions = {},
): NormalizedEvent | null {
  const p = obj(payload);
  if (!p || typeof event !== 'string') return null;
  const action = str(p.action);
  const repository = parseWebhookRepository(p.repository);
  const fallbackTime = (options.now ?? new Date()).toISOString();
  const base = (occurredAt: unknown, pullRequestNumbers: number[] = []): BaseEvent => ({
    event,
    action,
    installationId: num(obj(p.installation)?.id),
    repository,
    senderLogin: login(p.sender),
    occurredAt: isoDate(occurredAt) ?? fallbackTime,
    pullRequestNumbers,
  });

  switch (event) {
    case 'pull_request': {
      const pr = parseWebhookPullRequest(p.pull_request);
      if (!pr || !repository || !action) return null;
      let type: PullRequestEventType;
      if (action === 'closed') type = pr.merged ? 'pr_merged' : 'pr_closed';
      // Everything else (labeled, assigned, ready_for_review, review_requested, ...) is a metadata update.
      else type = PR_ACTION_TYPES[action] ?? 'pr_updated';
      const changes = obj(p.changes) ?? {};
      return {
        ...base(action === 'closed' ? (pr.mergedAt ?? pr.closedAt ?? pr.updatedAt) : pr.updatedAt, [
          pr.number,
        ]),
        type,
        pullRequest: pr,
        changedFields: Object.keys(changes),
        beforeSha: action === 'synchronize' ? str(p.before) : null,
        afterSha: action === 'synchronize' ? (str(p.after) ?? pr.headSha) : null,
      };
    }

    case 'pull_request_review': {
      if (action !== 'submitted' && action !== 'edited' && action !== 'dismissed') return null;
      const pr = parseWebhookPullRequest(p.pull_request);
      const r = obj(p.review);
      const reviewId = num(r?.id);
      if (!pr || !repository || !r || reviewId === null) return null;
      const review: WebhookReview = {
        githubId: reviewId,
        reviewerLogin: login(r.user),
        state: (str(r.state) ?? (action === 'dismissed' ? 'dismissed' : 'commented')).toUpperCase(),
        body: str(r.body),
        submittedAt: isoDate(r.submitted_at),
        commitId: str(r.commit_id),
        htmlUrl: str(r.html_url),
      };
      return {
        ...base(review.submittedAt ?? pr.updatedAt, [pr.number]),
        type: 'review_submitted',
        pullRequest: pr,
        review,
      };
    }

    case 'pull_request_review_comment': {
      if (action !== 'created' && action !== 'edited' && action !== 'deleted') return null;
      const pr = parseWebhookPullRequest(p.pull_request);
      const comment = parseComment(p.comment);
      if (!pr || !repository || !comment) return null;
      return {
        ...base(comment.updatedAt ?? comment.createdAt, [pr.number]),
        type: 'review_comment',
        pullRequest: pr,
        comment,
      };
    }

    case 'issue_comment': {
      if (action !== 'created' && action !== 'edited' && action !== 'deleted') return null;
      const issue = obj(p.issue);
      // Only comments on pull requests are relevant.
      if (!issue || !obj(issue.pull_request) || !repository) return null;
      const number = num(issue.number);
      const comment = parseComment(p.comment);
      if (number === null || !comment) return null;
      return {
        ...base(comment.updatedAt ?? comment.createdAt, [number]),
        type: 'issue_comment',
        pullRequestNumber: number,
        comment,
      };
    }

    case 'check_run': {
      const run = obj(p.check_run);
      const id = num(run?.id);
      const headSha = str(run?.head_sha);
      if (!run || id === null || !headSha || !repository) return null;
      const check: WebhookCheck = {
        kind: 'check_run',
        githubId: id,
        name: str(run.name) ?? 'check',
        headSha,
        status: str(run.status),
        conclusion: str(run.conclusion),
        url: str(run.html_url) ?? str(run.details_url),
        startedAt: isoDate(run.started_at),
        completedAt: isoDate(run.completed_at),
        appSlug: str(obj(run.app)?.slug),
      };
      return {
        ...base(
          check.completedAt ?? check.startedAt,
          pullNumbersFrom(run.pull_requests, repository.githubId),
        ),
        type: 'check_updated',
        check,
      };
    }

    case 'check_suite': {
      const suite = obj(p.check_suite);
      const id = num(suite?.id);
      const headSha = str(suite?.head_sha);
      if (!suite || id === null || !headSha || !repository) return null;
      const app = obj(suite.app);
      const check: WebhookCheck = {
        kind: 'check_suite',
        githubId: id,
        name: str(app?.name) ?? str(app?.slug) ?? 'check suite',
        headSha,
        status: str(suite.status),
        conclusion: str(suite.conclusion),
        url: str(suite.url),
        startedAt: isoDate(suite.created_at),
        completedAt: str(suite.status) === 'completed' ? isoDate(suite.updated_at) : null,
        appSlug: str(app?.slug),
      };
      return {
        ...base(suite.updated_at, pullNumbersFrom(suite.pull_requests, repository.githubId)),
        type: 'check_updated',
        check,
      };
    }

    case 'status': {
      const sha = str(p.sha);
      const context = str(p.context);
      const state = str(p.state);
      if (!sha || !context || !state || !repository) return null;
      return {
        ...base(p.updated_at ?? p.created_at),
        type: 'status_updated',
        status: {
          sha,
          context,
          state,
          description: str(p.description),
          targetUrl: str(p.target_url),
          branches: uniqueStrings(arr(p.branches).map((b) => str(obj(b)?.name))),
        },
      };
    }

    case 'push': {
      const ref = str(p.ref);
      const before = str(p.before);
      const after = str(p.after);
      if (!ref || !before || !after || !repository) return null;
      // Only branch pushes matter (tags are ignored).
      if (!ref.startsWith('refs/heads/')) return null;
      const branch = ref.slice('refs/heads/'.length);
      const commits = arr(p.commits);
      const changedPaths = uniqueStrings(
        commits.flatMap((c) => {
          const co = obj(c);
          return [...arr(co?.added), ...arr(co?.modified), ...arr(co?.removed)].map(str);
        }),
      );
      const headCommit = obj(p.head_commit);
      return {
        ...base(headCommit?.timestamp ?? obj(p.repository)?.pushed_at),
        type: 'push',
        push: {
          ref,
          branch,
          before,
          after,
          created: bool(p.created) ?? false,
          deleted: bool(p.deleted) ?? false,
          forced: bool(p.forced) ?? false,
          isDefaultBranch: repository.defaultBranch !== null && repository.defaultBranch === branch,
          commitCount: commits.length,
          changedPaths,
          headCommitSha: str(headCommit?.id),
        },
      };
    }

    case 'installation': {
      if (!action || !INSTALLATION_ACTIONS.has(action)) return null;
      const installation = parseInstallation(p.installation);
      if (!installation) return null;
      return {
        ...base(obj(p.installation)?.updated_at),
        type: 'installation_changed',
        installation,
        repositories: arr(p.repositories)
          .map(parseRepoRef)
          .filter((r): r is WebhookRepoRef => r !== null),
      };
    }

    case 'installation_repositories': {
      if (action !== 'added' && action !== 'removed') return null;
      const installation = parseInstallation(p.installation);
      if (!installation) return null;
      const refs = (list: unknown) =>
        arr(list)
          .map(parseRepoRef)
          .filter((r): r is WebhookRepoRef => r !== null);
      return {
        ...base(obj(p.installation)?.updated_at),
        type: 'installation_repos_changed',
        installation,
        repositorySelection: str(p.repository_selection) ?? installation.repositorySelection,
        repositoriesAdded: refs(p.repositories_added),
        repositoriesRemoved: refs(p.repositories_removed),
      };
    }

    case 'repository': {
      if (!action || !REPOSITORY_ACTIONS.has(action) || !repository) return null;
      return {
        ...base(obj(p.repository)?.updated_at),
        type: 'repository_changed',
        repository,
        changes: obj(p.changes) ?? {},
      };
    }

    default:
      return null;
  }
}
