import { describe, it, expect } from 'vitest';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import type { Action } from '../src/domain/action.js';
import type { PolicyConfig } from '../src/domain/policy.js';

const defaultConfig: PolicyConfig = {
  allowedDomains: ['localhost'],
  allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
  riskyActions: [],
  maxActionsPerRun: 100,
};

describe('LocalPolicyEngine', () => {
  it('should allow a basic click action', () => {
    const engine = new LocalPolicyEngine(defaultConfig);
    const action: Action = {
      type: 'click',
      target: { strategy: 'text', value: 'SEARCH' },
    };
    const result = engine.evaluate(action);
    expect(result.decision).toBe('allow');
    expect(result.riskLevel).toBe('safe');
  });

  it('should allow a navigate action to allowed domain', () => {
    const engine = new LocalPolicyEngine(defaultConfig);
    const action: Action = {
      type: 'navigate',
      value: 'http://localhost:3100/member?id=10234',
    };
    const result = engine.evaluate(action);
    expect(result.decision).toBe('allow');
  });

  it('should deny a navigate action to disallowed domain', () => {
    const engine = new LocalPolicyEngine(defaultConfig);
    const action: Action = {
      type: 'navigate',
      value: 'https://evil.com/steal-data',
    };
    const result = engine.evaluate(action);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('outside allowed domains');
  });

  it('should deny a disallowed action type', () => {
    const restrictedConfig: PolicyConfig = {
      allowedDomains: ['localhost'],
      allowedActions: ['read', 'wait', 'screenshot'],
    };
    const engine = new LocalPolicyEngine(restrictedConfig);
    const action: Action = {
      type: 'click',
      target: { strategy: 'text', value: 'Delete Account' },
    };
    const result = engine.evaluate(action);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('not in the allowed list');
  });

  it('should require confirmation for risky actions', () => {
    const configWithRisky: PolicyConfig = {
      allowedDomains: ['localhost'],
      allowedActions: ['navigate', 'click', 'type', 'read'],
      riskyActions: ['type'],
    };
    const engine = new LocalPolicyEngine(configWithRisky);
    const action: Action = {
      type: 'type',
      target: { strategy: 'css', value: 'input[name="amount"]' },
      value: '50000',
    };
    const result = engine.evaluate(action);
    expect(result.decision).toBe('require_confirmation');
    expect(result.riskLevel).toBe('risky');
  });

  it('should deny when action count exceeds limit', () => {
    const engine = new LocalPolicyEngine({ ...defaultConfig, maxActionsPerRun: 5 });
    const action: Action = {
      type: 'click',
      target: { strategy: 'text', value: 'Next' },
    };
    const result = engine.evaluate(action, { actionCount: 5 });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('limit reached');
  });

  it('should allow when action count is below limit', () => {
    const engine = new LocalPolicyEngine({ ...defaultConfig, maxActionsPerRun: 5 });
    const action: Action = {
      type: 'click',
      target: { strategy: 'text', value: 'Next' },
    };
    const result = engine.evaluate(action, { actionCount: 4 });
    expect(result.decision).toBe('allow');
  });

  it('should allow relative URL navigation', () => {
    const engine = new LocalPolicyEngine(defaultConfig);
    const action: Action = {
      type: 'navigate',
      value: '/member/10234/accounts',
    };
    const result = engine.evaluate(action);
    expect(result.decision).toBe('allow');
  });

  it('should deny when current URL is on disallowed domain', () => {
    const engine = new LocalPolicyEngine(defaultConfig);
    const action: Action = {
      type: 'click',
      target: { strategy: 'text', value: 'OK' },
    };
    const result = engine.evaluate(action, { currentUrl: 'https://malicious.site/page' });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('outside allowed domains');
  });

  it('should deny navigation with route restrictions', () => {
    const routeConfig: PolicyConfig = {
      allowedDomains: ['localhost'],
      allowedActions: ['navigate', 'click', 'read'],
      allowedRoutes: ['^/$', '^/member'],
    };
    const engine = new LocalPolicyEngine(routeConfig);
    const action: Action = {
      type: 'navigate',
      value: 'http://localhost:3100/admin/delete-all',
    };
    const result = engine.evaluate(action);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('does not match any allowed route');
  });

  it('should allow navigation matching route restrictions', () => {
    const routeConfig: PolicyConfig = {
      allowedDomains: ['localhost'],
      allowedActions: ['navigate', 'click', 'read'],
      allowedRoutes: ['^/$', '^/member'],
    };
    const engine = new LocalPolicyEngine(routeConfig);
    const action: Action = {
      type: 'navigate',
      value: 'http://localhost:3100/member?id=10234',
    };
    const result = engine.evaluate(action);
    expect(result.decision).toBe('allow');
  });
});
