import { randomUUID } from 'node:crypto';
import type { Action } from '../domain/action.js';
import type { Surface } from '../surface/types.js';
import type { ApprovalRecord, ApprovalScope } from '../domain/approval.js';
import { RememberedApprovalScopeSchema } from '../domain/approval.js';
import type { ApprovalStore } from '../policy/approval-store.js';
import { PolicyEnforcedSurface } from '../policy/enforced-surface.js';
import type { EvidenceLogger } from '../evidence/logger.js';
import type { HumanHandoff, HandoffResolution, HandoffHandler, HandoffState } from './types.js';
import { HandoffStateMachine } from './state-machine.js';

export interface CoordinatorOptions {
  /** Default human handoff handler */
  handler?: HandoffHandler;
  /** Evidence logger for structured handoff audit trail */
  evidence?: EvidenceLogger;
  /** Durable approval store for allow_and_remember decisions */
  approvalStore?: ApprovalStore;
}

export interface HandleConfirmationParams {
  action: Action;
  reason: string;
  surface: Surface;
  runId: string;
  stepIndex?: number;
  capabilityId?: string;
  scope?: ApprovalScope;
  evidenceCheckpoint?: Record<string, unknown>;
  handlerOverride?: HandoffHandler;
}

export interface CoordinatorResult {
  status: 'resumed' | 'denied' | 'session_unavailable' | 'abandoned';
  state: HandoffState;
  resolution?: HandoffResolution;
  error?: string;
}

/**
 * Coordinates human handoff when automation reaches a policy confirmation boundary.
 *
 * Keeps automation technology-neutral and guarantees:
 * 1. Automation pauses and captures sanitized handoff context.
 * 2. Human escalation operates on the EXACT SAME live Surface/session.
 * 3. Human approvals flow back through PolicyEnforcedSurface (no policy bypass).
 * 4. Structured audit evidence is emitted for all transitions.
 */
export class HandoffCoordinator {
  private eventCounter = 0;

  constructor(private readonly options: CoordinatorOptions = {}) {}

  /**
   * Orchestrate handoff for an action requiring confirmation.
   */
  async handleConfirmation(params: HandleConfirmationParams): Promise<CoordinatorResult> {
    const {
      action,
      reason,
      surface,
      runId,
      stepIndex,
      capabilityId,
      evidenceCheckpoint,
    } = params;

    const sm = new HandoffStateMachine('requested');
    const handoffId = `handoff-${randomUUID()}`;
    const logger = this.options.evidence;

    // Helper for emitting structured evidence
    const emit = (
      type:
        | 'handoff_requested'
        | 'human_takeover'
        | 'human_returned'
        | 'approval_granted'
        | 'approval_denied'
        | 'session_resumed'
        | 'error',
      controlMode: 'automation' | 'human' | 'paused',
      extra?: {
        message?: string;
        data?: Record<string, unknown>;
        approvalDecision?: 'deny' | 'allow_once' | 'allow_and_remember';
        approvalScope?: ApprovalScope;
      },
    ) => {
      if (!logger) return;
      logger.log({
        eventId: this.eventCounter++,
        timestamp: new Date().toISOString(),
        runId,
        stepIndex,
        sessionId: surface.sessionId,
        type,
        action,
        controlMode,
        message: extra?.message,
        data: extra?.data,
        approvalDecision: extra?.approvalDecision,
        approvalScope: extra?.approvalScope,
      });
    };

    // 1. Verify session availability before attempting handoff
    const sessionActive = await this.isSessionAvailable(surface);
    if (!sessionActive) {
      sm.transition('abandoned');
      const errorMsg = `Surface session '${surface.sessionId}' is closed or unavailable for handoff`;
      emit('error', 'paused', { message: errorMsg, data: { status: 'session_unavailable' } });
      return {
        status: 'session_unavailable',
        state: sm.state,
        error: errorMsg,
      };
    }

    // 2. Resolve approval scope (from PolicyEnforcedSurface or params or fallback)
    const approvalScope: ApprovalScope =
      params.scope ??
      (surface instanceof PolicyEnforcedSurface
        ? surface.buildApprovalScope(action)
        : { actionType: action.type });

    // 3. Create HumanHandoff contract (technology-neutral, no credentials)
    const handoff: HumanHandoff = {
      id: handoffId,
      runId,
      capabilityId,
      stepIndex,
      action,
      reason,
      surface,
      sessionId: surface.sessionId,
      approvalScope,
      state: sm.state,
      createdAt: new Date().toISOString(),
      evidenceCheckpoint,
    };

    // 4. Emit handoff requested (automation paused)
    emit('handoff_requested', 'paused', {
      message: `Human handoff requested for '${action.type}': ${reason}`,
      data: {
        handoffId,
        reason,
        sessionId: surface.sessionId,
        approvalScope,
      },
    });

    // 5. Transition to waiting_for_human
    sm.transition('waiting_for_human');
    handoff.state = sm.state;

    // 6. Invoke human handler on the SAME session
    const handler = params.handlerOverride ?? this.options.handler;
    if (!handler) {
      sm.transition('abandoned');
      handoff.state = sm.state;
      const errorMsg = 'No human handoff handler configured';
      emit('error', 'paused', { message: errorMsg, data: { status: 'abandoned' } });
      return {
        status: 'abandoned',
        state: sm.state,
        error: errorMsg,
      };
    }

    emit('human_takeover', 'human', {
      message: `Human operator took control of live session '${surface.sessionId}'`,
      data: { handoffId },
    });

    let resolution: HandoffResolution;
    try {
      resolution = await handler(handoff);
    } catch (err) {
      sm.transition('abandoned');
      handoff.state = sm.state;
      const errorMsg = `Human handoff handler threw error: ${err instanceof Error ? err.message : String(err)}`;
      emit('error', 'human', { message: errorMsg });
      return {
        status: 'abandoned',
        state: sm.state,
        error: errorMsg,
      };
    }

    // 7. Process human decision
    if (resolution.decision === 'deny') {
      sm.transition('denied');
      handoff.state = sm.state;
      emit('approval_denied', 'human', {
        message: resolution.reason ?? `Human operator denied action '${action.type}'`,
        approvalDecision: 'deny',
        approvalScope: resolution.scope ?? approvalScope,
        data: { reason: resolution.reason },
      });
      return {
        status: 'denied',
        state: sm.state,
        resolution,
      };
    }

    // Decision is allow_once or allow_and_remember
    sm.transition('approved');
    handoff.state = sm.state;
    emit('approval_granted', 'human', {
      message: resolution.reason ?? `Human operator approved action '${action.type}' with ${resolution.decision}`,
      approvalDecision: resolution.decision,
      approvalScope: resolution.scope ?? approvalScope,
      data: { decision: resolution.decision, reason: resolution.reason },
    });

    // Integrate approval back into policy boundary (NO BYPASS)
    const effectiveScope = resolution.scope ?? approvalScope;

    if (resolution.decision === 'allow_once') {
      if (surface instanceof PolicyEnforcedSurface) {
        surface.stageEphemeralApproval(effectiveScope);
      }
    } else if (resolution.decision === 'allow_and_remember') {
      const store =
        this.options.approvalStore ??
        (surface instanceof PolicyEnforcedSurface ? surface.getApprovalStore() : undefined);

      if (store) {
        const validatedScope = RememberedApprovalScopeSchema.safeParse({
          actionType: action.type,
          ...effectiveScope,
        });
        if (validatedScope.success) {
          const record: ApprovalRecord = {
            id: `apr-${randomUUID()}`,
            scope: validatedScope.data,
            decision: 'allow_and_remember',
            createdAt: new Date().toISOString(),
            reason: resolution.reason,
          };
          await store.saveRemembered(record);
        }
      }
    }

    // Verify session is still alive before resuming
    const stillAlive = await this.isSessionAvailable(surface);
    if (!stillAlive) {
      sm.transition('abandoned');
      handoff.state = sm.state;
      const errorMsg = `Surface session '${surface.sessionId}' closed or disconnected during human takeover`;
      emit('error', 'paused', { message: errorMsg, data: { status: 'session_unavailable' } });
      return {
        status: 'session_unavailable',
        state: sm.state,
        resolution,
        error: errorMsg,
      };
    }

    // 8. Resume automation on the SAME session
    sm.transition('resumed');
    handoff.state = sm.state;

    emit('human_returned', 'automation', {
      message: `Human returned control of live session '${surface.sessionId}' to automation`,
    });

    emit('session_resumed', 'automation', {
      message: `Automation resumed on live session '${surface.sessionId}'`,
      data: { sessionId: surface.sessionId },
    });

    return {
      status: 'resumed',
      state: sm.state,
      resolution,
    };
  }

  private async isSessionAvailable(surface: Surface): Promise<boolean> {
    try {
      await surface.currentUrl();
      return true;
    } catch {
      return false;
    }
  }
}
