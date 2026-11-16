import { parseJsonFromText } from '../json.ts';
import {
  AiError,
  type AiCompletionRequest,
  type AiCompletionResult,
  type AiProvider,
  type AiTokenUsage,
} from '../types.ts';

export type FakeResponse =
  | { json: unknown; text?: string; usage?: Partial<AiTokenUsage>; model?: string }
  | { text: string; usage?: Partial<AiTokenUsage>; model?: string }
  | { error: AiError | Error };

export type FakeHandler = (
  req: AiCompletionRequest,
  callIndex: number,
) => FakeResponse | Promise<FakeResponse>;

/**
 * Deterministic in-memory provider for tests (no network). Responds from a handler function or a queue of
 * canned responses; records every request in `calls`.
 */
export class FakeAiProvider implements AiProvider {
  readonly kind = 'fake' as const;
  readonly calls: AiCompletionRequest[] = [];
  private readonly queue: FakeResponse[] = [];
  private handler: FakeHandler | undefined;
  defaultUsage: AiTokenUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 };

  constructor(handlerOrResponses?: FakeHandler | FakeResponse[]) {
    if (typeof handlerOrResponses === 'function') this.handler = handlerOrResponses;
    else if (handlerOrResponses) this.queue.push(...handlerOrResponses);
  }

  enqueue(...responses: FakeResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  setHandler(handler: FakeHandler): this {
    this.handler = handler;
    return this;
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    const index = this.calls.length;
    this.calls.push(req);
    const response = this.queue.length > 0 ? this.queue.shift()! : await this.handler?.(req, index);
    if (!response) throw new AiError('api_error', 'FakeAiProvider has no response configured');
    if ('error' in response) throw response.error;
    const usage: AiTokenUsage = { ...this.defaultUsage, ...response.usage };
    const model = response.model ?? req.model;
    if ('json' in response) {
      const text = response.text ?? JSON.stringify(response.json);
      return { text, json: response.json, usage, model, stopReason: 'end_turn' };
    }
    if (req.jsonSchema) {
      const json = parseJsonFromText(response.text);
      if (json === undefined) {
        throw new AiError('invalid_json', 'fake output was not valid JSON', {
          usage,
          model: req.model,
        });
      }
      return { text: response.text, json, usage, model, stopReason: 'end_turn' };
    }
    return { text: response.text, usage, model, stopReason: 'end_turn' };
  }
}
