import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createApp } from '../apps/bank-ops/src/server.js';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import { PolicyEnforcedSurface } from '../src/policy/enforced-surface.js';
import { DiscoveryAgent } from '../src/agent/discovery-agent.js';
import { FakeModelClient } from '../src/agent/fake-model.js';
import { InMemoryEvidenceLogger } from '../src/evidence/logger.js';
import {
  TrustingVerifier,
  FailingVerifier,
  MemberBalanceVerifier,
} from '../src/agent/goal-verifier.js';
import type { Goal } from '../src/domain/goal.js';
import type { Surface } from '../src/surface/types.js';

// ---------------------------------------------------------------------------
// Test infrastructure: ephemeral bank-ops server
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGoal(overrides?: Partial<Goal>): Goal {
  return {
    id: 'test-goal',
    description: 'Find member 10234 and return their current savings balance',
    targetApp: 'bank-ops',
    entryPoint: baseUrl,
    maxSteps: 10,
    ...overrides,
  };
}

function makePolicy(overrides?: { riskyActions?: string[] }) {
  return new LocalPolicyEngine({
    allowedDomains: ['127.0.0.1', 'localhost'],
    allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
    riskyActions: overrides?.riskyActions as any,
  });
}

async function withSurface<T>(fn: (surface: BrowserSurface) => Promise<T>): Promise<T> {
  const surface = await BrowserSurface.create({ headless: true });
  try {
    return await fn(surface);
  } finally {
    await surface.close();
  }
}

/**
 * The correct action sequence for the member-lookup workflow.
 * Used by FakeModelClient for deterministic testing.
 */
const HAPPY_PATH_DECISIONS = [
  {
    type: 'ACTION',
    action: { type: 'type', target: { strategy: 'label', value: 'Member ID:' }, value: '10234' },
    reason: 'Type the member ID into the search field',
  },
  {
    type: 'ACTION',
    action: { type: 'click', target: { strategy: 'text', value: 'SEARCH' } },
    reason: 'Submit the search',
  },
  {
    type: 'ACTION',
    action: { type: 'click', target: { strategy: 'text', value: 'View Accounts' } },
    reason: 'Navigate to accounts',
  },
  {
    type: 'DONE',
    reason: 'Savings balance is visible on the accounts page',
    outputs: { savingsBalance: '$8,920.14' },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscoveryAgent with FakeModelClient', () => {
  it('should complete the full happy path with independent verification', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const model = new FakeModelClient(HAPPY_PATH_DECISIONS);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new MemberBalanceVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('success');
      expect(result.outputs).toBeDefined();
      expect(result.outputs!.savingsBalance).toBe('$8,920.14');
      expect(result.stepCount).toBe(3); // 3 ACTION steps before DONE
      expect(model.calls).toBe(4); // 3 ACTIONs + 1 DONE

      // Evidence should contain structured events
      const events = evidence.getAllEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('run_started');
      expect(events[events.length - 1].type).toBe('run_completed');
    });
  });

  it('should fail on malformed model decision', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const model = new FakeModelClient([
        'click the button', // malformed: not an object
      ]);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Invalid model decision');
    });
  });

  it('should fail on invalid action type in model decision', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const model = new FakeModelClient([
        {
          type: 'ACTION',
          action: { type: 'delete', value: 'everything' }, // invalid action type
        },
      ]);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Invalid model decision');
    });
  });

  it('should fail on invalid locator in model decision', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const model = new FakeModelClient([
        {
          type: 'ACTION',
          action: {
            type: 'click',
            target: { strategy: 'attribute', value: 'foo' }, // missing attributeName
          },
        },
      ]);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Invalid model decision');
    });
  });

  it('should fail on policy denial', async () => {
    await withSurface(async (surface) => {
      // Policy that does NOT allow 'type' actions
      const policy = new LocalPolicyEngine({
        allowedDomains: ['127.0.0.1', 'localhost'],
        allowedActions: ['navigate', 'click', 'read', 'wait', 'screenshot'],
        // 'type' is intentionally missing
      });
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const model = new FakeModelClient([
        {
          type: 'ACTION',
          action: { type: 'type', target: { strategy: 'label', value: 'Member ID:' }, value: '10234' },
          reason: 'Type the member ID',
        },
      ]);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Policy denied');
      expect(result.reason).toContain('type');
    });
  });

  it('should return needs_human on confirmation required', async () => {
    await withSurface(async (surface) => {
      // Policy that marks 'type' as risky
      const policy = new LocalPolicyEngine({
        allowedDomains: ['127.0.0.1', 'localhost'],
        allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
        riskyActions: ['type'],
      });
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const model = new FakeModelClient([
        {
          type: 'ACTION',
          action: { type: 'type', target: { strategy: 'label', value: 'Member ID:' }, value: '10234' },
          reason: 'Type the member ID',
        },
      ]);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('needs_human');
      expect(result.reason).toContain('Confirmation required');
    });
  });

  it('should stop at max steps', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      // Generate many wait actions that will never reach DONE
      const decisions = Array.from({ length: 20 }, () => ({
        type: 'ACTION',
        action: { type: 'wait', timeoutMs: 10 },
        reason: 'Waiting',
      }));
      const model = new FakeModelClient(decisions);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 3 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('max_steps');
      expect(result.stepCount).toBe(3);
    });
  });

  it('should stop on timeout', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      // Each wait action consumes 500ms. With 1s timeout, should stop around step 2.
      const decisions = Array.from({ length: 20 }, () => ({
        type: 'ACTION',
        action: { type: 'wait', value: '500' },
        reason: 'Waiting',
      }));
      const model = new FakeModelClient(decisions);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, {
        maxSteps: 20,
        timeoutMs: 1000,
      });

      const result = await agent.run(makeGoal({ maxSteps: 20 }));

      expect(result.status).toBe('timeout');
    });
  });

  it('should handle STUCK decision', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const model = new FakeModelClient([
        {
          type: 'STUCK',
          reason: 'The expected element is not on the page',
        },
      ]);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('stuck');
      expect(result.reason).toContain('The expected element is not on the page');
    });
  });

  it('should handle ABORT decision', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const model = new FakeModelClient([
        {
          type: 'ABORT',
          reason: 'Page is outside the allowed task domain',
        },
      ]);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Aborted');
    });
  });

  it('should fail when DONE verification fails', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const model = new FakeModelClient([
        // Immediately claim DONE without navigating to accounts
        {
          type: 'DONE',
          reason: 'I found the balance',
          outputs: { savingsBalance: '$999.99' },
        },
      ]);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new MemberBalanceVerifier(); // Real verifier — will fail
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('DONE verification failed');
    });
  });

  it('should succeed when DONE verification passes with FailingVerifier → failed', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      // Full happy path sequence
      const model = new FakeModelClient([...HAPPY_PATH_DECISIONS]);
      const evidence = new InMemoryEvidenceLogger();
      // FailingVerifier always fails, even if the model did everything right
      const verifier = new FailingVerifier('Intentional verification failure');
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Intentional verification failure');
    });
  });

  it('should handle model/API errors gracefully', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      // A model client that throws on decide()
      const throwingModel = {
        async decide(): Promise<unknown> {
          throw new Error('Connection refused: model API is down');
        },
      };
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(throwingModel, enforced, evidence, verifier, { maxSteps: 10 });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Model/API error');
      expect(result.reason).toContain('Connection refused');
    });
  });

  it('should fail when model call exceeds modelTimeoutMs', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const slowModel = {
        async decide(): Promise<unknown> {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { type: 'DONE' };
        },
      };
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new TrustingVerifier();
      const agent = new DiscoveryAgent(slowModel, enforced, evidence, verifier, {
        maxSteps: 10,
        modelTimeoutMs: 100,
      });

      const result = await agent.run(makeGoal());

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('Model/API error');
      expect(result.reason).toContain('Model call timed out');
    });
  });

  it('should emit structured evidence events throughout the run', async () => {
    await withSurface(async (surface) => {
      const policy = makePolicy();
      const enforced = new PolicyEnforcedSurface(surface, policy);
      const model = new FakeModelClient(HAPPY_PATH_DECISIONS);
      const evidence = new InMemoryEvidenceLogger();
      const verifier = new MemberBalanceVerifier();
      const agent = new DiscoveryAgent(model, enforced, evidence, verifier, { maxSteps: 10 });

      await agent.run(makeGoal());

      const events = evidence.getAllEvents();
      const types = events.map(e => e.type);

      // Must have these events in order
      expect(types[0]).toBe('run_started');
      expect(types).toContain('observation');
      expect(types).toContain('action_proposed');
      expect(types).toContain('action_executed');
      expect(types[types.length - 1]).toBe('run_completed');

      // All events should have required fields
      for (const event of events) {
        expect(event.runId).toBeDefined();
        expect(event.timestamp).toBeDefined();
        expect(event.controlMode).toBe('automation');
      }
    });
  });
});
