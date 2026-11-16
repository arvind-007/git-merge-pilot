/**
 * git-merge-pilot database schema (design §6).
 *
 * Conventions:
 * - every table: `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at` (timestamptz)
 * - tenant-owned tables carry `org_id` → organizations (ON DELETE CASCADE)
 * - child rows of a PR / repository / project cascade with their parent
 * - enumerations are stored as text, typed with the const arrays from @gmp/core
 * - GitHub numeric ids are bigint (JS number mode; safe below 2^53)
 * - columns ending in `_enc` hold `encrypt()` blobs from @gmp/core, never plaintext
 */
import {
  ANALYSIS_KINDS,
  ANALYSIS_STATUSES,
  AI_MODES,
  AI_PROVIDER_KINDS,
  CHANNEL_KINDS,
  CONTRACT_KINDS,
  CONTRACT_ROLES,
  FINDING_CATEGORIES,
  FINDING_LIFECYCLES,
  GENERATED_BY,
  NOTIFICATION_STATUSES,
  PR_STATES,
  RECOMMENDATIONS,
  RELATIONSHIP_CONFIDENCES,
  RELATIONSHIP_TYPES,
  RISK_LEVELS,
  SEVERITIES,
  SYMBOL_KINDS,
  USER_ROLES,
  WEBHOOK_DELIVERY_STATUSES,
  type AiUsageSummary,
  type Evidence,
  type Finding,
  type PrReport,
  type TaskModels,
} from '@gmp/core';
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

const id = () => uuid('id').primaryKey().defaultRandom();
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const timestamps = () => ({
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
const orgId = () =>
  uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });
const githubId = (name: string) => bigint(name, { mode: 'number' });
const textArray = (name: string) =>
  text(name)
    .array()
    .notNull()
    .default(sql`'{}'::text[]`);

// ---------------------------------------------------------------------------
// JSON shapes stored in jsonb columns
// ---------------------------------------------------------------------------

export interface OrganizationSettings {
  [key: string]: unknown;
}

export interface ProjectSettings {
  riskThresholds?: Partial<Record<'critical' | 'high' | 'medium', number>>;
  analysisDepth?: 'standard' | 'deep';
  [key: string]: unknown;
}

/** Discovered repository profile (filled by @gmp/github discoverRepository). */
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

export interface LinkedIssue {
  number: number;
  repo?: string;
  title?: string;
  url?: string;
  closing?: boolean;
}

// ---------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  settings: jsonb('settings').$type<OrganizationSettings>().notNull().default({}),
  ...timestamps(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    orgId: orgId(),
    /** Stored lower-cased; uniqueness is case-insensitive per org. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull().default('member'),
    disabled: boolean('disabled').notNull().default(false),
    timezone: text('timezone'),
    lastLoginAt: tstz('last_login_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('users_org_email_uq').on(t.orgId, sql`lower(${t.email})`),
    index('users_org_idx').on(t.orgId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256Hex of the session token held in the cookie. */
    tokenHash: text('token_hash').notNull().unique('sessions_token_hash_uq'),
    csrfToken: text('csrf_token').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    ...timestamps(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const invites = pgTable(
  'invites',
  {
    id: id(),
    orgId: orgId(),
    email: text('email').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull().default('member'),
    tokenHash: text('token_hash').notNull().unique('invites_token_hash_uq'),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [index('invites_org_idx').on(t.orgId)],
);

/** Single-row table (enforced by the `singleton` unique + check). */
export const systemState = pgTable(
  'system_state',
  {
    id: id(),
    singleton: boolean('singleton').notNull().default(true).unique('system_state_singleton_uq'),
    setupTokenHash: text('setup_token_hash'),
    setupCompletedAt: tstz('setup_completed_at'),
    setupStep: integer('setup_step').notNull().default(1),
    ...timestamps(),
  },
  (t) => [check('system_state_singleton_ck', sql`${t.singleton} = true`)],
);

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const githubApps = pgTable(
  'github_apps',
  {
    id: id(),
    orgId: orgId(),
    appId: githubId('app_id').notNull().unique('github_apps_app_id_uq'),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    clientId: text('client_id').notNull(),
    clientSecretEnc: text('client_secret_enc').notNull(),
    privateKeyEnc: text('private_key_enc').notNull(),
    webhookSecretEnc: text('webhook_secret_enc').notNull(),
    htmlUrl: text('html_url').notNull(),
    ownerLogin: text('owner_login'),
    ...timestamps(),
  },
  (t) => [index('github_apps_org_idx').on(t.orgId)],
);

export const installations = pgTable(
  'installations',
  {
    id: id(),
    orgId: orgId(),
    githubAppId: uuid('github_app_id')
      .notNull()
      .references(() => githubApps.id, { onDelete: 'cascade' }),
    /** GitHub's numeric installation id. */
    installationId: githubId('installation_id')
      .notNull()
      .unique('installations_installation_id_uq'),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull(),
    repositorySelection: text('repository_selection').notNull().default('selected'),
    permissions: jsonb('permissions').$type<Record<string, string>>().notNull().default({}),
    suspendedAt: tstz('suspended_at'),
    ...timestamps(),
  },
  (t) => [
    index('installations_org_idx').on(t.orgId),
    index('installations_app_idx').on(t.githubAppId),
  ],
);

export const repositories = pgTable(
  'repositories',
  {
    id: id(),
    orgId: orgId(),
    /**
     * FK to installations.id (uuid), not GitHub's numeric installation id.
     * SET NULL (not cascade) so uninstalling/disconnecting keeps PR history.
     */
    installationId: uuid('installation_id').references(() => installations.id, {
      onDelete: 'set null',
    }),
    githubId: githubId('github_id').notNull(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    private: boolean('private').notNull().default(true),
    defaultBranch: text('default_branch').notNull().default('main'),
    archived: boolean('archived').notNull().default(false),
    monitoringEnabled: boolean('monitoring_enabled').notNull().default(true),
    aiMode: text('ai_mode', { enum: AI_MODES }).notNull().default('full'),
    excludePaths: textArray('exclude_paths'),
    lastDiscoveredAt: tstz('last_discovered_at'),
    lastPolledAt: tstz('last_polled_at'),
    ...timestamps(),
  },
  (t) => [
    unique('repositories_org_github_id_uq').on(t.orgId, t.githubId),
    index('repositories_org_full_name_idx').on(t.orgId, t.fullName),
    index('repositories_installation_idx').on(t.installationId),
  ],
);

export const repositoryProfiles = pgTable('repository_profiles', {
  id: id(),
  repositoryId: uuid('repository_id')
    .notNull()
    .unique('repository_profiles_repository_uq')
    .references(() => repositories.id, { onDelete: 'cascade' }),
  discovered: jsonb('discovered').$type<RepositoryProfileData>().notNull().default({}),
  overrides: jsonb('overrides').$type<RepositoryProfileData>().notNull().default({}),
  headSha: text('head_sha'),
  ...timestamps(),
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: id(),
    orgId: orgId(),
    name: text('name').notNull(),
    description: text('description'),
    paused: boolean('paused').notNull().default(false),
    settings: jsonb('settings').$type<ProjectSettings>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [unique('projects_org_name_uq').on(t.orgId, t.name)],
);

export const projectRepositories = pgTable(
  'project_repositories',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    ...timestamps(),
  },
  (t) => [
    unique('project_repositories_pair_uq').on(t.projectId, t.repositoryId),
    index('project_repositories_repo_idx').on(t.repositoryId),
  ],
);

export const projectMembers = pgTable(
  'project_members',
  {
    id: id(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps(),
  },
  (t) => [
    unique('project_members_pair_uq').on(t.projectId, t.userId),
    index('project_members_user_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: id(),
    orgId: orgId(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    githubId: githubId('github_id').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    state: text('state', { enum: PR_STATES }).notNull().default('open'),
    draft: boolean('draft').notNull().default(false),
    authorLogin: text('author_login'),
    assignees: textArray('assignees'),
    requestedReviewers: textArray('requested_reviewers'),
    labels: textArray('labels'),
    baseRef: text('base_ref').notNull(),
    headRef: text('head_ref').notNull(),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha'),
    mergeableState: text('mergeable_state'),
    /** GraphQL reviewDecision: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null */
    reviewDecision: text('review_decision'),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    changedFiles: integer('changed_files').notNull().default(0),
    htmlUrl: text('html_url').notNull(),
    openedAt: tstz('opened_at'),
    closedAt: tstz('closed_at'),
    mergedAt: tstz('merged_at'),
    lastEventAt: tstz('last_event_at'),
    linkedIssues: jsonb('linked_issues').$type<LinkedIssue[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [
    unique('pull_requests_repo_number_uq').on(t.repositoryId, t.number),
    index('pull_requests_org_state_idx').on(t.orgId, t.state),
    index('pull_requests_author_idx').on(t.orgId, t.authorLogin),
    index('pull_requests_github_id_idx').on(t.githubId),
  ],
);

const pullRequestFk = () =>
  uuid('pull_request_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' });

export const prFiles = pgTable(
  'pr_files',
  {
    id: id(),
    pullRequestId: pullRequestFk(),
    headSha: text('head_sha').notNull(),
    path: text('path').notNull(),
    previousPath: text('previous_path'),
    /** added | removed | modified | renamed | copied | changed | unchanged */
    status: text('status').notNull(),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    ...timestamps(),
  },
  (t) => [unique('pr_files_pr_sha_path_uq').on(t.pullRequestId, t.headSha, t.path)],
);

export const prCommits = pgTable(
  'pr_commits',
  {
    id: id(),
    pullRequestId: pullRequestFk(),
    sha: text('sha').notNull(),
    message: text('message').notNull().default(''),
    authorLogin: text('author_login'),
    committedAt: tstz('committed_at'),
    ...timestamps(),
  },
  (t) => [unique('pr_commits_pr_sha_uq').on(t.pullRequestId, t.sha)],
);

export const prReviews = pgTable(
  'pr_reviews',
  {
    id: id(),
    pullRequestId: pullRequestFk(),
    githubId: githubId('github_id').notNull(),
    reviewerLogin: text('reviewer_login'),
    /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
    state: text('state').notNull(),
    submittedAt: tstz('submitted_at'),
    body: text('body'),
    ...timestamps(),
  },
  (t) => [unique('pr_reviews_pr_github_id_uq').on(t.pullRequestId, t.githubId)],
);

export const prChecks = pgTable(
  'pr_checks',
  {
    id: id(),
    pullRequestId: pullRequestFk(),
    headSha: text('head_sha').notNull(),
    name: text('name').notNull(),
    /** queued | in_progress | completed | pending (commit statuses) */
    status: text('status').notNull(),
    /** success | failure | neutral | cancelled | skipped | timed_out | action_required | error | null */
    conclusion: text('conclusion'),
    url: text('url'),
    completedAt: tstz('completed_at'),
    ...timestamps(),
  },
  (t) => [unique('pr_checks_pr_sha_name_uq').on(t.pullRequestId, t.headSha, t.name)],
);

// ---------------------------------------------------------------------------
// Webhooks & events
// ---------------------------------------------------------------------------

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
    /** X-GitHub-Delivery header; dedup key. */
    deliveryId: text('delivery_id').notNull().unique('webhook_deliveries_delivery_id_uq'),
    event: text('event').notNull(),
    action: text('action'),
    /** GitHub's numeric installation id from the payload. */
    installationId: githubId('installation_id'),
    repositoryFullName: text('repository_full_name'),
    /** Nulled by retention cleanup after 30 days. */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    status: text('status', { enum: WEBHOOK_DELIVERY_STATUSES }).notNull().default('received'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    processedAt: tstz('processed_at'),
    ...timestamps(),
  },
  (t) => [
    index('webhook_deliveries_status_idx').on(t.status, t.receivedAt),
    index('webhook_deliveries_received_idx').on(t.receivedAt),
  ],
);

export const prEvents = pgTable(
  'pr_events',
  {
    id: id(),
    orgId: orgId(),
    pullRequestId: pullRequestFk(),
    type: text('type').notNull(),
    actorLogin: text('actor_login'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: tstz('occurred_at').notNull().defaultNow(),
    /** X-GitHub-Delivery id that produced this event, when applicable. */
    deliveryId: text('delivery_id'),
    ...timestamps(),
  },
  (t) => [index('pr_events_pr_occurred_idx').on(t.pullRequestId, t.occurredAt)],
);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export const analyses = pgTable(
  'analyses',
  {
    id: id(),
    orgId: orgId(),
    pullRequestId: pullRequestFk(),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha'),
    previousAnalysisId: uuid('previous_analysis_id'),
    kind: text('kind', { enum: ANALYSIS_KINDS }).notNull().default('full'),
    status: text('status', { enum: ANALYSIS_STATUSES }).notNull().default('queued'),
    report: jsonb('report').$type<PrReport>(),
    overallRisk: text('overall_risk', { enum: RISK_LEVELS }),
    recommendation: text('recommendation', { enum: RECOMMENDATIONS }),
    /** 0..100 */
    confidence: integer('confidence'),
    generatedBy: text('generated_by', { enum: GENERATED_BY }),
    footprint: jsonb('footprint').$type<Record<string, unknown>>(),
    aiUsage: jsonb('ai_usage').$type<AiUsageSummary>(),
    error: text('error'),
    startedAt: tstz('started_at'),
    completedAt: tstz('completed_at'),
    ...timestamps(),
  },
  (t) => [
    unique('analyses_pr_sha_kind_uq').on(t.pullRequestId, t.headSha, t.kind),
    index('analyses_pr_created_idx').on(t.pullRequestId, t.createdAt),
    index('analyses_org_status_idx').on(t.orgId, t.status),
    // Self-reference declared as a table-level FK to avoid a circular column type.
    foreignKey({
      name: 'analyses_previous_analysis_id_fk',
      columns: [t.previousAnalysisId],
      foreignColumns: [t.id],
    }).onDelete('set null'),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: id(),
    orgId: orgId(),
    analysisId: uuid('analysis_id')
      .notNull()
      .references(() => analyses.id, { onDelete: 'cascade' }),
    pullRequestId: pullRequestFk(),
    fingerprint: text('fingerprint').notNull(),
    category: text('category', { enum: FINDING_CATEGORIES }).notNull(),
    severity: text('severity', { enum: SEVERITIES }).notNull(),
    title: text('title').notNull(),
    data: jsonb('data').$type<Finding>().notNull(),
    lifecycle: text('lifecycle', { enum: FINDING_LIFECYCLES }).notNull().default('new'),
    verified: boolean('verified').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    unique('findings_analysis_fingerprint_uq').on(t.analysisId, t.fingerprint),
    index('findings_pr_fingerprint_idx').on(t.pullRequestId, t.fingerprint),
    index('findings_org_severity_idx').on(t.orgId, t.severity),
  ],
);

export const prRelationships = pgTable(
  'pr_relationships',
  {
    id: id(),
    orgId: orgId(),
    /** Always the smaller uuid of the pair (enforced by check constraint). */
    prAId: uuid('pr_a_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    prBId: uuid('pr_b_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    type: text('type', { enum: RELATIONSHIP_TYPES }).notNull(),
    confidence: text('confidence', { enum: RELATIONSHIP_CONFIDENCES }).notNull(),
    summary: text('summary').notNull(),
    evidence: jsonb('evidence').$type<Evidence[]>().notNull().default([]),
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique('pr_relationships_pair_type_uq').on(t.prAId, t.prBId, t.type),
    check('pr_relationships_order_ck', sql`${t.prAId} < ${t.prBId}`),
    index('pr_relationships_pr_b_idx').on(t.prBId),
    index('pr_relationships_org_active_idx').on(t.orgId, t.active),
  ],
);

export const codeSymbols = pgTable(
  'code_symbols',
  {
    id: id(),
    orgId: orgId(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    refSha: text('ref_sha').notNull(),
    path: text('path').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: SYMBOL_KINDS }).notNull(),
    signature: text('signature'),
    exported: boolean('exported').notNull().default(false),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('code_symbols_repo_ref_idx').on(t.repositoryId, t.refSha),
    index('code_symbols_repo_name_idx').on(t.repositoryId, t.name),
  ],
);

export const codeContracts = pgTable(
  'code_contracts',
  {
    id: id(),
    orgId: orgId(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    refSha: text('ref_sha').notNull(),
    kind: text('kind', { enum: CONTRACT_KINDS }).notNull(),
    identifier: text('identifier').notNull(),
    role: text('role', { enum: CONTRACT_ROLES }).notNull(),
    path: text('path').notNull(),
    line: integer('line'),
    ...timestamps(),
  },
  (t) => [
    index('code_contracts_org_kind_identifier_idx').on(t.orgId, t.kind, t.identifier),
    index('code_contracts_repo_ref_idx').on(t.repositoryId, t.refSha),
  ],
);

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export const aiProviders = pgTable(
  'ai_providers',
  {
    id: id(),
    orgId: orgId(),
    name: text('name').notNull(),
    kind: text('kind', { enum: AI_PROVIDER_KINDS }).notNull(),
    baseUrl: text('base_url'),
    apiKeyEnc: text('api_key_enc'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('ai_providers_org_idx').on(t.orgId)],
);

export const aiSettings = pgTable('ai_settings', {
  id: id(),
  orgId: uuid('org_id')
    .notNull()
    .unique('ai_settings_org_uq')
    .references(() => organizations.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  consentAt: tstz('consent_at'),
  consentBy: uuid('consent_by').references(() => users.id, { onDelete: 'set null' }),
  taskModels: jsonb('task_models').$type<TaskModels>().notNull().default({}),
  monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 12, scale: 2, mode: 'number' })
    .notNull()
    .default(100),
  alertThresholdPct: integer('alert_threshold_pct').notNull().default(80),
  maxInputTokensPerCall: integer('max_input_tokens_per_call').notNull().default(120000),
  ...timestamps(),
});

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: id(),
    orgId: orgId(),
    task: text('task').notNull(),
    providerKind: text('provider_kind', { enum: AI_PROVIDER_KINDS }).notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 6, mode: 'number' }).notNull().default(0),
    pullRequestId: uuid('pull_request_id').references(() => pullRequests.id, {
      onDelete: 'set null',
    }),
    analysisId: uuid('analysis_id').references(() => analyses.id, { onDelete: 'set null' }),
    occurredAt: tstz('occurred_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [index('ai_usage_org_occurred_idx').on(t.orgId, t.occurredAt)],
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: id(),
    orgId: orgId(),
    kind: text('kind', { enum: CHANNEL_KINDS }).notNull(),
    name: text('name').notNull(),
    /** encryptJson() of the channel config (SMTP settings / Slack webhook URL); null for in_app. */
    configEnc: text('config_enc'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('notification_channels_org_idx').on(t.orgId)],
);

export const notificationRules = pgTable(
  'notification_rules',
  {
    id: id(),
    orgId: orgId(),
    /** null = org-wide default rule. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    minSeverity: text('min_severity', { enum: SEVERITIES }).notNull().default('high'),
    events: textArray('events'),
    channelIds: uuid('channel_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    digestEnabled: boolean('digest_enabled').notNull().default(true),
    /** Local hour (0-23) in `timezone`. */
    digestHour: integer('digest_hour').notNull().default(9),
    timezone: text('timezone').notNull().default('UTC'),
    /** "HH:MM" local time, inclusive start of quiet hours. */
    quietStart: text('quiet_start'),
    /** "HH:MM" local time, exclusive end of quiet hours. */
    quietEnd: text('quiet_end'),
    /** When the daily digest was last produced for this rule (worker bookkeeping). */
    lastDigestAt: tstz('last_digest_at'),
    ...timestamps(),
  },
  (t) => [
    index('notification_rules_org_project_idx').on(t.orgId, t.projectId),
    check('notification_rules_digest_hour_ck', sql`${t.digestHour} between 0 and 23`),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    orgId: orgId(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    pullRequestId: uuid('pull_request_id').references(() => pullRequests.id, {
      onDelete: 'set null',
    }),
    /** Target channel for email/slack rows; null for in-app rows. */
    channelId: uuid('channel_id').references(() => notificationChannels.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    severity: text('severity', { enum: SEVERITIES }).notNull().default('info'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    url: text('url'),
    dedupKey: text('dedup_key').notNull(),
    channelKind: text('channel_kind', { enum: CHANNEL_KINDS }).notNull(),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('pending'),
    sendAfter: tstz('send_after'),
    sentAt: tstz('sent_at'),
    readAt: tstz('read_at'),
    error: text('error'),
    ...timestamps(),
  },
  (t) => [
    unique('notifications_dedup_uq').on(t.dedupKey, t.channelKind, t.userId).nullsNotDistinct(),
    index('notifications_org_status_send_idx').on(t.orgId, t.status, t.sendAfter),
    index('notifications_user_read_idx').on(t.userId, t.readAt),
  ],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    orgId: orgId(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    ip: text('ip'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: tstz('occurred_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [index('audit_log_org_occurred_idx').on(t.orgId, t.occurredAt)],
);

// ---------------------------------------------------------------------------
// Relations (for db.query.* relational API)
// ---------------------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many, one }) => ({
  users: many(users),
  projects: many(projects),
  repositories: many(repositories),
  githubApps: many(githubApps),
  aiSettings: one(aiSettings),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, { fields: [users.orgId], references: [organizations.id] }),
  sessions: many(sessions),
  projectMemberships: many(projectMembers),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const githubAppsRelations = relations(githubApps, ({ one, many }) => ({
  organization: one(organizations, { fields: [githubApps.orgId], references: [organizations.id] }),
  installations: many(installations),
}));

export const installationsRelations = relations(installations, ({ one, many }) => ({
  githubApp: one(githubApps, { fields: [installations.githubAppId], references: [githubApps.id] }),
  repositories: many(repositories),
}));

export const repositoriesRelations = relations(repositories, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [repositories.orgId],
    references: [organizations.id],
  }),
  installation: one(installations, {
    fields: [repositories.installationId],
    references: [installations.id],
  }),
  profile: one(repositoryProfiles),
  projectLinks: many(projectRepositories),
  pullRequests: many(pullRequests),
}));

export const repositoryProfilesRelations = relations(repositoryProfiles, ({ one }) => ({
  repository: one(repositories, {
    fields: [repositoryProfiles.repositoryId],
    references: [repositories.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, { fields: [projects.orgId], references: [organizations.id] }),
  repositoryLinks: many(projectRepositories),
  members: many(projectMembers),
}));

export const projectRepositoriesRelations = relations(projectRepositories, ({ one }) => ({
  project: one(projects, { fields: [projectRepositories.projectId], references: [projects.id] }),
  repository: one(repositories, {
    fields: [projectRepositories.repositoryId],
    references: [repositories.id],
  }),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));

export const pullRequestsRelations = relations(pullRequests, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [pullRequests.repositoryId],
    references: [repositories.id],
  }),
  files: many(prFiles),
  commits: many(prCommits),
  reviews: many(prReviews),
  checks: many(prChecks),
  events: many(prEvents),
  analyses: many(analyses),
  findings: many(findings),
}));

export const prFilesRelations = relations(prFiles, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [prFiles.pullRequestId],
    references: [pullRequests.id],
  }),
}));

export const prCommitsRelations = relations(prCommits, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [prCommits.pullRequestId],
    references: [pullRequests.id],
  }),
}));

export const prReviewsRelations = relations(prReviews, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [prReviews.pullRequestId],
    references: [pullRequests.id],
  }),
}));

export const prChecksRelations = relations(prChecks, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [prChecks.pullRequestId],
    references: [pullRequests.id],
  }),
}));

export const prEventsRelations = relations(prEvents, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [prEvents.pullRequestId],
    references: [pullRequests.id],
  }),
}));

export const analysesRelations = relations(analyses, ({ one, many }) => ({
  pullRequest: one(pullRequests, {
    fields: [analyses.pullRequestId],
    references: [pullRequests.id],
  }),
  previousAnalysis: one(analyses, {
    fields: [analyses.previousAnalysisId],
    references: [analyses.id],
    relationName: 'analysis_previous',
  }),
  findings: many(findings),
}));

export const findingsRelations = relations(findings, ({ one }) => ({
  analysis: one(analyses, { fields: [findings.analysisId], references: [analyses.id] }),
  pullRequest: one(pullRequests, {
    fields: [findings.pullRequestId],
    references: [pullRequests.id],
  }),
}));

export const prRelationshipsRelations = relations(prRelationships, ({ one }) => ({
  prA: one(pullRequests, {
    fields: [prRelationships.prAId],
    references: [pullRequests.id],
    relationName: 'relationship_pr_a',
  }),
  prB: one(pullRequests, {
    fields: [prRelationships.prBId],
    references: [pullRequests.id],
    relationName: 'relationship_pr_b',
  }),
}));

export const notificationRulesRelations = relations(notificationRules, ({ one }) => ({
  project: one(projects, { fields: [notificationRules.projectId], references: [projects.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
  pullRequest: one(pullRequests, {
    fields: [notifications.pullRequestId],
    references: [pullRequests.id],
  }),
}));
