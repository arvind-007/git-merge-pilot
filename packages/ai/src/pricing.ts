import { createLogger, type AiTask, type Logger } from '@gmp/core';
import type { AiTokenUsage } from './types.ts';

/** USD per million tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Defaults to 10% of the input price. */
  cacheReadPerMTok?: number;
  /** Defaults to 125% of the input price. */
  cacheWritePerMTok?: number;
}

/** Default model per task (design §2). All admin-configurable via `ai_settings.task_models`. */
export const DEFAULT_ANTHROPIC_MODELS: Readonly<Record<AiTask, string>> = Object.freeze({
  triage: 'claude-haiku-5-5',
  digest: 'claude-haiku-5-5',
  pr_report: 'claude-sonnet-5-5',
  deep_analysis: 'claude-opus-5-5',
});

/** Default max output tokens per task, used when the task model config does not set one. */
export const DEFAULT_MAX_OUTPUT_TOKENS: Readonly<Record<AiTask, number>> = Object.freeze({
  triage: 2_000,
  digest: 4_000,
  pr_report: 16_000,
  deep_analysis: 16_000,
});

/** Known model prices (USD per million input/output tokens). */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
});

const warnedModels = new Set<string>();
let defaultLogger: Logger | undefined;

function logger(): Logger {
  defaultLogger ??= createLogger('ai.pricing');
  return defaultLogger;
}

/**
 * Normalizes provider-specific model ids to the price-table key:
 * `anthropic/claude-sonnet-5-5` (OpenRouter), `anthropic.claude-sonnet-5-5` (Bedrock-style) → `claude-sonnet-5-5`.
 */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  if (m.startsWith('anthropic.')) m = m.slice('anthropic.'.length);
  return m;
}

/**
 * Drops a dated snapshot suffix providers append to model ids (`gpt-4o-2024-08-06`,
 * `claude-x-20250101`, `model@20250101`, Bedrock-style `-v1:0`).
 */
export function stripModelDate(model: string): string {
  return model.replace(/-v\d+(?::\d+)?$/, '').replace(/[-@](?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
}

export function lookupModelPrice(
  model: string,
  prices: Readonly<Record<string, ModelPrice>> = MODEL_PRICES,
): ModelPrice | undefined {
  const normalized = normalizeModelId(model);
  return (
    prices[model] ??
    prices[normalized] ??
    prices[stripModelDate(model)] ??
    prices[stripModelDate(normalized)]
  );
}

/** True when a price for `model` is known from `prices` (merged over the built-in table). */
export function hasModelPrice(
  model: string,
  prices?: Readonly<Record<string, ModelPrice>>,
): boolean {
  return (
    lookupModelPrice(model, prices ? { ...MODEL_PRICES, ...prices } : MODEL_PRICES) !== undefined
  );
}

export interface EstimateCostOptions {
  /** Extra/override prices (merged over {@link MODEL_PRICES}). */
  prices?: Readonly<Record<string, ModelPrice>>;
  /** Price used for unknown models. Default: zero cost (with a logged warning). */
  fallback?: ModelPrice;
  logger?: Logger;
}

/**
 * Estimated cost of a call in USD. Unknown models cost `fallback` (default 0) and log a warning once per model.
 * `usage.inputTokens` is the uncached input; `cacheReadTokens` are billed at the cache-read rate and
 * `cacheWriteTokens` (a subset of `inputTokens`) at the cache-write premium.
 */
export function estimateCostUsd(
  model: string,
  usage: AiTokenUsage,
  opts: EstimateCostOptions = {},
): number {
  const table = opts.prices ? { ...MODEL_PRICES, ...opts.prices } : MODEL_PRICES;
  let price = lookupModelPrice(model, table);
  if (!price) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      (opts.logger ?? logger()).warn(
        { model, fallback: opts.fallback ?? null },
        'unknown AI model price; cost recorded using the fallback price (0 when unset)',
      );
    }
    price = opts.fallback;
    if (!price) return 0;
  }
  const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok * 0.1;
  const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok * 1.25;
  const write = Math.max(0, Math.min(usage.cacheWriteTokens ?? 0, usage.inputTokens));
  const plainInput = Math.max(0, usage.inputTokens - write);
  const cost =
    (plainInput * price.inputPerMTok +
      write * cacheWrite +
      Math.max(0, usage.cacheReadTokens) * cacheRead +
      Math.max(0, usage.outputTokens) * price.outputPerMTok) /
    1_000_000;
  // Round to the DB column precision (numeric(14,6)).
  return Math.round(cost * 1e6) / 1e6;
}

/** Test helper: forget which unknown models were already warned about. */
export function resetPricingWarnings(): void {
  warnedModels.clear();
}
