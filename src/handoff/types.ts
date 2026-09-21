import { z } from 'zod';
import type { Action } from '../domain/action.js';
import type { Surface } from '../surface/types.js';
import type { ApprovalDecision, ApprovalScope } from '../domain/approval.js';
import { ApprovalDecisionSchema, ApprovalScopeSchema } from '../domain/approval.js';
import { ActionSchema } from '../domain/action.js';

/**
 * Explicit handoff lifecycle states.
 */
export const HandoffStateSchema = z.enum([
  'requested',
  'waiting_for_human',
  'approved',
  'denied',
  'resumed',
  'completed',
  'abandoned',
]);

export type HandoffState = z.infer<typeof HandoffStateSchema>;

/**
 * Technology-neutral Human Handoff contract.
 *
 * Exposes all information necessary for human operator intervention
 * without exposing raw credentials or technology-specific browser objects.
 */
export interface HumanHandoff {
  /** Stable unique identifier for this handoff event */
  readonly id: string;
  /** Run identifier of the enclosing execution */
  readonly runId: string;
  /** Capability / artifact identifier if applicable */
  readonly capabilityId?: string;
  /** Step index at which escalation occurred (if applicable) */
  readonly stepIndex?: number;
  /** Proposed action that required human confirmation */
  readonly action: Action;
  /** Reason confirmation is required */
  readonly reason: string;
  /** Technology-neutral live Surface reference for same-session interaction */
  readonly surface: Surface;
  /** Stable session identity of the live surface */
  readonly sessionId: string;
  /** Required approval scope */
  readonly approvalScope: ApprovalScope;
  /** Current lifecycle state */
  state: HandoffState;
  /** When handoff was initiated */
  readonly createdAt: string;
  /** Optional checkpoint or observation snapshot for operator review */
  readonly evidenceCheckpoint?: Record<string, unknown>;
}

/**
 * Human resolution payload.
 */
export const HandoffResolutionSchema = z.object({
  /** Approval decision: deny, allow_once, or allow_and_remember */
  decision: ApprovalDecisionSchema,
  /** Human operator explanation */
  reason: z.string().optional(),
  /** Optional explicit approval scope override */
  scope: ApprovalScopeSchema.optional(),
});

export type HandoffResolution = z.infer<typeof HandoffResolutionSchema>;

/**
 * Callback function representing human operator intervention on the live session.
 */
export type HandoffHandler = (handoff: HumanHandoff) => Promise<HandoffResolution>;
