import type { Action } from '../domain/action.js';
import type { PolicyConfig, PolicyResult } from '../domain/policy.js';

/**
 * Policy engine interface.
 *
 * Sits between action proposals and execution.
 * Every action MUST pass through the policy engine before
 * the surface adapter executes it.
 *
 * LLM / Replay
 *       ↓
 * Policy Engine
 *       ↓
 * Surface Adapter
 */
export interface PolicyEngine {
  evaluate(action: Action, context?: PolicyContext): PolicyResult;
}

/**
 * Contextual information for policy evaluation.
 */
export interface PolicyContext {
  /** Current page URL */
  currentUrl?: string;
  /** Number of actions already taken in this run */
  actionCount?: number;
  /** Whether this is a replay (vs. discovery) */
  isReplay?: boolean;
}

/**
 * A configurable local policy engine.
 *
 * Evaluates proposed actions against a static configuration
 * of allowed domains, allowed action types, and risky actions.
 *
 * This is intentionally simple — the key design point is that
 * the enforcement seam exists and is enforceable rather than advisory.
 */
export class LocalPolicyEngine implements PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  evaluate(action: Action, context?: PolicyContext): PolicyResult {
    // Check action count limit
    if (
      this.config.maxActionsPerRun &&
      context?.actionCount !== undefined &&
      context.actionCount >= this.config.maxActionsPerRun
    ) {
      return {
        decision: 'deny',
        riskLevel: 'risky',
        reason: `Action count limit reached (${this.config.maxActionsPerRun})`,
      };
    }

    // Check if action type is allowed
    if (!this.config.allowedActions.includes(action.type)) {
      return {
        decision: 'deny',
        riskLevel: 'risky',
        reason: `Action type '${action.type}' is not in the allowed list`,
      };
    }

    // For navigate actions, check domain allowlist
    if (action.type === 'navigate' && action.value) {
      const domainAllowed = this.isDomainAllowed(action.value);
      if (!domainAllowed) {
        return {
          decision: 'deny',
          riskLevel: 'risky',
          reason: `Navigation to '${action.value}' is outside allowed domains`,
        };
      }

      // Check route patterns if configured
      if (this.config.allowedRoutes && this.config.allowedRoutes.length > 0) {
        const routeAllowed = this.isRouteAllowed(action.value);
        if (!routeAllowed) {
          return {
            decision: 'deny',
            riskLevel: 'moderate',
            reason: `Route '${action.value}' does not match any allowed route pattern`,
          };
        }
      }
    }

    // For context-aware domain check on current URL
    if (context?.currentUrl) {
      const currentDomainAllowed = this.isDomainAllowed(context.currentUrl);
      if (!currentDomainAllowed) {
        return {
          decision: 'deny',
          riskLevel: 'risky',
          reason: `Current page '${context.currentUrl}' is outside allowed domains`,
        };
      }
    }

    // Check if action type is risky
    if (this.config.riskyActions?.includes(action.type)) {
      return {
        decision: 'require_confirmation',
        riskLevel: 'risky',
        reason: `Action type '${action.type}' is classified as risky`,
      };
    }

    return {
      decision: 'allow',
      riskLevel: 'safe',
      reason: 'Action passes all policy checks',
    };
  }

  private isDomainAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      return this.config.allowedDomains.some(
        (domain) =>
          parsed.hostname === domain ||
          parsed.hostname.endsWith('.' + domain)
      );
    } catch {
      // If it's a relative URL or path, allow it
      // (it's on the current domain)
      if (url.startsWith('/')) {
        return true;
      }
      return false;
    }
  }

  private isRouteAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      return (this.config.allowedRoutes ?? []).some((pattern) => {
        const regex = new RegExp(pattern);
        return regex.test(path);
      });
    } catch {
      // For relative paths
      return (this.config.allowedRoutes ?? []).some((pattern) => {
        const regex = new RegExp(pattern);
        return regex.test(url);
      });
    }
  }
}
