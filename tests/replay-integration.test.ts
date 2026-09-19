import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createApp } from '../apps/bank-ops/src/server.js';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import { PolicyEnforcedSurface } from '../src/policy/enforced-surface.js';
import { ReplayEngine } from '../src/replay/index.js';
import { InMemoryEvidenceLogger } from '../src/evidence/logger.js';
import { memberSavingsBalanceArtifact } from './fixtures/member-balance-artifact.js';

describe('Deterministic Replay Integration Tests (Live Bank Operations Console)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}/`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  function makePolicy() {
    return new LocalPolicyEngine({
      allowedDomains: ['127.0.0.1', 'localhost'],
      allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
    });
  }

  async function withSurface<T>(fn: (surface: PolicyEnforcedSurface) => Promise<T>): Promise<T> {
    const rawSurface = await BrowserSurface.create({ headless: true });
    const policy = makePolicy();
    const enforcedSurface = new PolicyEnforcedSurface(rawSurface, policy, undefined, () => ({
      currentUrl: baseUrl,
      isReplay: true,
      targetApp: 'bank-ops',
    }));
    try {
      return await fn(enforcedSurface);
    } finally {
      await rawSurface.close();
    }
  }

  it('should replay member savings balance lookup against live browser without any LLM', async () => {
    await withSurface(async (surface) => {
      const evidence = new InMemoryEvidenceLogger();
      const engine = new ReplayEngine(surface, { evidence });

      const result = await engine.replay(
        memberSavingsBalanceArtifact,
        { memberId: '10234' },
        { entryPoint: baseUrl },
      );

      // Replay succeeded completely deterministically
      expect(result.status).toBe('success');
      expect(result.outputs).toBeDefined();
      expect(result.outputs?.savingsBalance).toBe('$8,920.14');
      expect(result.message).toBe('Replay completed successfully');

      // Verify evidence events
      const events = evidence.getAllEvents();
      expect(events.length).toBeGreaterThan(6);

      const executedActions = events
        .filter((e) => e.type === 'action_executed')
        .map((e) => e.action?.type);
      expect(executedActions).toEqual(['type', 'click', 'click']);

      // Checkpoints passed
      const checkpointPassedEvents = events.filter((e) => e.type === 'checkpoint_passed');
      expect(checkpointPassedEvents.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('should detect business outcome MEMBER_NOT_FOUND when replaying with unknown member ID', async () => {
    await withSurface(async (surface) => {
      const evidence = new InMemoryEvidenceLogger();
      const engine = new ReplayEngine(surface, { evidence });

      const result = await engine.replay(
        memberSavingsBalanceArtifact,
        { memberId: '99999' },
        { entryPoint: baseUrl },
      );

      expect(result.status).toBe('business_outcome');
      expect(result.category).toBe('BUSINESS_OUTCOME');
      expect(result.outputs).toEqual({ code: 'MEMBER_NOT_FOUND' });
      expect(result.message).toBe('Member not found in database');

      // Verify that after search, execution stopped at member not found without clicking [ View Accounts ]
      const executedActions = evidence
        .getAllEvents()
        .filter((e) => e.type === 'action_executed')
        .map((e) => e.action?.type);
      expect(executedActions).toEqual(['type', 'click']);
    });
  });
});
