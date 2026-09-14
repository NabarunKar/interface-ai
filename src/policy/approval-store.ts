import type { ApprovalRecord, ApprovalScope } from '../domain/approval.js';
import { ApprovalRecordSchema, RememberedApprovalScopeSchema } from '../domain/approval.js';

/**
 * Technology-neutral interface for approval state storage.
 *
 * Approval state is SEPARATE from policy rules:
 * - Policy rules are deterministic code/configuration.
 * - Approval state is separate mutable state.
 * - The LLM does not own authorization state.
 * - The LLM cannot write directly to the ApprovalStore.
 * - Future human approval code is the authority that creates remembered state.
 * - DENY and ALLOW_ONCE are runtime responses only and are not stored here.
 *
 * The PolicyEngine itself does NOT query this store.
 * The enforcement layer (PolicyEnforcedSurface) consults it
 * when a policy decision is 'require_confirmation'.
 */
export interface ApprovalStore {
  /**
   * Find a valid remembered approval matching the given scope.
   * Returns undefined if no matching valid approval exists.
   * Expired approvals must not be returned.
   */
  findMatching(scope: ApprovalScope): Promise<ApprovalRecord | undefined>;

  /** Save a durable remembered approval record. */
  saveRemembered(record: ApprovalRecord): Promise<void>;

  /** Revoke an approval by ID. Returns true if found and removed. */
  revoke(id: string): Promise<boolean>;

  /** List all stored approval records. */
  list(): Promise<ApprovalRecord[]>;
}

/**
 * In-memory approval store for testing.
 *
 * Scope matching rules:
 * A stored approval matches only when every supported scope field is equal.
 * This keeps remembered approvals from authorizing another tenant,
 * application, capability, action type, or route by omission.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private records: ApprovalRecord[] = [];

  async findMatching(query: ApprovalScope): Promise<ApprovalRecord | undefined> {
    if (!RememberedApprovalScopeSchema.safeParse(query).success) {
      return undefined;
    }

    const now = new Date();
    return this.records.find((record) => {
      // Check expiration
      if (record.expiresAt && new Date(record.expiresAt) <= now) return false;
      // Check scope match
      return this.scopeMatches(record.scope, query);
    });
  }

  async saveRemembered(record: ApprovalRecord): Promise<void> {
    ApprovalRecordSchema.parse(record);
    // Replace existing record with same ID
    this.records = this.records.filter(r => r.id !== record.id);
    this.records.push(record);
  }

  async revoke(id: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter(r => r.id !== id);
    return this.records.length < before;
  }

  async list(): Promise<ApprovalRecord[]> {
    return [...this.records];
  }

  /**
   * A stored scope matches a query only if every supported field is equal.
   */
  private scopeMatches(stored: ApprovalScope, query: ApprovalScope): boolean {
    return stored.capabilityId === query.capabilityId &&
      stored.targetApp === query.targetApp &&
      stored.actionType === query.actionType &&
      stored.tenant === query.tenant &&
      stored.route === query.route;
  }
}
