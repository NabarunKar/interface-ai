import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createApp } from '../apps/bank-ops/src/server.js';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import { PolicyEnforcedSurface } from '../src/policy/enforced-surface.js';
import { InMemoryApprovalStore } from '../src/policy/approval-store.js';
import { InMemoryEvidenceLogger } from '../src/evidence/logger.js';
import { ReplayEngine } from '../src/replay/replay-engine.js';
import type { CapabilityArtifact } from '../src/domain/artifact.js';
import type { HumanHandoff } from '../src/handoff/types.js';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

/**
 * Capability artifact targeting member search followed by
 * the protected "Reset Web Access Password" action.
 */
const resetAccessArtifact: CapabilityArtifact = {
  id: 'reset-member-web-access',
  name: 'Reset Member Web Access',
  description: 'Lookup member and reset web access password',
  version: '1.0.0',
  targetApp: 'bank-ops',
  surfaceType: 'web',
  entryPoint: 'http://127.0.0.1:3100/',
  inputs: [
    {
      name: 'memberId',
      description: '5-digit Member ID',
      type: 'string',
      required: true,
      example: '10234',
    },
  ],
  steps: [
    {
      index: 0,
      action: {
        type: 'type',
        target: { strategy: 'label', value: 'Member ID:' },
        value: '{{memberId}}',
      },
      rationale: 'Type member ID into search input',
    },
    {
      index: 1,
      action: {
        type: 'click',
        target: { strategy: 'text', value: 'SEARCH' },
      },
      postcondition: {
        description: 'Navigated to member profile page',
        condition: 'url_matches',
        expectedValue: '/member',
      },
      rationale: 'Click search button',
    },
    {
      index: 2,
      action: {
        type: 'click',
        target: { strategy: 'css', value: '#btn-reset-access' },
      },
      postcondition: {
        description: 'Confirmation banner visible',
        condition: 'element_visible',
        target: { strategy: 'css', value: '#reset-success-banner' },
      },
      rationale: 'Click Reset Web Access Password (protected confirmation boundary)',
    },
  ],
  outputs: [
    {
      name: 'confirmationText',
      description: 'The confirmation banner text',
      source: { strategy: 'css', value: '#reset-success-banner' },
      type: 'string',
    },
  ],
  successCondition: {
    description: 'Confirmation banner visible',
    condition: 'element_visible',
    target: { strategy: 'css', value: '#reset-success-banner' },
  },
  createdAt: '2026-09-18T20:00:00.000Z',
  updatedAt: '2026-09-18T20:00:00.000Z',
};

function makePolicy() {
  return new LocalPolicyEngine({
    allowedDomains: ['127.0.0.1', 'localhost'],
    allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
    riskyTargets: ['#btn-reset-access'],
    riskyRoutes: ['/reset-access'],
  });
}

describe('Same-Session Escalation Integration Tests', () => {
  // ---------------------------------------------------------------------------
  // 1. Same-Session Handoff & Approval (allow_once)
  // ---------------------------------------------------------------------------
  it('should pause on confirmation boundary, hand off to human on SAME session, approve, and complete workflow', async () => {
    const rawSurface = await BrowserSurface.create({ headless: true });
    const policy = makePolicy();
    const approvalStore = new InMemoryApprovalStore();
    const evidence = new InMemoryEvidenceLogger();

    const sessionIdBefore = rawSurface.sessionId;
    const debugPageBefore = rawSurface.getDebugPage();

    const enforced = new PolicyEnforcedSurface(
      rawSurface,
      policy,
      approvalStore,
      () => ({
        currentUrl: baseUrl,
        isReplay: true,
        targetApp: 'bank-ops',
        capabilityId: resetAccessArtifact.id,
      }),
    );

    let handoffReceived: HumanHandoff | undefined;
    let handoffSessionId: string | undefined;

    const engine = new ReplayEngine(enforced, { evidence });

    try {
      const result = await engine.replay(
        resetAccessArtifact,
        { memberId: '10234' },
        {
          entryPoint: baseUrl,
          handoff: async (handoff) => {
            handoffReceived = handoff;
            handoffSessionId = handoff.sessionId;

            // Assert session identity during handoff matches the live surface
            expect(handoff.sessionId).toBe(sessionIdBefore);
            expect(handoff.surface.sessionId).toBe(sessionIdBefore);

            // Return simulated human operator approval
            return {
              decision: 'allow_once',
              reason: 'Operator confirmed member identity and authorized password reset',
            };
          },
        },
      );

      expect(result).toEqual(expect.objectContaining({ status: 'success' }));
      expect(result.outputs?.confirmationText).toContain('TEMPORARY ACCESS CODE GENERATED FOR Jane Doe');

      // Assert same-session continuity:
      // 1. Session ID is strictly identical
      expect(handoffSessionId).toBe(sessionIdBefore);
      expect(enforced.sessionId).toBe(sessionIdBefore);
      expect(rawSurface.sessionId).toBe(sessionIdBefore);

      // 2. Playwright Page object reference is strictly identical (Object.is)
      //    Proves no second browser or page was created during escalation.
      const debugPageAfter = rawSurface.getDebugPage();
      expect(Object.is(debugPageBefore, debugPageAfter)).toBe(true);

      // 3. Hand off received proper parameters
      expect(handoffReceived).toBeDefined();
      expect(handoffReceived!.action.type).toBe('click');
      expect(handoffReceived!.reason).toContain('#btn-reset-access');

      // 4. Verify structured evidence trail
      const events = evidence.getAllEvents();
      const eventTypes = events.map((e) => e.type);

      expect(eventTypes).toContain('handoff_requested');
      expect(eventTypes).toContain('human_takeover');
      expect(eventTypes).toContain('approval_granted');
      expect(eventTypes).toContain('human_returned');
      expect(eventTypes).toContain('session_resumed');
      expect(eventTypes).toContain('run_completed');

      // Verify all handoff events recorded the exact session ID
      const handoffReq = events.find((e) => e.type === 'handoff_requested');
      expect(handoffReq?.sessionId).toBe(sessionIdBefore);
      expect(handoffReq?.controlMode).toBe('paused');

      const takeover = events.find((e) => e.type === 'human_takeover');
      expect(takeover?.sessionId).toBe(sessionIdBefore);
      expect(takeover?.controlMode).toBe('human');

      const resumed = events.find((e) => e.type === 'session_resumed');
      expect(resumed?.sessionId).toBe(sessionIdBefore);
      expect(resumed?.controlMode).toBe('automation');
    } finally {
      await rawSurface.close();
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Human Denial
  // ---------------------------------------------------------------------------
  it('should halt workflow when human operator denies action and record terminal outcome without executing protected action', async () => {
    const rawSurface = await BrowserSurface.create({ headless: true });
    const policy = makePolicy();
    const approvalStore = new InMemoryApprovalStore();
    const evidence = new InMemoryEvidenceLogger();

    const sessionIdBefore = rawSurface.sessionId;
    const debugPageBefore = rawSurface.getDebugPage();

    const enforced = new PolicyEnforcedSurface(
      rawSurface,
      policy,
      approvalStore,
      () => ({
        currentUrl: baseUrl,
        isReplay: true,
        targetApp: 'bank-ops',
        capabilityId: resetAccessArtifact.id,
      }),
    );

    const engine = new ReplayEngine(enforced, { evidence });

    try {
      const result = await engine.replay(
        resetAccessArtifact,
        { memberId: '10234' },
        {
          entryPoint: baseUrl,
          handoff: async (handoff) => {
            // Human operator inspects and denies
            return {
              decision: 'deny',
              reason: 'Member identity verification failed — suspicious activity',
            };
          },
        },
      );

      // Produces explicit terminal human denial outcome — MUST NOT be classified as business_outcome
      expect(result.status).not.toBe('business_outcome');
      expect(result.category).not.toBe('BUSINESS_OUTCOME');
      expect(result.status).toBe('denied');
      expect(result.category).toBe('HUMAN_DENIAL');
      expect(result.message).toContain('denied by human operator');
      expect(result.message).toContain('Member identity verification failed');

      // Assert same session was preserved
      expect(rawSurface.sessionId).toBe(sessionIdBefore);
      expect(Object.is(rawSurface.getDebugPage(), debugPageBefore)).toBe(true);

      // Verify the protected action was NOT executed:
      // The current page must still be the member profile, NOT the confirmation page
      const currentUrl = await rawSurface.currentUrl();
      expect(currentUrl).toContain('/member');
      expect(currentUrl).not.toContain('/reset-access');

      const pageText = await rawSurface.pageText();
      expect(pageText).not.toContain('TEMPORARY ACCESS CODE GENERATED');

      // Verify evidence recorded approval_denied
      const events = evidence.getAllEvents();
      const denyEvent = events.find((e) => e.type === 'approval_denied');
      expect(denyEvent).toBeDefined();
      expect(denyEvent?.approvalDecision).toBe('deny');
      expect(denyEvent?.message).toContain('Member identity verification failed');
    } finally {
      await rawSurface.close();
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Crash / Disconnect Semantics
  // ---------------------------------------------------------------------------
  it('should produce an explicit recoverable failure when the session is closed/unavailable during handoff', async () => {
    const rawSurface = await BrowserSurface.create({ headless: true });
    const policy = makePolicy();
    const approvalStore = new InMemoryApprovalStore();
    const evidence = new InMemoryEvidenceLogger();

    const enforced = new PolicyEnforcedSurface(
      rawSurface,
      policy,
      approvalStore,
      () => ({
        currentUrl: baseUrl,
        isReplay: true,
        targetApp: 'bank-ops',
        capabilityId: resetAccessArtifact.id,
      }),
    );

    const engine = new ReplayEngine(enforced, { evidence });

    try {
      const result = await engine.replay(
        resetAccessArtifact,
        { memberId: '10234' },
        {
          entryPoint: baseUrl,
          handoff: async () => {
            // Simulate browser crash / disconnect while human is in control
            await rawSurface.close();
            return {
              decision: 'allow_once',
              reason: 'Approved before crash',
            };
          },
        },
      );

      // Must produce explicit recoverable_failure rather than silently succeeding
      expect(result.status).toBe('recoverable_failure');
      expect(result.category).toBe('RECOVERABLE');
      expect(result.message).toContain('closed or disconnected');

      // Evidence records error
      const errorEvents = evidence.getAllEvents().filter((e) => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);
    } finally {
      await rawSurface.close().catch(() => undefined);
    }
  });
});
