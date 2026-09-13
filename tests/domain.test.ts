import { describe, it, expect } from 'vitest';
import {
  ActionSchema,
  GoalSchema,
  ObservationSchema,
  ReplayResultSchema,
  CapabilityArtifactSchema,
  EvidenceEventSchema,
  PolicyConfigSchema,
  PolicyResultSchema,
  TargetLocatorSchema,
} from '../src/domain/index.js';

describe('Domain Schemas', () => {
  describe('TargetLocator', () => {
    it('should accept a valid locator', () => {
      const result = TargetLocatorSchema.safeParse({
        strategy: 'css',
        value: 'input[name="id"]',
        description: 'Member ID input field',
      });
      expect(result.success).toBe(true);
    });

    it('should accept a locator with fallbacks', () => {
      const result = TargetLocatorSchema.safeParse({
        strategy: 'label',
        value: 'Member ID',
        fallbacks: [
          { strategy: 'css', value: 'input[name="id"]' },
          { strategy: 'role', value: 'textbox' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('should reject an invalid strategy', () => {
      const result = TargetLocatorSchema.safeParse({
        strategy: 'invalid',
        value: 'something',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing value', () => {
      const result = TargetLocatorSchema.safeParse({
        strategy: 'css',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Action', () => {
    it('should accept a valid navigate action', () => {
      const result = ActionSchema.safeParse({
        type: 'navigate',
        value: 'http://localhost:3100/',
        description: 'Navigate to search page',
      });
      expect(result.success).toBe(true);
    });

    it('should accept a valid click action with target', () => {
      const result = ActionSchema.safeParse({
        type: 'click',
        target: { strategy: 'text', value: 'SEARCH' },
      });
      expect(result.success).toBe(true);
    });

    it('should accept a valid type action', () => {
      const result = ActionSchema.safeParse({
        type: 'type',
        target: { strategy: 'label', value: 'Member ID' },
        value: '10234',
      });
      expect(result.success).toBe(true);
    });

    it('should reject an unknown action type', () => {
      const result = ActionSchema.safeParse({
        type: 'delete',
        value: 'something',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Goal', () => {
    it('should accept a valid goal', () => {
      const result = GoalSchema.safeParse({
        id: 'goal-001',
        description: 'Find member 10234 and return their current savings balance',
        targetApp: 'bank-ops',
        entryPoint: 'http://localhost:3100/',
        parameters: { memberId: '10234' },
      });
      expect(result.success).toBe(true);
    });

    it('should reject a goal without description', () => {
      const result = GoalSchema.safeParse({
        id: 'goal-002',
        targetApp: 'bank-ops',
        entryPoint: 'http://localhost:3100/',
      });
      expect(result.success).toBe(false);
    });

    it('should reject a goal with invalid entry point URL', () => {
      const result = GoalSchema.safeParse({
        id: 'goal-003',
        description: 'Some goal',
        targetApp: 'bank-ops',
        entryPoint: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Observation', () => {
    it('should accept a valid observation', () => {
      const result = ObservationSchema.safeParse({
        url: 'http://localhost:3100/',
        title: 'Bank Operations Console',
        visibleText: 'BANK OPERATIONS CONSOLE\nMEMBER SEARCH',
        timestamp: new Date().toISOString(),
      });
      expect(result.success).toBe(true);
    });

    it('should accept an observation with elements', () => {
      const result = ObservationSchema.safeParse({
        url: 'http://localhost:3100/',
        timestamp: new Date().toISOString(),
        elements: [
          { tag: 'input', attributes: { name: 'id', type: 'text' }, visible: true, enabled: true },
          { tag: 'button', text: 'SEARCH', visible: true, enabled: true },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('ReplayResult', () => {
    it('should accept a successful result', () => {
      const result = ReplayResultSchema.safeParse({
        status: 'success',
        outputs: { savingsBalance: 8920.14 },
        message: 'Successfully retrieved savings balance',
        durationMs: 1500,
      });
      expect(result.success).toBe(true);
    });

    it('should accept a business outcome result', () => {
      const result = ReplayResultSchema.safeParse({
        status: 'business_outcome',
        category: 'BUSINESS_OUTCOME',
        message: 'Member not found',
        failedAtStep: 1,
      });
      expect(result.success).toBe(true);
    });

    it('should accept a failure result', () => {
      const result = ReplayResultSchema.safeParse({
        status: 'failure',
        category: 'HARD_FAILURE',
        message: 'Element not found on page',
        failedAtStep: 2,
        expected: 'Accounts table visible',
        observed: 'Page showed error message',
      });
      expect(result.success).toBe(true);
    });

    it('should reject an invalid status', () => {
      const result = ReplayResultSchema.safeParse({
        status: 'unknown',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('CapabilityArtifact', () => {
    const validArtifact = {
      id: 'cap-001',
      name: 'Lookup Member Savings Balance',
      description: 'Search for a member by ID and retrieve their savings balance',
      version: '1.0.0',
      targetApp: 'bank-ops',
      surfaceType: 'web',
      entryPoint: 'http://localhost:3100/',
      inputs: [
        { name: 'memberId', description: 'The member ID to look up', type: 'string', required: true, example: '10234' },
      ],
      steps: [
        {
          index: 0,
          action: { type: 'navigate', value: 'http://localhost:3100/' },
        },
        {
          index: 1,
          action: { type: 'type', target: { strategy: 'label', value: 'Member ID' }, value: '{{memberId}}' },
        },
        {
          index: 2,
          action: { type: 'click', target: { strategy: 'text', value: 'SEARCH' } },
        },
        {
          index: 3,
          action: { type: 'click', target: { strategy: 'text', value: 'View Accounts' } },
        },
        {
          index: 4,
          action: { type: 'read', target: { strategy: 'css', value: 'td' }, description: 'Read savings balance' },
        },
      ],
      outputs: [
        {
          name: 'savingsBalance',
          description: 'The current savings account balance',
          source: { strategy: 'css' as const, value: 'tr:nth-child(3) td:nth-child(3)' },
          type: 'string' as const,
        },
      ],
      successCondition: {
        description: 'Accounts page is displayed with balance data',
        condition: 'page_contains_text' as const,
        expectedValue: 'ACCOUNTS',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it('should accept a valid capability artifact', () => {
      const result = CapabilityArtifactSchema.safeParse(validArtifact);
      expect(result.success).toBe(true);
    });

    it('should reject an artifact without steps', () => {
      const result = CapabilityArtifactSchema.safeParse({
        ...validArtifact,
        steps: [],
      });
      expect(result.success).toBe(false);
    });

    it('should reject an artifact with invalid version format', () => {
      const result = CapabilityArtifactSchema.safeParse({
        ...validArtifact,
        version: 'v1',
      });
      expect(result.success).toBe(false);
    });

    it('should reject an artifact without required fields', () => {
      const result = CapabilityArtifactSchema.safeParse({
        id: 'cap-002',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('EvidenceEvent', () => {
    it('should accept a valid run_started event', () => {
      const result = EvidenceEventSchema.safeParse({
        eventId: 0,
        timestamp: new Date().toISOString(),
        runId: 'run-001',
        type: 'run_started',
        controlMode: 'automation',
        message: 'Starting member lookup',
      });
      expect(result.success).toBe(true);
    });

    it('should accept a valid action_executed event', () => {
      const result = EvidenceEventSchema.safeParse({
        eventId: 1,
        timestamp: new Date().toISOString(),
        runId: 'run-001',
        type: 'action_executed',
        stepIndex: 0,
        action: { type: 'navigate', value: 'http://localhost:3100/' },
        controlMode: 'automation',
      });
      expect(result.success).toBe(true);
    });

    it('should accept a human_takeover event', () => {
      const result = EvidenceEventSchema.safeParse({
        eventId: 5,
        timestamp: new Date().toISOString(),
        runId: 'run-001',
        type: 'human_takeover',
        controlMode: 'human',
        reasoning: 'Agent was stuck on unexpected dialog',
      });
      expect(result.success).toBe(true);
    });

    it('should reject an event with invalid type', () => {
      const result = EvidenceEventSchema.safeParse({
        eventId: 0,
        timestamp: new Date().toISOString(),
        runId: 'run-001',
        type: 'invalid_type',
        controlMode: 'automation',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('PolicyConfig', () => {
    it('should accept a valid policy config', () => {
      const result = PolicyConfigSchema.safeParse({
        allowedDomains: ['localhost'],
        allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
        riskyActions: [],
        maxActionsPerRun: 50,
      });
      expect(result.success).toBe(true);
    });

    it('should reject a config without allowed domains', () => {
      const result = PolicyConfigSchema.safeParse({
        allowedDomains: [],
        allowedActions: ['click'],
      });
      expect(result.success).toBe(false);
    });
  });
});
