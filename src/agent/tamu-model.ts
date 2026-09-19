import type { ModelClient, ModelInput } from './types.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { buildModelUserMessage } from './prompt-utils.js';
import { ProviderError } from './provider-error.js';

export interface TamuModelClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * TAMU AI Chat ModelClient implementation.
 *
 * Interacts with TAMU's OpenAI-compatible chat completions endpoint.
 * Requires:
 *   - TAMU_API_KEY: Authentication token
 *   - TAMU_BASE_URL: Base URL for the OpenAI-compatible service (e.g. https://api.tamu.edu/v1)
 *   - TAMU_MODEL: Model identifier (e.g. gpt-4o, llama-3, etc.)
 *
 * Translates provider-neutral ModelInput into an OpenAI-compatible request
 * and returns the raw parsed JSON response. The return type is `unknown` —
 * validation happens in the agent validation boundary via parseModelDecision().
 *
 * Imports NO Gemini, Playwright, or BrowserSurface types.
 */
export class TamuModelClient implements ModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options?: TamuModelClientOptions) {
    const apiKey = options?.apiKey ?? process.env.TAMU_API_KEY;
    if (!apiKey) {
      throw new ProviderError(
        'TAMU_API_KEY is required. Set the TAMU_API_KEY environment variable or pass apiKey in options.',
        { provider: 'tamu', isTransient: false },
      );
    }

    const baseUrl = options?.baseUrl ?? process.env.TAMU_BASE_URL;
    if (!baseUrl) {
      throw new ProviderError(
        'TAMU_BASE_URL is required. Set the TAMU_BASE_URL environment variable or pass baseUrl in options.',
        { provider: 'tamu', isTransient: false },
      );
    }

    const model = options?.model ?? process.env.TAMU_MODEL;
    if (!model) {
      throw new ProviderError(
        'TAMU_MODEL is required. Set the TAMU_MODEL environment variable or pass model in options.',
        { provider: 'tamu', isTransient: false },
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get modelName(): string {
    return this.model;
  }

  get providerName(): string {
    return 'tamu';
  }

  async decide(input: ModelInput): Promise<unknown> {
    const userMessage = buildModelUserMessage(input);
    const endpoint = `${this.baseUrl}/chat/completions`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          response_format: { type: 'json_object' },
          stream: false,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (networkError) {
      const isTimeout =
        networkError instanceof Error &&
        (networkError.name === 'TimeoutError' || networkError.name === 'AbortError');
      const message = networkError instanceof Error ? networkError.message : String(networkError);
      throw new ProviderError(`TAMU request failed: ${sanitizeErrorMessage(message)}`, {
        provider: 'tamu',
        code: isTimeout ? 'ETIMEDOUT' : 'NETWORK_ERROR',
        isTransient: true, // Network failures & timeouts are transient
        cause: networkError,
      });
    }

    if (!response.ok) {
      let rawError = '';
      try {
        const json = await response.json();
        rawError = JSON.stringify(json);
      } catch {
        rawError = await response.text().catch(() => '');
      }

      const status = response.status;
      const isTransient = [429, 500, 502, 503, 504].includes(status);
      throw new ProviderError(
        `TAMU API returned HTTP ${status}: ${sanitizeErrorMessage(rawError)}`,
        {
          provider: 'tamu',
          status,
          isTransient,
        },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (parseError) {
      throw new ProviderError('TAMU API response was not valid JSON', {
        provider: 'tamu',
        isTransient: false,
        cause: parseError,
      });
    }

    const choices = (payload as Record<string, unknown>)?.choices;
    const firstChoice = Array.isArray(choices) && choices.length > 0 ? (choices[0] as Record<string, unknown>) : undefined;
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    const content = message?.content;

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ProviderError('TAMU API returned empty choice content', {
        provider: 'tamu',
        isTransient: true,
      });
    }

    try {
      return JSON.parse(content);
    } catch {
      throw new ProviderError(`TAMU API output is not valid JSON: ${content.slice(0, 200)}`, {
        provider: 'tamu',
        isTransient: false,
      });
    }
  }
}

function sanitizeErrorMessage(msg: string): string {
  // Redact long alphanumeric strings that might look like auth tokens
  return msg.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]').slice(0, 500);
}
