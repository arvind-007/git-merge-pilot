import Anthropic from '@anthropic-ai/sdk';
import { parseJsonFromText } from '../json.ts';
import {
  AiError,
  type AiCompletionRequest,
  type AiCompletionResult,
  type AiProvider,
  type AiTokenUsage,
} from '../types.ts';

/** The subset of the Anthropic client used by the adapter (injectable for tests). */
export interface AnthropicClientLike {
  messages: {
    stream(
      params: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): { finalMessage(): Promise<Anthropic.Message> };
  };
}

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string | null;
  /** Inject a client (tests). */
  client?: AnthropicClientLike;
  /** Request timeout in ms (default 10 minutes). */
  timeoutMs?: number;
  maxRetries?: number;
}

function usageFrom(message: Pick<Anthropic.Message, 'usage'>): AiTokenUsage {
  const u = message.usage;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: (u.input_tokens ?? 0) + cacheWrite,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: cacheWrite,
  };
}

function jsonInstruction(schema: Record<string, unknown>): string {
  return (
    '\n\nOUTPUT FORMAT: Respond with a single JSON object only (no prose, no code fences) that validates ' +
    `against this JSON Schema:\n${JSON.stringify(schema)}`
  );
}

function isFormatUnsupported(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  let body: string;
  try {
    body = JSON.stringify(err.error ?? '');
  } catch {
    body = '';
  }
  const msg = `${String(err.message ?? '')} ${body}`.toLowerCase();
  return (
    msg.includes('output_config') || msg.includes('json_schema') || msg.includes('output_format')
  );
}

/** Anthropic adapter: structured output via `output_config.format`, prompt caching on the system block. */
export function createAnthropicProvider(opts: AnthropicProviderOptions): AiProvider {
  const client: AnthropicClientLike =
    opts.client ??
    new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      timeout: opts.timeoutMs ?? 10 * 60 * 1000,
      maxRetries: opts.maxRetries ?? 2,
    });

  async function call(
    req: AiCompletionRequest,
    useStructuredOutput: boolean,
  ): Promise<AiCompletionResult> {
    const systemText =
      req.jsonSchema && !useStructuredOutput
        ? req.system + jsonInstruction(req.jsonSchema)
        : req.system;
    const outputConfig: Anthropic.OutputConfig = {};
    if (req.effort) outputConfig.effort = req.effort;
    if (req.jsonSchema && useStructuredOutput) {
      outputConfig.format = { type: 'json_schema', schema: req.jsonSchema };
    }
    const params: Anthropic.MessageStreamParams = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      system: [
        {
          type: 'text',
          text: systemText,
          ...(req.cacheSystem ? { cache_control: { type: 'ephemeral' as const } } : {}),
        },
      ],
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    };

    let message: Anthropic.Message;
    try {
      message = await client.messages
        .stream(params, req.signal ? { signal: req.signal } : undefined)
        .finalMessage();
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (useStructuredOutput && req.jsonSchema && isFormatUnsupported(err))
        throw new FormatUnsupported(err);
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      throw new AiError(
        'api_error',
        `Anthropic request failed${status ? ` (HTTP ${status})` : ''}: ${err instanceof Error ? err.name : 'error'}`,
        { cause: err, model: req.model },
      );
    }

    const usage = usageFrom(message);
    const model = message.model ?? req.model;
    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category ?? 'unspecified';
      throw new AiError('refusal', `model declined the request (category: ${category})`, {
        usage,
        model,
      });
    }
    if (
      message.stop_reason === 'max_tokens' ||
      message.stop_reason === 'model_context_window_exceeded'
    ) {
      throw new AiError('max_tokens', `model output was truncated (${message.stop_reason})`, {
        usage,
        model,
      });
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!req.jsonSchema) {
      if (!text.trim())
        throw new AiError('empty_response', 'model returned no text', { usage, model });
      return { text, usage, model, stopReason: message.stop_reason ?? undefined };
    }
    const json = parseJsonFromText(text);
    if (json === undefined) {
      throw new AiError('invalid_json', 'model output was not valid JSON', { usage, model });
    }
    return { text, json, usage, model, stopReason: message.stop_reason ?? undefined };
  }

  return {
    kind: 'anthropic',
    async complete(req) {
      try {
        return await call(req, true);
      } catch (err) {
        if (err instanceof FormatUnsupported) {
          // Gateway/model without structured outputs: instruct JSON and validate client-side.
          return call(req, false);
        }
        throw err;
      }
    },
  };
}

class FormatUnsupported extends Error {
  constructor(cause: unknown) {
    super('structured output not supported', { cause });
    this.name = 'FormatUnsupported';
  }
}
