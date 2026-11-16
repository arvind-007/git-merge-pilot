import { z } from 'zod';

/**
 * Shared enumerations. Each is exported as a readonly `as const` array (for runtime use,
 * e.g. drizzle text enums and iteration), a zod enum schema, and a union type.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = (typeof SEVERITIES)[number];

export const RISK_LEVELS = ['critical', 'high', 'medium', 'low'] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RECOMMENDATIONS = [
  'ready_to_merge',
  'merge_after_checks',
  'needs_clarification',
  'changes_required',
  'escalate',
] as const;
export const RecommendationSchema = z.enum(RECOMMENDATIONS);
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
export const FindingCategorySchema = z.enum(FINDING_CATEGORIES);
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const RISK_DIMENSIONS = [
  'security',
  'breaking_change',
  'integration',
  'regression',
  'database',
  'deployment',
] as const;
export const RiskDimensionSchema = z.enum(RISK_DIMENSIONS);
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
export const RelationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_CONFIDENCES = ['confirmed', 'likely', 'possible'] as const;
export const RelationshipConfidenceSchema = z.enum(RELATIONSHIP_CONFIDENCES);
export type RelationshipConfidence = (typeof RELATIONSHIP_CONFIDENCES)[number];

export const AI_TASKS = ['triage', 'pr_report', 'deep_analysis', 'digest'] as const;
export const AiTaskSchema = z.enum(AI_TASKS);
export type AiTask = (typeof AI_TASKS)[number];

// ---- Supporting enums used by the database schema and API layers (design §6) ----

export const USER_ROLES = ['admin', 'member'] as const;
export const UserRoleSchema = z.enum(USER_ROLES);
export type UserRole = (typeof USER_ROLES)[number];

export const AI_MODES = ['full', 'metadata_only', 'off'] as const;
export const AiModeSchema = z.enum(AI_MODES);
export type AiMode = (typeof AI_MODES)[number];

export const AI_PROVIDER_KINDS = ['anthropic', 'openai_compatible'] as const;
export const AiProviderKindSchema = z.enum(AI_PROVIDER_KINDS);
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

export const PR_STATES = ['open', 'closed', 'merged'] as const;
export const PrStateSchema = z.enum(PR_STATES);
export type PrState = (typeof PR_STATES)[number];

export const WEBHOOK_DELIVERY_STATUSES = [
  'received',
  'queued',
  'processed',
  'ignored',
  'failed',
] as const;
export const WebhookDeliveryStatusSchema = z.enum(WEBHOOK_DELIVERY_STATUSES);
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const ANALYSIS_KINDS = ['full', 'incremental', 'readiness_only'] as const;
export const AnalysisKindSchema = z.enum(ANALYSIS_KINDS);
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

export const ANALYSIS_STATUSES = ['queued', 'running', 'completed', 'failed', 'skipped'] as const;
export const AnalysisStatusSchema = z.enum(ANALYSIS_STATUSES);
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const FINDING_LIFECYCLES = ['new', 'unchanged', 'resolved'] as const;
export const FindingLifecycleSchema = z.enum(FINDING_LIFECYCLES);
export type FindingLifecycle = (typeof FINDING_LIFECYCLES)[number];

export const SYMBOL_KINDS = ['function', 'class', 'method', 'interface', 'type', 'const'] as const;
export const SymbolKindSchema = z.enum(SYMBOL_KINDS);
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export const CONTRACT_KINDS = [
  'http_route',
  'graphql',
  'proto',
  'event',
  'env_var',
  'db_table',
  'queue_topic',
] as const;
export const ContractKindSchema = z.enum(CONTRACT_KINDS);
export type ContractKind = (typeof CONTRACT_KINDS)[number];

export const CONTRACT_ROLES = ['provider', 'consumer'] as const;
export const ContractRoleSchema = z.enum(CONTRACT_ROLES);
export type ContractRole = (typeof CONTRACT_ROLES)[number];

export const CHANNEL_KINDS = ['email', 'slack', 'in_app'] as const;
export const ChannelKindSchema = z.enum(CHANNEL_KINDS);
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const NOTIFICATION_STATUSES = ['pending', 'sent', 'deferred', 'failed', 'read'] as const;
export const NotificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

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
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const EVIDENCE_SOURCES = ['diff', 'index', 'github', 'scanner', 'ai'] as const;
export const EvidenceSourceSchema = z.enum(EVIDENCE_SOURCES);
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const FINDING_SOURCES = ['rule', 'scanner', 'github', 'ai'] as const;
export const FindingSourceSchema = z.enum(FINDING_SOURCES);
export type FindingSource = (typeof FINDING_SOURCES)[number];

export const CHECK_STATUSES = ['pass', 'fail', 'pending', 'unknown'] as const;
export const CheckStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const GENERATED_BY = ['ai', 'deterministic'] as const;
export const GeneratedBySchema = z.enum(GENERATED_BY);
export type GeneratedBy = (typeof GENERATED_BY)[number];

export const ROLLBACK_DIFFICULTIES = ['easy', 'moderate', 'hard'] as const;
export const RollbackDifficultySchema = z.enum(ROLLBACK_DIFFICULTIES);
export type RollbackDifficulty = (typeof ROLLBACK_DIFFICULTIES)[number];

// ---- Ordering helpers ----

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};
const RISK_RANK: Record<RiskLevel, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/** Numeric rank of a severity (critical=4 … info=0). */
export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

/** True when `severity` is at least as severe as `min`. */
export function severityAtLeast(severity: Severity, min: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

/** Sort comparator: most severe first. */
export function compareSeverityDesc(a: Severity, b: Severity): number {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a];
}

/** Numeric rank of a risk level (critical=3 … low=0). */
export function riskLevelRank(level: RiskLevel): number {
  return RISK_RANK[level];
}

/** Highest of the given risk levels; `low` for an empty list. */
export function maxRiskLevel(levels: Iterable<RiskLevel>): RiskLevel {
  let best: RiskLevel = 'low';
  for (const level of levels) if (RISK_RANK[level] > RISK_RANK[best]) best = level;
  return best;
}

/** Design §8 thresholds: critical >= 80, high >= 60, medium >= 30, else low. */
export function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}
