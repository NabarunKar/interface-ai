import type { EvidenceEvent } from '../domain/evidence.js';

/**
 * Interface for evidence logging.
 * Events are structured and JSONL-friendly.
 */
export interface EvidenceLogger {
  /** Log a single event */
  log(event: EvidenceEvent): void;
  /** Get all events for a run */
  getEvents(runId: string): EvidenceEvent[];
  /** Get all events */
  getAllEvents(): EvidenceEvent[];
}

/**
 * In-memory evidence logger.
 * Suitable for Phase 0 testing.
 * A file-based JSONL logger can be added later.
 */
export class InMemoryEvidenceLogger implements EvidenceLogger {
  private events: EvidenceEvent[] = [];

  log(event: EvidenceEvent): void {
    this.events.push(event);
  }

  getEvents(runId: string): EvidenceEvent[] {
    return this.events.filter((e) => e.runId === runId);
  }

  getAllEvents(): EvidenceEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}
