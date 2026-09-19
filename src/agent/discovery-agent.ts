import type { Surface } from '../surface/types.js';
import type { Goal } from '../domain/goal.js';
import type { Action } from '../domain/action.js';
import type { EvidenceEvent } from '../domain/evidence.js';
import type { EvidenceLogger } from '../evidence/logger.js';
import type { ModelClient, ModelDecision, AgentResult, AgentState } from './types.js';
import type { GoalVerifier } from './goal-verifier.js';
import { canTransitionAgentState, isTerminalAgentState } from './types.js';
import { buildModelInput, parseModelDecision, ModelDecisionValidationError } from './validation.js';
import { PolicyDeniedError, ConfirmationRequiredError } from '../policy/enforced-surface.js';
import type { CapabilityArtifact } from '../domain/artifact.js';
import type { ArtifactRecorder, DiscoveredStepRecord } from '../artifact/index.js';

/**
 * Configuration for the discovery agent loop.
 */
export interface DiscoveryAgentConfig {
  /** Maximum number of ACTION steps before stopping. Default: 15 */
  maxSteps?: number;
  /** Overall timeout in ms. Default: 120_000 (2 minutes) */
  timeoutMs?: number;
  /** Per-model-call timeout in ms. Default: 30_000 */
  modelTimeoutMs?: number;
  /** Optional artifact recorder to capture and persist capability artifact on verified success */
  recorder?: ArtifactRecorder;
}

const DEFAULT_CONFIG: Required<Omit<DiscoveryAgentConfig, 'recorder'>> = {
  maxSteps: 15,
  timeoutMs: 120_000,
  modelTimeoutMs: 30_000,
};

/**
 * The discovery agent loop.
 *
 * Observe → Decide → Validate → Policy → Execute → Observe
 *
 * The model proposes structured actions. Every UI-changing action
 * passes through PolicyEnforcedSurface. The model never has direct
 * access to BrowserSurface, Playwright, or the filesystem.
 *
 * After the model returns DONE, the result is independently verified
 * via the GoalVerifier before the agent reports success.
 *
 * State machine transitions follow the existing contract in types.ts:
 *   IDLE → OBSERVING → DECIDING → POLICY_CHECKING → EXECUTING → VERIFYING → OBSERVING (loop)
 *   DECIDING → SUCCESS (DONE verified) | STUCK | FAILED (DONE unverified, ABORT, errors)
 */
export class DiscoveryAgent {
  private readonly config: Required<Omit<DiscoveryAgentConfig, 'recorder'>>;
  private readonly recorder?: ArtifactRecorder;

  constructor(
    private readonly model: ModelClient,
    private readonly surface: Surface,
    private readonly evidence: EvidenceLogger,
    private readonly verifier: GoalVerifier,
    config?: DiscoveryAgentConfig,
    recorder?: ArtifactRecorder,
  ) {
    this.config = {
      maxSteps: config?.maxSteps ?? DEFAULT_CONFIG.maxSteps,
      timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
      modelTimeoutMs: config?.modelTimeoutMs ?? DEFAULT_CONFIG.modelTimeoutMs,
    };
    this.recorder = recorder ?? config?.recorder;
  }

  async run(goal: Goal): Promise<AgentResult> {
    const runId = `discovery-${Date.now()}`;
    const startTime = Date.now();
    let state: AgentState = 'IDLE';
    let stepIndex = 0;
    const previousDecisions: ModelDecision[] = [];
    const executedSteps: DiscoveredStepRecord[] = [];

    const transition = (to: AgentState): void => {
      if (!canTransitionAgentState(state, to)) {
        throw new Error(`Invalid state transition: ${state} → ${to}`);
      }
      state = to;
    };

    // Emit run_started evidence
    this.emitEvidence(runId, 0, 'run_started', {
      data: {
        goal: goal.description,
        entryPoint: goal.entryPoint,
        maxSteps: this.config.maxSteps,
        timeoutMs: this.config.timeoutMs,
      },
    });

    try {
      // Navigate to the entry point
      transition('OBSERVING');
      await this.surface.navigate(goal.entryPoint);

      while (!isTerminalAgentState(state)) {
        // At loop top, state is OBSERVING (set by initial navigate or previous iteration).

        // Check timeout
        if (Date.now() - startTime > this.config.timeoutMs) {
          transition('DECIDING');
          transition('TIMEOUT');
          return this.buildResult('timeout', goal, stepIndex, runId, 'Overall timeout exceeded');
        }

        // Check max steps
        if (stepIndex >= this.config.maxSteps) {
          transition('DECIDING');
          transition('MAX_STEPS');
          return this.buildResult('max_steps', goal, stepIndex, runId, `Max steps (${this.config.maxSteps}) reached`);
        }

        // OBSERVE
        const observation = await this.surface.observe();
        this.emitEvidence(runId, stepIndex, 'observation', {
          data: {
            url: observation.url,
            title: observation.title,
            visibleTextLength: observation.visibleText?.length,
            elementCount: observation.elements?.length,
          },
        });

        // DECIDE
        transition('DECIDING');
        const input = buildModelInput({
          goal,
          observation,
          stepIndex,
          maxSteps: this.config.maxSteps,
          previousDecisions: previousDecisions.slice(-5),
        });

        let rawDecision: unknown;
        try {
          let timer: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Model call timed out after ${this.config.modelTimeoutMs}ms`));
            }, this.config.modelTimeoutMs);
          });
          try {
            rawDecision = await Promise.race([this.model.decide(input), timeoutPromise]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        } catch (error) {
          transition('FAILED');
          const reason = `Model/API error: ${error instanceof Error ? error.message : String(error)}`;
          this.emitEvidence(runId, stepIndex, 'error', { message: reason });
          return this.buildResult('failed', goal, stepIndex, runId, reason);
        }

        // VALIDATE
        let decision: ModelDecision;
        try {
          decision = parseModelDecision(rawDecision);
        } catch (error) {
          transition('FAILED');
          const reason = error instanceof ModelDecisionValidationError
            ? `Invalid model decision: ${error.message}`
            : `Validation error: ${String(error)}`;
          this.emitEvidence(runId, stepIndex, 'error', {
            message: reason,
            data: { rawDecision: sanitizeForEvidence(rawDecision) },
          });
          return this.buildResult('failed', goal, stepIndex, runId, reason);
        }

        previousDecisions.push(decision);

        // Handle terminal decisions
        // From DECIDING, the allowed transitions are:
        //   POLICY_CHECKING, SUCCESS, STUCK, FAILED, TIMEOUT, MAX_STEPS
        if (decision.type === 'DONE') {
          this.emitEvidence(runId, stepIndex, 'action_proposed', {
            reasoning: decision.reason,
            data: { type: 'DONE', outputs: decision.outputs },
          });

          // Independent verification (still in DECIDING state)
          const verification = await this.verifier.verify(this.surface, decision);

          if (verification.verified) {
            transition('SUCCESS');
            let recordedArtifact: CapabilityArtifact | undefined;
            let artifactPath: string | undefined;

            if (this.recorder) {
              try {
                const recordResult = await this.recorder.record({
                  goal,
                  steps: executedSteps,
                  outputs: verification.outputs,
                  runId,
                  entryPoint: goal.entryPoint,
                });
                recordedArtifact = recordResult.artifact;
                artifactPath = recordResult.filePath;
              } catch (err) {
                transition('FAILED');
                const reason = `Artifact recording failed: ${err instanceof Error ? err.message : String(err)}`;
                this.emitEvidence(runId, stepIndex, 'error', { message: reason });
                return this.buildResult('failed', goal, stepIndex, runId, reason);
              }
            }

            this.emitEvidence(runId, stepIndex, 'run_completed', {
              message: `Goal completed: ${verification.reason}`,
              data: { outputs: verification.outputs, artifactPath },
            });
            return this.buildResult(
              'success',
              goal,
              stepIndex,
              runId,
              verification.reason,
              verification.outputs,
              recordedArtifact,
              artifactPath,
            );
          } else {
            transition('FAILED');
            this.emitEvidence(runId, stepIndex, 'error', {
              message: `DONE verification failed: ${verification.reason}`,
            });
            return this.buildResult('failed', goal, stepIndex, runId, `DONE verification failed: ${verification.reason}`);
          }
        }

        if (decision.type === 'STUCK') {
          transition('STUCK');
          this.emitEvidence(runId, stepIndex, 'run_completed', {
            message: `Agent stuck: ${decision.reason}`,
          });
          return this.buildResult('stuck', goal, stepIndex, runId, decision.reason);
        }

        if (decision.type === 'ABORT') {
          transition('FAILED');
          this.emitEvidence(runId, stepIndex, 'run_completed', {
            message: `Agent aborted: ${decision.reason}`,
          });
          return this.buildResult('failed', goal, stepIndex, runId, `Aborted: ${decision.reason}`);
        }

        // ACTION
        const action = decision.action;
        this.emitEvidence(runId, stepIndex, 'action_proposed', {
          action,
          reasoning: decision.reason,
        });

        // POLICY CHECK + EXECUTE
        transition('POLICY_CHECKING');
        try {
          await this.executeAction(action);
          transition('EXECUTING');
          this.emitEvidence(runId, stepIndex, 'action_executed', { action });
        } catch (error) {
          if (error instanceof PolicyDeniedError) {
            transition('FAILED');
            this.emitEvidence(runId, stepIndex, 'action_rejected', {
              action,
              message: `Policy denied: ${error.policyResult.reason}`,
            });
            return this.buildResult('failed', goal, stepIndex, runId,
              `Policy denied '${action.type}': ${error.policyResult.reason}`);
          }

          if (error instanceof ConfirmationRequiredError) {
            transition('STUCK');
            this.emitEvidence(runId, stepIndex, 'approval_requested', {
              action,
              message: `Confirmation required: ${error.policyResult.reason}`,
            });
            return this.buildResult('needs_human', goal, stepIndex, runId,
              `Confirmation required for '${action.type}': ${error.policyResult.reason}`);
          }

          // Browser/surface error
          transition('FAILED');
          const reason = `Execution error: ${error instanceof Error ? error.message : String(error)}`;
          this.emitEvidence(runId, stepIndex, 'error', {
            action,
            message: reason,
          });
          return this.buildResult('failed', goal, stepIndex, runId, reason);
        }

        // Post-action: brief wait for page to settle
        await this.surface.wait({ durationMs: 300 });
        const postUrl = await this.surface.currentUrl();

        executedSteps.push({
          index: stepIndex,
          action,
          preUrl: observation.url,
          postUrl,
          rationale: decision.reason,
        });

        // Move to VERIFYING then back to OBSERVING for next iteration
        transition('VERIFYING');
        transition('OBSERVING');
        stepIndex++;
      }

      // Should not reach here, but safety net
      return this.buildResult('failed', goal, stepIndex, runId, 'Agent loop exited unexpectedly');
    } catch (error) {
      // Catch-all for unexpected errors
      this.emitEvidence(runId, stepIndex, 'error', {
        message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      });
      return this.buildResult('failed', goal, stepIndex, runId,
        `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Execute a validated action through the surface.
   * The surface is expected to be a PolicyEnforcedSurface.
   */
  private async executeAction(action: Action): Promise<void> {
    switch (action.type) {
      case 'navigate':
        if (!action.value) throw new Error('Navigate action requires a URL value');
        await this.surface.navigate(action.value);
        break;
      case 'click':
        if (!action.target) throw new Error('Click action requires a target');
        await this.surface.click(action.target);
        break;
      case 'type':
        if (!action.target) throw new Error('Type action requires a target');
        if (action.value === undefined) throw new Error('Type action requires a value');
        await this.surface.type(action.target, action.value);
        break;
      case 'read':
        if (!action.target) throw new Error('Read action requires a target');
        await this.surface.read(action.target);
        break;
      case 'wait':
        await this.surface.wait({
          durationMs: action.timeoutMs ?? (action.value ? parseInt(action.value, 10) : 1000),
        });
        break;
      case 'screenshot':
        await this.surface.screenshot();
        break;
    }
  }

  private buildResult(
    status: AgentResult['status'],
    goal: Goal,
    stepCount: number,
    runId: string,
    reason?: string,
    outputs?: Record<string, unknown>,
    artifact?: CapabilityArtifact,
    artifactPath?: string,
  ): AgentResult {
    return {
      status,
      goal,
      stepCount,
      runId,
      reason,
      outputs,
      artifact,
      artifactPath,
    };
  }

  private emitEvidence(
    runId: string,
    stepIndex: number,
    type: EvidenceEvent['type'],
    extra?: Partial<Pick<EvidenceEvent, 'action' | 'data' | 'reasoning' | 'message'>>,
  ): void {
    const event: EvidenceEvent = {
      eventId: this.nextEventId++,
      timestamp: new Date().toISOString(),
      runId,
      type,
      stepIndex,
      controlMode: 'automation',
      ...extra,
    };
    this.evidence.log(event);
  }

  private nextEventId = 0;
}

/**
 * Sanitize raw model output for evidence logging.
 * Avoids storing potentially enormous/sensitive raw data.
 */
function sanitizeForEvidence(raw: unknown): unknown {
  try {
    const str = JSON.stringify(raw);
    if (str.length > 2000) {
      return { truncated: true, preview: str.slice(0, 500) };
    }
    return raw;
  } catch {
    return { type: typeof raw, value: String(raw).slice(0, 200) };
  }
}
