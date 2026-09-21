import type { HandoffState } from './types.js';

export class HandoffStateError extends Error {
  constructor(
    public readonly from: HandoffState,
    public readonly to: HandoffState,
    message?: string,
  ) {
    super(message ?? `Invalid handoff state transition: '${from}' -> '${to}'`);
    this.name = 'HandoffStateError';
  }
}

const ALLOWED_TRANSITIONS: Record<HandoffState, HandoffState[]> = {
  requested: ['waiting_for_human', 'abandoned'],
  waiting_for_human: ['approved', 'denied', 'abandoned'],
  approved: ['resumed', 'abandoned'],
  denied: [], // Terminal
  resumed: ['completed', 'abandoned'],
  completed: [], // Terminal
  abandoned: [], // Terminal
};

/**
 * Deterministic state machine governing handoff lifecycle transitions.
 */
export class HandoffStateMachine {
  private _state: HandoffState;

  constructor(initialState: HandoffState = 'requested') {
    this._state = initialState;
  }

  get state(): HandoffState {
    return this._state;
  }

  canTransition(to: HandoffState): boolean {
    return ALLOWED_TRANSITIONS[this._state].includes(to);
  }

  transition(to: HandoffState): HandoffState {
    if (!this.canTransition(to)) {
      throw new HandoffStateError(this._state, to);
    }
    this._state = to;
    return this._state;
  }

  isTerminal(): boolean {
    return ALLOWED_TRANSITIONS[this._state].length === 0;
  }
}
