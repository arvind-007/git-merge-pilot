import type { AiProviderKind } from '@gmp/core';

/** Token usage reported by a single provider call. */
export interface AiTokenUsage {
  /** Uncached input tokens billed at the full input rate (includes cache-write tokens). */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cacheReadTokens: number;
  /** Input tokens written to the prompt cache (Anthropic only; included in `inputTokens`). */
  cacheWriteTokens?: number;
}

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AiEffort = 'low' | 'medium' | 'high';

export interface AiCompletionRequest {
  model: string;
  /** Fixed system prompt. Never contains repository/PR content. */
  system: string;
  messages: AiMessage[];
  /** When set, the provider must return JSON matching this JSON Schema (validated again by the caller). */
  jsonSchema?: Record<string, unknown>;
  /** Name for the schema (OpenAI requires one). */
  jsonSchemaName?: string;
  maxOutputTokens: number;
  /** Mark the system prompt as cacheable (Anthropic prompt caching). */
  cacheSystem?: boolean;
  /** Optional effort hint (Anthropic `output_config.effort`). Ignored by providers that do not support it. */
  effort?: AiEffort;
  /** Abort the request. */
  signal?: AbortSignal;
}

export interface AiCompletionResult {
  text: string;
  /** Parsed JSON when `jsonSchema` was requested. */
  json?: unknown;
  usage: AiTokenUsage;
  /** Model id reported by the provider (may differ from the requested alias). */
  model?: string;
  stopReason?: string;
}

/** Provider abstraction (design §9). */
export interface AiProvider {
  readonly kind: AiProviderKind | 'fake';
  complete(req: AiCompletionRequest): Promise<AiCompletionResult>;
}

export interface ProviderConfig {
  kind: AiProviderKind;
  apiKey: string;
  baseUrl?: string | null;
}

export type AiErrorCode =
  'refusal' | 'max_tokens' | 'invalid_json' | 'empty_response' | 'api_error' | 'not_configured';

/**
 * Error raised by providers and the service. `usage` is set when the provider consumed tokens
 * before the failure (e.g. truncated or refused output) so the spend can still be recorded.
 */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly usage: AiTokenUsage | undefined;
  readonly model: string | undefined;

  constructor(
    code: AiErrorCode,
    message: string,
    opts: { usage?: AiTokenUsage; model?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AiError';
    this.code = code;
    this.usage = opts.usage;
    this.model = opts.model;
  }
}

export function zeroUsage(): AiTokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}
