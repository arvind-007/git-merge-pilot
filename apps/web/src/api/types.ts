/**
 * Shared API response/request types for the git-merge-pilot SPA.
 *
 * These mirror the server API contract (design §12) and the report schema from @gmp/core
 * (design §5). The web app deliberately does not import @gmp/core at runtime (it would pull zod
 * and Node-only modules into the browser bundle), so the shapes are restated here as plain types.
 *
 * Conventions assumed for the server:
 *  - JSON field names are camelCase (as in the Drizzle row types).
 *  - Timestamps are ISO-8601 strings.
 *  - List endpoints may return either a bare array or an object wrapping it
 *    (`{ items: [...] }` or `{ <resource>: [...] }`); the client normalises both (see `asList`).
 *  - Write-only secrets are never returned; instead a `...Configured: boolean` flag is present.
 *  - Errors are `{ error?: string; message?: string; code?: string; issues?: unknown }`.
 */

// ---------------------------------------------------------------------------
// Enums (mirrors @gmp/core enums.ts)
// ---------------------------------------------------------------------------

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RISK_LEVELS = ['critical', 'high', 'medium', 'low'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RECOMMENDATIONS = [
  'ready_to_merge',
  'merge_after_checks',
  'needs_clarification',
  'changes_required',
  'escalate',
] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const FINDING_CATEGORIES = [
  'security',
  'breaking_change',
  'integration',
  'testing',
  'deployment',
  'database',
  'regression',
  'other',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const RISK_DIMENSIONS = [
  'security',
  'breaking_change',
  'integration',
  'regression',
  'database',
  'deployment',
] as const;
export type RiskDimension = (typeof RISK_DIMENSIONS)[number];

export const RELATIONSHIP_TYPES = [
  'same_file',
  'same_symbol',
  'contract_change',
  'shared_table',
  'shared_config',
  'duplicate_work',
  'depends_on',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_CONFIDENCES = ['confirmed', 'likely', 'possible'] as const;
export type RelationshipConfidence = (typeof RELATIONSHIP_CONFIDENCES)[number];

export const AI_TASKS = ['triage', 'pr_report', 'deep_analysis', 'digest'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const AI_MODES = ['full', 'metadata_only', 'off'] as const;
export type AiMode = (typeof AI_MODES)[number];

export const AI_PROVIDER_KINDS = ['anthropic', 'openai_compatible'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

export const PR_STATES = ['open', 'closed', 'merged'] as const;
export type PrState = (typeof PR_STATES)[number];

export type WebhookDeliveryStatus = 'received' | 'queued' | 'processed' | 'ignored' | 'failed';
export type AnalysisKind = 'full' | 'incremental' | 'readiness_only';
export type AnalysisStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
export type FindingLifecycle = 'new' | 'unchanged' | 'resolved';

export const CHANNEL_KINDS = ['email', 'slack', 'in_app'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export type NotificationStatus = 'pending' | 'sent' | 'deferred' | 'failed' | 'read';

export const NOTIFICATION_KINDS = [
  'pr_analyzed',
  'high_risk',
  'security_finding',
  'breaking_change',
  'overlap_detected',
  'pr_updated_meaningfully',
  'clarification_needed',
  'digest',
  'budget_alert',
  'webhook_failure',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type EvidenceSource = 'diff' | 'index' | 'github' | 'scanner' | 'ai';
export type FindingSource = 'rule' | 'scanner' | 'github' | 'ai';
export type CheckStatus = 'pass' | 'fail' | 'pending' | 'unknown';
export type GeneratedBy = 'ai' | 'deterministic';
export type RollbackDifficulty = 'easy' | 'moderate' | 'hard';

// ---------------------------------------------------------------------------
// Report schema (design §5)
// ---------------------------------------------------------------------------

export interface Evidence {
  repo: string;
  path?: string;
  line?: number;
  endLine?: number;
  url?: string;
  snippet?: string;
  source: EvidenceSource;
  /** `base` when `line` refers to removed code (old line numbers). */
  side?: 'base' | 'head';
  /** Commit the path/line refer to. */
  ref?: string;
}

export interface Finding {
  fingerprint: string;
  category: FindingCategory;
  severity: Severity;
  title: string;
  description: string;
  technicalDetail?: string;
  whatMightBreak?: string;
  affected?: string[];
  recommendation?: string;
  evidence: Evidence[];
  verified: boolean;
  source: FindingSource;
  ruleId?: string;
}

export interface RiskScore {
  dimension: RiskDimension;
  score: number;
  level: RiskLevel;
  rationale: string;
  evidence: Evidence[];
}

export interface ReadinessCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface MergeReadiness {
  recommendation: Recommendation;
  blockers: string[];
  checks: ReadinessCheck[];
  rationale: string;
}

export interface AffectedAreas {
  modules: string[];
  services: string[];
  apis: string[];
  databaseTables: string[];
  sharedComponents: string[];
  integrations: string[];
  configuration: string[];
  infrastructure: string[];
}

export interface OverlappingWork {
  prRef: string;
  type: RelationshipType;
  confidence: RelationshipConfidence;
  summary: string;
  suggestedCoordination?: string;
}

export interface TestingSummary {
  testsAdded: string[];
  testsModified: string[];
  missingTests: string[];
  ciSummary: string;
}

export interface DeploymentSummary {
  migrations: string[];
  envChanges: string[];
  configChanges: string[];
  ordering: string[];
  notes: string;
}

export interface PrReport {
  executiveSummary: string;
  businessImpact: string;
  technicalSummary: string;
  affectedAreas: AffectedAreas;
  breakingChanges: Finding[];
  security: Finding[];
  integrationImpact: Finding[];
  overlappingWork: OverlappingWork[];
  testing: TestingSummary;
  deployment: DeploymentSummary;
  rollback: { difficulty: RollbackDifficulty; notes: string };
  recommendedActions: string[];
  riskScores: RiskScore[];
  overallRisk: RiskLevel;
  mergeReadiness: MergeReadiness;
  confidence: { score: number; rationale: string };
  generatedBy: GeneratedBy;
  limitations: string[];
}

export interface ModelPriceConfig {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  cacheReadPerMTok?: number;
}

export interface TaskModelConfig {
  providerId: string;
  model: string;
  maxOutputTokens: number;
  /** Required for models missing from the built-in price list. */
  price?: ModelPriceConfig;
}
export type TaskModels = Partial<Record<AiTask, TaskModelConfig>>;

export interface AiUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  calls?: number;
  model?: string;
}

// ---------------------------------------------------------------------------
// Setup & auth
// ---------------------------------------------------------------------------

/** GET /api/setup/status */
export interface SetupStatus {
  /** True once the wizard's final "start monitoring" step has run. */
  completed: boolean;
  /** True once the first admin account exists (wizard step 1 done). */
  adminCreated: boolean;
  /** Last wizard step the server recorded (1–7). */
  step: number;
}

/** POST /api/setup/admin */
export interface SetupAdminRequest {
  setupToken: string;
  orgName?: string;
  email: string;
  name: string;
  password: string;
  timezone: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  timezone: string | null;
}

export interface SessionOrg {
  id: string;
  name: string;
  timezone: string;
}

/** GET /api/auth/me, POST /api/auth/login, POST /api/auth/invite/accept */
export interface MeResponse {
  user: SessionUser;
  org: SessionOrg;
  csrfToken: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AcceptInviteRequest {
  token: string;
  name: string;
  password: string;
  timezone?: string;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GithubAppInfo {
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  ownerLogin: string | null;
  clientId?: string;
}

export interface Installation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  permissions: Record<string, string>;
  suspendedAt: string | null;
  createdAt?: string;
}

/** GET /api/github/status */
export interface GithubStatus {
  /** True when a GitHub App has been created and its credentials are stored. */
  connected: boolean;
  app: GithubAppInfo | null;
  /** Link that installs the app (usually `<htmlUrl>/installations/new`). */
  installUrl?: string | null;
  installations: Installation[];
  /** Base web URL of GitHub (e.g. https://github.com); used to build evidence links. */
  webUrl?: string;
  webhookUrl?: string;
  smeeEnabled?: boolean;
  lastDeliveryAt?: string | null;
}

/** POST /api/github/manifest */
export interface ManifestRequest {
  appName?: string;
  /** GitHub organisation login to create the app under; omit for the personal account. */
  org?: string;
  /** Where the callback should send the browser back to. */
  returnTo?: 'setup' | 'settings';
}

export interface ManifestResponse {
  postUrl: string;
  manifest: Record<string, unknown>;
}

/** GET /api/github/repositories — repositories visible through installations. */
export interface AvailableRepository {
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  installationId: number;
  /** Local repository row id when it is already tracked. */
  repositoryId?: string | null;
  monitoringEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface RepositoryProfileData {
  languages?: Record<string, number>;
  frameworks?: string[];
  buildTools?: string[];
  packageManagers?: string[];
  testFrameworks?: string[];
  ciWorkflows?: string[];
  securityTools?: string[];
  codeowners?: string | null;
  prTemplate?: string | null;
  contributing?: string | null;
  architectureDocs?: string[];
  packages?: Array<{ name: string; path: string }>;
  [key: string]: unknown;
}

export interface RepositoryProfile {
  discovered: RepositoryProfileData;
  overrides: RepositoryProfileData;
  headSha: string | null;
  updatedAt?: string;
}

export interface ProjectRef {
  id: string;
  name: string;
}

export interface Repository {
  id: string;
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
  monitoringEnabled: boolean;
  aiMode: AiMode;
  excludePaths: string[];
  lastDiscoveredAt: string | null;
  lastPolledAt: string | null;
  installationId?: string | null;
  projects?: ProjectRef[];
  openPrCount?: number;
  createdAt?: string;
}

/** GET /api/repositories/:id */
export interface RepositoryDetail extends Repository {
  profile: RepositoryProfile | null;
}

/** PATCH /api/repositories/:id */
export interface RepositoryPatch {
  monitoringEnabled?: boolean;
  aiMode?: AiMode;
  excludePaths?: string[];
  profileOverrides?: RepositoryProfileData;
}

/** GET /api/repositories/:id/overview */
export interface RepositoryOverview {
  repository?: Repository;
  openPrs?: PrListItem[];
  riskCounts?: Partial<Record<RiskLevel, number>>;
  recentFindings?: RiskFindingItem[];
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectSettings {
  riskThresholds?: Partial<Record<'critical' | 'high' | 'medium', number>>;
  analysisDepth?: 'standard' | 'deep';
  [key: string]: unknown;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  paused: boolean;
  settings: ProjectSettings;
  createdAt?: string;
  updatedAt?: string;
  repositoryCount?: number;
  memberCount?: number;
  openPrCount?: number;
  riskCounts?: Partial<Record<RiskLevel, number>>;
}

export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
}

/** GET /api/projects/:id */
export interface ProjectDetail extends Project {
  repositories: Repository[];
  members: ProjectMember[];
}

export interface ProjectCreate {
  name: string;
  description?: string | null;
  repositoryIds?: string[];
  settings?: ProjectSettings;
}

export interface ProjectPatch {
  name?: string;
  description?: string | null;
  settings?: ProjectSettings;
}

/** GET /api/projects/:id/overview */
export interface ProjectOverview {
  project?: Project;
  openPrs?: PrListItem[];
  riskCounts?: Partial<Record<RiskLevel, number>>;
  recommendationCounts?: Partial<Record<Recommendation, number>>;
  relationships?: RelationshipItem[];
}

// ---------------------------------------------------------------------------
// Pull requests & analyses
// ---------------------------------------------------------------------------

export interface PrListItem {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  number: number;
  title: string;
  state: PrState;
  draft: boolean;
  authorLogin: string | null;
  htmlUrl: string;
  headSha?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  openedAt?: string | null;
  lastEventAt?: string | null;
  updatedAt?: string;
  overallRisk: RiskLevel | null;
  recommendation: Recommendation | null;
  confidence?: number | null;
  analysisStatus?: AnalysisStatus | null;
  generatedBy?: GeneratedBy | null;
  findingCounts?: Partial<Record<Severity, number>>;
  projectIds?: string[];
}

export interface PrListFilters {
  projectId?: string;
  repositoryId?: string;
  state?: PrState | '';
  risk?: RiskLevel | '';
  author?: string;
}

export interface LinkedIssue {
  number: number;
  repo?: string;
  title?: string;
  url?: string;
  closing?: boolean;
}

export interface PullRequest {
  id: string;
  repositoryId: string;
  githubId: number;
  number: number;
  title: string;
  body: string | null;
  state: PrState;
  draft: boolean;
  authorLogin: string | null;
  assignees: string[];
  requestedReviewers: string[];
  labels: string[];
  baseRef: string;
  headRef: string;
  headSha: string;
  baseSha: string | null;
  mergeableState: string | null;
  reviewDecision: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  htmlUrl: string;
  openedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  lastEventAt: string | null;
  linkedIssues: LinkedIssue[];
}

export interface Analysis {
  id: string;
  pullRequestId: string;
  headSha: string;
  baseSha: string | null;
  previousAnalysisId: string | null;
  kind: AnalysisKind;
  status: AnalysisStatus;
  report: PrReport | null;
  overallRisk: RiskLevel | null;
  recommendation: Recommendation | null;
  confidence: number | null;
  generatedBy: GeneratedBy | null;
  aiUsage: AiUsageSummary | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface FindingRow {
  id: string;
  analysisId: string;
  fingerprint: string;
  category: FindingCategory;
  severity: Severity;
  title: string;
  data: Finding;
  lifecycle: FindingLifecycle;
  verified: boolean;
}

export interface PrRef {
  id: string;
  number: number;
  title: string;
  repositoryFullName: string;
  htmlUrl: string;
  authorLogin?: string | null;
  state?: PrState;
  overallRisk?: RiskLevel | null;
}

/** A relationship as seen from one PR (the "other" PR is resolved by the server). */
export interface RelationshipView {
  id: string;
  type: RelationshipType;
  confidence: RelationshipConfidence;
  summary: string;
  evidence: Evidence[];
  active: boolean;
  otherPr: PrRef;
}

export interface PrCheck {
  id?: string;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  completedAt: string | null;
}

export interface PrReview {
  id?: string;
  reviewerLogin: string;
  state: string;
  submittedAt: string | null;
}

export interface PrFile {
  path: string;
  previousPath?: string | null;
  status: string;
  additions: number;
  deletions: number;
}

/** GET /api/pull-requests/:id */
export interface PullRequestDetail {
  pullRequest: PullRequest;
  repository: Pick<Repository, 'id' | 'fullName' | 'owner' | 'name' | 'aiMode' | 'defaultBranch'> &
    Partial<Repository>;
  analysis: Analysis | null;
  /**
   * The most recent analysis run when it is not `analysis` (e.g. a newer run that is queued,
   * running or failed while an older completed report is shown). Has no report.
   */
  latestRun?: Omit<Analysis, 'report'> | null;
  findings: FindingRow[];
  relationships: RelationshipView[];
  checks: PrCheck[];
  reviews: PrReview[];
  files?: PrFile[];
  /** AI status at the time of the request, used for banners. */
  ai?: AiStatus;
}

export interface AnalysisFindingSummary {
  fingerprint: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  lifecycle: FindingLifecycle;
  verified: boolean;
}

/** GET /api/pull-requests/:id/analyses (each element) */
export interface AnalysisHistoryItem extends Omit<Analysis, 'report'> {
  report?: PrReport | null;
  findings?: AnalysisFindingSummary[];
  findingCounts?: Partial<Record<FindingLifecycle, number>>;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface AiStatus {
  enabled: boolean;
  budgetExhausted: boolean;
  spentUsd?: number;
  capUsd?: number;
  pct?: number;
}

/** GET /api/overview */
export interface OverviewResponse {
  stats?: {
    openPrs?: number;
    highRiskPrs?: number;
    needsAttention?: number;
    projects?: number;
    monitoredRepositories?: number;
    activeOverlaps?: number;
  };
  riskCounts?: Partial<Record<RiskLevel, number>>;
  recommendationCounts?: Partial<Record<Recommendation, number>>;
  attention?: PrListItem[];
  recent?: PrListItem[];
  projects?: Project[];
  ai?: AiStatus;
  github?: { connected: boolean; installations?: number };
}

export interface RiskFindingItem {
  id: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  verified: boolean;
  lifecycle?: FindingLifecycle;
  pullRequest: PrRef;
  data?: Finding;
}

export interface RelationshipItem {
  id: string;
  type: RelationshipType;
  confidence: RelationshipConfidence;
  summary: string;
  prA: PrRef;
  prB: PrRef;
}

/** GET /api/risk-center */
export interface RiskCenterResponse {
  pullRequests: PrListItem[];
  findings: RiskFindingItem[];
  relationships: RelationshipItem[];
}

export interface Developer {
  login: string;
  openPrs: number;
  mergedPrs?: number;
  highRiskPrs: number;
  findings?: number;
  repositories?: string[];
  lastActivityAt?: string | null;
  recommendationCounts?: Partial<Record<Recommendation, number>>;
}

// ---------------------------------------------------------------------------
// AI settings
// ---------------------------------------------------------------------------

export interface AiProvider {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string | null;
  enabled: boolean;
  apiKeyConfigured: boolean;
  createdAt?: string;
}

export interface AiProviderCreate {
  name: string;
  kind: AiProviderKind;
  baseUrl?: string | null;
  apiKey: string;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  detail?: string;
  latencyMs?: number;
}

export interface BudgetStatus {
  spentUsd: number;
  capUsd: number;
  pct: number;
  exhausted: boolean;
}

/** GET /api/settings/ai */
export interface AiSettings {
  enabled: boolean;
  consentAt: string | null;
  consentBy: string | null;
  taskModels: TaskModels;
  monthlyBudgetUsd: number;
  alertThresholdPct: number;
  maxInputTokensPerCall: number;
  budget?: BudgetStatus;
  /** Configured models without a known price: AI is skipped for them until a price is set. */
  unpricedModels?: string[];
  disabledReason?: string | null;
}

/** PUT /api/settings/ai */
export interface AiSettingsUpdate {
  enabled?: boolean;
  /** Must be true the first time AI is enabled; records consent time and admin. */
  consent?: boolean;
  taskModels?: TaskModels;
  monthlyBudgetUsd?: number;
  alertThresholdPct?: number;
  maxInputTokensPerCall?: number;
}

export interface UsageBreakdown {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd: number;
  calls?: number;
}

/** GET /api/usage */
export interface UsageResponse {
  budget: BudgetStatus;
  byTask?: UsageBreakdown[];
  byModel?: UsageBreakdown[];
  daily?: Array<{ date: string; costUsd: number }>;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface EmailChannelConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /**
   * Address used only by the Test button. Notifications go to each recipient user's own
   * account address (admins and project members).
   */
  testRecipient?: string;
}

export interface SlackChannelConfig {
  webhookUrl: string;
}

export interface NotificationChannel {
  id: string;
  kind: ChannelKind;
  name: string;
  enabled: boolean;
  /** True when encrypted config is stored (secret values are never returned). */
  configured: boolean;
  /** Non-secret summary (e.g. "to: a@b.c via smtp.example.com"). */
  summary?: string | null;
  createdAt?: string;
}

export interface NotificationChannelCreate {
  kind: ChannelKind;
  name: string;
  enabled?: boolean;
  config?: EmailChannelConfig | SlackChannelConfig | null;
}

export interface NotificationRule {
  id: string;
  projectId: string | null;
  minSeverity: Severity;
  events: NotificationKind[];
  channelIds: string[];
  digestEnabled: boolean;
  digestHour: number;
  timezone: string | null;
  quietStart: string | null;
  quietEnd: string | null;
  lastDigestAt?: string | null;
}

export type NotificationRuleInput = Omit<NotificationRule, 'id' | 'lastDigestAt'>;

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  severity: Severity | null;
  title: string;
  body: string | null;
  url: string | null;
  status: NotificationStatus;
  readAt: string | null;
  createdAt: string;
  pullRequestId?: string | null;
  projectId?: string | null;
}

// ---------------------------------------------------------------------------
// Users, system, audit
// ---------------------------------------------------------------------------

export interface OrgUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  disabled: boolean;
  timezone: string | null;
  lastLoginAt: string | null;
  createdAt?: string;
}

export interface InviteItem {
  id: string;
  email: string;
  role: UserRole;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt?: string;
}

/** GET /api/users */
export interface UsersResponse {
  users: OrgUser[];
  invites?: InviteItem[];
}

export interface InviteRequest {
  email: string;
  role: UserRole;
}

export interface InviteResponse {
  /** One-time link to send to the invitee. Shown once. */
  inviteUrl: string;
  expiresAt: string;
}

export interface QueueStat {
  name: string;
  queued: number;
  active: number;
  failed: number;
  completed?: number;
}

export interface FailedJob {
  id: string;
  queue: string;
  error: string | null;
  failedAt: string | null;
}

/** GET /api/system/status */
export interface SystemStatus {
  version?: string;
  database?: { ok: boolean };
  queues?: QueueStat[];
  failedJobs?: FailedJob[];
  webhooks?: {
    backlog: number;
    failed24h?: number;
    lastDeliveryAt: string | null;
    lastDeliveryStatus?: WebhookDeliveryStatus | null;
  };
  rateLimit?: { limit: number; remaining: number; resetAt: string | null } | null;
  ai?: BudgetStatus & { enabled?: boolean };
  smeeUrl?: string | null;
  lastPollAt?: string | null;
}

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  userName?: string | null;
  userEmail?: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  data: Record<string, unknown> | null;
  occurredAt: string;
}

export interface AuditLogResponse {
  entries: AuditLogEntry[];
  nextCursor?: string | null;
}
