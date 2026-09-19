import { z } from 'zod';
import { ActionSchema } from '../domain/action.js';
import { GoalSchema } from '../domain/goal.js';
import { ObservationSchema } from '../domain/observation.js';
import { OutcomeCategory } from '../domain/outcome.js';

/**
 * Model decisions are structured, provider-neutral, and untrusted until parsed.
 */
export const ModelDecisionTypeSchema = z.enum(['ACTION', 'DONE', 'STUCK', 'ABORT']);
export type ModelDecisionType = z.infer<typeof ModelDecisionTypeSchema>;

export const ModelDecisionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ACTION'),
    action: ActionSchema,
    reason: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal('DONE'),
    reason: z.string().optional(),
    outputs: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    type: z.literal('STUCK'),
    reason: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('ABORT'),
    reason: z.string().min(1),
  }).strict(),
]);

export type ModelDecision = z.infer<typeof ModelDecisionSchema>;

/**
 * Provider-neutral input supplied to a model for one decision.
 */
export const ModelInputSchema = z.object({
  goal: GoalSchema,
  observation: ObservationSchema,
  stepIndex: z.number().int().nonnegative(),
  stepsRemaining: z.number().int().nonnegative(),
  previousDecisions: z.array(ModelDecisionSchema).optional(),
});

export type ModelInput = z.infer<typeof ModelInputSchema>;

/**
 * Provider-neutral model client contract. Implementations may wrap any model,
 * but the core agent contract imports no provider SDKs.
 */
export interface ModelClient {
  decide(input: ModelInput): Promise<unknown>;
}

export const AgentResultStatusSchema = z.enum([
  'success',
  'business_outcome',
  'stuck',
  'needs_human',
  'failed',
  'timeout',
  'max_steps',
]);

export type AgentResultStatus = z.infer<typeof AgentResultStatusSchema>;

export const AgentResultSchema = z.object({
  status: AgentResultStatusSchema,
  goal: GoalSchema,
  stepCount: z.number().int().nonnegative(),
  reason: z.string().optional(),
  message: z.string().optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  runId: z.string().optional(),
  evidenceRef: z.string().optional(),
  category: OutcomeCategory.optional(),
});

export type AgentResult = z.infer<typeof AgentResultSchema>;

export const AgentStateSchema = z.enum([
  'IDLE',
  'OBSERVING',
  'DECIDING',
  'POLICY_CHECKING',
  'EXECUTING',
  'VERIFYING',
  'SUCCESS',
  'BUSINESS_OUTCOME',
  'STUCK',
  'FAILED',
  'TIMEOUT',
  'MAX_STEPS',
]);

export type AgentState = z.infer<typeof AgentStateSchema>;

const TERMINAL_STATES = new Set<AgentState>([
  'SUCCESS',
  'BUSINESS_OUTCOME',
  'STUCK',
  'FAILED',
  'TIMEOUT',
  'MAX_STEPS',
]);

const ALLOWED_TRANSITIONS: Record<AgentState, AgentState[]> = {
  IDLE: ['OBSERVING', 'TIMEOUT', 'FAILED'],
  OBSERVING: ['DECIDING', 'TIMEOUT', 'FAILED'],
  DECIDING: ['POLICY_CHECKING', 'SUCCESS', 'STUCK', 'FAILED', 'TIMEOUT', 'MAX_STEPS'],
  POLICY_CHECKING: ['EXECUTING', 'STUCK', 'FAILED', 'TIMEOUT'],
  EXECUTING: ['VERIFYING', 'STUCK', 'FAILED', 'TIMEOUT', 'MAX_STEPS'],
  VERIFYING: ['OBSERVING', 'SUCCESS', 'BUSINESS_OUTCOME', 'STUCK', 'FAILED', 'TIMEOUT', 'MAX_STEPS'],
  SUCCESS: [],
  BUSINESS_OUTCOME: [],
  STUCK: [],
  FAILED: [],
  TIMEOUT: [],
  MAX_STEPS: [],
};

export function isTerminalAgentState(state: AgentState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransitionAgentState(from: AgentState, to: AgentState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
