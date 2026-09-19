import { GoogleGenAI, Type } from '@google/genai';
import type { ModelClient, ModelInput } from './types.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { buildModelUserMessage } from './prompt-utils.js';
import { ProviderError, isTransientProviderError } from './provider-error.js';

/**
 * Gemini-backed ModelClient implementation.
 *
 * This adapter translates the provider-neutral ModelInput into a
 * Gemini API call and returns the raw parsed JSON. The return type
 * is `unknown` — validation happens in the agent layer via
 * parseModelDecision(), not here.
 *
 * The core agent imports no Gemini types.
 */
export class GeminiModelClient implements ModelClient {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(options?: { apiKey?: string; model?: string }) {
    const apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new ProviderError(
        'GEMINI_API_KEY environment variable is required. ' +
        'Set it before running the discovery agent.',
        { provider: 'gemini', isTransient: false },
      );
    }
    this.ai = new GoogleGenAI({ apiKey });
    this.model = options?.model ?? process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
  }

  get modelName(): string {
    return this.model;
  }

  get providerName(): string {
    return 'gemini';
  }

  async decide(input: ModelInput): Promise<unknown> {
    const userMessage = buildModelUserMessage(input);

    let response;
    try {
      response = await this.ai.models.generateContent({
        model: this.model,
        contents: [
          { role: 'user', parts: [{ text: userMessage }] },
        ],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: MODEL_DECISION_SCHEMA,
          temperature: 0.1,
        },
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const isTransient = isTransientProviderError(error);
      throw new ProviderError(`Gemini request failed: ${sanitizeErrorMessage(message)}`, {
        provider: 'gemini',
        isTransient,
        cause: error,
      });
    }

    const text = response.text;
    if (!text) {
      throw new ProviderError('Gemini returned an empty response', {
        provider: 'gemini',
        isTransient: true,
      });
    }

    // Parse JSON — the result is still `unknown` from the agent's perspective.
    // Structural validation happens via parseModelDecision() in the agent layer.
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError(`Gemini response is not valid JSON: ${text.slice(0, 200)}`, {
        provider: 'gemini',
        isTransient: false,
      });
    }
  }
}

/**
 * JSON Schema for structured output matching ModelDecisionSchema.
 *
 * Gemini's structured output feature uses this schema to constrain
 * the model's response to valid ModelDecision shapes. This is a
 * best-effort constraint — parseModelDecision() remains the
 * authoritative validation boundary.
 */
const MODEL_DECISION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    type: {
      type: Type.STRING,
      description: 'Decision type: ACTION, DONE, STUCK, or ABORT',
      enum: ['ACTION', 'DONE', 'STUCK', 'ABORT'],
    },
    reason: {
      type: Type.STRING,
      description: 'Explanation for the decision',
    },
    action: {
      type: Type.OBJECT,
      description: 'The action to perform (only for ACTION type)',
      properties: {
        type: {
          type: Type.STRING,
          enum: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
        },
        target: {
          type: Type.OBJECT,
          description: 'Target element locator',
          properties: {
            strategy: {
              type: Type.STRING,
              enum: ['role', 'label', 'text', 'attribute', 'css', 'coordinates'],
            },
            value: {
              type: Type.STRING,
              description: 'Locator value',
            },
            description: {
              type: Type.STRING,
              description: 'Human-readable element description',
            },
            attributeName: {
              type: Type.STRING,
              description: 'HTML attribute name (required for attribute strategy)',
            },
          },
          required: ['strategy', 'value'],
        },
        value: {
          type: Type.STRING,
          description: 'Value for the action (URL for navigate, text for type)',
        },
        description: {
          type: Type.STRING,
          description: 'Step description',
        },
      },
      required: ['type'],
    },
    outputs: {
      type: Type.OBJECT,
      description: 'Extracted outputs (only for DONE type)',
      properties: {
        savingsBalance: { type: Type.STRING },
        checkingBalance: { type: Type.STRING },
        memberName: { type: Type.STRING },
        memberId: { type: Type.STRING },
        value: { type: Type.STRING },
      },
    },
  },
  required: ['type'],
};

function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/[A-Za-z0-9_-]{20,}/g, '[REDACTED]').slice(0, 500);
}
