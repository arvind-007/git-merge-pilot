/**
 * Public types for @gmp/analysis. Everything here is plain JSON-serializable data so it can be
 * persisted (e.g. `analyses.footprint`, `code_symbols`, `code_contracts`) without conversion.
 */
import type {
  CheckStatus,
  ContractKind,
  ContractRole,
  Evidence,
  Finding,
  MergeReadiness,
  RelationshipConfidence,
  RelationshipType,
  RiskLevel,
  RiskScore,
  SymbolKind,
} from '@gmp/core';

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type DiffLineType = 'add' | 'del' | 'context';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  /** Line number in the old file (context + deleted lines). */
  oldLine?: number;
  /** Line number in the new file (context + added lines). */
  newLine?: number;
}

export interface NumberedLine {
  line: number;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@` (usually the enclosing function / section). */
  header: string;
  lines: DiffLine[];
  /** Added lines with their new-file line numbers. */
  added: NumberedLine[];
  /** Removed lines with their old-file line numbers. */
  removed: NumberedLine[];
}

// ---------------------------------------------------------------------------
// Symbols & contracts
// ---------------------------------------------------------------------------

export interface ExtractedSymbol {
  /** Simple name (e.g. `save`). */
  name: string;
  /** Name qualified by its container (e.g. `UserService.save`); equals `name` at top level. */
  qualifiedName: string;
  kind: SymbolKind;
  /** Normalized declaration signature (no body), whitespace collapsed. */
  signature: string;
  /** Visible outside its module/package (export, public, capitalized, no leading `_`, ...). */
  exported: boolean;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** Containing class/struct/interface for methods. */
  parent?: string;
}

export interface Contract {
  kind: ContractKind;
  /**
   * Normalized identifier used for matching:
   * - http_route: `METHOD /path/:param` (METHOD is `ANY` when unknown)
   * - graphql: `Type` or `Type.field`
   * - proto: `pkg.Message`, `pkg.Message.field`, `pkg.Service.Rpc`
   * - env_var: variable name
   * - db_table: lower-cased table name
   * - queue_topic / event: topic, queue or event name
   */
  identifier: string;
  role: ContractRole;
  path: string;
  /** 1-based line of the declaration / usage. */
  line: number;
  /**
   * Extra comparable detail (field type, rpc signature, HTTP framework, ...). A change of
   * `signature` for the same identifier is reported as a modification.
   */
  signature?: string;
  /** Framework / mechanism that produced the contract (e.g. `express`, `prisma`, `kafka`). */
  source?: string;
}

// ---------------------------------------------------------------------------
// Change facts
// ---------------------------------------------------------------------------

export type FileStatus =
  'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface ChangedFileInput {
  path: string;
  status: FileStatus | string;
  previousPath?: string | null;
  /** Unified diff for this file (GitHub `patch`), if available. */
  patch?: string | null;
  /** Full file content before the change (base), if available. */
  before?: string | null;
  /** Full file content after the change (head), if available. */
  after?: string | null;
  additions?: number;
  deletions?: number;
}

/** Subset of the repository profile used by analysis (structurally compatible with @gmp/db). */
export interface RepositoryProfileLike {
  languages?: Record<string, number>;
  frameworks?: string[];
  testFrameworks?: string[];
  packages?: Array<{ name: string; path: string }>;
  [key: string]: unknown;
}

export interface AnalyzeChangesInput {
  repo: string;
  files: ChangedFileInput[];
  profile?: RepositoryProfileLike | null;
}

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface FileFact {
  path: string;
  previousPath?: string;
  status: FileStatus;
  language: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  isTest: boolean;
  isConfig: boolean;
  isMigration: boolean;
  isWorkflow: boolean;
  isDependencyManifest: boolean;
  isDocumentation: boolean;
  isGenerated: boolean;
  /** No patch and no before/after content was available (binary, too large, ...). */
  contentUnavailable: boolean;
}

export interface SymbolChange {
  path: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  change: ChangeKind | 'renamed';
  exported: boolean;
  /** Containing class/struct for methods (qualified). */
  parent?: string;
  /** For renames: the old qualified name. */
  oldName?: string;
  oldSignature?: string;
  newSignature?: string;
  /** New-file line (added/modified/renamed). */
  line?: number;
  /** Old-file line (removed/modified/renamed). */
  oldLine?: number;
  /** Signature differs between before and after (vs. body-only change). */
  signatureChanged: boolean;
  /** `content` when computed from full before/after files, `patch` when from diff hunks only. */
  basis: 'content' | 'patch';
}

export interface ContractChange {
  kind: ContractKind;
  identifier: string;
  role: ContractRole;
  path: string;
  change: ChangeKind;
  line?: number;
  oldLine?: number;
  oldSignature?: string;
  newSignature?: string;
  source?: string;
}

export const SCHEMA_OPERATION_TYPES = [
  'create_table',
  'drop_table',
  'rename_table',
  'add_column',
  'drop_column',
  'rename_column',
  'alter_column_type',
  'set_not_null',
  'drop_not_null',
  'create_index',
  'drop_index',
  'add_constraint',
  'drop_constraint',
  'truncate_table',
] as const;
export type SchemaOperationType = (typeof SCHEMA_OPERATION_TYPES)[number];

export interface SchemaOperation {
  op: SchemaOperationType;
  table: string;
  column?: string;
  /** New name for renames. */
  newName?: string;
  /** For add_column: column is declared NOT NULL. */
  notNull?: boolean;
  /** For add_column: column has a default value. */
  hasDefault?: boolean;
  path: string;
  line: number;
  /** The source statement / line (trimmed, truncated). */
  statement: string;
  /** Mechanism that produced it: `sql`, `rails`, `django`, `alembic`, `knex`, `prisma`, ... */
  source: string;
}

export interface MigrationFact {
  path: string;
  status: FileStatus;
  operations: SchemaOperation[];
}

export interface EnvVarRef {
  name: string;
  path: string;
  line: number;
  role: ContractRole;
  /** `base` when `line` is an old (removed-side) line number. */
  side?: 'base';
}

export type DependencyEcosystem =
  'npm' | 'pypi' | 'go' | 'maven' | 'gradle' | 'rubygems' | 'cargo' | 'composer' | 'other';

export interface DependencyChange {
  manifest: string;
  ecosystem: DependencyEcosystem;
  name: string;
  change: 'added' | 'removed' | 'upgraded' | 'downgraded' | 'changed';
  from?: string;
  to?: string;
  dev: boolean;
  /** Major version changed (semver-ish comparison). */
  major: boolean;
  line?: number;
}

export interface WorkflowChange {
  path: string;
  status: FileStatus;
  /** Notable trigger/permission keywords present in added lines. */
  notes: string[];
}

export type ConfigKind =
  | 'docker'
  | 'compose'
  | 'kubernetes'
  | 'helm'
  | 'terraform'
  | 'env'
  | 'ci'
  | 'build'
  | 'app_config'
  | 'lint'
  | 'other';

export interface ConfigChange {
  path: string;
  status: FileStatus;
  kind: ConfigKind;
  infrastructure: boolean;
}

export type PermissionChangeKind =
  'workflow_permissions' | 'auth_middleware' | 'access_control' | 'codeowners' | 'iam';

export interface PermissionChange {
  path: string;
  line: number;
  kind: PermissionChangeKind;
  change: 'added' | 'removed';
  detail: string;
}

export interface ChangeFacts {
  repo: string;
  files: FileFact[];
  touchedSymbols: SymbolChange[];
  contractsChanged: ContractChange[];
  migrations: MigrationFact[];
  /** Flattened migration + ORM schema operations. */
  schemaOperations: SchemaOperation[];
  envVarsAdded: EnvVarRef[];
  envVarsRemoved: EnvVarRef[];
  dependencyChanges: DependencyChange[];
  testsAdded: string[];
  testsModified: string[];
  testsRemoved: string[];
  /** Non-test source files that changed (used for "missing tests"). */
  sourceFilesChanged: string[];
  workflowChanges: WorkflowChange[];
  configChanges: ConfigChange[];
  permissionChanges: PermissionChange[];
  packagesTouched: string[];
  stats: { files: number; additions: number; deletions: number };
  /** Analysis caveats (missing patches, unparsed languages, ...). */
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Footprint & relationships
// ---------------------------------------------------------------------------

export interface LineRange {
  start: number;
  end: number;
}

export interface FootprintFile {
  path: string;
  status: FileStatus;
  previousPath?: string;
  /** Old-file (base) line ranges touched by the change; used for hunk overlap. */
  ranges: LineRange[];
}

export interface FootprintSymbol {
  path: string;
  name: string;
  kind: SymbolKind;
  change: SymbolChange['change'];
  exported: boolean;
}

export interface FootprintContract {
  kind: ContractKind;
  identifier: string;
  role: ContractRole;
  path: string;
  change: ChangeKind;
}

export interface Footprint {
  repo: string;
  files: FootprintFile[];
  symbols: FootprintSymbol[];
  contracts: FootprintContract[];
  tables: string[];
  envVars: string[];
  packages: string[];
  configFiles: string[];
}

export interface RelationshipPrInput {
  /** Pull request id (uuid in the DB). */
  id: string;
  repo: string;
  /** PR number (enables `depends on #n` resolution). */
  number?: number;
  footprint: Footprint;
  title: string;
  body?: string | null;
  linkedIssues?: Array<{ number: number; repo?: string | null }> | null;
}

export interface IndexedContract {
  repo: string;
  path: string;
  kind: ContractKind;
  identifier: string;
  role: ContractRole;
  line?: number;
}

/** Contract usages indexed from default branches (code_contracts rows), typically consumers. */
export type ContractIndex = ReadonlyArray<IndexedContract>;

export interface Relationship {
  /** Lexicographically smaller PR id (matches the DB check `pr_a_id < pr_b_id`). */
  prAId: string;
  prBId: string;
  /** The PR whose analysis produced the relationship. */
  sourcePrId: string;
  type: RelationshipType;
  confidence: RelationshipConfidence;
  summary: string;
  evidence: Evidence[];
  /** Candidate that requires AI confirmation before being shown as more than `possible`. */
  needsAiConfirmation: boolean;
}

// ---------------------------------------------------------------------------
// Risk & readiness
// ---------------------------------------------------------------------------

export interface CheckInput {
  name: string;
  /** Normalized status, or a raw GitHub status (`queued`, `in_progress`, `completed`, `success`, ...). */
  status: CheckStatus | string;
  /** Raw GitHub conclusion for check runs (`success`, `failure`, ...). */
  conclusion?: string | null;
  /** Set to `false` to mark a check as optional (does not block). Defaults to required. */
  required?: boolean;
  url?: string | null;
}

export interface RiskThresholds {
  critical?: number;
  high?: number;
  medium?: number;
}

export interface ScoreRiskInput {
  facts: ChangeFacts;
  findings: Finding[];
  relationships?: Relationship[];
  checks?: CheckInput[];
  /** GitHub `reviewDecision`: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null. */
  reviewDecision?: string | null;
  /**
   * Reviewers whose latest review is an approval. Used when `reviewDecision` is null (no
   * branch protection): without any approval the PR is `merge_after_checks`.
   */
  approvedReviews?: number;
  /** GitHub `mergeable_state`: clean | dirty | blocked | behind | unstable | draft | unknown ... */
  mergeableState?: string | null;
  projectSettings?: { riskThresholds?: RiskThresholds; [key: string]: unknown } | null;
  /** Open questions / AI-flagged ambiguities. */
  openQuestions?: string[];
  /** Fingerprints of findings that have an acknowledged mitigation. */
  mitigatedFingerprints?: string[];
  draft?: boolean;
}

export interface ScoreRiskResult {
  riskScores: RiskScore[];
  overallRisk: RiskLevel;
  mergeReadiness: MergeReadiness;
}

// ---------------------------------------------------------------------------
// Security scan
// ---------------------------------------------------------------------------

export interface SecurityScanFile {
  path: string;
  status?: FileStatus | string;
  /** Unified diff; when present only ADDED lines are scanned. */
  patch?: string | null;
  /** Full content (used when there is no patch, e.g. new-file indexing). */
  content?: string | null;
}

export interface ExternalScannerOptions {
  /** Enable gitleaks when on PATH (default true when `workdir` is set). */
  gitleaks?: boolean;
  /** Enable semgrep when on PATH (default true when `workdir` is set). */
  semgrep?: boolean;
  /** Semgrep `--config` value (default `p/default`). */
  semgrepConfig?: string;
  /** Per-scanner timeout in ms (default 120000). */
  timeoutMs?: number;
  /** Override PATH lookup (mainly for tests). */
  pathEnv?: string;
}

export interface SecurityScanInput {
  repo?: string;
  files: SecurityScanFile[];
  /** Checked-out working tree (head) for external scanners. */
  workdir?: string | null;
  scanners?: ExternalScannerOptions;
}

export interface SecurityScanReport {
  findings: Finding[];
  scannersRun: string[];
  scannersSkipped: Array<{ name: string; reason: string }>;
}
