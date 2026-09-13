import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryEvidenceLogger } from '../src/evidence/logger.js';
import type { EvidenceEvent } from '../src/domain/evidence.js';

describe('InMemoryEvidenceLogger', () => {
  let logger: InMemoryEvidenceLogger;

  beforeEach(() => {
    logger = new InMemoryEvidenceLogger();
  });

  it('should log and retrieve events', () => {
    const event: EvidenceEvent = {
      eventId: 0,
      timestamp: new Date().toISOString(),
      runId: 'run-001',
      type: 'run_started',
      controlMode: 'automation',
      message: 'Starting run',
    };
    logger.log(event);
    expect(logger.getAllEvents()).toHaveLength(1);
    expect(logger.getAllEvents()[0]).toEqual(event);
  });

  it('should filter events by run ID', () => {
    const event1: EvidenceEvent = {
      eventId: 0,
      timestamp: new Date().toISOString(),
      runId: 'run-001',
      type: 'run_started',
      controlMode: 'automation',
    };
    const event2: EvidenceEvent = {
      eventId: 0,
      timestamp: new Date().toISOString(),
      runId: 'run-002',
      type: 'run_started',
      controlMode: 'automation',
    };
    logger.log(event1);
    logger.log(event2);
    expect(logger.getEvents('run-001')).toHaveLength(1);
    expect(logger.getEvents('run-002')).toHaveLength(1);
    expect(logger.getAllEvents()).toHaveLength(2);
  });

  it('should return empty array for unknown run ID', () => {
    expect(logger.getEvents('nonexistent')).toHaveLength(0);
  });

  it('should clear all events', () => {
    logger.log({
      eventId: 0,
      timestamp: new Date().toISOString(),
      runId: 'run-001',
      type: 'run_started',
      controlMode: 'automation',
    });
    logger.clear();
    expect(logger.getAllEvents()).toHaveLength(0);
  });

  it('should return a copy of events (not the internal array)', () => {
    logger.log({
      eventId: 0,
      timestamp: new Date().toISOString(),
      runId: 'run-001',
      type: 'run_started',
      controlMode: 'automation',
    });
    const events = logger.getAllEvents();
    events.pop();
    expect(logger.getAllEvents()).toHaveLength(1);
  });
});
