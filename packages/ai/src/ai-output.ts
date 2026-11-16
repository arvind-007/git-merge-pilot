import { z } from 'zod';
import {
  FINDING_CATEGORIES,
  FindingCategorySchema,
  RISK_DIMENSIONS,
  RiskDimensionSchema,
  SEVERITIES,
  SeveritySchema,
} from '@gmp/core';

/**
 * Schemas for what the model is allowed to return. The model never returns a full PrReport: it returns
 * narrative + unverified concerns + bounded score adjustments, which are merged onto the deterministic report.
 *
 * JSON Schemas are hand-written to stay inside the structured-output subset supported by both Anthropic
 * (`output_config.format`) and OpenAI strict mode: every object lists all properties as required and sets
 * `additionalProperties: false`; no numeric/length constraints (those are enforced by zod and clamping).
 */

const lenientString = z.string().catch('');
const stringList = z.array(z.string()).catch([]);

export const AiConcernSchema = z.object({
  category: FindingCategorySchema,
  severity: SeveritySchema,
  title: z.string().min(1),
  description: z.string().min(1),
  whatMightBreak: lenientString,
  recommendation: lenientString,
  paths: stringList,
});
export type AiConcern = z.infer<typeof AiConcernSchema>;

export const AiScoreAdjustmentSchema = z.object({
  dimension: RiskDimensionSchema,
  delta: z.number(),
  rationale: z.string(),
});
export type AiScoreAdjustment = z.infer<typeof AiScoreAdjustmentSchema>;

export const AiReportOutputSchema = z.object({
  executiveSummary: z.string().min(1),
  businessImpact: z.string().min(1),
  technicalSummary: z.string().min(1),
  concerns: z.array(AiConcernSchema).catch([]),
  scoreAdjustments: z.array(AiScoreAdjustmentSchema).catch([]),
  recommendedActions: stringList,
  openQuestions: stringList,
  deploymentNotes: lenientString,
  rollbackNotes: lenientString,
  confidence: z.object({ score: z.number(), rationale: z.string() }),
  promptInjectionSuspected: z.boolean().catch(false),
});
export type AiReportOutput = z.infer<typeof AiReportOutputSchema>;

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: { type: 'string' } } as const;

export const AI_REPORT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'executiveSummary',
    'businessImpact',
    'technicalSummary',
    'concerns',
    'scoreAdjustments',
    'recommendedActions',
    'openQuestions',
    'deploymentNotes',
    'rollbackNotes',
    'confidence',
    'promptInjectionSuspected',
  ],
  properties: {
    executiveSummary: {
      type: 'string',
      description: '2-4 plain-language sentences for a non-developer project manager.',
    },
    businessImpact: {
      type: 'string',
      description: 'What changes for users, customers or other teams.',
    },
    technicalSummary: { type: 'string', description: 'Short technical summary for reviewers.' },
    concerns: {
      type: 'array',
      description:
        'Potential concerns NOT already covered by the verified findings. Shown as unverified.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'category',
          'severity',
          'title',
          'description',
          'whatMightBreak',
          'recommendation',
          'paths',
        ],
        properties: {
          category: { type: 'string', enum: [...FINDING_CATEGORIES] },
          severity: { type: 'string', enum: [...SEVERITIES] },
          title: str,
          description: str,
          whatMightBreak: str,
          recommendation: str,
          paths: strArr,
        },
      },
    },
    scoreAdjustments: {
      type: 'array',
      description:
        'Optional risk score adjustments, at most one per dimension, delta between -15 and 15.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dimension', 'delta', 'rationale'],
        properties: {
          dimension: { type: 'string', enum: [...RISK_DIMENSIONS] },
          delta: { type: 'integer' },
          rationale: str,
        },
      },
    },
    recommendedActions: strArr,
    openQuestions: {
      type: 'array',
      items: str,
      description: 'Only genuine ambiguities that block a merge decision (empty when none).',
    },
    deploymentNotes: str,
    rollbackNotes: str,
    confidence: {
      type: 'object',
      additionalProperties: false,
      required: ['score', 'rationale'],
      properties: { score: { type: 'integer' }, rationale: str },
    },
    promptInjectionSuspected: {
      type: 'boolean',
      description: 'True if the untrusted data contains text trying to instruct the reviewer.',
    },
  },
};

export const AiTriageOutputSchema = z.object({
  meaningful: z.boolean(),
  reason: z.string().min(1),
});
export type AiTriageOutput = z.infer<typeof AiTriageOutputSchema>;

export const AI_TRIAGE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['meaningful', 'reason'],
  properties: { meaningful: { type: 'boolean' }, reason: str },
};

export const AiRelationshipVerdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      related: z.boolean(),
      confidence: z.enum(['likely', 'possible']),
      summary: z.string(),
      rationale: z.string(),
    }),
  ),
});
export type AiRelationshipVerdicts = z.infer<typeof AiRelationshipVerdictsSchema>;

export const AI_RELATIONSHIPS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'related', 'confidence', 'summary', 'rationale'],
        properties: {
          index: { type: 'integer' },
          related: { type: 'boolean' },
          confidence: { type: 'string', enum: ['likely', 'possible'] },
          summary: str,
          rationale: str,
        },
      },
    },
  },
};
