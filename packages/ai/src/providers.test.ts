import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { createAnthropicProvider, type AnthropicClientLike } from './providers/anthropic.ts';
import { FakeAiProvider } from './providers/fake.ts';
import { createProvider } from './providers/index.ts';
import { createOpenAiCompatibleProvider, type OpenAiClientLike } from './providers/openai.ts';
import { AiError, type AiCompletionRequest } from './types.ts';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
};

function anthropicMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: '{"ok":true}', citations: null } as Anthropic.TextBlock],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 400,
    } as Anthropic.Usage,
    ...overrides,
  } as Anthropic.Message;
}

function fakeAnthropic(
  respond: (params: Anthropic.MessageStreamParams, n: number) => Anthropic.Message | Error,
) {
  const calls: Anthropic.MessageStreamParams[] = [];
  const client: AnthropicClientLike = {
    messages: {
      stream(params) {
        calls.push(params);
        const r = respond(params, calls.length - 1);
        return {
          finalMessage: () => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r)),
        };
      },
    },
  };
  return { client, calls };
}

const baseReq: AiCompletionRequest = {
  model: 'claude-sonnet-5-5',
  system: 'SYSTEM',
  messages: [{ role: 'user', content: 'hello' }],
  jsonSchema: SCHEMA,
  maxOutputTokens: 1000,
  cacheSystem: true,
  effort: 'medium',
};

describe('anthropic provider', () => {
  it('sends structured output + cache_control on the system block and maps usage', async () => {
    const { client, calls } = fakeAnthropic(() => anthropicMessage());
    const p = createAnthropicProvider({ apiKey: 'x', client });
    const res = await p.complete(baseReq);
    expect(res.json).toEqual({ ok: true });
    expect(res.usage).toEqual({
      inputTokens: 150,
      outputTokens: 20,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
    });
    const params = calls[0]!;
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.max_tokens).toBe(1000);
    expect(params.system).toEqual([
      { type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } },
    ]);
    expect(params.output_config).toEqual({
      effort: 'medium',
      format: { type: 'json_schema', schema: SCHEMA },
    });
    expect(params).not.toHaveProperty('tools');
  });

  it('treats refusal and max_tokens stop reasons as failures carrying usage', async () => {
    const refusal = createAnthropicProvider({
      apiKey: 'x',
      client: fakeAnthropic(() =>
        anthropicMessage({
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: null } as never,
        }),
      ).client,
    });
    await expect(refusal.complete(baseReq)).rejects.toMatchObject({
      code: 'refusal',
      usage: { outputTokens: 20 },
    });

    const truncated = createAnthropicProvider({
      apiKey: 'x',
      client: fakeAnthropic(() => anthropicMessage({ stop_reason: 'max_tokens' })).client,
    });
    await expect(truncated.complete(baseReq)).rejects.toMatchObject({ code: 'max_tokens' });
  });

  it('rejects non-JSON output when a schema was requested', async () => {
    const p = createAnthropicProvider({
      apiKey: 'x',
      client: fakeAnthropic(() =>
        anthropicMessage({
          content: [{ type: 'text', text: 'sorry, no', citations: null } as Anthropic.TextBlock],
        }),
      ).client,
    });
    await expect(p.complete(baseReq)).rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('falls back to instructed JSON when output_config.format is rejected', async () => {
    const { client, calls } = fakeAnthropic((_p, n) =>
      n === 0
        ? new Anthropic.BadRequestError(
            400,
            {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'output_config.format: Extra inputs are not permitted',
              },
            },
            undefined,
            new Headers(),
          )
        : anthropicMessage({
            content: [
              { type: 'text', text: 'Sure: {"ok":false}', citations: null } as Anthropic.TextBlock,
            ],
          }),
    );
    const p = createAnthropicProvider({ apiKey: 'x', client });
    const res = await p.complete(baseReq);
    expect(res.json).toEqual({ ok: false });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.output_config?.format).toBeUndefined();
    const sys = calls[1]!.system as Anthropic.TextBlockParam[];
    expect(sys[0]!.text).toContain('JSON Schema');
  });

  it('wraps API errors without leaking details', async () => {
    const p = createAnthropicProvider({
      apiKey: 'x',
      client: fakeAnthropic(
        () =>
          new Anthropic.AuthenticationError(
            401,
            { type: 'error' },
            'invalid x-api-key',
            new Headers(),
          ),
      ).client,
    });
    const err = await p.complete(baseReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe('api_error');
    expect((err as AiError).message).toContain('401');
  });
});

function chatCompletion(
  overrides: Partial<OpenAI.Chat.Completions.ChatCompletion['choices'][number]> = {},
  usage?: object,
) {
  return {
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-x',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content: '{"ok":true}', refusal: null },
        ...overrides,
      },
    ],
    usage: usage ?? {
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 600 },
    },
  } as OpenAI.Chat.Completions.ChatCompletion;
}

function fakeOpenAi(
  respond: (
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    n: number,
  ) => object | Error,
) {
  const calls: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming[] = [];
  const client: OpenAiClientLike = {
    chat: {
      completions: {
        create(params) {
          calls.push(params);
          const r = respond(params, calls.length - 1);
          return r instanceof Error
            ? Promise.reject(r)
            : Promise.resolve(r as OpenAI.Chat.Completions.ChatCompletion);
        },
      },
    },
  };
  return { client, calls };
}

describe('openai-compatible provider', () => {
  it('uses strict json_schema response_format and maps cached tokens', async () => {
    const { client, calls } = fakeOpenAi(() => chatCompletion());
    const p = createOpenAiCompatibleProvider({
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      client,
    });
    const res = await p.complete({ ...baseReq, model: 'llama3', jsonSchemaName: 'pr report!' });
    expect(res.json).toEqual({ ok: true });
    expect(res.usage).toEqual({ inputTokens: 400, outputTokens: 50, cacheReadTokens: 600 });
    const params = calls[0]!;
    expect(params.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'pr_report_', schema: SCHEMA, strict: true },
    });
    expect(params.max_tokens).toBe(1000);
    expect(params.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' });
  });

  it('uses max_completion_tokens for the official API', async () => {
    const { client, calls } = fakeOpenAi(() => chatCompletion());
    await createOpenAiCompatibleProvider({ apiKey: 'k', client }).complete(baseReq);
    expect(calls[0]!.max_completion_tokens).toBe(1000);
    expect(calls[0]!.max_tokens).toBeUndefined();
  });

  it('degrades json_schema → json_object → none when unsupported', async () => {
    const { client, calls } = fakeOpenAi((_p, n) =>
      n < 2
        ? new OpenAI.BadRequestError(
            400,
            { message: 'response_format not supported' },
            undefined,
            new Headers(),
          )
        : chatCompletion({
            message: { role: 'assistant', content: 'ok: {"ok":true}', refusal: null },
          }),
    );
    const res = await createOpenAiCompatibleProvider({
      apiKey: 'k',
      baseUrl: 'http://vllm:8000/v1',
      client,
    }).complete(baseReq);
    expect(res.json).toEqual({ ok: true });
    expect(calls.map((c) => c.response_format?.type ?? 'none')).toEqual([
      'json_schema',
      'json_object',
      'none',
    ]);
    expect(calls[1]!.messages[0]!.content).toContain('JSON Schema');
  });

  it('maps length / refusal / content_filter to failures', async () => {
    const mk = (o: object) =>
      createOpenAiCompatibleProvider({
        apiKey: 'k',
        client: fakeOpenAi(() => chatCompletion(o)).client,
      });
    await expect(mk({ finish_reason: 'length' }).complete(baseReq)).rejects.toMatchObject({
      code: 'max_tokens',
    });
    await expect(
      mk({ message: { role: 'assistant', content: null, refusal: 'no' } }).complete(baseReq),
    ).rejects.toMatchObject({ code: 'refusal' });
    await expect(mk({ finish_reason: 'content_filter' }).complete(baseReq)).rejects.toMatchObject({
      code: 'refusal',
    });
  });
});

describe('createProvider / FakeAiProvider', () => {
  it('creates adapters by kind', () => {
    expect(createProvider({ kind: 'anthropic', apiKey: 'test-key' }).kind).toBe('anthropic');
    expect(
      createProvider({
        kind: 'openai_compatible',
        apiKey: '',
        baseUrl: 'http://localhost:11434/v1',
      }).kind,
    ).toBe('openai_compatible');
    expect(() => createProvider({ kind: 'anthropic', apiKey: '' })).toThrow(AiError);
  });

  it('fake provider records calls and replays queued responses', async () => {
    const fake = new FakeAiProvider([
      { json: { ok: true } },
      { error: new AiError('refusal', 'no') },
    ]);
    await expect(fake.complete(baseReq)).resolves.toMatchObject({ json: { ok: true } });
    await expect(fake.complete(baseReq)).rejects.toMatchObject({ code: 'refusal' });
    expect(fake.calls).toHaveLength(2);
  });
});
