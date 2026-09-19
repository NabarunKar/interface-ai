import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Surface } from '../src/surface/types.js';
import type { CapabilityArtifact } from '../src/domain/artifact.js';
import { ReplayEngine } from '../src/replay/index.js';
import { InMemoryEvidenceLogger } from '../src/evidence/logger.js';
import { memberSavingsBalanceArtifact } from './fixtures/member-balance-artifact.js';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import { PolicyEnforcedSurface } from '../src/policy/enforced-surface.js';

describe('ReplayEngine (Deterministic Replay Unit Tests)', () => {
  let mockSurface: Surface;
  let evidence: InMemoryEvidenceLogger;

  beforeEach(() => {
    evidence = new InMemoryEvidenceLogger();
    mockSurface = {
      observe: vi.fn().mockResolvedValue({
        url: 'http://localhost:3100/',
        title: 'Bank Operations Console',
        visibleText: 'MEMBER SEARCH\nMember ID:\nSEARCH',
        timestamp: new Date().toISOString(),
      }),
      navigate: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue('$8,920.14'),
      wait: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue('screenshot.png'),
      currentUrl: vi.fn().mockResolvedValue('http://localhost:3100/member/10234/accounts'),
      isVisible: vi.fn().mockResolvedValue(true),
      pageText: vi.fn().mockResolvedValue('ACCOUNTS — MEMBER 10234\nSavings ****5678 $8,920.14'),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('should successfully replay artifact and extract outputs without calling any LLM', async () => {
    const engine = new ReplayEngine(mockSurface, { evidence });
    const result = await engine.replay(memberSavingsBalanceArtifact, { memberId: '10234' });

    expect(result.status).toBe('success');
    expect(result.outputs).toEqual({ savingsBalance: '$8,920.14' });
    expect(result.message).toBe('Replay completed successfully');

    // Verify step order
    expect(mockSurface.navigate).toHaveBeenCalledWith('http://localhost:3100/');
    expect(mockSurface.type).toHaveBeenCalledWith(
      { strategy: 'label', value: 'Member ID:' },
      '10234',
    );
    expect(mockSurface.click).toHaveBeenNthCalledWith(1, { strategy: 'text', value: 'SEARCH' });
    expect(mockSurface.click).toHaveBeenNthCalledWith(2, { strategy: 'text', value: '[ View Accounts ]' });
    expect(mockSurface.read).toHaveBeenCalledWith(
      memberSavingsBalanceArtifact.outputs[0].source,
    );

    // Verify structured evidence logged
    const events = evidence.getAllEvents();
    expect(events.length).toBeGreaterThan(5);
    expect(events[0].type).toBe('run_started');
    expect(events.some((e) => e.type === 'action_executed')).toBe(true);
    expect(events[events.length - 1].type).toBe('run_completed');
  });

  it('should support runtime entry point override without mutating artifact', async () => {
    const ephemeralUrl = 'http://127.0.0.1:54321/';
    const engine = new ReplayEngine(mockSurface, { evidence });

    const result = await engine.replay(
      memberSavingsBalanceArtifact,
      { memberId: '10234' },
      { entryPoint: ephemeralUrl },
    );

    expect(result.status).toBe('success');
    expect(mockSurface.navigate).toHaveBeenCalledWith(ephemeralUrl);
    // Provenance in artifact remains unchanged
    expect(memberSavingsBalanceArtifact.entryPoint).toBe('http://localhost:3100/');
  });

  it('should reject missing required input before executing any surface actions', async () => {
    const engine = new ReplayEngine(mockSurface, { evidence });
    const result = await engine.replay(memberSavingsBalanceArtifact, {}); // Missing memberId

    expect(result.status).toBe('invalid_input');
    expect(result.category).toBe('INVALID_INPUT');
    expect(result.message).toContain("Missing required parameter: 'memberId'");

    // Crucial: NO surface action occurred!
    expect(mockSurface.navigate).not.toHaveBeenCalled();
    expect(mockSurface.type).not.toHaveBeenCalled();
    expect(mockSurface.click).not.toHaveBeenCalled();
  });

  it('should reject unknown extra parameters before executing any surface actions', async () => {
    const engine = new ReplayEngine(mockSurface, { evidence });
    const result = await engine.replay(memberSavingsBalanceArtifact, {
      memberId: '10234',
      maliciousParam: 'drop tables',
    });

    expect(result.status).toBe('invalid_input');
    expect(result.category).toBe('INVALID_INPUT');
    expect(result.message).toContain("Unknown parameter: 'maliciousParam'");

    expect(mockSurface.navigate).not.toHaveBeenCalled();
    expect(mockSurface.type).not.toHaveBeenCalled();
  });

  it('should reject invalid artifact schema before executing any surface actions', async () => {
    const engine = new ReplayEngine(mockSurface, { evidence });
    const invalidArtifact = {
      ...memberSavingsBalanceArtifact,
      version: 'invalid-version', // Not a semver
    };

    const result = await engine.replay(invalidArtifact as unknown as CapabilityArtifact, {
      memberId: '10234',
    });

    expect(result.status).toBe('invalid_artifact');
    expect(result.category).toBe('INVALID_ARTIFACT');
    expect(result.message).toContain('Invalid capability artifact');

    expect(mockSurface.navigate).not.toHaveBeenCalled();
  });

  it('should fail when step precondition fails', async () => {
    const artifactWithPrecondition: CapabilityArtifact = {
      ...memberSavingsBalanceArtifact,
      steps: [
        {
          index: 0,
          action: { type: 'click', target: { strategy: 'text', value: 'SEARCH' } },
          precondition: {
            description: 'Require search button visible',
            condition: 'element_visible',
            target: { strategy: 'text', value: 'SEARCH' },
          },
        },
      ],
    };

    vi.mocked(mockSurface.isVisible).mockResolvedValue(false);

    const engine = new ReplayEngine(mockSurface, { evidence });
    const result = await engine.replay(artifactWithPrecondition, { memberId: '10234' });

    expect(result.status).toBe('hard_failure');
    expect(result.category).toBe('HARD_FAILURE');
    expect(result.failedAtStep).toBe(0);
    expect(result.message).toContain('Precondition failed at step 0');
    expect(mockSurface.click).not.toHaveBeenCalled();
  });

  it('should fail when step postcondition fails', async () => {
    vi.mocked(mockSurface.currentUrl).mockResolvedValue('http://localhost:3100/unrelated-page');

    const engine = new ReplayEngine(mockSurface, { evidence });
    const result = await engine.replay(memberSavingsBalanceArtifact, { memberId: '10234' });

    expect(result.status).toBe('hard_failure');
    expect(result.category).toBe('HARD_FAILURE');
    expect(result.failedAtStep).toBe(1); // Step 1 postcondition is url_matches /member
    expect(result.message).toContain('Postcondition failed at step 1');
  });

  it('should detect and return expected business outcome (e.g. MEMBER_NOT_FOUND)', async () => {
    // Initial page before search, then member not found page after step 1 SEARCH click
    vi.mocked(mockSurface.currentUrl).mockResolvedValue('http://localhost:3100/member?id=99999');
    vi.mocked(mockSurface.pageText)
      .mockResolvedValueOnce('MEMBER SEARCH\nMember ID:\nSEARCH')
      .mockResolvedValue('MEMBER SEARCH\nNo member found with ID: 99999');

    const engine = new ReplayEngine(mockSurface, { evidence });
    const result = await engine.replay(memberSavingsBalanceArtifact, { memberId: '99999' });

    expect(result.status).toBe('business_outcome');
    expect(result.category).toBe('BUSINESS_OUTCOME');
    expect(result.outputs).toEqual({ code: 'MEMBER_NOT_FOUND' });
    expect(result.message).toBe('Member not found in database');

    // Step 2 ([ View Accounts ]) was not executed because business outcome concluded execution
    expect(mockSurface.click).toHaveBeenCalledTimes(1); // Only step 1 SEARCH was clicked
  });

  it('should fail when success condition is not met', async () => {
    vi.mocked(mockSurface.pageText).mockResolvedValue('Page without required content');

    const engine = new ReplayEngine(mockSurface, { evidence });
    const result = await engine.replay(memberSavingsBalanceArtifact, { memberId: '10234' });

    expect(result.status).toBe('hard_failure');
    expect(result.category).toBe('HARD_FAILURE');
    expect(result.message).toContain('Success condition failed');
  });

  it('should respect policy enforcement and fail on policy denial', async () => {
    // Policy engine that allows only 'read' and 'wait', but denies 'type'
    const policy = new LocalPolicyEngine({
      allowedActions: ['read', 'wait', 'navigate'],
      allowedDomains: ['localhost', '127.0.0.1'],
    });

    const enforcedSurface = new PolicyEnforcedSurface(mockSurface, policy);
    const engine = new ReplayEngine(enforcedSurface, { evidence });

    const result = await engine.replay(memberSavingsBalanceArtifact, { memberId: '10234' });

    expect(result.status).toBe('hard_failure');
    expect(result.category).toBe('HARD_FAILURE');
    expect(result.failedAtStep).toBe(0);
    expect(result.message).toContain("Policy denied action at step 0: Policy denied action 'type'");

    const rejectedEvents = evidence.getAllEvents().filter((e) => e.type === 'action_rejected');
    expect(rejectedEvents.length).toBe(1);
    expect(rejectedEvents[0].action?.type).toBe('type');
  });

  it('should classify timeout during action as recoverable_failure', async () => {
    vi.mocked(mockSurface.click).mockRejectedValue(new Error('Timeout 5000ms exceeded while waiting for element'));

    const engine = new ReplayEngine(mockSurface, { evidence });
    const result = await engine.replay(memberSavingsBalanceArtifact, { memberId: '10234' });

    expect(result.status).toBe('recoverable_failure');
    expect(result.category).toBe('RECOVERABLE');
    expect(result.failedAtStep).toBe(1);
  });
});
