import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactRecorder, ArtifactValidationError } from '../src/artifact/index.js';
import { CapabilityArtifactSchema } from '../src/domain/artifact.js';
import { ReplayEngine } from '../src/replay/index.js';
import type { Surface } from '../src/surface/types.js';
import type { Goal } from '../src/domain/goal.js';
import type { DiscoveredStepRecord } from '../src/artifact/types.js';

describe('ArtifactRecorder Unit Tests', () => {
  let tempDir: string;
  let recorder: ArtifactRecorder;

  const sampleGoal: Goal = {
    id: 'goal-10234',
    description: 'Find member 10234 and return their current savings balance',
    targetApp: 'bank-ops',
    entryPoint: 'http://127.0.0.1:3100/',
    maxSteps: 10,
  };

  const sampleDiscoveredSteps: DiscoveredStepRecord[] = [
    {
      index: 0,
      action: {
        type: 'type',
        target: { strategy: 'label', value: 'Member ID:' },
        value: '10234',
      },
      preUrl: 'http://127.0.0.1:3100/',
      postUrl: 'http://127.0.0.1:3100/',
      rationale: 'Enter member ID into search input',
    },
    {
      index: 1,
      action: {
        type: 'click',
        target: { strategy: 'text', value: 'SEARCH' },
      },
      preUrl: 'http://127.0.0.1:3100/',
      postUrl: 'http://127.0.0.1:3100/member?id=10234',
      rationale: 'Submit search form',
    },
    {
      index: 2,
      action: {
        type: 'click',
        target: { strategy: 'text', value: '[ View Accounts ]' },
      },
      preUrl: 'http://127.0.0.1:3100/member?id=10234',
      postUrl: 'http://127.0.0.1:3100/member/10234/accounts',
      rationale: 'Open member accounts page',
    },
  ];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'artifact-recorder-test-'));
    recorder = new ArtifactRecorder({
      outputDir: tempDir,
      saveToDisk: true,
    });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('1. should record executed actions into structured artifact steps', async () => {
    const result = await recorder.record({
      goal: sampleGoal,
      steps: sampleDiscoveredSteps,
      outputs: { savingsBalance: '$8,920.14' },
      runId: 'run-test-01',
    });

    expect(result.artifact.steps).toHaveLength(3);

    // Step 0: typing
    expect(result.artifact.steps[0].index).toBe(0);
    expect(result.artifact.steps[0].action.type).toBe('type');
    expect(result.artifact.steps[0].action.target?.value).toBe('Member ID:');
    expect(result.artifact.steps[0].rationale).toBe('Enter member ID into search input');

    // Step 1: click search with derived postcondition
    expect(result.artifact.steps[1].index).toBe(1);
    expect(result.artifact.steps[1].action.type).toBe('click');
    expect(result.artifact.steps[1].action.target?.value).toBe('SEARCH');
    expect(result.artifact.steps[1].postcondition).toBeDefined();
    expect(result.artifact.steps[1].postcondition?.condition).toBe('url_matches');
    expect(result.artifact.steps[1].postcondition?.expectedValue).toBe('/member');

    // Step 2: click view accounts with derived postcondition
    expect(result.artifact.steps[2].index).toBe(2);
    expect(result.artifact.steps[2].action.type).toBe('click');
    expect(result.artifact.steps[2].postcondition).toBeDefined();
    expect(result.artifact.steps[2].postcondition?.expectedValue).toBe('/accounts');
  });

  it('2. should parameterize memberId into {{memberId}} across steps', async () => {
    const result = await recorder.record({
      goal: sampleGoal,
      steps: sampleDiscoveredSteps,
      outputs: { savingsBalance: '$8,920.14' },
      runId: 'run-test-02',
    });

    // Check declared inputs
    expect(result.artifact.inputs).toHaveLength(1);
    expect(result.artifact.inputs[0].name).toBe('memberId');
    expect(result.artifact.inputs[0].type).toBe('string');
    expect(result.artifact.inputs[0].example).toBe('10234');

    // Value 10234 must be templated, not baked in
    expect(result.artifact.steps[0].action.value).toBe('{{memberId}}');
    expect(result.artifact.steps[0].action.value).not.toBe('10234');
  });

  it('3. should pass strict CapabilityArtifactSchema validation', async () => {
    const result = await recorder.record({
      goal: sampleGoal,
      steps: sampleDiscoveredSteps,
      outputs: { savingsBalance: '$8,920.14' },
      runId: 'run-test-03',
    });

    const parsed = CapabilityArtifactSchema.safeParse(result.artifact);
    expect(parsed.success).toBe(true);

    // Provenance
    expect(result.artifact.sourceRunId).toBe('run-test-03');
    expect(result.artifact.version).toBe('1.0.0');
    expect(result.artifact.createdAt).toBeDefined();
    expect(result.artifact.updatedAt).toBeDefined();
    expect(result.artifact.outputs[0].name).toBe('savingsBalance');
  });

  it('4. should successfully round-trip through JSON persistence and load', async () => {
    const recordResult = await recorder.record({
      goal: sampleGoal,
      steps: sampleDiscoveredSteps,
      outputs: { savingsBalance: '$8,920.14' },
      runId: 'run-test-04',
    });

    expect(recordResult.filePath).toBeDefined();
    expect(existsSync(recordResult.filePath!)).toBe(true);

    // Read back and parse
    const rawContent = readFileSync(recordResult.filePath!, 'utf-8');
    const loaded = JSON.parse(rawContent);

    const parsed = CapabilityArtifactSchema.safeParse(loaded);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(recordResult.artifact);
  });

  it('5. should reject invalid artifacts before persistence and write no files', async () => {
    // 0 steps should fail validation
    await expect(
      recorder.record({
        goal: sampleGoal,
        steps: [],
        runId: 'run-test-05',
      }),
    ).rejects.toThrow(ArtifactValidationError);

    // Ensure no files were written to disk
    expect(existsSync(join(tempDir, 'lookup-member-savings-balance.json'))).toBe(false);
  });

  it('6. should produce an artifact directly accepted by ReplayEngine pre-execution validation', async () => {
    const recordResult = await recorder.record({
      goal: sampleGoal,
      steps: sampleDiscoveredSteps,
      outputs: { savingsBalance: '$8,920.14' },
      runId: 'run-test-06',
    });

    // Mock surface to observe replay pre-validation
    const mockSurface: Surface = {
      sessionId: 'mock-recorder-session',
      observe: async () => ({
        url: 'http://127.0.0.1:3100/',
        timestamp: new Date().toISOString(),
      }),
      navigate: async () => {},
      click: async () => {},
      type: async () => {},
      read: async () => '$8,920.14',
      wait: async () => {},
      screenshot: async () => 'data:image/png;base64,mock',
      currentUrl: async () => 'http://127.0.0.1:3100/member/10234/accounts',
      isVisible: async () => true,
      pageText: async () => 'Savings $8,920.14',
      close: async () => {},
    };

    const engine = new ReplayEngine(mockSurface);

    // Test rejection on missing input
    const missingInputResult = await engine.replay(recordResult.artifact, {});
    expect(missingInputResult.status).toBe('invalid_input');

    // Test acceptance and execution with valid input
    const validResult = await engine.replay(recordResult.artifact, { memberId: '10234' });
    expect(validResult.status).toBe('success');
    expect(validResult.outputs?.savingsBalance).toBe('$8,920.14');
  });

  it('7. should never use concrete observed output values as locator fallbacks', async () => {
    const result = await recorder.record({
      goal: sampleGoal,
      steps: sampleDiscoveredSteps,
      outputs: { savingsBalance: '$8,920.14' },
      runId: 'run-test-07',
    });

    const output = result.artifact.outputs.find((o) => o.name === 'savingsBalance');
    expect(output).toBeDefined();
    // Locator must be purely structural
    expect(output!.source.strategy).toBe('css');
    expect(output!.source.value).toBe('tr:nth-child(3) td:nth-child(3)');
    // Must NOT contain observed runtime value in source or fallbacks
    expect(output!.source.fallbacks).toBeUndefined();
    expect(JSON.stringify(output!.source)).not.toContain('$8,920.14');
  });

  it('8. should record canonicalEntryPoint when provided and preserve discovery entryPoint when omitted', async () => {
    // A: With canonicalEntryPoint
    const canonicalRecorder = new ArtifactRecorder({
      outputDir: tempDir,
      saveToDisk: false,
      canonicalEntryPoint: 'http://localhost:3100/',
    });

    const canonicalResult = await canonicalRecorder.record({
      goal: { ...sampleGoal, entryPoint: 'http://127.0.0.1:54321/' },
      steps: sampleDiscoveredSteps,
      outputs: { savingsBalance: '$8,920.14' },
      runId: 'run-test-08a',
    });

    expect(canonicalResult.artifact.entryPoint).toBe('http://localhost:3100/');
    expect(canonicalResult.artifact.sourceRunId).toBe('run-test-08a');

    // B: Without canonicalEntryPoint
    const defaultResult = await recorder.record({
      goal: { ...sampleGoal, entryPoint: 'http://127.0.0.1:54321/' },
      steps: sampleDiscoveredSteps,
      outputs: { savingsBalance: '$8,920.14' },
      runId: 'run-test-08b',
    });

    expect(defaultResult.artifact.entryPoint).toBe('http://127.0.0.1:54321/');
  });
});
