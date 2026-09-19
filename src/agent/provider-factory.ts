import type { ModelClient } from './types.js';
import { GeminiModelClient } from './gemini-model.js';
import { TamuModelClient } from './tamu-model.js';
import { FallbackModelClient, type FallbackPolicy } from './fallback-model.js';

export interface ProviderFactoryOptions {
  primaryProvider?: string;
  fallbackProvider?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  tamuApiKey?: string;
  tamuBaseUrl?: string;
  tamuModel?: string;
  fallbackPolicy?: FallbackPolicy;
}

/**
 * Check whether TAMU provider configuration is present in options or process environment.
 */
export function isTamuConfigured(options?: ProviderFactoryOptions): boolean {
  const apiKey = options?.tamuApiKey ?? process.env.TAMU_API_KEY;
  const baseUrl = options?.tamuBaseUrl ?? process.env.TAMU_BASE_URL;
  const model = options?.tamuModel ?? process.env.TAMU_MODEL;
  return Boolean(apiKey && baseUrl && model);
}

/**
 * Check whether Gemini provider configuration is present in options or process environment.
 */
export function isGeminiConfigured(options?: ProviderFactoryOptions): boolean {
  const apiKey = options?.geminiApiKey ?? process.env.GEMINI_API_KEY;
  return Boolean(apiKey);
}

/**
 * Create a ModelClient according to configuration.
 *
 * Provider selection:
 * - Primary provider: options.primaryProvider ?? process.env.LLM_PRIMARY_PROVIDER ?? 'gemini'
 * - Fallback provider: options.fallbackProvider ?? process.env.LLM_FALLBACK_PROVIDER ?? 'tamu'
 *
 * Defaults:
 * - primary = gemini
 * - fallback = tamu
 *
 * If TAMU is designated as fallback but is not configured with credentials,
 * the factory configures the primary client without a fallback, ensuring the system
 * works with Gemini alone and fails clearly if Gemini is unavailable.
 */
export function createConfiguredModelClient(options?: ProviderFactoryOptions): ModelClient {
  const primaryName = (
    options?.primaryProvider ??
    process.env.LLM_PRIMARY_PROVIDER ??
    'gemini'
  ).toLowerCase().trim();

  const fallbackName = (
    options?.fallbackProvider ??
    process.env.LLM_FALLBACK_PROVIDER ??
    'tamu'
  ).toLowerCase().trim();

  // Instantiate primary client
  let primaryClient: ModelClient;
  switch (primaryName) {
    case 'gemini':
      primaryClient = new GeminiModelClient({
        apiKey: options?.geminiApiKey,
        model: options?.geminiModel,
      });
      break;

    case 'tamu':
      primaryClient = new TamuModelClient({
        apiKey: options?.tamuApiKey,
        baseUrl: options?.tamuBaseUrl,
        model: options?.tamuModel,
      });
      break;

    default:
      throw new Error(
        `Unsupported primary LLM provider: '${primaryName}'. Supported providers: 'gemini', 'tamu'.`,
      );
  }

  // Instantiate fallback client if configured and distinct from primary
  let fallbackClient: ModelClient | undefined;
  if (fallbackName === 'none' || fallbackName === 'off' || fallbackName === 'false') {
    fallbackClient = undefined;
  } else if (fallbackName === 'tamu') {
    if (primaryName !== 'tamu' && isTamuConfigured(options)) {
      fallbackClient = new TamuModelClient({
        apiKey: options?.tamuApiKey,
        baseUrl: options?.tamuBaseUrl,
        model: options?.tamuModel,
      });
    }
  } else if (fallbackName === 'gemini') {
    if (primaryName !== 'gemini' && isGeminiConfigured(options)) {
      fallbackClient = new GeminiModelClient({
        apiKey: options?.geminiApiKey,
        model: options?.geminiModel,
      });
    }
  } else {
    throw new Error(
      `Unsupported fallback LLM provider: '${fallbackName}'. Supported providers: 'gemini', 'tamu', 'none'.`,
    );
  }

  if (!fallbackClient) {
    return primaryClient;
  }

  return new FallbackModelClient(primaryClient, fallbackClient, options?.fallbackPolicy);
}
