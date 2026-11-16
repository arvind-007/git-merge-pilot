import type {
  AiMode,
  ContractKind,
  ContractRole,
  Evidence,
  Finding,
  MergeReadiness,
  RelationshipConfidence,
  RelationshipType,
  RiskLevel,
  RiskScore,
} from '@gmp/core';

/**
 * Inputs to report generation. These are structural types: the worker maps `@gmp/analysis` output
 * (ChangeFacts, findings, relationships, scoreRisk result) and DB rows onto them.
 */

export interface RepoContext {
  fullName: string;
  aiMode?: AiMode;
  excludePaths?: readonly string[] | null;
  /** Discovered profile merged with overrides (languages, frameworks, packages …). */
  profile?: RepoProfileSummary | null;
}

export interface RepoProfileSummary {
  languages?: Record<string, number> | string[];
  frameworks?: string[];
  buildTools?: string[];
  packageManagers?: string[];
  testFrameworks?: string[];
  ciWorkflows?: string[];
  securityTools?: string[];
  packages?: Array<{ name: string; path: string }>;
  [key: string]: unknown;
}

export interface ReportPr {
  number: number;
  title: string;
  body?: string | null;
  authorLogin?: string | null;
  baseRef?: string | null;
  headRef?: string | null;
  headSha?: string | null;
  htmlUrl?: string | null;
  draft?: boolean;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  labels?: string[];
  linkedIssues?: Array<{
    number: number;
    repo?: string;
    title?: string;
    url?: string;
    closing?: boolean;
  }>;
  reviewDecision?: string | null;
  mergeableState?: string | null;
}

export interface ReportFile {
  path: string;
  status?: string;
  previousPath?: string | null;
  additions?: number;
  deletions?: number;
  /** Unified diff for the file; null/undefined when unavailable (binary, too large). */
  patch?: string | null;
}

export interface TouchedSymbol {
  name: string;
  path: string;
  kind?: string;
  change: 'added' | 'removed' | 'modified' | 'renamed';
  exported?: boolean;
  oldSignature?: string | null;
  newSignature?: string | null;
}

export interface ChangedContract {
  kind: ContractKind | (string & {});
  identifier: string;
  role?: ContractRole;
  change?: 'added' | 'removed' | 'modified' | (string & {});
  path?: string;
  line?: number;
}

export interface DependencyChange {
  name: string;
  from?: string | null;
  to?: string | null;
  manifest?: string;
  change?: 'added' | 'removed' | 'upgraded' | 'downgraded' | 'modified' | (string & {});
}

/** Subset of `@gmp/analysis` ChangeFacts used by report generation. All fields optional. */
export interface ReportFacts {
  touchedSymbols?: TouchedSymbol[];
  contractsChanged?: ChangedContract[];
  /** Migration file paths (or objects with a path). */
  migrations?: Array<string | { path: string; summary?: string }>;
  envVarsAdded?: string[];
  envVarsRemoved?: string[];
  dependencyChanges?: DependencyChange[];
  testsAdded?: string[];
  testsModified?: string[];
  workflowChanges?: string[];
  configChanges?: string[];
  permissionChanges?: string[];
  packagesTouched?: string[];
  tablesTouched?: string[];
}

export interface ReportRelationship {
  /** Human reference of the other PR, e.g. `owner/repo#12`. */
  prRef: string;
  /** Id of the other PR (lets readers filter entries they may not see). */
  pullRequestId?: string;
  /** Full name of the other PR's repository. */
  repository?: string;
  /**
   * AI data policy of the other PR's repository. Relationships with an `off` repository are
   * never sent to the AI; summaries mentioning its `excludePaths` are withheld.
   */
  aiMode?: AiMode;
  excludePaths?: readonly string[] | null;
  type: RelationshipType;
  confidence: RelationshipConfidence;
  summary: string;
  evidence?: Evidence[];
}

export interface ReportCheck {
  name: string;
  /** GitHub status (`queued`, `in_progress`, `completed`) or normalized status. */
  status?: string | null;
  conclusion?: string | null;
  url?: string | null;
}

export interface ReportRisk {
  riskScores: RiskScore[];
  overallRisk: RiskLevel;
  mergeReadiness: MergeReadiness;
}

export interface ReportInput {
  repo: RepoContext;
  pr: ReportPr;
  files: ReportFile[];
  facts: ReportFacts;
  /** Deterministic findings (breaking, security, other). Kept verbatim in the report. */
  findings: Finding[];
  relationships?: ReportRelationship[];
  checks?: ReportCheck[];
  /** Deterministic scores and readiness from `scoreRisk`. */
  risk: ReportRisk;
  commits?: Array<{ sha?: string; message: string }>;
  /** Present for incremental analyses. */
  previous?: { headSha?: string | null; executiveSummary?: string | null } | null;
  /** Extra limitations from earlier stages (e.g. "symbols not indexed for Rust"). */
  limitations?: string[];
  /** Used to attribute `ai_usage` rows. */
  pullRequestId?: string | null;
  analysisId?: string | null;
}
