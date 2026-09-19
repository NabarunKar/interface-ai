import type { Action, TargetLocator } from '../domain/action.js';
import type { CapabilityArtifact, Checkpoint } from '../domain/artifact.js';
import type { Goal } from '../domain/goal.js';

/**
 * An executed action recorded during a live discovery run.
 */
export interface DiscoveredStepRecord {
  /** Sequential index of this step in the discovery execution trace */
  index: number;
  /** The action that was executed */
  action: Action;
  /** URL before this step was executed */
  preUrl?: string;
  /** URL after this step was executed */
  postUrl?: string;
  /** Rationale or explanation provided by the model */
  rationale?: string;
  /** Explicit precondition checkpoint, if any */
  precondition?: Checkpoint;
  /** Explicit postcondition checkpoint, if any */
  postcondition?: Checkpoint;
}

/**
 * Options to configure the ArtifactRecorder.
 */
export interface ArtifactRecorderOptions {
  /** Directory where generated artifacts are persisted. Default: 'evidence/artifacts' */
  outputDir?: string;
  /** Explicit mapping of parameter names to concrete discovery values */
  parameterMappings?: Record<string, string>;
  /** Explicit output locator overrides */
  outputLocators?: Record<string, TargetLocator>;
  /** Whether to persist to disk. Default: true */
  saveToDisk?: boolean;
  /** Target app override */
  targetApp?: string;
  /** Surface type override */
  surfaceType?: 'web' | 'legacy-web' | 'desktop';
  /**
   * Canonical entry point URL to persist in the artifact (e.g., standard base URL).
   * When provided, persisted as `artifact.entryPoint`.
   * When omitted, defaults to the runtime entry point used during discovery.
   */
  canonicalEntryPoint?: string;
}

/**
 * Parameters passed to ArtifactRecorder.record().
 */
export interface RecordArtifactParams {
  /** The discovery goal */
  goal: Goal;
  /** Sequence of executed discovery actions */
  steps: DiscoveredStepRecord[];
  /** Verified output values extracted during verification */
  outputs?: Record<string, unknown>;
  /** Discovery run ID */
  runId: string;
  /** Recorded entry point URL */
  entryPoint?: string;
}

/**
 * Result of artifact recording.
 */
export interface RecordArtifactResult {
  /** The validated CapabilityArtifact */
  artifact: CapabilityArtifact;
  /** The file path where the artifact was persisted, if saved */
  filePath?: string;
}
