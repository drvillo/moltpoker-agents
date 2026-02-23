import type { LanguageModel } from 'ai'
import {
  SUPPORTED_MODEL_PROVIDERS,
  getProviderApiKeyFromEnv,
  normalizeProvider,
} from '@moltpoker/shared'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Parse a provider:model string (e.g. "openai:gpt-4.1") into an AI SDK LanguageModel.
 * Dynamically imports the provider package to avoid loading unused providers.
 */
export async function resolveModel(modelSpec: string): Promise<LanguageModel> {
  const [provider, ...rest] = modelSpec.split(':')
  const modelId = rest.join(':') // rejoin in case model name contains ':'

  if (!provider || !modelId)
    throw new Error(
      `Invalid model spec "${modelSpec}". Expected format: provider:model (e.g. openai:gpt-4.1, openrouter:openai/gpt-4o-mini)`,
    )

  const normalizedProvider = normalizeProvider(provider)

  switch (normalizedProvider) {
    case 'openai': {
      const { openai } = await import('@ai-sdk/openai')
      return openai(modelId)
    }
    case 'openrouter': {
      const openrouterApiKey = getProviderApiKeyFromEnv('openrouter', process.env)
      if (!openrouterApiKey)
        throw new Error(
          'Missing OpenRouter API key. Set OPENROUTER_KEY (preferred) or OPENROUTER_API_KEY.',
        )

      const openaiSdk = await import('@ai-sdk/openai')
      const createOpenAICompat = (openaiSdk as unknown as {
        createOpenAI?: (options: { apiKey: string; baseURL: string }) => (id: string) => LanguageModel
      }).createOpenAI

      if (!createOpenAICompat)
        throw new Error('OpenRouter requires @ai-sdk/openai createOpenAI support.')

      const openrouter = createOpenAICompat({
        apiKey: openrouterApiKey,
        baseURL: OPENROUTER_BASE_URL,
      })
      return openrouter(modelId)
    }
    case 'anthropic': {
      const { anthropic } = await import('@ai-sdk/anthropic')
      return anthropic(modelId)
    }
    default:
      throw new Error(
        `Unsupported LLM provider: "${provider}". Supported: ${SUPPORTED_MODEL_PROVIDERS.join(', ')}`,
      )
  }
}
