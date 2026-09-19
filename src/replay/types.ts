import type { EvidenceLogger } from '../evidence/logger.js';

/**
 * Options for replaying a capability artifact.
 */
export interface ReplayOptions {
  /**
   * Runtime entry point URL override.
   * Allows replaying an artifact against ephemeral or staging environments
   * without mutating the recorded artifact's entryPoint provenance.
   */
  entryPoint?: string;

  /**
   * Evidence logger for recording structured replay events.
   */
  evidence?: EvidenceLogger;

  /**
   * Maximum total execution time in milliseconds.
   * Defaults to artifact.policyConstraints?.maxDurationMs or 60_000ms.
   */
  timeoutMs?: number;

  /**
   * Optional pause in milliseconds between consecutive steps.
   * Useful for debugging or slowing down visual replays.
   */
  stepDelayMs?: number;

  /**
   * If true, assumes the surface is already at the target entry point
   * and skips the initial surface.navigate(entryPoint) call.
   */
  skipInitialNavigation?: boolean;
}
