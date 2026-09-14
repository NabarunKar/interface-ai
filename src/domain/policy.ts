import { z } from 'zod';
import { ActionTypeSchema } from './action.js';

/**
 * Risk level for an action.
 */
export const RiskLevel = z.enum([
  'safe',       // read-only, no side effects
  'moderate',   // may have side effects but reversible
  'risky',      // irreversible or sensitive operation
]);

export type RiskLevel = z.infer<typeof RiskLevel>;

/**
 * Policy decision — what the policy engine decided about an action.
 */
export const PolicyDecision = z.enum([
  'allow',
  'deny',
  'require_confirmation',
]);

export type PolicyDecision = z.infer<typeof PolicyDecision>;

/**
 * Result of a policy evaluation.
 */
export const PolicyResultSchema = z.object({
  /** The decision */
  decision: PolicyDecision,
  /** Risk level of the evaluated action */
  riskLevel: RiskLevel,
  /** Reason for the decision */
  reason: z.string(),
});

export type PolicyResult = z.infer<typeof PolicyResultSchema>;

/**
 * Configuration for the policy engine.
 *
 * allowedActions and riskyActions use ActionTypeSchema for compile-time
 * and parse-time safety — a typo in the config (e.g., 'clikc') is
 * caught by Zod validation, not silently ignored at runtime.
 */
export const PolicyConfigSchema = z.object({
  /** Allowed domains (navigation restricted to these) */
  allowedDomains: z.array(z.string()).min(1),
  /** Allowed URL path patterns (regex strings) */
  allowedRoutes: z.array(z.string()).optional(),
  /** Action types that are allowed — must be valid ActionType values */
  allowedActions: z.array(ActionTypeSchema),
  /** Action types considered risky (require confirmation) — must be valid ActionType values */
  riskyActions: z.array(ActionTypeSchema).optional(),
  /** Maximum actions per run */
  maxActionsPerRun: z.number().positive().int().optional(),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
