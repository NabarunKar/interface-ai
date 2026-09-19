import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EvidenceEvent } from '../domain/evidence.js';
import type { EvidenceLogger } from './logger.js';

/**
 * File-based evidence logger that writes JSONL.
 *
 * Each event is appended as a single JSON line.
 * Also keeps events in memory for getEvents() queries.
 */
export class FileEvidenceLogger implements EvidenceLogger {
  private readonly events: EvidenceEvent[] = [];
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  log(event: EvidenceEvent): void {
    this.events.push(event);
    const line = JSON.stringify(event) + '\n';
    writeFileSync(this.filePath, line, { flag: 'a' });
  }

  getEvents(runId: string): EvidenceEvent[] {
    return this.events.filter(e => e.runId === runId);
  }

  getAllEvents(): EvidenceEvent[] {
    return [...this.events];
  }

  /**
   * Read events from an existing JSONL file.
   * Useful for loading previously saved evidence.
   */
  static readFromFile(filePath: string): EvidenceEvent[] {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as EvidenceEvent);
  }

  getFilePath(): string {
    return this.filePath;
  }
}
