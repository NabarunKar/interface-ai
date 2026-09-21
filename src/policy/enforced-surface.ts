import type { Surface, WaitOptions } from '../surface/types.js';
import type { TargetLocator, Action } from '../domain/action.js';
import type { Observation } from '../domain/observation.js';
import type { PolicyResult } from '../domain/policy.js';
import type { ApprovalScope } from '../domain/approval.js';
import type { PolicyEngine, PolicyContext } from './engine.js';
import type { ApprovalStore } from './approval-store.js';

/**
 * Thrown when a policy evaluation denies an action.
 */
export class PolicyDeniedError extends Error {
  public readonly action: Action;
  public readonly policyResult: PolicyResult;

  constructor(action: Action, result: PolicyResult) {
    super(`Policy denied action '${action.type}': ${result.reason}`);
    this.name = 'PolicyDeniedError';
    this.action = action;
    this.policyResult = result;
  }
}

/**
 * Thrown when an action requires human confirmation and no
 * matching remembered approval is available.
 */
export class ConfirmationRequiredError extends Error {
  public readonly action: Action;
  public readonly policyResult: PolicyResult;

  constructor(action: Action, result: PolicyResult) {
    super(`Confirmation required for action '${action.type}': ${result.reason}`);
    this.name = 'ConfirmationRequiredError';
    this.action = action;
    this.policyResult = result;
  }
}

/**
 * Contextual information the caller supplies for enforcement.
 * Separate from PolicyContext — the enforcement layer translates
 * this into what the PolicyEngine needs.
 */
export interface EnforcementContext {
  currentUrl?: string;
  isReplay?: boolean;
  capabilityId?: string;
  targetApp?: string;
  tenant?: string;
  route?: string;
}

/**
 * A Surface wrapper that enforces policy on all mutating actions.
 *
 * This is the structural enforcement boundary:
 * NO UI-CHANGING AUTOMATION ACTION MAY REACH THE UNDERLYING SURFACE
 * WITHOUT POLICY EVALUATION.
 *
 * Non-mutating/passive operations (observe, read, screenshot, pageText,
 * currentUrl, isVisible, wait, close) pass through without policy checks.
 *
 * Policy-gated operations at this layer are the UI-changing Surface methods:
 * click, type, and navigate. They are evaluated by the
 * PolicyEngine before execution:
 * - 'allow': action proceeds
 * - 'deny': throws PolicyDeniedError, action does NOT execute
 * - 'require_confirmation': checks ApprovalStore for matching
 *   remembered approval; if found and valid, proceeds;
 *   otherwise throws ConfirmationRequiredError
 */
export class PolicyEnforcedSurface implements Surface {
  private actionCount = 0;
  private readonly ephemeralApprovals: ApprovalScope[] = [];

  constructor(
    private readonly underlying: Surface,
    private readonly policy: PolicyEngine,
    private readonly approvalStore?: ApprovalStore,
    private readonly contextProvider?: () => EnforcementContext,
  ) {}

  /** Forward technology-neutral session identity of the underlying surface */
  get sessionId(): string {
    return this.underlying.sessionId;
  }

  /** Direct reference to underlying Surface for same-session handoff interaction */
  getUnderlying(): Surface {
    return this.underlying;
  }

  /** Optional reference to the configured approval store */
  getApprovalStore(): ApprovalStore | undefined {
    return this.approvalStore;
  }

  /**
   * Stage an ephemeral (one-time) approval for a specific scope.
   * This does NOT bypass PolicyEngine evaluation: the action is still evaluated
   * by PolicyEngine and, if 'require_confirmation' is returned, this staged approval
   * is consumed strictly once.
   */
  stageEphemeralApproval(scope: ApprovalScope): void {
    this.ephemeralApprovals.push(scope);
  }

  /** Clear any pending ephemeral approvals */
  clearEphemeralApprovals(): void {
    this.ephemeralApprovals.length = 0;
  }

  // --- Pass-through (non-mutating) methods ---

  async observe(): Promise<Observation> {
    return this.underlying.observe();
  }

  async read(target: TargetLocator): Promise<string> {
    return this.underlying.read(target);
  }

  async screenshot(path?: string): Promise<string> {
    return this.underlying.screenshot(path);
  }

  async currentUrl(): Promise<string> {
    return this.underlying.currentUrl();
  }

  async isVisible(target: TargetLocator): Promise<boolean> {
    return this.underlying.isVisible(target);
  }

  async pageText(): Promise<string> {
    return this.underlying.pageText();
  }

  async wait(options: WaitOptions): Promise<void> {
    return this.underlying.wait(options);
  }

  async close(): Promise<void> {
    return this.underlying.close();
  }

  // --- Policy-enforced (mutating) methods ---

  async click(target: TargetLocator): Promise<void> {
    const action: Action = { type: 'click', target };
    await this.enforcePolicy(action);
    return this.underlying.click(target);
  }

  async type(target: TargetLocator, value: string): Promise<void> {
    const action: Action = { type: 'type', target, value };
    await this.enforcePolicy(action);
    return this.underlying.type(target, value);
  }

  async navigate(url: string): Promise<void> {
    const action: Action = { type: 'navigate', value: url };
    await this.enforcePolicy(action);
    return this.underlying.navigate(url);
  }

  // --- Internal enforcement logic ---

  private async enforcePolicy(action: Action): Promise<void> {
    const context = this.buildPolicyContext();
    const result = this.policy.evaluate(action, context);

    if (result.decision === 'deny') {
      throw new PolicyDeniedError(action, result);
    }

    if (result.decision === 'require_confirmation') {
      const scope = this.buildApprovalScope(action);

      // 1. Check for a matching remembered approval in persistent store
      if (this.approvalStore) {
        const approval = await this.approvalStore.findMatching(scope);
        if (approval) {
          // Remembered approval found and valid — proceed
          this.actionCount++;
          return;
        }
      }

      // 2. Check for a matching ephemeral (allow_once) approval
      const ephemeralIndex = this.ephemeralApprovals.findIndex((staged) =>
        matchesApprovalScope(staged, scope)
      );
      if (ephemeralIndex !== -1) {
        // Ephemeral approval consumed — proceed strictly once
        this.ephemeralApprovals.splice(ephemeralIndex, 1);
        this.actionCount++;
        return;
      }

      throw new ConfirmationRequiredError(action, result);
    }

    // 'allow' — proceed
    this.actionCount++;
  }

  private buildPolicyContext(): PolicyContext {
    const ext = this.contextProvider?.() ?? {};
    return {
      currentUrl: ext.currentUrl,
      actionCount: this.actionCount,
      isReplay: ext.isReplay,
    };
  }

  public buildApprovalScope(action: Action): ApprovalScope {
    const ext = this.contextProvider?.() ?? {};
    const scope: Record<string, string | undefined> = {
      actionType: action.type,
    };
    if (ext.capabilityId) scope.capabilityId = ext.capabilityId;
    if (ext.targetApp) scope.targetApp = ext.targetApp;
    if (ext.tenant) scope.tenant = ext.tenant;
    const route = ext.route ?? this.routeFromUrl(ext.currentUrl);
    if (route) scope.route = route;
    return scope as ApprovalScope;
  }

  private routeFromUrl(url?: string): string | undefined {
    if (!url) return undefined;
    try {
      return new URL(url).pathname;
    } catch {
      return url.startsWith('/') ? url.split('?')[0] : undefined;
    }
  }
}

/**
 * Check if a staged approval scope covers a queried action scope.
 * Any field specified in `staged` must match the corresponding field in `query`.
 */
export function matchesApprovalScope(staged: ApprovalScope, query: ApprovalScope): boolean {
  if (staged.actionType !== undefined && staged.actionType !== query.actionType) return false;
  if (staged.capabilityId !== undefined && staged.capabilityId !== query.capabilityId) return false;
  if (staged.targetApp !== undefined && staged.targetApp !== query.targetApp) return false;
  if (staged.tenant !== undefined && staged.tenant !== query.tenant) return false;
  if (staged.route !== undefined && staged.route !== query.route) return false;
  return true;
}

