import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Surface, WaitOptions } from '../src/surface/types.js';
import type { TargetLocator, Action } from '../src/domain/action.js';
import type { Observation } from '../src/domain/observation.js';
import type { PolicyConfig } from '../src/domain/policy.js';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import {
  PolicyEnforcedSurface,
  ConfirmationRequiredError,
} from '../src/policy/enforced-surface.js';
import { InMemoryApprovalStore } from '../src/policy/approval-store.js';
import { InMemoryEvidenceLogger } from '../src/evidence/logger.js';
import {
  HandoffCoordinator,
  HandoffStateMachine,
  HandoffStateError,
  type HumanHandoff,
  type HandoffResolution,
} from '../src/handoff/index.js';

class MockSurface implements Surface {
  readonly sessionId: string;
  calls: Array<{ method: string; args: unknown[] }> = [];
  closed = false;

  constructor(sessionId: string = 'test-session-123') {
    this.sessionId = sessionId;
  }

  async observe(): Promise<Observation> {
    this.assertOpen();
    this.calls.push({ method: 'observe', args: [] });
    return { url: 'http://localhost:3100/member?id=10234', timestamp: new Date().toISOString() };
  }
  async click(target: TargetLocator): Promise<void> {
    this.assertOpen();
    this.calls.push({ method: 'click', args: [target] });
  }
  async type(target: TargetLocator, value: string): Promise<void> {
    this.assertOpen();
    this.calls.push({ method: 'type', args: [target, value] });
  }
  async read(target: TargetLocator): Promise<string> {
    this.assertOpen();
    this.calls.push({ method: 'read', args: [target] });
    return 'mock text';
  }
  async navigate(url: string): Promise<void> {
    this.assertOpen();
    this.calls.push({ method: 'navigate', args: [url] });
  }
  async wait(options: WaitOptions): Promise<void> {
    this.assertOpen();
    this.calls.push({ method: 'wait', args: [options] });
  }
  async screenshot(path?: string): Promise<string> {
    this.assertOpen();
    this.calls.push({ method: 'screenshot', args: [path] });
    return 'screenshot.png';
  }
  async currentUrl(): Promise<string> {
    this.assertOpen();
    this.calls.push({ method: 'currentUrl', args: [] });
    return 'http://localhost:3100/member?id=10234';
  }
  async isVisible(target: TargetLocator): Promise<boolean> {
    this.assertOpen();
    this.calls.push({ method: 'isVisible', args: [target] });
    return true;
  }
  async pageText(): Promise<string> {
    this.assertOpen();
    this.calls.push({ method: 'pageText', args: [] });
    return 'page text';
  }
  async close(): Promise<void> {
    this.closed = true;
    this.calls.push({ method: 'close', args: [] });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Surface is closed');
  }
}

const RISKY_POLICY_CONFIG: PolicyConfig = {
  allowedDomains: ['localhost'],
  allowedActions: ['navigate', 'click', 'type', 'read'],
  riskyActions: ['click'],
};

describe('Human Handoff Unit Tests', () => {
  let rawSurface: MockSurface;
  let approvalStore: InMemoryApprovalStore;
  let evidence: InMemoryEvidenceLogger;
  let policy: LocalPolicyEngine;
  let enforced: PolicyEnforcedSurface;

  beforeEach(() => {
    rawSurface = new MockSurface('test-session-abc');
    approvalStore = new InMemoryApprovalStore();
    evidence = new InMemoryEvidenceLogger();
    policy = new LocalPolicyEngine(RISKY_POLICY_CONFIG);
    enforced = new PolicyEnforcedSurface(rawSurface, policy, approvalStore, () => ({
      currentUrl: 'http://localhost:3100/member?id=10234',
      targetApp: 'bank-ops',
      capabilityId: 'reset-access',
      route: '/member/10234/reset-access',
    }));
  });

  // ---------------------------------------------------------------------------
  // 1. State Machine Transitions
  // ---------------------------------------------------------------------------
  describe('HandoffStateMachine', () => {
    it('should follow the happy path lifecycle', () => {
      const sm = new HandoffStateMachine('requested');
      expect(sm.state).toBe('requested');

      sm.transition('waiting_for_human');
      expect(sm.state).toBe('waiting_for_human');

      sm.transition('approved');
      expect(sm.state).toBe('approved');

      sm.transition('resumed');
      expect(sm.state).toBe('resumed');

      sm.transition('completed');
      expect(sm.state).toBe('completed');
      expect(sm.isTerminal()).toBe(true);
    });

    it('should transition directly to denied (terminal)', () => {
      const sm = new HandoffStateMachine('waiting_for_human');
      sm.transition('denied');
      expect(sm.state).toBe('denied');
      expect(sm.isTerminal()).toBe(true);
      expect(() => sm.transition('resumed')).toThrow(HandoffStateError);
    });

    it('should reject invalid transitions', () => {
      const sm = new HandoffStateMachine('requested');
      expect(() => sm.transition('completed')).toThrow(HandoffStateError);
      expect(() => sm.transition('resumed')).toThrow(HandoffStateError);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Handoff Coordinator Creation & Same-Session Continuity
  // ---------------------------------------------------------------------------
  describe('HandoffCoordinator Creation & Session Preservation', () => {
    it('should pass the live session identity and surface reference into the handoff contract', async () => {
      let receivedHandoff: HumanHandoff | undefined;

      const coordinator = new HandoffCoordinator({
        evidence,
        approvalStore,
        handler: async (handoff) => {
          receivedHandoff = handoff;
          return { decision: 'allow_once', reason: 'Operator approved one-time reset' };
        },
      });

      const action: Action = {
        type: 'click',
        target: { strategy: 'css', value: '#btn-reset-access' },
      };

      const result = await coordinator.handleConfirmation({
        action,
        reason: "Action type 'click' is classified as risky",
        surface: enforced,
        runId: 'run-1',
        stepIndex: 3,
        capabilityId: 'reset-access',
      });

      expect(result.status).toBe('resumed');
      expect(receivedHandoff).toBeDefined();
      expect(receivedHandoff!.sessionId).toBe(rawSurface.sessionId);
      expect(receivedHandoff!.surface.sessionId).toBe(rawSurface.sessionId);
      expect(receivedHandoff!.action).toEqual(action);
      expect(receivedHandoff!.reason).toBe("Action type 'click' is classified as risky");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Approval: allow_once
  // ---------------------------------------------------------------------------
  describe('Approval: allow_once (One-Time Execution Safety)', () => {
    it('should stage one-time approval on PolicyEnforcedSurface and allow exact action to succeed once', async () => {
      const action: Action = {
        type: 'click',
        target: { strategy: 'css', value: '#btn-reset-access' },
      };

      // Initially, calling click throws ConfirmationRequiredError
      await expect(enforced.click(action.target!)).rejects.toThrow(ConfirmationRequiredError);

      const coordinator = new HandoffCoordinator({
        evidence,
        approvalStore,
        handler: async () => ({
          decision: 'allow_once',
          reason: 'Verified operator identity',
        }),
      });

      const result = await coordinator.handleConfirmation({
        action,
        reason: 'Action requires confirmation',
        surface: enforced,
        runId: 'run-2',
      });

      expect(result.status).toBe('resumed');
      expect(result.state).toBe('resumed');

      // Now the retried action MUST proceed through PolicyEnforcedSurface
      await enforced.click(action.target!);
      expect(rawSurface.calls.some((c) => c.method === 'click')).toBe(true);

      // Subsequent call must throw ConfirmationRequiredError again (one-time approval consumed!)
      await expect(enforced.click(action.target!)).rejects.toThrow(ConfirmationRequiredError);

      // Stored approval records must remain empty (allow_once does NOT persist)
      expect(await approvalStore.list()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Approval: allow_and_remember
  // ---------------------------------------------------------------------------
  describe('Approval: allow_and_remember', () => {
    it('should persist an ApprovalRecord and allow subsequent matching actions', async () => {
      const action: Action = {
        type: 'click',
        target: { strategy: 'css', value: '#btn-reset-access' },
      };

      const coordinator = new HandoffCoordinator({
        evidence,
        approvalStore,
        handler: async (handoff) => ({
          decision: 'allow_and_remember',
          reason: 'Authorized administrator role',
        }),
      });

      const result = await coordinator.handleConfirmation({
        action,
        reason: 'Action requires confirmation',
        surface: enforced,
        runId: 'run-3',
      });

      expect(result.status).toBe('resumed');

      // ApprovalStore now has a remembered approval record
      const stored = await approvalStore.list();
      expect(stored).toHaveLength(1);
      expect(stored[0].decision).toBe('allow_and_remember');
      expect(stored[0].scope.actionType).toBe('click');

      // Subsequent actions proceed without re-triggering confirmation
      await enforced.click(action.target!);
      await enforced.click(action.target!);
      expect(rawSurface.calls.filter((c) => c.method === 'click')).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Denial
  // ---------------------------------------------------------------------------
  describe('Approval: deny', () => {
    it('should halt workflow without executing action or modifying ApprovalStore', async () => {
      const action: Action = {
        type: 'click',
        target: { strategy: 'css', value: '#btn-reset-access' },
      };

      const coordinator = new HandoffCoordinator({
        evidence,
        approvalStore,
        handler: async () => ({
          decision: 'deny',
          reason: 'Suspicious request denied by operator',
        }),
      });

      const result = await coordinator.handleConfirmation({
        action,
        reason: 'Action requires confirmation',
        surface: enforced,
        runId: 'run-4',
      });

      expect(result.status).toBe('denied');
      expect(result.state).toBe('denied');

      // Protected action never reached the surface
      expect(rawSurface.calls.some((c) => c.method === 'click')).toBe(false);

      // ApprovalStore is unchanged
      expect(await approvalStore.list()).toHaveLength(0);

      // Evidence logged denial
      const events = evidence.getAllEvents();
      expect(events.some((e) => e.type === 'approval_denied')).toBe(true);
      const denyEvent = events.find((e) => e.type === 'approval_denied');
      expect(denyEvent?.approvalDecision).toBe('deny');
      expect(denyEvent?.message).toContain('Suspicious request denied');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Disconnect / Session Unavailable Semantics
  // ---------------------------------------------------------------------------
  describe('Session Unavailable / Crash Semantics', () => {
    it('should return session_unavailable if surface is closed before handoff begins', async () => {
      await rawSurface.close();

      const coordinator = new HandoffCoordinator({
        evidence,
        approvalStore,
        handler: async () => ({ decision: 'allow_once' }),
      });

      const result = await coordinator.handleConfirmation({
        action: { type: 'click', target: { strategy: 'css', value: '#btn' } },
        reason: 'Requires confirmation',
        surface: enforced,
        runId: 'run-5',
      });

      expect(result.status).toBe('session_unavailable');
      expect(result.state).toBe('abandoned');
      expect(result.error).toContain('closed or unavailable');

      // Evidence logged error
      const errorEvents = evidence.getAllEvents().filter((e) => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);
    });

    it('should return session_unavailable if surface closes during human intervention', async () => {
      const coordinator = new HandoffCoordinator({
        evidence,
        approvalStore,
        handler: async () => {
          // Simulate surface being closed or crashing while human has taken over
          await rawSurface.close();
          return { decision: 'allow_once', reason: 'Approved but session crashed' };
        },
      });

      const result = await coordinator.handleConfirmation({
        action: { type: 'click', target: { strategy: 'css', value: '#btn' } },
        reason: 'Requires confirmation',
        surface: enforced,
        runId: 'run-6',
      });

      expect(result.status).toBe('session_unavailable');
      expect(result.state).toBe('abandoned');
      expect(result.error).toContain('closed or disconnected during human takeover');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Structured Evidence Audit Trail
  // ---------------------------------------------------------------------------
  describe('Structured Evidence Audit Trail', () => {
    it('should record the complete chain of handoff events with controlMode and sessionId', async () => {
      const coordinator = new HandoffCoordinator({
        evidence,
        approvalStore,
        handler: async () => ({
          decision: 'allow_once',
          reason: 'Valid audit review',
        }),
      });

      await coordinator.handleConfirmation({
        action: { type: 'click', target: { strategy: 'css', value: '#btn' } },
        reason: 'Policy confirmation required',
        surface: enforced,
        runId: 'run-7',
        stepIndex: 2,
      });

      const events = evidence.getAllEvents();
      const eventTypes = events.map((e) => e.type);

      expect(eventTypes).toContain('handoff_requested');
      expect(eventTypes).toContain('human_takeover');
      expect(eventTypes).toContain('approval_granted');
      expect(eventTypes).toContain('human_returned');
      expect(eventTypes).toContain('session_resumed');

      // Verify control modes
      const handoffReq = events.find((e) => e.type === 'handoff_requested');
      expect(handoffReq?.controlMode).toBe('paused');
      expect(handoffReq?.sessionId).toBe(rawSurface.sessionId);

      const humanTakeover = events.find((e) => e.type === 'human_takeover');
      expect(humanTakeover?.controlMode).toBe('human');
      expect(humanTakeover?.sessionId).toBe(rawSurface.sessionId);

      const approvalGranted = events.find((e) => e.type === 'approval_granted');
      expect(approvalGranted?.controlMode).toBe('human');
      expect(approvalGranted?.approvalDecision).toBe('allow_once');

      const resumed = events.find((e) => e.type === 'session_resumed');
      expect(resumed?.controlMode).toBe('automation');
      expect(resumed?.sessionId).toBe(rawSurface.sessionId);
    });
  });
});
