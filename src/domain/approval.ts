import { z } from 'zod';
import { ActionTypeSchema } from './action.js';

/**
 * Human approval decisions for policy-gated actions.
 *
 * deny           — reject this action (one-time by default)
 * allow_once     — approve this action for this occurrence only
 * allow_and_remember — approve and remember for future matching actions
 *
 * A one-time denial does NOT persist as a remembered block.
 * Remembered approvals are scoped and optionally expirable.
 */
export const ApprovalDecisionSchema = z.enum([
  'deny',
  'allow_once',
  'allow_and_remember',
]);

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * Durable remembered approval records only represent approvals that a human
 * explicitly chose to remember. One-time allow and deny responses are runtime
 * responses to a pending action and are not persisted in ApprovalStore.
 */
export const RememberedApprovalDecisionSchema = z.literal('allow_and_remember');

export type RememberedApprovalDecision = z.infer<typeof RememberedApprovalDecisionSchema>;

/**
 * Scope of an approval — defines what the approval covers.
 *
 * A remembered approval only applies when ALL non-undefined
 * fields in the stored scope match the action being evaluated.
 * At least one field must be specified to prevent accidentally
 * creating an approval that matches everything.
 *
 * Example:
 *   scope: { capabilityId: 'lookup_member', actionType: 'type' }
 *   → matches only 'type' actions within the 'lookup_member' capability
 *   → does NOT match 'type' in 'delete_account'
 *   → does NOT match 'click' in 'lookup_member'
 */
export const ApprovalScopeSchema = z.object({
  /** Capability/artifact ID this approval applies to */
  capabilityId: z.string().optional(),
  /** Target application identifier */
  targetApp: z.string().optional(),
  /** Action type this approval covers */
  actionType: ActionTypeSchema.optional(),
  /** Tenant/institution context */
  tenant: z.string().optional(),
  /** URL route pattern this approval applies to */
  route: z.string().optional(),
}).refine(
  (data) => Object.values(data).some(v => v !== undefined),
  { message: 'Approval scope must specify at least one field' }
);

export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

/**
 * Scope for durable remembered approvals.
 *
 * A durable approval must include the action type and at least one contextual
 * boundary beyond action type. This prevents an approval like
 * `{ actionType: 'click' }` from becoming a broad global authorization.
 */
export const RememberedApprovalScopeSchema = ApprovalScopeSchema.refine(
  (data) => data.actionType !== undefined,
  { message: 'Remembered approval scope must include actionType', path: ['actionType'] }
).refine(
  (data) => data.tenant !== undefined || data.targetApp !== undefined || data.capabilityId !== undefined || data.route !== undefined,
  { message: 'Remembered approval scope must include at least one contextual boundary beyond actionType' }
);

export type RememberedApprovalScope = z.infer<typeof RememberedApprovalScopeSchema>;

/**
 * A stored approval record.
 *
 * Safety boundaries:
 * - Only human approval creates these records.
 * - The LLM cannot write directly to the approval store.
 * - Raw sensitive values and credentials must not appear here.
 * - Remembered approvals are scoped and optionally expirable.
 */
export const ApprovalRecordSchema = z.object({
  /** Stable unique identifier */
  id: z.string().min(1),
  /** What this approval covers */
  scope: RememberedApprovalScopeSchema,
  /** Durable remembered authorization is always allow_and_remember */
  decision: RememberedApprovalDecisionSchema,
  /** When this approval was created */
  createdAt: z.string().datetime(),
  /** When this approval expires (if not set, valid until revoked) */
  expiresAt: z.string().datetime().optional(),
  /** Human-provided reason for the decision */
  reason: z.string().optional(),
});

export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
