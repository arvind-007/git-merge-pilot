import { AiError, type AiProvider, type ProviderConfig } from '../types.ts';
import { createAnthropicProvider } from './anthropic.ts';
import { createOpenAiCompatibleProvider } from './openai.ts';

/** Creates a provider adapter for the configured kind (design §9). */
export function createProvider(config: ProviderConfig): AiProvider {
  if (!config.apiKey && config.kind === 'anthropic') {
    throw new AiError('not_configured', 'Anthropic provider requires an API key');
  }
  switch (config.kind) {
    case 'anthropic':
      return createAnthropicProvider({ apiKey: config.apiKey, baseUrl: config.baseUrl ?? null });
    case 'openai_compatible':
      // Local servers (e.g. Ollama) may not need a key; the SDK still requires a non-empty string.
      return createOpenAiCompatibleProvider({
        apiKey: config.apiKey || 'not-needed',
        baseUrl: config.baseUrl ?? null,
      });
    default: {
      const kind: never = config.kind;
      throw new AiError('not_configured', `unsupported AI provider kind: ${String(kind)}`);
    }
  }
}

export {
  createAnthropicProvider,
  type AnthropicClientLike,
  type AnthropicProviderOptions,
} from './anthropic.ts';
export {
  createOpenAiCompatibleProvider,
  type OpenAiClientLike,
  type OpenAiCompatibleProviderOptions,
} from './openai.ts';
export { FakeAiProvider, type FakeHandler, type FakeResponse } from './fake.ts';
