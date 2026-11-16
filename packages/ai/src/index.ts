// @gmp/ai — AI providers, prompt building, report generation, budget/usage (design §9).
export * from './types.ts';
export * from './pricing.ts';
export * from './providers/index.ts';
export { parseJsonFromText } from './json.ts';
export {
  createPathMatcher,
  isPathExcluded,
  mentionsExcludedPath,
  normalizeRepoPath,
  type PathMatcher,
} from './glob.ts';
export { monthWindow, timeZoneOffsetMs } from './budget.ts';
export * from './report-input.ts';
export {
  buildDeterministicReport,
  normalizeCheckStatus,
  summarizeChecks,
  RECOMMENDATION_LABELS,
  type DeterministicReportOptions,
} from './deterministic.ts';
export {
  buildReportPrompt,
  redactForPrompt,
  MAX_TOKEN_RUN,
  buildWrappedUserMessage,
  wrapUntrusted,
  neutralizeDelimiters,
  newBoundaryId,
  estimateTokens,
  CHARS_PER_TOKEN,
  DEFAULT_MAX_INPUT_TOKENS,
  REPORT_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
  RELATIONSHIP_SYSTEM_PROMPT,
  DIGEST_SYSTEM_PROMPT,
  type BuiltPrompt,
  type PromptBuildOptions,
} from './prompt.ts';
export * from './ai-output.ts';
export {
  aiAssessmentOf,
  mergeAiReport,
  reapplyAiAssessment,
  refreshSummaryReadiness,
  sanitizeAiText,
  MAX_AI_SCORE_ADJUSTMENT,
  type MergeContext,
} from './merge.ts';
export {
  deterministicTriage,
  renderDeterministicDigest,
  buildTriageMessage,
  buildRelationshipMessage,
  buildDigestMessage,
  type TriageInput,
  type TriageResult,
  type PrBrief,
  type RelationshipCandidate,
  type ConfirmedRelationship,
  type DigestItem,
  type DigestInput,
} from './tasks.ts';
export {
  AiService,
  type AiServiceOptions,
  type BudgetStatus,
  type GenerateReportResult,
  type RepoAiTarget,
} from './service.ts';
