import { describe, it, expect } from 'vitest';
import type { CapabilityArtifact } from '../src/domain/artifact.js';
import {
  extractPlaceholders,
  interpolateAction,
  interpolateString,
  validateArtifactInterpolation,
  validateInputs,
} from '../src/interpolation/index.js';

const inputs = [
  { name: 'memberId', type: 'string' as const, required: true },
  { name: 'accountType', type: 'string' as const, required: true },
  { name: 'page', type: 'number' as const, required: false },
];

describe('Interpolation', () => {
  it('should perform single substitution', () => {
    expect(interpolateString('Member {{memberId}}', inputs, { memberId: '10234', accountType: 'Savings' }))
      .toBe('Member 10234');
  });

  it('should perform multiple substitutions', () => {
    expect(interpolateString('{{accountType}} account for {{memberId}}', inputs, { memberId: '10234', accountType: 'Savings' }))
      .toBe('Savings account for 10234');
  });

  it('should reject missing required input', () => {
    expect(() => validateInputs(inputs, { memberId: '10234' })).toThrow('Missing required parameter');
  });

  it('should reject extra input', () => {
    expect(() => validateInputs(inputs, { memberId: '10234', accountType: 'Savings', unknown: true })).toThrow('Unknown parameter');
  });

  it('should reject undeclared placeholder', () => {
    expect(() => interpolateString('Member {{missing}}', inputs, { memberId: '10234', accountType: 'Savings' }))
      .toThrow('Undeclared placeholder');
  });

  it('should reject malformed placeholder', () => {
    expect(() => extractPlaceholders('Member {{member-id}}')).toThrow('Malformed placeholder');
  });

  it('should return unchanged strings without placeholders', () => {
    expect(interpolateString('Member ID', inputs, { memberId: '10234', accountType: 'Savings' })).toBe('Member ID');
  });

  it('should be deterministic across repeated interpolation', () => {
    const params = { memberId: '10234', accountType: 'Savings' };
    const first = interpolateString('/member/{{memberId}}/{{accountType}}', inputs, params);
    const second = interpolateString('/member/{{memberId}}/{{accountType}}', inputs, params);
    expect(first).toBe(second);
  });

  it('should interpolate action values and locator values', () => {
    const action = interpolateAction(
      {
        type: 'type',
        target: {
          strategy: 'css',
          value: 'input[name="{{accountType}}"]',
          attributeName: 'name',
          fallbacks: [{ strategy: 'text', value: '{{accountType}}' }],
        },
        value: '{{memberId}}',
      },
      inputs,
      { memberId: '10234', accountType: 'Savings' },
    );

    expect(action.value).toBe('10234');
    expect(action.target?.value).toBe('input[name="Savings"]');
    expect(action.target?.attributeName).toBe('name');
    expect(action.target?.fallbacks?.[0].value).toBe('Savings');
  });

  it('should validate supported artifact fields', () => {
    const artifact: CapabilityArtifact = {
      id: 'cap-001',
      name: 'Lookup Member Savings Balance',
      description: 'Search for a member by ID and retrieve a balance',
      version: '1.0.0',
      targetApp: 'bank-ops',
      surfaceType: 'web',
      entryPoint: 'http://localhost:3100/',
      inputs,
      steps: [
        {
          index: 0,
          action: { type: 'navigate', value: '/member?id={{memberId}}' },
          postcondition: {
            description: 'Member page loaded',
            condition: 'page_contains_text',
            expectedValue: '{{memberId}}',
          },
        },
        {
          index: 1,
          action: { type: 'read', target: { strategy: 'text', value: '{{accountType}}' } },
        },
      ],
      outputs: [
        {
          name: 'balance',
          source: { strategy: 'css', value: '[data-account="{{accountType}}"]' },
          type: 'string',
        },
      ],
      successCondition: {
        description: 'Account is shown',
        condition: 'page_contains_text',
        expectedValue: '{{accountType}}',
      },
      expectedBusinessOutcomes: [
        {
          code: 'MEMBER_NOT_FOUND',
          checkpoint: {
            description: 'Member not found message shown',
            condition: 'page_contains_text',
            expectedValue: 'No member found with ID: {{memberId}}',
          },
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(() => validateArtifactInterpolation(artifact, { memberId: '10234', accountType: 'Savings' })).not.toThrow();
  });

  it('should reject undeclared placeholders during artifact validation', () => {
    const artifact: CapabilityArtifact = {
      id: 'cap-001',
      name: 'Bad Artifact',
      description: 'Contains undeclared placeholder',
      version: '1.0.0',
      targetApp: 'bank-ops',
      surfaceType: 'web',
      entryPoint: 'http://localhost:3100/',
      inputs,
      steps: [
        { index: 0, action: { type: 'navigate', value: '/member?id={{unknown}}' } },
      ],
      outputs: [],
      successCondition: {
        description: 'Loaded',
        condition: 'page_contains_text',
        expectedValue: 'Loaded',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(() => validateArtifactInterpolation(artifact)).toThrow('Undeclared placeholder');
  });

  it('should reject optional but referenced placeholders when no value is provided before execution', () => {
    const artifact: CapabilityArtifact = {
      id: 'cap-001',
      name: 'Paged Lookup',
      description: 'Uses optional page parameter in a URL',
      version: '1.0.0',
      targetApp: 'bank-ops',
      surfaceType: 'web',
      entryPoint: 'http://localhost:3100/',
      inputs,
      steps: [
        { index: 0, action: { type: 'navigate', value: '/member?id={{memberId}}&page={{page}}' } },
      ],
      outputs: [],
      successCondition: {
        description: 'Loaded',
        condition: 'page_contains_text',
        expectedValue: 'Loaded',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(() => validateArtifactInterpolation(artifact, { memberId: '10234', accountType: 'Savings' }))
      .toThrow('No value provided');
  });
});
