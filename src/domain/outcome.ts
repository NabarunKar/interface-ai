import { z } from 'zod';

/**
 * Error/outcome taxonomy.
 *
 * BUSINESS_OUTCOME: An expected business result that the caller needs to know about.
 *   E.g., "member not found" is a legitimate answer, not a crash.
 *
 * RECOVERABLE: A transient or known condition that could potentially
 *   be resolved by retry or dismissal. E.g., dismiss a dialog, wait/retry on slow load.
 *
 * HARD_FAILURE: An unrecoverable error that should stop execution and
 *   surface a clear, debuggable error.
 *
 * HUMAN_DENIAL: An explicit human control decision to deny the proposed action
 *   during handoff. Distinct from target application business outcomes.
 */
export const OutcomeCategory = z.enum([
  'BUSINESS_OUTCOME',
  'RECOVERABLE',
  'HARD_FAILURE',
  'INVALID_ARTIFACT',
  'INVALID_INPUT',
  'HUMAN_DENIAL',
]);

export type OutcomeCategory = z.infer<typeof OutcomeCategory>;

/**
 * Replay result status.
 */
export const ReplayStatus = z.enum([
  'success',
  'business_outcome',
  'invalid_artifact',
  'invalid_input',
  'recoverable_failure',
  'hard_failure',
  'failure', // retained for generic/backwards compatibility
  'denied',
]);

export type ReplayStatus = z.infer<typeof ReplayStatus>;

/**
 * The result of executing a capability artifact (via replay).
 */
export const ReplayResultSchema = z.object({
  /** Overall status */
  status: ReplayStatus,
  /** Outcome category for non-success results */
  category: OutcomeCategory.optional(),
  /** Extracted output data (on success) */
  outputs: z.record(z.string(), z.unknown()).optional(),
  /** Human-readable message */
  message: z.string().optional(),
  /** Which step failed (0-indexed), if applicable */
  failedAtStep: z.number().int().nonnegative().optional(),
  /** What was expected at the failure point */
  expected: z.string().optional(),
  /** What was actually observed at the failure point */
  observed: z.string().optional(),
  /** Duration in ms */
  durationMs: z.number().nonnegative().optional(),
  /** Evidence reference (e.g., path to screenshot or trace) */
  evidenceRef: z.string().optional(),
});

export type ReplayResult = z.infer<typeof ReplayResultSchema>;
