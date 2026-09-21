import { describe, it, expect } from 'vitest';
import {
  AgentResultSchema,
  AgentStateSchema,
  FakeModelClient,
  ModelDecisionSchema,
  buildModelInput,
  canTransitionAgentState,
  isTerminalAgentState,
  parseModelDecision,
} from '../src/agent/index.js';
import type { Goal } from '../src/domain/goal.js';
import type { Observation } from '../src/domain/observation.js';

const goal: Goal = {
  id: 'goal-001',
  description: 'Find member 10234 and return their current savings balance',
  targetApp: 'bank-ops',
  entryPoint: 'http://localhost:3100/',
  parameters: { memberId: '10234' },
  maxSteps: 10,
};

const observation: Observation = {
  url: 'http://localhost:3100/',
  title: 'Bank Operations Console',
  visibleText: 'BANK OPERATIONS CONSOLE\nMEMBER SEARCH\nMember ID: SEARCH',
  elements: [
    { tag: 'input', attributes: { name: 'id', type: 'text' }, visible: true, enabled: true },
    { tag: 'button', text: 'SEARCH', attributes: { type: 'submit' }, visible: true, enabled: true },
  ],
  timestamp: new Date().toISOString(),
};

describe('Agent contract', () => {
  it('should accept a valid ACTION decision containing a domain Action', () => {
    const decision = parseModelDecision({
      type: 'ACTION',
      action: { type: 'navigate', value: 'http://localhost:3100/' },
      reason: 'Open the target application',
    });

    expect(decision.type).toBe('ACTION');
    if (decision.type === 'ACTION') {
      expect(decision.action.type).toBe('navigate');
    }
  });

  it('should accept valid DONE, STUCK, and ABORT decisions', () => {
    expect(ModelDecisionSchema.safeParse({
      type: 'DONE',
      reason: 'Found the balance',
      outputs: { savingsBalance: '$8,920.14' },
    }).success).toBe(true);

    expect(ModelDecisionSchema.safeParse({
      type: 'STUCK',
      reason: 'The expected link is missing',
    }).success).toBe(true);

    expect(ModelDecisionSchema.safeParse({
      type: 'ABORT',
      reason: 'The page is outside the allowed task',
    }).success).toBe(true);
  });

  it('should reject malformed or unknown model output', () => {
    expect(() => parseModelDecision('click the button')).toThrow('Invalid model decision');
    expect(() => parseModelDecision({ type: 'CLICK', target: 'SEARCH' })).toThrow('Invalid model decision');
    expect(() => parseModelDecision({ type: 'STUCK' })).toThrow('Invalid model decision');
  });

  it('should reject invalid action and locator data in ACTION decisions', () => {
    expect(() => parseModelDecision({
      type: 'ACTION',
      action: { type: 'delete', value: 'account' },
    })).toThrow('Invalid model decision');

    expect(() => parseModelDecision({
      type: 'ACTION',
      action: { type: 'click', target: { strategy: 'attribute', value: 'abc' } },
    })).toThrow('Invalid model decision');
  });

  it('should validate serializable agent result statuses', () => {
    for (const status of ['success', 'business_outcome', 'stuck', 'needs_human', 'failed', 'timeout', 'max_steps', 'denied']) {
      const result = AgentResultSchema.safeParse({
        status,
        goal,
        stepCount: 3,
        reason: 'test result',
        outputs: status === 'success' ? { value: 'ok' } : undefined,
        runId: 'run-001',
        evidenceRef: 'evidence/run-001.jsonl',
      });
      expect(result.success).toBe(true);
    }
  });

  it('should reject unknown agent result status', () => {
    const result = AgentResultSchema.safeParse({
      status: 'maybe_done',
      goal,
      stepCount: 1,
    });
    expect(result.success).toBe(false);
  });

  it('should define allowed discovery state transitions', () => {
    expect(AgentStateSchema.safeParse('OBSERVING').success).toBe(true);
    expect(canTransitionAgentState('IDLE', 'OBSERVING')).toBe(true);
    expect(canTransitionAgentState('OBSERVING', 'DECIDING')).toBe(true);
    expect(canTransitionAgentState('DECIDING', 'POLICY_CHECKING')).toBe(true);
    expect(canTransitionAgentState('POLICY_CHECKING', 'EXECUTING')).toBe(true);
    expect(canTransitionAgentState('EXECUTING', 'VERIFYING')).toBe(true);
    expect(canTransitionAgentState('VERIFYING', 'SUCCESS')).toBe(true);
    expect(canTransitionAgentState('SUCCESS', 'OBSERVING')).toBe(false);
    expect(isTerminalAgentState('SUCCESS')).toBe(true);
    expect(isTerminalAgentState('MAX_STEPS')).toBe(true);
    expect(isTerminalAgentState('DECIDING')).toBe(false);
  });

  it('should provide a deterministic fake model sequence', async () => {
    const model = new FakeModelClient([
      { type: 'ACTION', action: { type: 'navigate', value: 'http://localhost:3100/' } },
      { type: 'ACTION', action: { type: 'type', target: { strategy: 'label', value: 'Member ID:' }, value: '10234' } },
      { type: 'ACTION', action: { type: 'click', target: { strategy: 'text', value: 'SEARCH' } } },
      { type: 'ACTION', action: { type: 'click', target: { strategy: 'text', value: 'View Accounts' } } },
      { type: 'DONE', outputs: { savingsBalance: '$8,920.14' }, reason: 'Savings balance found' },
    ]);

    const input = buildModelInput({ goal, observation, stepIndex: 0, maxSteps: 10 });
    const decisions = [];
    for (let i = 0; i < 5; i++) {
      decisions.push(parseModelDecision(await model.decide(input)));
    }

    expect(decisions.map((decision) => decision.type)).toEqual(['ACTION', 'ACTION', 'ACTION', 'ACTION', 'DONE']);
    expect(model.calls).toBe(5);
  });

  it('should build provider-neutral model input from goal and observation', () => {
    const input = buildModelInput({
      goal,
      observation,
      stepIndex: 2,
      maxSteps: 10,
      previousDecisions: [
        { type: 'ACTION', action: { type: 'navigate', value: 'http://localhost:3100/' } },
      ],
    });

    const serialized = JSON.parse(JSON.stringify(input));
    expect(serialized.goal.id).toBe('goal-001');
    expect(serialized.observation.url).toBe('http://localhost:3100/');
    expect(serialized.observation.elements[0].attributes.name).toBe('id');
    expect(serialized.stepIndex).toBe(2);
    expect(serialized.stepsRemaining).toBe(8);
  });
});
