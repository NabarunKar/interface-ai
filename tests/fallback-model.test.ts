import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ModelClient, ModelInput } from '../src/agent/types.js';
import {
  GeminiModelClient,
  FallbackModelClient,
  TamuModelClient,
  ProviderError,
  CombinedProviderError,
  isTransientProviderError,
  createConfiguredModelClient,
  isTamuConfigured,
  isGeminiConfigured,
  DiscoveryAgent,
  TrustingVerifier,
} from '../src/agent/index.js';
import { InMemoryEvidenceLogger } from '../src/evidence/logger.js';
import type { Surface } from '../src/surface/types.js';
import type { Goal } from '../src/domain/goal.js';

// Dummy ModelInput fixture for unit tests
const testInput: ModelInput = {
  goal: {
    id: 'test-goal',
    description: 'Test goal',
    targetApp: 'bank-ops',
    entryPoint: 'http://localhost:3100/',
  },
  observation: {
    url: 'http://localhost:3100/',
    timestamp: new Date().toISOString(),
  },
  stepIndex: 0,
  stepsRemaining: 5,
};

describe('Provider Error Classification (isTransientProviderError)', () => {
  it('should classify HTTP 503 as transient', () => {
    const error = new ProviderError('High demand', { provider: 'gemini', status: 503, isTransient: true });
    expect(isTransientProviderError(error)).toBe(true);

    const rawError = { status: 503, message: 'Service unavailable' };
    expect(isTransientProviderError(rawError)).toBe(true);

    const jsonError = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}');
    expect(isTransientProviderError(jsonError)).toBe(true);
  });

  it('should classify HTTP 429 as transient', () => {
    const error = new ProviderError('Rate limited', { provider: 'tamu', status: 429, isTransient: true });
    expect(isTransientProviderError(error)).toBe(true);

    const rawError = { status: 429, message: 'Too Many Requests' };
    expect(isTransientProviderError(rawError)).toBe(true);
  });

  it('should classify HTTP 500, 502, 504 as transient', () => {
    expect(isTransientProviderError({ status: 500, message: 'Internal Server Error' })).toBe(true);
    expect(isTransientProviderError({ status: 502, message: 'Bad Gateway' })).toBe(true);
    expect(isTransientProviderError({ status: 504, message: 'Gateway Timeout' })).toBe(true);
  });

  it('should classify network connection errors and timeouts as transient', () => {
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    expect(isTransientProviderError(timeoutErr)).toBe(true);

    const abortErr = new Error('AbortError');
    abortErr.name = 'AbortError';
    expect(isTransientProviderError(abortErr)).toBe(true);

    expect(isTransientProviderError(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:8000'))).toBe(true);
    expect(isTransientProviderError(new Error('connect ETIMEDOUT'))).toBe(true);
  });

  it('should NOT classify HTTP 400, 401, 403 as transient', () => {
    expect(isTransientProviderError(new ProviderError('Bad Request', { provider: 'tamu', status: 400, isTransient: false }))).toBe(false);
    expect(isTransientProviderError(new ProviderError('Unauthorized', { provider: 'tamu', status: 401, isTransient: false }))).toBe(false);
    expect(isTransientProviderError(new ProviderError('Forbidden', { provider: 'tamu', status: 403, isTransient: false }))).toBe(false);

    expect(isTransientProviderError({ status: 400, message: 'Bad Request' })).toBe(false);
    expect(isTransientProviderError({ status: 401, message: 'Invalid API key provided' })).toBe(false);
    expect(isTransientProviderError({ status: 403, message: 'Permission denied' })).toBe(false);
  });
});

describe('FallbackModelClient', () => {
  it('should return primary result when primary succeeds, without calling fallback', async () => {
    const primaryDecide = vi.fn().mockResolvedValue({ type: 'DONE', outputs: { value: 'primary' } });
    const fallbackDecide = vi.fn().mockResolvedValue({ type: 'DONE', outputs: { value: 'fallback' } });

    const primary: ModelClient = { decide: primaryDecide };
    const fallback: ModelClient = { decide: fallbackDecide };

    const client = new FallbackModelClient(primary, fallback);
    const result = await client.decide(testInput);

    expect(result).toEqual({ type: 'DONE', outputs: { value: 'primary' } });
    expect(primaryDecide).toHaveBeenCalledTimes(1);
    expect(fallbackDecide).not.toHaveBeenCalled();
  });

  it('should call fallback when primary fails with HTTP 503', async () => {
    const primaryError = new ProviderError('Gemini 503 high demand', { provider: 'gemini', status: 503, isTransient: true });
    const primary: ModelClient = { decide: vi.fn().mockRejectedValue(primaryError) };
    const fallback: ModelClient = { decide: vi.fn().mockResolvedValue({ type: 'DONE', outputs: { value: 'fallback-success' } }) };

    let fallbackTriggered = false;
    const client = new FallbackModelClient(primary, fallback, {
      onFallback: () => { fallbackTriggered = true; },
    });

    const result = await client.decide(testInput);

    expect(result).toEqual({ type: 'DONE', outputs: { value: 'fallback-success' } });
    expect(fallbackTriggered).toBe(true);
    expect(fallback.decide).toHaveBeenCalledTimes(1);
  });

  it('should call fallback when primary fails with HTTP 429', async () => {
    const primaryError = new ProviderError('Rate limit exceeded', { provider: 'gemini', status: 429, isTransient: true });
    const primary: ModelClient = { decide: vi.fn().mockRejectedValue(primaryError) };
    const fallback: ModelClient = { decide: vi.fn().mockResolvedValue({ type: 'DONE' }) };

    const client = new FallbackModelClient(primary, fallback);
    const result = await client.decide(testInput);

    expect(result).toEqual({ type: 'DONE' });
    expect(fallback.decide).toHaveBeenCalledTimes(1);
  });

  it('should call fallback when primary fails with network timeout', async () => {
    const timeoutError = new Error('Model call timed out');
    timeoutError.name = 'TimeoutError';
    const primary: ModelClient = { decide: vi.fn().mockRejectedValue(timeoutError) };
    const fallback: ModelClient = { decide: vi.fn().mockResolvedValue({ type: 'DONE' }) };

    const client = new FallbackModelClient(primary, fallback);
    const result = await client.decide(testInput);

    expect(result).toEqual({ type: 'DONE' });
    expect(fallback.decide).toHaveBeenCalledTimes(1);
  });

  it('should NOT call fallback when primary fails with HTTP 401', async () => {
    const primaryError = new ProviderError('Invalid API Key', { provider: 'gemini', status: 401, isTransient: false });
    const primary: ModelClient = { decide: vi.fn().mockRejectedValue(primaryError) };
    const fallback: ModelClient = { decide: vi.fn().mockResolvedValue({ type: 'DONE' }) };

    const client = new FallbackModelClient(primary, fallback);

    await expect(client.decide(testInput)).rejects.toThrow('Invalid API Key');
    expect(fallback.decide).not.toHaveBeenCalled();
  });

  it('should NOT call fallback when primary fails with HTTP 400', async () => {
    const primaryError = new ProviderError('Invalid prompt argument', { provider: 'gemini', status: 400, isTransient: false });
    const primary: ModelClient = { decide: vi.fn().mockRejectedValue(primaryError) };
    const fallback: ModelClient = { decide: vi.fn().mockResolvedValue({ type: 'DONE' }) };

    const client = new FallbackModelClient(primary, fallback);

    await expect(client.decide(testInput)).rejects.toThrow('Invalid prompt argument');
    expect(fallback.decide).not.toHaveBeenCalled();
  });

  it('should throw CombinedProviderError when both primary and fallback fail', async () => {
    const primaryError = new ProviderError('Primary 503', { provider: 'gemini', status: 503, isTransient: true });
    const fallbackError = new ProviderError('Fallback 502', { provider: 'tamu', status: 502, isTransient: true });

    const primary: ModelClient = { decide: vi.fn().mockRejectedValue(primaryError) };
    const fallback: ModelClient = { decide: vi.fn().mockRejectedValue(fallbackError) };

    const client = new FallbackModelClient(primary, fallback);

    await expect(client.decide(testInput)).rejects.toThrow(CombinedProviderError);
    await expect(client.decide(testInput)).rejects.toThrow(/Primary provider experienced a transient failure/);
  });

  it('should return primary failure clearly when no fallback is configured', async () => {
    const primaryError = new ProviderError('Primary 503 high demand', { provider: 'gemini', status: 503, isTransient: true });
    const primary: ModelClient = { decide: vi.fn().mockRejectedValue(primaryError) };

    const client = new FallbackModelClient(primary, undefined);

    await expect(client.decide(testInput)).rejects.toThrow('Primary 503 high demand');
  });

  it('should expose primary and fallback model names correctly', () => {
    const primary = { decide: vi.fn(), modelName: 'gemini-3.8-flash' };
    const fallback = { decide: vi.fn(), modelName: 'meta-llama-3' };

    const client = new FallbackModelClient(primary, fallback);
    expect(client.modelName).toBe('gemini-3.8-flash (fallback: meta-llama-3)');

    const singleClient = new FallbackModelClient(primary);
    expect(singleClient.modelName).toBe('gemini-3.8-flash');
  });
});

describe('TamuModelClient', () => {
  it('should throw configuration error if TAMU_API_KEY is missing', () => {
    expect(() => new TamuModelClient({ baseUrl: 'https://example.com/v1', model: 'gpt-4o' })).toThrow(
      /TAMU_API_KEY is required/,
    );
  });

  it('should throw configuration error if TAMU_BASE_URL is missing', () => {
    expect(() => new TamuModelClient({ apiKey: 'fake-key', model: 'gpt-4o' })).toThrow(
      /TAMU_BASE_URL is required/,
    );
  });

  it('should throw configuration error if TAMU_MODEL is missing', () => {
    expect(() => new TamuModelClient({ apiKey: 'fake-key', baseUrl: 'https://example.com/v1' })).toThrow(
      /TAMU_MODEL is required/,
    );
  });

  it('should send OpenAI-compatible chat completions request and parse response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                type: 'DONE',
                outputs: { savingsBalance: '$8,920.14' },
                reason: 'Balance found',
              }),
            },
          },
        ],
      }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const client = new TamuModelClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.tamu.edu/v1',
        model: 'llama-3-70b',
      });

      const result = await client.decide(testInput);

      expect(result).toEqual({
        type: 'DONE',
        outputs: { savingsBalance: '$8,920.14' },
        reason: 'Balance found',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe('https://api.tamu.edu/v1/chat/completions');
      expect(calledInit.method).toBe('POST');
      expect(calledInit.headers['Authorization']).toBe('Bearer test-key');
      expect(calledInit.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(calledInit.body);
      expect(body.model).toBe('llama-3-70b');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.stream).toBe(false);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1].role).toBe('user');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should classify HTTP 503 and 429 from TAMU as transient ProviderErrors', async () => {
    const mockFetch503 = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Service Unavailable' }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch503;

    try {
      const client = new TamuModelClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.tamu.edu/v1',
        model: 'llama-3-70b',
      });

      await expect(client.decide(testInput)).rejects.toMatchObject({
        isTransient: true,
        status: 503,
        provider: 'tamu',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should classify HTTP 401 and 400 from TAMU as non-transient ProviderErrors', async () => {
    const mockFetch401 = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Invalid API Key' }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch401;

    try {
      const client = new TamuModelClient({
        apiKey: 'bad-key',
        baseUrl: 'https://api.tamu.edu/v1',
        model: 'llama-3-70b',
      });

      await expect(client.decide(testInput)).rejects.toMatchObject({
        isTransient: false,
        status: 401,
        provider: 'tamu',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Provider Factory (createConfiguredModelClient)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LLM_PRIMARY_PROVIDER;
    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.TAMU_API_KEY;
    delete process.env.TAMU_BASE_URL;
    delete process.env.TAMU_MODEL;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should return Gemini alone when TAMU is not configured', () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const client = createConfiguredModelClient();

    // Default primary is Gemini
    expect(client).toBeInstanceOf(GeminiModelClient);
    expect(isTamuConfigured()).toBe(false);
  });

  it('should return FallbackModelClient when both Gemini and TAMU are configured', () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.TAMU_API_KEY = 'test-tamu-key';
    process.env.TAMU_BASE_URL = 'https://api.tamu.edu/v1';
    process.env.TAMU_MODEL = 'llama-3-70b';

    const client = createConfiguredModelClient();

    expect(client).toBeInstanceOf(FallbackModelClient);
    const fallbackClient = client as FallbackModelClient;
    expect(fallbackClient.primary).toBeInstanceOf(GeminiModelClient);
    expect(fallbackClient.fallback).toBeInstanceOf(TamuModelClient);
  });

  it('should support TAMU as primary provider when configured', () => {
    process.env.LLM_PRIMARY_PROVIDER = 'tamu';
    process.env.LLM_FALLBACK_PROVIDER = 'none';
    process.env.TAMU_API_KEY = 'test-tamu-key';
    process.env.TAMU_BASE_URL = 'https://api.tamu.edu/v1';
    process.env.TAMU_MODEL = 'llama-3-70b';

    const client = createConfiguredModelClient();
    expect(client).toBeInstanceOf(TamuModelClient);
  });

  it('should throw clear configuration error if TAMU is selected as primary but not configured', () => {
    process.env.LLM_PRIMARY_PROVIDER = 'tamu';
    expect(() => createConfiguredModelClient()).toThrow(/TAMU_API_KEY is required/);
  });
});

describe('DiscoveryAgent provider-neutral integration with FallbackModelClient', () => {
  it('should run DiscoveryAgent through FallbackModelClient when primary fails with 503 and fallback succeeds', async () => {
    const primaryError = new ProviderError('Gemini 503 high demand', { provider: 'gemini', status: 503, isTransient: true });
    const primary: ModelClient = { decide: vi.fn().mockRejectedValue(primaryError) };

    const fallback: ModelClient = {
      decide: vi.fn().mockResolvedValue({
        type: 'DONE',
        reason: 'Fallback reached goal',
        outputs: { savingsBalance: '$8,920.14' },
      }),
    };

    const fallbackModel = new FallbackModelClient(primary, fallback);

    const mockSurface: Surface = {
      sessionId: 'mock-fallback-session',
      observe: vi.fn().mockResolvedValue({
        url: 'http://localhost:3100/member/10234/accounts',
        title: 'Bank Operations Console',
        visibleText: 'ACCOUNTS — MEMBER 10234 (Jane Doe)\nSavings ****5678 $8,920.14',
        timestamp: new Date().toISOString(),
      }),
      navigate: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue('$8,920.14'),
      wait: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue('screenshot.png'),
      currentUrl: vi.fn().mockResolvedValue('http://localhost:3100/member/10234/accounts'),
      isVisible: vi.fn().mockResolvedValue(true),
      pageText: vi.fn().mockResolvedValue('ACCOUNTS — MEMBER 10234 (Jane Doe)\nSavings ****5678 $8,920.14'),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const evidence = new InMemoryEvidenceLogger();
    const verifier = new TrustingVerifier();
    const goal: Goal = {
      id: 'test-goal',
      description: 'Find member 10234 and return their current savings balance',
      targetApp: 'bank-ops',
      entryPoint: 'http://localhost:3100/',
    };

    const agent = new DiscoveryAgent(fallbackModel, mockSurface, evidence, verifier, { maxSteps: 5 });
    const result = await agent.run(goal);

    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({ savingsBalance: '$8,920.14' });
    expect(primary.decide).toHaveBeenCalledTimes(1);
    expect(fallback.decide).toHaveBeenCalledTimes(1);
  });
});
