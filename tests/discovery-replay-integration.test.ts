import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../apps/bank-ops/src/server.js';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import { PolicyEnforcedSurface } from '../src/policy/enforced-surface.js';
import { DiscoveryAgent } from '../src/agent/discovery-agent.js';
import { FakeModelClient } from '../src/agent/fake-model.js';
import { InMemoryEvidenceLogger } from '../src/evidence/logger.js';
import { MemberBalanceVerifier } from '../src/agent/goal-verifier.js';
import { ArtifactRecorder } from '../src/artifact/index.js';
import { CapabilityArtifactSchema } from '../src/domain/artifact.js';
import { ReplayEngine } from '../src/replay/index.js';
import type { Goal } from '../src/domain/goal.js';

describe('Discovery → Artifact Recording → Deterministic Replay Integration Test', () => {
  async function startBankOpsServer(): Promise<{ server: Server; baseUrl: string }> {
    const app = createApp();
    return new Promise((res) => {
      const server = createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        res({ server, baseUrl: `http://127.0.0.1:${port}/` });
      });
    });
  }

  function makePolicy() {
    return new LocalPolicyEngine({
      allowedDomains: ['127.0.0.1', 'localhost'],
      allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
    });
  }

  it('should run live discovery, record & persist artifact, load artifact, and replay deterministically with 0 LLM calls', async () => {
    // -------------------------------------------------------------------------
    // Phase 1: Live LLM-driven Discovery with ArtifactRecorder
    // -------------------------------------------------------------------------
    const { server: discoveryServer, baseUrl: discoveryBaseUrl } = await startBankOpsServer();
    const discoverySurface = await BrowserSurface.create({ headless: true });
    const discoveryPolicy = makePolicy();
    const enforcedDiscoverySurface = new PolicyEnforcedSurface(
      discoverySurface,
      discoveryPolicy,
      undefined,
      () => ({ currentUrl: discoveryBaseUrl, targetApp: 'bank-ops' }),
    );

    const discoveryEvidence = new InMemoryEvidenceLogger();
    const verifier = new MemberBalanceVerifier();

    // Model client with exact decision sequence produced during live LLM discovery runs
    const DISCOVERY_DECISIONS = [
      {
        type: 'ACTION' as const,
        action: {
          type: 'type' as const,
          target: { strategy: 'label' as const, value: 'Member ID:' },
          value: '10234',
        },
        reason: 'Type the member ID into the search field',
      },
      {
        type: 'ACTION' as const,
        action: {
          type: 'click' as const,
          target: { strategy: 'text' as const, value: 'SEARCH' },
        },
        reason: 'Submit the search',
      },
      {
        type: 'ACTION' as const,
        action: {
          type: 'click' as const,
          target: { strategy: 'text' as const, value: '[ View Accounts ]' },
        },
        reason: 'Navigate to accounts',
      },
      {
        type: 'DONE' as const,
        reason: 'Savings balance is visible on the accounts page',
        outputs: { savingsBalance: '$8,920.14' },
      },
    ];

    const modelClient = new FakeModelClient(DISCOVERY_DECISIONS);

    const artifactsDir = resolve(process.cwd(), 'evidence', 'artifacts');
    const recorder = new ArtifactRecorder({
      outputDir: artifactsDir,
      saveToDisk: true,
      canonicalEntryPoint: 'http://localhost:3100/',
    });

    const discoveryAgent = new DiscoveryAgent(
      modelClient,
      enforcedDiscoverySurface,
      discoveryEvidence,
      verifier,
      {
        maxSteps: 10,
        recorder,
      },
    );

    const goal: Goal = {
      id: `goal-${Date.now()}`,
      description: 'Find member 10234 and return their current savings balance',
      targetApp: 'bank-ops',
      entryPoint: discoveryBaseUrl,
      maxSteps: 10,
    };

    let discoveryResult;
    try {
      discoveryResult = await discoveryAgent.run(goal);
    } finally {
      await discoverySurface.close();
      discoveryServer.close();
    }

    // Verify discovery run success
    expect(discoveryResult.status).toBe('success');
    expect(discoveryResult.outputs?.savingsBalance).toBe('$8,920.14');
    expect(discoveryResult.artifact).toBeDefined();
    expect(discoveryResult.artifactPath).toBeDefined();

    // Verify artifact file exists on disk under evidence/artifacts
    const persistedPath = discoveryResult.artifactPath!;
    expect(existsSync(persistedPath)).toBe(true);

    const modelCallsAfterDiscovery = modelClient.calls;
    expect(modelCallsAfterDiscovery).toBe(4);

    // -------------------------------------------------------------------------
    // Phase 2: Load Persisted CapabilityArtifact from disk
    // -------------------------------------------------------------------------
    const fileContent = readFileSync(persistedPath, 'utf-8');
    const loadedRaw = JSON.parse(fileContent);

    // Validate loaded JSON against domain CapabilityArtifactSchema
    const parseResult = CapabilityArtifactSchema.safeParse(loadedRaw);
    expect(parseResult.success).toBe(true);
    const loadedArtifact = parseResult.data!;

    // Verify canonicalEntryPoint was persisted rather than ephemeral discovery URL
    expect(loadedArtifact.entryPoint).toBe('http://localhost:3100/');

    // Verify parameterization: 10234 is NOT baked in as a literal value
    expect(loadedArtifact.inputs).toHaveLength(1);
    expect(loadedArtifact.inputs[0].name).toBe('memberId');
    expect(loadedArtifact.steps[0].action.value).toBe('{{memberId}}');
    expect(loadedArtifact.steps[0].action.value).not.toBe('10234');

    // Verify output locator is purely structural and does NOT bake in observed balance
    expect(loadedArtifact.outputs[0].source.strategy).toBe('css');
    expect(loadedArtifact.outputs[0].source.value).toBe('tr:nth-child(3) td:nth-child(3)');
    expect(loadedArtifact.outputs[0].source.fallbacks).toBeUndefined();
    expect(JSON.stringify(loadedArtifact.outputs)).not.toContain('$8,920.14');

    // -------------------------------------------------------------------------
    // Phase 3: Deterministic Replay against Fresh Bank Operations Console Session
    // -------------------------------------------------------------------------
    const { server: replayServer, baseUrl: replayBaseUrl } = await startBankOpsServer();
    const replaySurface = await BrowserSurface.create({ headless: true });
    const replayPolicy = makePolicy();
    const enforcedReplaySurface = new PolicyEnforcedSurface(
      replaySurface,
      replayPolicy,
      undefined,
      () => ({ currentUrl: replayBaseUrl, isReplay: true, targetApp: 'bank-ops' }),
    );

    const replayEvidence = new InMemoryEvidenceLogger();

    // ReplayEngine has NO reference to modelClient or any LLM
    const replayEngine = new ReplayEngine(enforcedReplaySurface, {
      evidence: replayEvidence,
    });

    let replayResult;
    try {
      replayResult = await replayEngine.replay(
        loadedArtifact,
        { memberId: '10234' },
        { entryPoint: replayBaseUrl },
      );
    } finally {
      await replaySurface.close();
      replayServer.close();
    }

    // -------------------------------------------------------------------------
    // Phase 4: Verify Replay Result and Zero LLM Invocations
    // -------------------------------------------------------------------------
    expect(replayResult.status).toBe('success');
    expect(replayResult.outputs).toBeDefined();
    expect(replayResult.outputs?.savingsBalance).toBe('$8,920.14');
    expect(replayResult.message).toBe('Replay completed successfully');

    // Model client must not have received ANY calls during replay
    expect(modelClient.calls).toBe(modelCallsAfterDiscovery);
  });

  it('should replay the persisted artifact with a different valid member (10235) and extract their correct balance ($15,340.89)', async () => {
    // Load the persisted artifact produced by discovery
    const artifactsDir = resolve(process.cwd(), 'evidence', 'artifacts');
    const artifactPath = resolve(artifactsDir, 'lookup-member-savings-balance.json');
    expect(existsSync(artifactPath)).toBe(true);

    const fileContent = readFileSync(artifactPath, 'utf-8');
    const artifact = CapabilityArtifactSchema.parse(JSON.parse(fileContent));

    // Confirm that the artifact has no hardcoded balance from member 10234
    expect(JSON.stringify(artifact.outputs)).not.toContain('$8,920.14');

    // Spin up a fresh Bank Operations Console server
    const { server, baseUrl } = await startBankOpsServer();
    const surface = await BrowserSurface.create({ headless: true });
    const policy = makePolicy();
    const enforcedSurface = new PolicyEnforcedSurface(surface, policy, undefined, () => ({
      currentUrl: baseUrl,
      isReplay: true,
      targetApp: 'bank-ops',
    }));

    const evidence = new InMemoryEvidenceLogger();
    const replayEngine = new ReplayEngine(enforcedSurface, { evidence });

    let result;
    try {
      // Replay with member 10235 instead of 10234
      result = await replayEngine.replay(artifact, { memberId: '10235' }, { entryPoint: baseUrl });
    } finally {
      await surface.close();
      server.close();
    }

    // Member 10235's savings balance in Bank Operations Console database is $15,340.89
    expect(result.status).toBe('success');
    expect(result.outputs).toBeDefined();
    expect(result.outputs?.savingsBalance).toBe('$15,340.89');
    expect(result.message).toBe('Replay completed successfully');
  });
});
