import { describe, it, expect, beforeEach } from 'vitest';
import type { Surface, WaitOptions } from '../src/surface/types.js';
import type { TargetLocator } from '../src/domain/action.js';
import type { Observation } from '../src/domain/observation.js';
import type { PolicyConfig } from '../src/domain/policy.js';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import { PolicyEnforcedSurface, PolicyDeniedError, ConfirmationRequiredError } from '../src/policy/enforced-surface.js';
import { InMemoryApprovalStore } from '../src/policy/approval-store.js';
import type { ApprovalRecord } from '../src/domain/approval.js';

// --- Mock Surface ---

class MockSurface implements Surface {
  readonly sessionId = 'mock-enforcement-session';
  calls: Array<{ method: string; args: unknown[] }> = [];

  async observe(): Promise<Observation> {
    this.calls.push({ method: 'observe', args: [] });
    return { url: 'http://localhost:3100/', timestamp: new Date().toISOString() };
  }
  async click(target: TargetLocator): Promise<void> {
    this.calls.push({ method: 'click', args: [target] });
  }
  async type(target: TargetLocator, value: string): Promise<void> {
    this.calls.push({ method: 'type', args: [target, value] });
  }
  async read(target: TargetLocator): Promise<string> {
    this.calls.push({ method: 'read', args: [target] });
    return 'mock text';
  }
  async navigate(url: string): Promise<void> {
    this.calls.push({ method: 'navigate', args: [url] });
  }
  async wait(options: WaitOptions): Promise<void> {
    this.calls.push({ method: 'wait', args: [options] });
  }
  async screenshot(path?: string): Promise<string> {
    this.calls.push({ method: 'screenshot', args: [path] });
    return 'screenshot.png';
  }
  async currentUrl(): Promise<string> {
    this.calls.push({ method: 'currentUrl', args: [] });
    return 'http://localhost:3100/';
  }
  async isVisible(target: TargetLocator): Promise<boolean> {
    this.calls.push({ method: 'isVisible', args: [target] });
    return true;
  }
  async pageText(): Promise<string> {
    this.calls.push({ method: 'pageText', args: [] });
    return 'page text';
  }
  async close(): Promise<void> {
    this.calls.push({ method: 'close', args: [] });
  }
}

// --- Test fixtures ---

const TARGET: TargetLocator = { strategy: 'text', value: 'SEARCH' };

const ALLOW_ALL_CONFIG: PolicyConfig = {
  allowedDomains: ['localhost'],
  allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
  riskyActions: [],
  maxActionsPerRun: 100,
};

const DENY_CLICK_CONFIG: PolicyConfig = {
  allowedDomains: ['localhost'],
  allowedActions: ['navigate', 'read', 'wait', 'screenshot'],
  riskyActions: [],
};

const RISKY_TYPE_CONFIG: PolicyConfig = {
  allowedDomains: ['localhost'],
  allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
  riskyActions: ['type'],
};

describe('PolicyEnforcedSurface', () => {
  let mock: MockSurface;

  beforeEach(() => {
    mock = new MockSurface();
  });

  // --- Allowed actions reach the underlying surface ---

  it('should pass allowed click through to underlying surface', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(ALLOW_ALL_CONFIG));
    await enforced.click(TARGET);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('click');
  });

  it('should pass allowed navigate through to underlying surface', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(ALLOW_ALL_CONFIG));
    await enforced.navigate('http://localhost:3100/member?id=10234');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('navigate');
    expect(mock.calls[0].args[0]).toBe('http://localhost:3100/member?id=10234');
  });

  it('should pass allowed type through to underlying surface', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(ALLOW_ALL_CONFIG));
    await enforced.type(TARGET, '10234');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('type');
  });

  // --- Denied actions NEVER reach the underlying surface ---

  it('should deny click and NOT reach underlying surface', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(DENY_CLICK_CONFIG));
    await expect(enforced.click(TARGET)).rejects.toThrow(PolicyDeniedError);
    expect(mock.calls).toHaveLength(0); // click never reached the mock
  });

  it('should deny navigate to disallowed domain and NOT reach underlying surface', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(ALLOW_ALL_CONFIG));
    await expect(enforced.navigate('https://evil.com/steal')).rejects.toThrow(PolicyDeniedError);
    expect(mock.calls).toHaveLength(0);
  });

  // --- require_confirmation blocks without approval ---

  it('should throw ConfirmationRequiredError for risky action without approval', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(RISKY_TYPE_CONFIG));
    await expect(enforced.type(TARGET, '10234')).rejects.toThrow(ConfirmationRequiredError);
    expect(mock.calls).toHaveLength(0);
  });

  // --- require_confirmation with remembered approval proceeds ---

  it('should allow risky action when matching remembered approval exists', async () => {
    const store = new InMemoryApprovalStore();
    const approval: ApprovalRecord = {
      id: 'apr-001',
      scope: {
        tenant: 'tenant-a',
        targetApp: 'bank-ops',
        capabilityId: 'lookup-member',
        actionType: 'type',
        route: '/member',
      },
      decision: 'allow_and_remember',
      createdAt: new Date().toISOString(),
    };
    await store.saveRemembered(approval);

    const enforced = new PolicyEnforcedSurface(
      mock,
      new LocalPolicyEngine(RISKY_TYPE_CONFIG),
      store,
      () => ({
        tenant: 'tenant-a',
        targetApp: 'bank-ops',
        capabilityId: 'lookup-member',
        route: '/member',
      }),
    );
    await enforced.type(TARGET, '10234');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('type');
  });

  it('should not treat actionType-only approval as remembered authorization', async () => {
    const store = new InMemoryApprovalStore();
    const broadApproval = {
      id: 'apr-broad',
      scope: { actionType: 'type' },
      decision: 'allow_and_remember',
      createdAt: new Date().toISOString(),
    };

    await expect(store.saveRemembered(broadApproval as ApprovalRecord)).rejects.toThrow();
  });

  // --- Non-mutating operations pass through without policy checks ---

  it('should pass observe through without policy check', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(DENY_CLICK_CONFIG));
    const obs = await enforced.observe();
    expect(obs.url).toBe('http://localhost:3100/');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('observe');
  });

  it('should pass read through without policy check', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(DENY_CLICK_CONFIG));
    const text = await enforced.read(TARGET);
    expect(text).toBe('mock text');
    expect(mock.calls).toHaveLength(1);
  });

  it('should pass screenshot through without policy check', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(DENY_CLICK_CONFIG));
    await enforced.screenshot();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('screenshot');
  });

  it('should pass pageText through without policy check', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(DENY_CLICK_CONFIG));
    await enforced.pageText();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('pageText');
  });

  it('should pass currentUrl through without policy check', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(DENY_CLICK_CONFIG));
    await enforced.currentUrl();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('currentUrl');
  });

  it('should pass isVisible through without policy check', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(DENY_CLICK_CONFIG));
    await enforced.isVisible(TARGET);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('isVisible');
  });

  it('should pass wait through without policy check', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(DENY_CLICK_CONFIG));
    await enforced.wait({ durationMs: 100 });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('wait');
  });

  it('should pass close through without policy check', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(DENY_CLICK_CONFIG));
    await enforced.close();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('close');
  });

  // --- Context is passed into policy evaluation ---

  it('should pass context into policy evaluation (current URL check)', async () => {
    const enforced = new PolicyEnforcedSurface(
      mock,
      new LocalPolicyEngine(ALLOW_ALL_CONFIG),
      undefined,
      () => ({ currentUrl: 'https://malicious.site/page' }),
    );
    // Click itself is allowed, but context URL is on disallowed domain
    await expect(enforced.click(TARGET)).rejects.toThrow(PolicyDeniedError);
    expect(mock.calls).toHaveLength(0);
  });

  it('should pass isReplay context into policy evaluation', async () => {
    const policy = {
      evaluate: (_action: unknown, context?: { isReplay?: boolean }) => {
        expect(context?.isReplay).toBe(true);
        return { decision: 'allow' as const, riskLevel: 'safe' as const, reason: 'ok' };
      },
    };
    const enforced = new PolicyEnforcedSurface(
      mock,
      policy,
      undefined,
      () => ({ isReplay: true }),
    );
    await enforced.click(TARGET);
    expect(mock.calls).toHaveLength(1);
  });

  // --- Action count tracking ---

  it('should track action count across multiple actions', async () => {
    const config: PolicyConfig = {
      allowedDomains: ['localhost'],
      allowedActions: ['click', 'type', 'navigate'],
      maxActionsPerRun: 2,
    };
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(config));

    await enforced.click(TARGET);
    await enforced.click(TARGET);
    // Third action should be denied (limit = 2)
    await expect(enforced.click(TARGET)).rejects.toThrow(PolicyDeniedError);
    expect(mock.calls).toHaveLength(2); // only 2 clicks reached surface
  });

  // --- Error properties ---

  it('should include action and policy result in PolicyDeniedError', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(DENY_CLICK_CONFIG));
    try {
      await enforced.click(TARGET);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyDeniedError);
      const err = e as PolicyDeniedError;
      expect(err.action.type).toBe('click');
      expect(err.policyResult.decision).toBe('deny');
    }
  });

  it('should include action and policy result in ConfirmationRequiredError', async () => {
    const enforced = new PolicyEnforcedSurface(mock, new LocalPolicyEngine(RISKY_TYPE_CONFIG));
    try {
      await enforced.type(TARGET, 'test');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfirmationRequiredError);
      const err = e as ConfirmationRequiredError;
      expect(err.action.type).toBe('type');
      expect(err.policyResult.decision).toBe('require_confirmation');
    }
  });
});

describe('InMemoryApprovalStore', () => {
  const baseApproval = (): ApprovalRecord => ({
    id: 'apr-001',
    scope: {
      tenant: 'tenant-a',
      targetApp: 'bank-ops',
      capabilityId: 'open_savings_account',
      actionType: 'click',
      route: '/member/10234/accounts',
    },
    decision: 'allow_and_remember',
    createdAt: new Date().toISOString(),
  });

  it('should match exact remembered approval scope', async () => {
    const store = new InMemoryApprovalStore();
    const approval = baseApproval();
    await store.saveRemembered(approval);
    await expect(store.findMatching({ ...approval.scope })).resolves.toEqual(approval);
  });

  it('should reject tenant mismatch', async () => {
    const store = new InMemoryApprovalStore();
    const approval = baseApproval();
    await store.saveRemembered(approval);
    await expect(store.findMatching({ ...approval.scope, tenant: 'tenant-b' })).resolves.toBeUndefined();
  });

  it('should reject app mismatch', async () => {
    const store = new InMemoryApprovalStore();
    const approval = baseApproval();
    await store.saveRemembered(approval);
    await expect(store.findMatching({ ...approval.scope, targetApp: 'other-app' })).resolves.toBeUndefined();
  });

  it('should reject capability mismatch', async () => {
    const store = new InMemoryApprovalStore();
    const approval = baseApproval();
    await store.saveRemembered(approval);
    await expect(store.findMatching({ ...approval.scope, capabilityId: 'close_account' })).resolves.toBeUndefined();
  });

  it('should reject action mismatch', async () => {
    const store = new InMemoryApprovalStore();
    const approval = baseApproval();
    await store.saveRemembered(approval);
    await expect(store.findMatching({ ...approval.scope, actionType: 'type' })).resolves.toBeUndefined();
  });

  it('should reject route mismatch', async () => {
    const store = new InMemoryApprovalStore();
    const approval = baseApproval();
    await store.saveRemembered(approval);
    await expect(store.findMatching({ ...approval.scope, route: '/admin' })).resolves.toBeUndefined();
  });

  it('should reject expired approval', async () => {
    const store = new InMemoryApprovalStore();
    const approval: ApprovalRecord = {
      ...baseApproval(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await store.saveRemembered(approval);
    await expect(store.findMatching({ ...approval.scope })).resolves.toBeUndefined();
  });

  it('should match unexpired approval', async () => {
    const store = new InMemoryApprovalStore();
    const approval: ApprovalRecord = {
      ...baseApproval(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await store.saveRemembered(approval);
    await expect(store.findMatching({ ...approval.scope })).resolves.toEqual(approval);
  });
});
