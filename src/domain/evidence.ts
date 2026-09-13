import { z } from 'zod';
import { ActionSchema } from './action.js';

/**
 * Who was in control when this event occurred.
 */
export const ControlMode = z.enum([
  'automation',   // system was acting autonomously
  'human',        // human operator had taken over
  'paused',       // system was paused awaiting decision
]);

export type ControlMode = z.infer<typeof ControlMode>;

/**
 * A single event in the evidence log.
 * Designed to be serialized as JSON lines (JSONL).
 */
export const EvidenceEventSchema = z.object({
  /** Monotonically increasing event ID within a run */
  eventId: z.number().int().nonnegative(),
  /** ISO timestamp */
  timestamp: z.string().datetime(),
  /** Run ID this event belongs to */
  runId: z.string(),
  /** Event type */
  type: z.enum([
    'run_started',
    'action_proposed',
    'action_approved',
    'action_executed',
    'action_rejected',
    'observation',
    'checkpoint_passed',
    'checkpoint_failed',
    'error',
    'human_takeover',
    'human_returned',
    'run_completed',
  ]),
  /** Step index in the artifact (if applicable) */
  stepIndex: z.number().int().nonnegative().optional(),
  /** The action associated with this event (if applicable) */
  action: ActionSchema.optional(),
  /** Who was in control */
  controlMode: ControlMode,
  /** Observation or outcome data */
  data: z.record(z.string(), z.unknown()).optional(),
  /** Reasoning or rationale (why was this action chosen) */
  reasoning: z.string().optional(),
  /** Human-readable message */
  message: z.string().optional(),
});

export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;
