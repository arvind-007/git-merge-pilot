import OpenAI from 'openai';
import { parseJsonFromText } from '../json.ts';
import {
  AiError,
  type AiCompletionRequest,
  type AiCompletionResult,
  type AiProvider,
  type AiTokenUsage,
} from '../types.ts';

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;

/** The subset of the OpenAI client used by the adapter (injectable for tests). */
export interface OpenAiClientLike {
  chat: {
    completions: {
      create(params: ChatParams, options?: { signal?: AbortSignal }): Promise<ChatCompletion>;
    };
  };
}

export interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  baseUrl?: string | null;
  client?: OpenAiClientLike;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Which output-token parameter to send. Default: `max_completion_tokens` for api.openai.com (or no baseUrl),
   * `max_tokens` for other OpenAI-compatible servers (Ollama, vLLM, LiteLLM, OpenRouter, Azure deployments).
   */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
}

type JsonMode = 'json_schema' | 'json_object' | 'none';

function usageFrom(c: ChatCompletion): AiTokenUsage {
  const prompt = c.usage?.prompt_tokens ?? 0;
  const cached = c.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: c.usage?.completion_tokens ?? 0,
    cacheReadTokens: cached,
  };
}

function schemaName(name: string | undefined): string {
  const n = (name ?? 'response').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return n || 'response';
}

function isResponseFormatUnsupported(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status !== 400 && err.status !== 422) return false;
  let body: string;
  try {
    body = JSON.stringify(err.error ?? '');
  } catch {
    body = '';
  }
  const msg = `${String(err.message ?? '')} ${body}`.toLowerCase();
  return (
    msg.includes('response_format') ||
    msg.includes('json_schema') ||
    msg.includes('json_object') ||
    msg.includes('structured')
  );
}

/** OpenAI-compatible adapter (OpenAI, Azure, OpenRouter, Ollama, vLLM, LiteLLM) via the official SDK. */
export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleProviderOptions): AiProvider {
  const client: OpenAiClientLike =
    opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      timeout: opts.timeoutMs ?? 10 * 60 * 1000,
      maxRetries: opts.maxRetries ?? 2,
    });
  const isOfficial = !opts.baseUrl || /(^|\.)api\.openai\.com/i.test(safeHost(opts.baseUrl));
  const maxTokensParam =
    opts.maxTokensParam ?? (isOfficial ? 'max_completion_tokens' : 'max_tokens');

  async function call(req: AiCompletionRequest, mode: JsonMode): Promise<AiCompletionResult> {
    const schema = req.jsonSchema;
    let system = req.system;
    if (schema && mode !== 'json_schema') {
      system +=
        '\n\nOUTPUT FORMAT: Respond with a single JSON object only (no prose, no code fences) that validates ' +
        `against this JSON Schema:\n${JSON.stringify(schema)}`;
    }
    const params: ChatParams = {
      model: req.model,
      messages: [
        { role: 'system', content: system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      ...(maxTokensParam === 'max_completion_tokens'
        ? { max_completion_tokens: req.maxOutputTokens }
        : { max_tokens: req.maxOutputTokens }),
    };
    if (schema && mode === 'json_schema') {
      params.response_format = {
        type: 'json_schema',
        json_schema: { name: schemaName(req.jsonSchemaName), schema, strict: true },
      };
    } else if (schema && mode === 'json_object') {
      params.response_format = { type: 'json_object' };
    }

    let completion: ChatCompletion;
    try {
      completion = await client.chat.completions.create(
        params,
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (err) {
      if (schema && mode !== 'none' && isResponseFormatUnsupported(err)) {
        return call(req, mode === 'json_schema' ? 'json_object' : 'none');
      }
      const status = err instanceof OpenAI.APIError ? err.status : undefined;
      throw new AiError(
        'api_error',
        `OpenAI-compatible request failed${status ? ` (HTTP ${status})` : ''}: ${err instanceof Error ? err.name : 'error'}`,
        { cause: err, model: req.model },
      );
    }

    const usage = usageFrom(completion);
    const model = completion.model || req.model;
    const choice = completion.choices[0];
    if (!choice)
      throw new AiError('empty_response', 'provider returned no choices', { usage, model });
    if (choice.message.refusal || choice.finish_reason === 'content_filter') {
      throw new AiError('refusal', 'model declined the request', { usage, model });
    }
    if (choice.finish_reason === 'length') {
      throw new AiError('max_tokens', 'model output was truncated (length)', { usage, model });
    }
    const text = choice.message.content ?? '';
    if (!schema) {
      if (!text.trim())
        throw new AiError('empty_response', 'model returned no text', { usage, model });
      return { text, usage, model, stopReason: choice.finish_reason };
    }
    const json = parseJsonFromText(text);
    if (json === undefined)
      throw new AiError('invalid_json', 'model output was not valid JSON', { usage, model });
    return { text, json, usage, model, stopReason: choice.finish_reason };
  }

  return {
    kind: 'openai_compatible',
    complete: (req) => call(req, req.jsonSchema ? 'json_schema' : 'none'),
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
