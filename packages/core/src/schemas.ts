import { z } from 'zod';
import {
  AiTaskSchema,
  CheckStatusSchema,
  EvidenceSourceSchema,
  FindingCategorySchema,
  FindingSourceSchema,
  GeneratedBySchema,
  RecommendationSchema,
  RelationshipConfidenceSchema,
  RelationshipTypeSchema,
  RiskDimensionSchema,
  RiskLevelSchema,
  RollbackDifficultySchema,
  SeveritySchema,
} from './enums.ts';

const score0to100 = z.number().min(0).max(100);

/** A pointer to the concrete evidence behind a fact or concern. */
export const EvidenceSchema = z.object({
  repo: z.string(),
  path: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  endLine: z.number().int().nonnegative().optional(),
  url: z.string().optional(),
  snippet: z.string().optional(),
  source: EvidenceSourceSchema,
  /**
   * Which side of the change `line` refers to: `base` for removed code (old line numbers),
   * `head` (default) for added or current code.
   */
  side: z.enum(['base', 'head']).optional(),
  /** Commit the path/line refer to (merge base for `base`, analysed head for `head`). */
  ref: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * A single finding. `verified=true` means it comes from deterministic analysis or GitHub data
 * (a verified fact); `verified=false` is a potential concern (e.g. AI inference).
 */
export const FindingSchema = z.object({
  fingerprint: z.string().min(1),
  category: FindingCategorySchema,
  severity: SeveritySchema,
  title: z.string(),
  /** Plain-language description for non-developers. */
  description: z.string(),
  technicalDetail: z.string().optional(),
  whatMightBreak: z.string().optional(),
  affected: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
  evidence: z.array(EvidenceSchema),
  verified: z.boolean(),
  source: FindingSourceSchema,
  ruleId: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const RiskScoreSchema = z.object({
  dimension: RiskDimensionSchema,
  score: score0to100,
  level: RiskLevelSchema,
  rationale: z.string(),
  evidence: z.array(EvidenceSchema),
});
export type RiskScore = z.infer<typeof RiskScoreSchema>;

export const ReadinessCheckSchema = z.object({
  name: z.string(),
  status: CheckStatusSchema,
  detail: z.string(),
});
export type ReadinessCheck = z.infer<typeof ReadinessCheckSchema>;

export const MergeReadinessSchema = z.object({
  recommendation: RecommendationSchema,
  blockers: z.array(z.string()),
  checks: z.array(ReadinessCheckSchema),
  rationale: z.string(),
});
export type MergeReadiness = z.infer<typeof MergeReadinessSchema>;

export const AffectedAreasSchema = z.object({
  modules: z.array(z.string()),
  services: z.array(z.string()),
  apis: z.array(z.string()),
  databaseTables: z.array(z.string()),
  sharedComponents: z.array(z.string()),
  integrations: z.array(z.string()),
  configuration: z.array(z.string()),
  infrastructure: z.array(z.string()),
});
export type AffectedAreas = z.infer<typeof AffectedAreasSchema>;

export const OverlappingWorkSchema = z.object({
  prRef: z.string(),
  /** Id of the other PR, so entries a reader may not see can be filtered out. */
  pullRequestId: z.string().optional(),
  /** Full name of the other PR's repository. */
  repository: z.string().optional(),
  type: RelationshipTypeSchema,
  confidence: RelationshipConfidenceSchema,
  summary: z.string(),
  suggestedCoordination: z.string().optional(),
});
export type OverlappingWork = z.infer<typeof OverlappingWorkSchema>;

export const TestingSummarySchema = z.object({
  testsAdded: z.array(z.string()),
  testsModified: z.array(z.string()),
  missingTests: z.array(z.string()),
  ciSummary: z.string(),
});
export type TestingSummary = z.infer<typeof TestingSummarySchema>;

export const DeploymentSummarySchema = z.object({
  migrations: z.array(z.string()),
  envChanges: z.array(z.string()),
  configChanges: z.array(z.string()),
  ordering: z.array(z.string()),
  notes: z.string(),
});
export type DeploymentSummary = z.infer<typeof DeploymentSummarySchema>;

export const RollbackSchema = z.object({
  difficulty: RollbackDifficultySchema,
  notes: z.string(),
});
export type Rollback = z.infer<typeof RollbackSchema>;

export const ConfidenceSchema = z.object({
  score: score0to100,
  rationale: z.string(),
});
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** The full PR report (design §5). Stored in `analyses.report`. */
export const PrReportSchema = z.object({
  executiveSummary: z.string(),
  businessImpact: z.string(),
  technicalSummary: z.string(),
  affectedAreas: AffectedAreasSchema,
  breakingChanges: z.array(FindingSchema),
  security: z.array(FindingSchema),
  integrationImpact: z.array(FindingSchema),
  overlappingWork: z.array(OverlappingWorkSchema),
  testing: TestingSummarySchema,
  deployment: DeploymentSummarySchema,
  rollback: RollbackSchema,
  recommendedActions: z.array(z.string()),
  riskScores: z.array(RiskScoreSchema),
  overallRisk: RiskLevelSchema,
  mergeReadiness: MergeReadinessSchema,
  confidence: ConfidenceSchema,
  /** 'deterministic' when AI is off, budget is exhausted, or the AI call failed. */
  generatedBy: GeneratedBySchema,
  /** e.g. "AI disabled for this repo", "diff truncated". */
  limitations: z.array(z.string()),
  /**
   * What the AI review contributed to scores and readiness (unverified), kept so later
   * readiness refreshes can re-apply it instead of silently dropping it.
   */
  aiAssessment: z
    .object({
      openQuestions: z.array(z.string()),
      scoreAdjustments: z.array(
        z.object({
          dimension: RiskDimensionSchema,
          delta: z.number(),
          rationale: z.string(),
        }),
      ),
    })
    .optional(),
});
export type PrReport = z.infer<typeof PrReportSchema>;
export type AiAssessment = NonNullable<PrReport['aiAssessment']>;

/** Per-task AI model selection stored in `ai_settings.task_models`. */
/** Admin-configured price of a model (USD per million tokens). */
export const ModelPriceConfigSchema = z.object({
  inputPerMTok: z.number().nonnegative().max(10_000),
  outputPerMTok: z.number().nonnegative().max(10_000),
  cacheReadPerMTok: z.number().nonnegative().max(10_000).optional(),
});
export type ModelPriceConfig = z.infer<typeof ModelPriceConfigSchema>;

export const TaskModelConfigSchema = z.object({
  providerId: z.uuid(),
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive(),
  /**
   * Price of `model`. Required for models missing from the built-in price table: without a
   * price their spend cannot be counted against the monthly budget, so AI calls are skipped.
   */
  price: ModelPriceConfigSchema.optional(),
});
export type TaskModelConfig = z.infer<typeof TaskModelConfigSchema>;

export const TaskModelsSchema = z.partialRecord(AiTaskSchema, TaskModelConfigSchema);
export type TaskModels = z.infer<typeof TaskModelsSchema>;

/** Usage numbers reported by an AI call (stored in `analyses.ai_usage`). */
export const AiUsageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  calls: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
});
export type AiUsageSummary = z.infer<typeof AiUsageSummarySchema>;

/** An empty `AffectedAreas` value. */
export function emptyAffectedAreas(): AffectedAreas {
  return {
    modules: [],
    services: [],
    apis: [],
    databaseTables: [],
    sharedComponents: [],
    integrations: [],
    configuration: [],
    infrastructure: [],
  };
}
