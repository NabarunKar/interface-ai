import { z } from 'zod';
import { ActionSchema } from './action.js';
import { ApprovalDecisionSchema, ApprovalScopeSchema } from './approval.js';

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
 *
 * Approval-related events:
 * - approval_requested: an action required human confirmation
 * - approval_granted: a human approved the action
 * - approval_denied: a human denied the action
 * - approval_remembered: an existing remembered approval was applied
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
    // Approval-related events
    'approval_requested',
    'approval_granted',
    'approval_denied',
    'approval_remembered',
    // Handoff lifecycle events
    'handoff_requested',
    'session_resumed',
  ]),
  /** Step index in the artifact (if applicable) */
  stepIndex: z.number().int().nonnegative().optional(),
  /** Session identifier associated with this event */
  sessionId: z.string().optional(),
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
  /** ID of the approval record involved, if any */
  approvalId: z.string().optional(),
  /** The human's approval decision, if applicable */
  approvalDecision: ApprovalDecisionSchema.optional(),
  /** The scope of the approval, if applicable */
  approvalScope: ApprovalScopeSchema.optional(),
});

export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;
