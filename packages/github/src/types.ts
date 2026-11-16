/**
 * Public data shapes returned by @gmp/github. They are plain JSON-serialisable
 * objects (ISO date strings) so they can be stored in jsonb / queued as-is.
 */

/** Issue referenced by a PR (shape-compatible with @gmp/db `LinkedIssue`). */
export interface LinkedIssue {
  number: number;
  /** owner/name, set for cross-repository references. */
  repo?: string;
  title?: string;
  url?: string;
  /** True for closing references (closingIssuesReferences / closing keywords). */
  closing?: boolean;
}

export type PrState = 'open' | 'closed' | 'merged';

export type PrFileStatus =
  'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface PrFileSnapshot {
  path: string;
  previousPath: string | null;
  status: PrFileStatus | string;
  additions: number;
  deletions: number;
  changes: number;
  /** Unified diff hunk text; null when GitHub omits it (binary or too large). */
  patch: string | null;
  /** Blob sha of the file at head (null for removed files). */
  sha: string | null;
  blobUrl: string | null;
}

export interface PrCommitSnapshot {
  sha: string;
  message: string;
  authorLogin: string | null;
  authorName: string | null;
  committedAt: string | null;
}

export interface PrReviewSnapshot {
  githubId: number;
  reviewerLogin: string | null;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string;
  submittedAt: string | null;
  body: string | null;
  commitId: string | null;
}

export interface PrCheckSnapshot {
  kind: 'check_run' | 'status';
  name: string;
  /** check runs: queued | in_progress | completed | waiting | requested | pending; statuses: pending | completed */
  status: string;
  /** success | failure | neutral | cancelled | skipped | timed_out | action_required | stale | error | null */
  conclusion: string | null;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  appSlug: string | null;
}

export interface SecurityAlertSummary {
  /** Alert number within the repository. */
  number: number;
  state: string;
  /** critical | high | medium | low | warning | note | error | null */
  severity: string | null;
  ruleId: string | null;
  title: string;
  path: string | null;
  startLine: number | null;
  url: string | null;
  tool: string | null;
  /** Dependabot only. */
  packageName?: string | null;
  ecosystem?: string | null;
  manifestPath?: string | null;
  ghsaId?: string | null;
  cveId?: string | null;
  fixedIn?: string | null;
  createdAt: string | null;
}

export interface OptionalAlerts {
  /** False when the endpoint was not available (permission, feature disabled, 404). */
  available: boolean;
  /** Why it is unavailable (e.g. "HTTP 403: Resource not accessible by integration"). */
  reason: string | null;
  alerts: SecurityAlertSummary[];
  /** True when more alerts existed than were fetched. */
  truncated: boolean;
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

export interface PrMeta {
  githubId: number;
  number: number;
  title: string;
  body: string | null;
  state: PrState;
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
  headRepoFullName: string | null;
  isCrossRepository: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  mergeCommitSha: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitsCount: number;
  /** Issue (conversation) comment count. */
  commentsCount: number;
  /** Review (inline diff) comment count. */
  reviewCommentsCount: number;
  htmlUrl: string;
  openedAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface PrSnapshot {
  pullRequest: PrMeta;
  files: PrFileSnapshot[];
  /** True when GitHub's 3000-file cap (or `maxFiles`) was hit. */
  filesTruncated: boolean;
  commits: PrCommitSnapshot[];
  /** True when the PR has more commits than the API returns (250). */
  commitsTruncated: boolean;
  reviews: PrReviewSnapshot[];
  reviewCommentsCount: number;
  checks: PrCheckSnapshot[];
  reviewDecision: ReviewDecision | null;
  mergeableState: string | null;
  linkedIssues: LinkedIssue[];
  codeScanningAlerts: OptionalAlerts;
  dependabotAlerts: OptionalAlerts;
  /** Human-readable notes about data that could not be fetched. */
  limitations: string[];
  fetchedAt: string;
}

export interface PrSummary {
  githubId: number;
  number: number;
  title: string;
  state: PrState;
  draft: boolean;
  authorLogin: string | null;
  labels: string[];
  baseRef: string;
  headRef: string;
  headSha: string;
  baseSha: string;
  htmlUrl: string;
  openedAt: string | null;
  updatedAt: string | null;
}

export type CompareStatus = 'ahead' | 'behind' | 'identical' | 'diverged';

export interface CompareResult {
  status: CompareStatus;
  aheadBy: number;
  behindBy: number;
  totalCommits: number;
  mergeBaseSha: string | null;
  commits: PrCommitSnapshot[];
  files: PrFileSnapshot[];
  /** True when GitHub's 300-file compare cap was likely hit. */
  filesTruncated: boolean;
  htmlUrl: string | null;
}

export interface WorkspacePackage {
  name: string;
  /** Directory relative to the repo root ('' never; root is not a package). */
  path: string;
  ecosystem: string;
}

export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

/**
 * Discovered repository profile (design §6 `repository_profiles.discovered`).
 * A type alias (not an interface) so it is assignable to @gmp/db's
 * `RepositoryProfileData`.
 */
export type RepositoryProfile = {
  /** Bytes per language from the languages API. */
  languages: Record<string, number>;
  primaryLanguage: string | null;
  frameworks: string[];
  buildTools: string[];
  packageManagers: string[];
  testFrameworks: string[];
  /** CI systems detected (github_actions, gitlab_ci, circleci, jenkins, ...). */
  ciSystems: string[];
  /** Paths of GitHub Actions workflow files. */
  ciWorkflows: string[];
  /** codeql, dependabot, renovate, semgrep, gitleaks, snyk, trivy, ... */
  securityTools: string[];
  /** Infrastructure-as-code / deployment tooling (docker, terraform, helm, ...). */
  infrastructure: string[];
  /** Path of the effective CODEOWNERS file (GitHub precedence: .github/, root, docs/). */
  codeowners: string | null;
  /** Every CODEOWNERS file present, in precedence order. */
  codeownersFiles: string[];
  codeownersRules: CodeownersRule[];
  /** Path of the primary PR template. */
  prTemplate: string | null;
  prTemplates: string[];
  contributing: string | null;
  securityPolicy: string | null;
  /** ARCHITECTURE.md, ADR directories, design docs. */
  architectureDocs: string[];
  docsDirs: string[];
  adrDirs: string[];
  /** Workspace / monorepo packages. */
  packages: WorkspacePackage[];
  /** npm/yarn/pnpm workspaces, lerna, nx, turborepo, rush, go_work, cargo_workspace, maven_modules, gradle_multiproject, uv_workspace, heuristic */
  monorepoTools: string[];
  isMonorepo: boolean;
  /** Manifest files that were found. */
  manifests: string[];
  defaultBranch: string;
  /** Ref requested (or the default branch). */
  ref: string;
  /** Commit sha the profile was computed at. */
  headSha: string;
  treeTruncated: boolean;
  limitations: string[];
  discoveredAt: string;
};
