/**
 * Structured error representing an error originating from or when calling an LLM provider.
 */
export class ProviderError extends Error {
  public readonly provider: string;
  public readonly status?: number;
  public readonly code?: string;
  public readonly isTransient: boolean;

  constructor(
    message: string,
    options: {
      provider: string;
      status?: number;
      code?: string;
      isTransient: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = options.provider;
    this.status = options.status;
    this.code = options.code;
    this.isTransient = options.isTransient;
  }
}

/**
 * Structured error thrown when both the primary provider and fallback provider fail.
 */
export class CombinedProviderError extends Error {
  constructor(
    message: string,
    public readonly primaryError: unknown,
    public readonly fallbackError: unknown,
  ) {
    const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    super(`${message}\n  [Primary Provider Error]: ${primaryMsg}\n  [Fallback Provider Error]: ${fallbackMsg}`);
    this.name = 'CombinedProviderError';
  }
}

/**
 * Transient HTTP status codes representing temporary infrastructure/capacity issues.
 */
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Non-transient HTTP status codes indicating client/configuration errors that should fail immediately.
 */
const NON_TRANSIENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 422]);

/**
 * Patterns in error messages or codes that signal transient network or infrastructure problems.
 */
const TRANSIENT_PATTERNS = [
  /503/i,
  /429/i,
  /502/i,
  /504/i,
  /500/i,
  /unavailable/i,
  /high demand/i,
  /rate limit/i,
  /resource_exhausted/i,
  /overloaded/i,
  /timeout/i,
  /timed? ?out/i,
  /econnrefused/i,
  /econnreset/i,
  /enotfound/i,
  /enetunreach/i,
  /etimedout/i,
  /socket hang up/i,
  /fetch failed/i,
  /network/i,
  /und_err/i,
];

/**
 * Patterns that signal permanent/non-transient errors (e.g. auth, bad request).
 */
const NON_TRANSIENT_PATTERNS = [
  /400/i,
  /401/i,
  /403/i,
  /404/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid_argument/i,
  /bad request/i,
  /api[ _]?key/i,
  /permission_denied/i,
  /unauthenticated/i,
];

/**
 * Determine if an error from an LLM provider represents a transient condition
 * (such as 429, 500, 502, 503, 504, connection failure, or timeout) that warrants falling back.
 */
export function isTransientProviderError(error: unknown): boolean {
  if (!error) return false;

  // 1. Check if it's already a classified ProviderError
  if (error instanceof ProviderError) {
    return error.isTransient;
  }

  // 2. Check HTTP status on error object if present
  const anyErr = error as Record<string, unknown>;
  const status = typeof anyErr.status === 'number'
    ? anyErr.status
    : typeof anyErr.statusCode === 'number'
      ? anyErr.statusCode
      : undefined;

  if (status !== undefined) {
    if (TRANSIENT_HTTP_STATUSES.has(status)) return true;
    if (NON_TRANSIENT_HTTP_STATUSES.has(status)) return false;
  }

  const code = typeof anyErr.code === 'number'
    ? anyErr.code
    : typeof anyErr.code === 'string'
      ? parseInt(anyErr.code, 10)
      : undefined;

  if (code !== undefined && !Number.isNaN(code)) {
    if (TRANSIENT_HTTP_STATUSES.has(code)) return true;
    if (NON_TRANSIENT_HTTP_STATUSES.has(code)) return false;
  }

  // 3. Check for specific JS/Node timeout and network error types
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return true;
    }
  }

  // 4. Check error message / string representation
  const message = error instanceof Error ? error.message : String(error);

  // Check non-transient first to avoid false positives (e.g., 400 Bad Request containing some transient word)
  for (const pattern of NON_TRANSIENT_PATTERNS) {
    if (pattern.test(message)) {
      return false;
    }
  }

  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(message)) {
      return true;
    }
  }

  return false;
}
