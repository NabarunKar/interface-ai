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
  ApprovalRecordSchema,
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

    it('should accept an attribute locator with separate name and value', () => {
      const result = TargetLocatorSchema.safeParse({
        strategy: 'attribute',
        attributeName: 'data-member-id',
        value: '10234',
      });
      expect(result.success).toBe(true);
    });

    it('should reject an attribute locator without attributeName', () => {
      const result = TargetLocatorSchema.safeParse({
        strategy: 'attribute',
        value: '10234',
      });
      expect(result.success).toBe(false);
    });

    it('should reject an attribute fallback without attributeName', () => {
      const result = TargetLocatorSchema.safeParse({
        strategy: 'label',
        value: 'Member ID',
        fallbacks: [
          { strategy: 'attribute', value: '10234' },
        ],
      });
      expect(result.success).toBe(false);
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

    it('should accept a human denial outcome result', () => {
      const result = ReplayResultSchema.safeParse({
        status: 'denied',
        category: 'HUMAN_DENIAL',
        message: 'Action denied by human operator',
        failedAtStep: 2,
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
      expectedBusinessOutcomes: [
        {
          code: 'MEMBER_NOT_FOUND',
          checkpoint: {
            description: 'Member not found message is displayed',
            condition: 'page_contains_text' as const,
            expectedValue: 'No member found',
          },
        },
      ],
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

    it('should reject duplicate input parameter names', () => {
      const result = CapabilityArtifactSchema.safeParse({
        ...validArtifact,
        inputs: [
          { name: 'memberId', type: 'string' },
          { name: 'memberId', type: 'string' },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('should reject duplicate step indices', () => {
      const result = CapabilityArtifactSchema.safeParse({
        ...validArtifact,
        steps: [
          { index: 0, action: { type: 'navigate', value: 'http://localhost:3100/' } },
          { index: 0, action: { type: 'click', target: { strategy: 'text', value: 'SEARCH' } } },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('should accept expected business outcomes with optional description', () => {
      const result = CapabilityArtifactSchema.safeParse({
        ...validArtifact,
        expectedBusinessOutcomes: [
          {
            code: 'MEMBER_NOT_FOUND',
            checkpoint: {
              description: 'Member not found message is displayed',
              condition: 'page_contains_text',
              expectedValue: 'No member found',
            },
          },
        ],
      });
      expect(result.success).toBe(true);
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

    it('should accept approval-related evidence events', () => {
      const base = {
        eventId: 10,
        timestamp: new Date().toISOString(),
        runId: 'run-001',
        controlMode: 'paused' as const,
        action: { type: 'type' as const, target: { strategy: 'label' as const, value: 'Member ID' }, value: '[REDACTED]' },
        approvalScope: {
          tenant: 'tenant-a',
          targetApp: 'bank-ops',
          capabilityId: 'lookup-member',
          actionType: 'type' as const,
          route: '/member',
        },
      };

      for (const event of [
        { ...base, type: 'approval_requested' as const },
        { ...base, type: 'approval_denied' as const, approvalDecision: 'deny' as const },
        { ...base, type: 'approval_granted' as const, approvalDecision: 'allow_once' as const },
        { ...base, type: 'approval_granted' as const, approvalDecision: 'allow_and_remember' as const, approvalId: 'apr-001' },
        { ...base, type: 'approval_remembered' as const, approvalDecision: 'allow_and_remember' as const, approvalId: 'apr-001' },
      ]) {
        expect(EvidenceEventSchema.safeParse(event).success).toBe(true);
      }
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

    it('should reject invalid allowed action strings', () => {
      const result = PolicyConfigSchema.safeParse({
        allowedDomains: ['localhost'],
        allowedActions: ['navigate', 'clikc'],
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid risky action strings', () => {
      const result = PolicyConfigSchema.safeParse({
        allowedDomains: ['localhost'],
        allowedActions: ['navigate', 'click'],
        riskyActions: ['click', 'wire_transfer'],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ApprovalRecord', () => {
    it('should accept a scoped durable remembered approval', () => {
      const result = ApprovalRecordSchema.safeParse({
        id: 'apr-001',
        scope: {
          tenant: 'tenant-a',
          targetApp: 'bank-ops',
          capabilityId: 'lookup-member',
          actionType: 'click',
          route: '/member',
        },
        decision: 'allow_and_remember',
        createdAt: new Date().toISOString(),
      });
      expect(result.success).toBe(true);
    });

    it('should reject non-remembered decisions in durable approval records', () => {
      const result = ApprovalRecordSchema.safeParse({
        id: 'apr-001',
        scope: { targetApp: 'bank-ops', actionType: 'click' },
        decision: 'allow_once',
        createdAt: new Date().toISOString(),
      });
      expect(result.success).toBe(false);
    });

    it('should reject actionType-only durable approval records', () => {
      const result = ApprovalRecordSchema.safeParse({
        id: 'apr-001',
        scope: { actionType: 'click' },
        decision: 'allow_and_remember',
        createdAt: new Date().toISOString(),
      });
      expect(result.success).toBe(false);
    });
  });
});
