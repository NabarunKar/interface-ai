import type { ModelDecision, ModelInput } from './types.js';
import { ModelDecisionSchema, ModelInputSchema } from './types.js';
import type { Goal } from '../domain/goal.js';
import type { Observation } from '../domain/observation.js';

export class ModelDecisionValidationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ModelDecisionValidationError';
  }
}

/**
 * Parse and validate untrusted model output before it can become a domain Action.
 */
export function parseModelDecision(output: unknown): ModelDecision {
  const result = ModelDecisionSchema.safeParse(output);
  if (!result.success) {
    throw new ModelDecisionValidationError('Invalid model decision', result.error);
  }
  return result.data;
}

/**
 * Build the provider-neutral input used for a single model decision.
 */
export function buildModelInput(args: {
  goal: Goal;
  observation: Observation;
  stepIndex: number;
  maxSteps: number;
  previousDecisions?: ModelDecision[];
}): ModelInput {
  const candidate = {
    goal: args.goal,
    observation: args.observation,
    stepIndex: args.stepIndex,
    stepsRemaining: Math.max(args.maxSteps - args.stepIndex, 0),
    previousDecisions: args.previousDecisions,
  };

  return ModelInputSchema.parse(candidate);
}
