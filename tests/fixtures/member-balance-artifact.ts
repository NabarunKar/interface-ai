import type { CapabilityArtifact } from '../../src/domain/artifact.js';

/**
 * Canonical capability artifact discovered for looking up a member's savings balance.
 *
 * Discovered against Bank Operations Console in Phase 1B:
 * 1. Navigate to entry point (search page)
 * 2. Type memberId into "Member ID:" input
 * 3. Click "SEARCH"
 * 4. Click "[ View Accounts ]"
 * 5. Verify accounts page and read savings balance
 */
export const memberSavingsBalanceArtifact: CapabilityArtifact = {
  id: 'lookup-member-savings-balance',
  name: 'Lookup Member Savings Balance',
  description: 'Search for a member by ID and retrieve their savings balance',
  version: '1.0.0',
  targetApp: 'bank-ops',
  surfaceType: 'web',
  entryPoint: 'http://localhost:3100/',
  inputs: [
    {
      name: 'memberId',
      description: 'The member ID to look up',
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
      rationale: 'Enter member ID into search input',
    },
    {
      index: 1,
      action: {
        type: 'click',
        target: { strategy: 'text', value: 'SEARCH' },
      },
      postcondition: {
        description: 'Navigated to member profile or error page',
        condition: 'url_matches',
        expectedValue: '/member',
      },
      rationale: 'Submit search form',
    },
    {
      index: 2,
      action: {
        type: 'click',
        target: { strategy: 'text', value: '[ View Accounts ]' },
      },
      postcondition: {
        description: 'Navigated to accounts page',
        condition: 'url_matches',
        expectedValue: '/accounts',
      },
      rationale: 'Open member accounts page',
    },
  ],
  outputs: [
    {
      name: 'savingsBalance',
      description: 'The current savings account balance',
      source: {
        strategy: 'css',
        value: 'tr:nth-child(3) td:nth-child(3)',
        fallbacks: [
          { strategy: 'text', value: '$8,920.14' },
        ],
      },
      type: 'string',
    },
  ],
  successCondition: {
    description: 'Accounts page is displayed with savings balance',
    condition: 'page_contains_text',
    expectedValue: 'Savings',
  },
  expectedBusinessOutcomes: [
    {
      code: 'MEMBER_NOT_FOUND',
      description: 'Member not found in database',
      checkpoint: {
        description: 'Page displays not found message',
        condition: 'page_contains_text',
        expectedValue: 'No member found',
      },
    },
  ],
  policyConstraints: {
    allowedDomains: ['localhost', '127.0.0.1'],
    readOnly: true,
    maxDurationMs: 30_000,
  },
  createdAt: '2026-09-18T19:00:00.000Z',
  updatedAt: '2026-09-18T19:00:00.000Z',
  sourceRunId: 'discovery-1789776108124',
};
