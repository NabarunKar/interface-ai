import type { ModelClient, ModelDecision, ModelInput } from './types.js';

/**
 * Deterministic test double for ModelClient.
 * It returns a fixed sequence and has no network/provider dependency.
 */
export class FakeModelClient implements ModelClient {
  private index = 0;

  constructor(private readonly decisions: unknown[]) {}

  async decide(_input: ModelInput): Promise<unknown> {
    if (this.index >= this.decisions.length) {
      return { type: 'STUCK', reason: 'Fake model decision sequence exhausted' } satisfies ModelDecision;
    }

    const decision = this.decisions[this.index];
    this.index += 1;
    return decision;
  }

  get calls(): number {
    return this.index;
  }
}
