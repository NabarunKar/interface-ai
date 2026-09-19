import type { ModelClient, ModelInput } from './types.js';
import { CombinedProviderError, isTransientProviderError } from './provider-error.js';

export interface FallbackPolicy {
  /**
   * Predicate to determine if an error is transient and eligible for fallback.
   * Defaults to isTransientProviderError().
   */
  isTransientError?: (error: unknown) => boolean;

  /**
   * Optional callback triggered when fallback is engaged.
   */
  onFallback?: (event: {
    primaryError: unknown;
    input: ModelInput;
    attempt: number;
  }) => void;
}

/**
 * Provider-neutral FallbackModelClient.
 *
 * Wraps a primary ModelClient and an optional fallback ModelClient.
 *
 * Semantics:
 * 1. Attempt primary client.
 * 2. If primary succeeds -> return result.
 * 3. If primary fails:
 *    a. If failure is transient (429, 500, 502, 503, 504, timeout, network error)
 *       AND fallback is configured:
 *       -> trigger onFallback callback
 *       -> attempt fallback client
 *       -> if fallback succeeds -> return result
 *       -> if fallback fails -> throw CombinedProviderError with safe diagnostics
 *    b. If failure is non-transient (400, 401, 403, configuration error)
 *       OR no fallback client is configured:
 *       -> throw primary error directly (do not mask configuration or client errors)
 */
export class FallbackModelClient implements ModelClient {
  constructor(
    public readonly primary: ModelClient,
    public readonly fallback?: ModelClient,
    private readonly policy?: FallbackPolicy,
  ) {}

  get modelName(): string {
    const primaryName = (this.primary as { modelName?: string }).modelName ?? 'primary';
    if (!this.fallback) {
      return primaryName;
    }
    const fallbackName = (this.fallback as { modelName?: string }).modelName ?? 'fallback';
    return `${primaryName} (fallback: ${fallbackName})`;
  }

  async decide(input: ModelInput): Promise<unknown> {
    try {
      return await this.primary.decide(input);
    } catch (primaryError) {
      // If no fallback is configured, propagate primary error directly
      if (!this.fallback) {
        throw primaryError;
      }

      // Determine if the error is transient and warrants fallback
      const isTransient = this.policy?.isTransientError
        ? this.policy.isTransientError(primaryError)
        : isTransientProviderError(primaryError);

      if (!isTransient) {
        // Non-transient errors (400, 401, 403, invalid config) must fail immediately
        throw primaryError;
      }

      // Notify fallback listener if configured
      this.policy?.onFallback?.({
        primaryError,
        input,
        attempt: 1,
      });

      // Attempt fallback client
      try {
        return await this.fallback.decide(input);
      } catch (fallbackError) {
        // Both primary and fallback failed -> surface combined structured failure
        throw new CombinedProviderError(
          'Primary provider experienced a transient failure, and fallback provider also failed.',
          primaryError,
          fallbackError,
        );
      }
    }
  }
}
