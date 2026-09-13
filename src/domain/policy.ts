import { z } from 'zod';
import type { ActionType } from './action.js';

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
 */
export const PolicyConfigSchema = z.object({
  /** Allowed domains (navigation restricted to these) */
  allowedDomains: z.array(z.string()).min(1),
  /** Allowed URL path patterns (regex strings) */
  allowedRoutes: z.array(z.string()).optional(),
  /** Action types that are allowed */
  allowedActions: z.array(z.string()),
  /** Action types considered risky (require confirmation) */
  riskyActions: z.array(z.string()).optional(),
  /** Maximum actions per run */
  maxActionsPerRun: z.number().positive().int().optional(),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
