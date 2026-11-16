import {
  maxRiskLevel,
  PrReportSchema,
  riskLevelFromScore,
  riskLevelRank,
  severityAtLeast,
  sha256Hex,
  type Finding,
  type FindingCategory,
  type MergeReadiness,
  type PrReport,
  type RiskDimension,
  type RiskLevel,
  type AiAssessment,
  type RiskScore,
  type Severity,
} from '@gmp/core';
import type { AiConcern, AiReportOutput } from './ai-output.ts';
import { listPreview, uniq } from './classify.ts';
import { buildDeterministicReport, RECOMMENDATION_LABELS, RISK_LABELS } from './deterministic.ts';
import { createPathMatcher, normalizeRepoPath } from './glob.ts';
import type { ReportInput, ReportRisk } from './report-input.ts';

/** Maximum absolute AI adjustment per risk dimension (design §9). */
export const MAX_AI_SCORE_ADJUSTMENT = 15;
const MAX_AI_CONCERNS = 12;
const MAX_AI_ACTIONS = 8;
const MAX_TEXT = 4_000;
const MAX_SHORT = 600;
/** AI concerns are potential issues; they can never be 'critical'. */
const MAX_AI_SEVERITY: Severity = 'high';

const DIMENSION_CATEGORIES: Readonly<Record<RiskDimension, readonly FindingCategory[]>> = {
  security: ['security'],
  breaking_change: ['breaking_change'],
  integration: ['integration'],
  regression: ['regression', 'testing'],
  database: ['database'],
  deployment: ['deployment'],
};

/** C0 controls (except \\t \\n \\r), DEL, zero-width and bidi-override characters. */
const UNSAFE_CHARS_RE = new RegExp(
  // eslint-disable-next-line no-control-regex -- intentionally matches control characters to strip them
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);

/** Strips control characters (except newlines/tabs), trims and bounds length. Output is plain text. */
export function sanitizeAiText(s: string, max = MAX_TEXT): string {
  const cleaned = s.replace(UNSAFE_CHARS_RE, '').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function capSeverity(sev: Severity): Severity {
  return severityAtLeast(sev, MAX_AI_SEVERITY) ? MAX_AI_SEVERITY : sev;
}

function concernToFinding(
  c: AiConcern,
  input: ReportInput,
  allowedPaths: Set<string>,
): Finding | null {
  const title = sanitizeAiText(c.title, 200);
  const description = sanitizeAiText(c.description);
  if (!title || !description) return null;
  const paths = uniq(c.paths.map((p) => normalizeRepoPath(p.trim()))).filter((p) =>
    allowedPaths.has(p),
  );
  const evidence = paths.length
    ? paths.slice(0, 10).map((path) => ({ repo: input.repo.fullName, path, source: 'ai' as const }))
    : [{ repo: input.repo.fullName, source: 'ai' as const }];
  const whatMightBreak = sanitizeAiText(c.whatMightBreak, MAX_SHORT);
  const recommendation = sanitizeAiText(c.recommendation, MAX_SHORT);
  return {
    fingerprint: `ai:${sha256Hex(`${c.category}|${normTitle(title)}`).slice(0, 24)}`,
    category: c.category,
    severity: capSeverity(c.severity),
    title,
    description,
    ...(whatMightBreak ? { whatMightBreak } : {}),
    ...(recommendation ? { recommendation } : {}),
    ...(paths.length ? { affected: paths.slice(0, 10) } : {}),
    evidence,
    verified: false,
    source: 'ai',
  };
}

type ScoreAdjustment = AiAssessment['scoreAdjustments'][number];

/** Clamps, sanitizes and de-duplicates (first per dimension) AI score adjustments. */
function normalizeAdjustments(
  list: readonly { dimension: RiskDimension; delta: number; rationale: string }[],
): ScoreAdjustment[] {
  const seen = new Set<RiskDimension>();
  const out: ScoreAdjustment[] = [];
  for (const adj of list) {
    if (seen.has(adj.dimension)) continue;
    seen.add(adj.dimension);
    const delta = Math.round(
      Math.max(-MAX_AI_SCORE_ADJUSTMENT, Math.min(MAX_AI_SCORE_ADJUSTMENT, adj.delta)),
    );
    const rationale = sanitizeAiText(adj.rationale, MAX_SHORT);
    if (!Number.isFinite(delta) || delta === 0 || !rationale) continue;
    out.push({ dimension: adj.dimension, delta, rationale });
  }
  return out;
}

function applyAdjustments(
  scores: RiskScore[],
  list: readonly ScoreAdjustment[],
  verifiedFindings: Finding[],
): RiskScore[] {
  const adjustments = new Map(normalizeAdjustments(list).map((a) => [a.dimension, a]));
  return scores.map((s) => {
    const adj = adjustments.get(s.dimension);
    if (!adj) return s;
    const score = Math.max(0, Math.min(100, s.score + adj.delta));
    let level = riskLevelFromScore(score);
    // AI may not lower the level of a dimension backed by verified high/critical findings.
    const backed = verifiedFindings.some(
      (f) =>
        DIMENSION_CATEGORIES[s.dimension].includes(f.category) &&
        severityAtLeast(f.severity, 'high'),
    );
    if (backed && riskLevelRank(level) < riskLevelRank(s.level)) level = s.level;
    const sign = adj.delta > 0 ? '+' : '';
    return {
      ...s,
      score,
      level,
      rationale: `${s.rationale} AI adjustment (${sign}${adj.delta}, unverified): ${adj.rationale}`,
    };
  });
}

/** Overall risk from (adjusted) scores, never below `high` with a verified high/critical security finding. */
function overallFrom(riskScores: RiskScore[], findings: readonly Finding[], fallback: RiskLevel) {
  const securityFloor: RiskLevel[] = findings.some(
    (f) => f.verified && f.category === 'security' && severityAtLeast(f.severity, 'high'),
  )
    ? ['high']
    : [];
  return riskScores.length > 0
    ? maxRiskLevel([...riskScores.map((s) => s.level), ...securityFloor])
    : fallback;
}

/**
 * Re-applies a stored AI assessment (score adjustments and open questions) on top of freshly
 * computed deterministic scores and readiness. Readiness only ever becomes stricter.
 */
export function reapplyAiAssessment(
  risk: ReportRisk,
  assessment: AiAssessment | null | undefined,
  findings: readonly Finding[],
): ReportRisk {
  if (!assessment) return risk;
  const verified = findings.filter((f) => f.verified);
  const riskScores = applyAdjustments(risk.riskScores, assessment.scoreAdjustments, verified);
  const overallRisk = overallFrom(riskScores, verified, risk.overallRisk);
  const mergeReadiness = stricterReadiness(
    risk.mergeReadiness,
    overallRisk,
    risk.overallRisk,
    assessment.openQuestions,
  );
  return { riskScores, overallRisk, mergeReadiness };
}

const OPEN_QUESTION_PREFIX = 'Open question (AI, unverified): ';
const AI_ADJUSTMENT_RE = / AI adjustment \(([+-]?\d+), unverified\): ([\s\S]*)$/;

/**
 * The AI assessment stored with a report. Reports written before it was stored get it
 * reconstructed from the blockers and score rationales the AI merge produced.
 */
export function aiAssessmentOf(report: PrReport | null | undefined): AiAssessment | null {
  if (!report || report.generatedBy !== 'ai') return null;
  if (report.aiAssessment) return report.aiAssessment;
  const openQuestions = report.mergeReadiness.blockers
    .filter((b) => b.startsWith(OPEN_QUESTION_PREFIX))
    .map((b) => b.slice(OPEN_QUESTION_PREFIX.length));
  const scoreAdjustments: ScoreAdjustment[] = [];
  for (const s of report.riskScores) {
    const m = AI_ADJUSTMENT_RE.exec(s.rationale);
    if (m) scoreAdjustments.push({ dimension: s.dimension, delta: Number(m[1]), rationale: m[2]! });
  }
  return openQuestions.length || scoreAdjustments.length
    ? { openQuestions, scoreAdjustments }
    : null;
}

const AI_READINESS_LINE_RE = /Automated checks: overall risk [a-z]+; merge readiness: [^.\n]+\./;
const DETERMINISTIC_READINESS_RE =
  /Overall risk is [^.\n]+\. Merge readiness: [^.\n]+\.(?: Before merging: [\s\S]*)?$/;

function aiReadinessLine(overallRisk: RiskLevel, readiness: MergeReadiness): string {
  return `Automated checks: overall risk ${overallRisk}; merge readiness: ${RECOMMENDATION_LABELS[readiness.recommendation]}.`;
}

/**
 * Rewrites the risk/readiness sentence baked into an executive summary so it matches the
 * current scores (after a readiness refresh or narrative reuse).
 */
export function refreshSummaryReadiness(
  summary: string,
  overallRisk: RiskLevel,
  readiness: MergeReadiness,
): string {
  if (AI_READINESS_LINE_RE.test(summary)) {
    return summary.replace(AI_READINESS_LINE_RE, aiReadinessLine(overallRisk, readiness));
  }
  if (DETERMINISTIC_READINESS_RE.test(summary)) {
    const before = readiness.blockers.length
      ? ` Before merging: ${listPreview(readiness.blockers, 3)}.`
      : '';
    return summary.replace(
      DETERMINISTIC_READINESS_RE,
      `Overall risk is ${RISK_LABELS[overallRisk]}. Merge readiness: ${RECOMMENDATION_LABELS[readiness.recommendation]}.${before}`,
    );
  }
  return `${summary.trimEnd()}\n\n${aiReadinessLine(overallRisk, readiness)}`;
}

function stricterReadiness(
  base: MergeReadiness,
  overallRisk: RiskLevel,
  baseOverall: RiskLevel,
  openQuestions: string[],
): MergeReadiness {
  const rec = base.recommendation;
  if (openQuestions.length > 0 && (rec === 'ready_to_merge' || rec === 'merge_after_checks')) {
    return {
      ...base,
      recommendation: 'needs_clarification',
      blockers: uniq([
        ...base.blockers,
        ...openQuestions.slice(0, 5).map((q) => `${OPEN_QUESTION_PREFIX}${q}`),
      ]),
      rationale: `${base.rationale} AI review raised open questions that should be answered before merging.`,
    };
  }
  if (
    rec === 'ready_to_merge' &&
    riskLevelRank(overallRisk) >= riskLevelRank('high') &&
    riskLevelRank(overallRisk) > riskLevelRank(baseOverall)
  ) {
    return {
      ...base,
      recommendation: 'merge_after_checks',
      blockers: uniq([
        ...base.blockers,
        `Risk raised to ${overallRisk} by AI review (unverified); have a reviewer confirm.`,
      ]),
      rationale: `${base.rationale} AI review raised the overall risk to ${overallRisk}.`,
    };
  }
  return base;
}

export interface MergeContext {
  /** Prompt-building limitations (truncation, exclusions, metadata-only). */
  limitations?: string[];
}

/**
 * Merges AI output onto the deterministic report (design §9):
 * - deterministic findings are kept verbatim; AI concerns are appended as verified=false (severity ≤ high);
 * - AI score adjustments are clamped to ±15 with rationale and cannot lower levels backed by verified findings;
 * - merge readiness can only become stricter, never more permissive;
 * - the result is validated with PrReportSchema (throws on failure).
 */
export function mergeAiReport(
  input: ReportInput,
  ai: AiReportOutput,
  ctx: MergeContext = {},
): PrReport {
  const base = buildDeterministicReport(input);
  const excluded = createPathMatcher(input.repo.excludePaths ?? []);
  const allowedPaths = new Set(
    input.files.map((f) => normalizeRepoPath(f.path)).filter((p) => !excluded(p)),
  );
  const existingTitles = new Set(input.findings.map((f) => normTitle(f.title)));

  const concerns: Finding[] = [];
  const seenFp = new Set(input.findings.map((f) => f.fingerprint));
  const aiConcerns = [...ai.concerns];
  if (ai.promptInjectionSuspected) {
    aiConcerns.unshift({
      category: 'security',
      severity: 'medium',
      title: 'PR content contains text that tries to instruct the AI reviewer',
      description:
        'The pull request text or code contains instructions aimed at the automated reviewer (a prompt-injection attempt). ' +
        'They were ignored, but a person should check why this text is there.',
      whatMightBreak: '',
      recommendation:
        'Ask the author about the instruction-like text and review the change manually.',
      paths: [],
    });
  }
  for (const c of aiConcerns) {
    if (concerns.length >= MAX_AI_CONCERNS) break;
    if (existingTitles.has(normTitle(c.title))) continue;
    const f = concernToFinding(c, input, allowedPaths);
    if (!f || seenFp.has(f.fingerprint)) continue;
    seenFp.add(f.fingerprint);
    concerns.push(f);
  }

  const verified = input.findings.filter((f) => f.verified);
  const scoreAdjustments = normalizeAdjustments(ai.scoreAdjustments);
  const riskScores = applyAdjustments(base.riskScores, scoreAdjustments, verified);
  const overallRisk = overallFrom(riskScores, verified, base.overallRisk);
  const openQuestions = ai.openQuestions.map((q) => sanitizeAiText(q, MAX_SHORT)).filter(Boolean);
  const mergeReadiness = stricterReadiness(
    base.mergeReadiness,
    overallRisk,
    base.overallRisk,
    openQuestions,
  );

  const aiActions = ai.recommendedActions
    .map((a) => sanitizeAiText(a, MAX_SHORT))
    .filter(Boolean)
    .slice(0, MAX_AI_ACTIONS);
  const deploymentNote = sanitizeAiText(ai.deploymentNotes, 1_500);
  const rollbackNote = sanitizeAiText(ai.rollbackNotes, 1_500);
  const confidenceScore = Math.round(
    Math.max(
      0,
      Math.min(
        95,
        Math.min(
          Number.isFinite(ai.confidence.score) ? ai.confidence.score : base.confidence.score,
          base.confidence.score + 20,
        ),
      ),
    ),
  );

  const readinessLine = aiReadinessLine(overallRisk, mergeReadiness);

  const report: PrReport = {
    ...base,
    executiveSummary: `${sanitizeAiText(ai.executiveSummary)}\n\n${readinessLine}`,
    businessImpact: sanitizeAiText(ai.businessImpact),
    technicalSummary: sanitizeAiText(ai.technicalSummary),
    breakingChanges: [
      ...base.breakingChanges,
      ...concerns.filter((c) => c.category === 'breaking_change'),
    ],
    security: [...base.security, ...concerns.filter((c) => c.category === 'security')],
    integrationImpact: [
      ...base.integrationImpact,
      ...concerns.filter((c) => c.category !== 'breaking_change' && c.category !== 'security'),
    ],
    deployment: {
      ...base.deployment,
      notes: [
        base.deployment.notes,
        deploymentNote ? `Potential concern (AI, unverified): ${deploymentNote}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    },
    rollback: {
      ...base.rollback,
      notes: [base.rollback.notes, rollbackNote ? `AI note (unverified): ${rollbackNote}` : '']
        .filter(Boolean)
        .join(' '),
    },
    recommendedActions: uniq([
      ...mergeReadiness.blockers,
      ...base.recommendedActions.filter((a) => !a.startsWith('No additional actions')),
      ...aiActions,
    ]).slice(0, 20),
    riskScores,
    overallRisk,
    mergeReadiness,
    confidence: {
      score: confidenceScore,
      rationale: sanitizeAiText(ai.confidence.rationale, MAX_SHORT) || base.confidence.rationale,
    },
    generatedBy: 'ai',
    limitations: uniq([...(input.limitations ?? []), ...(ctx.limitations ?? [])]),
    aiAssessment: { openQuestions: openQuestions.slice(0, 10), scoreAdjustments },
  };
  if (report.recommendedActions.length === 0)
    report.recommendedActions = ['No additional actions identified beyond normal review.'];
  return PrReportSchema.parse(report);
}
