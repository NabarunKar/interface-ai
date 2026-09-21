import type { Surface } from '../surface/types.js';
import {
  CapabilityArtifactSchema,
  type CapabilityArtifact,
  type Checkpoint,
} from '../domain/artifact.js';
import type { Action } from '../domain/action.js';
import type { ReplayResult } from '../domain/outcome.js';
import type { EvidenceEvent } from '../domain/evidence.js';
import {
  validateArtifactInterpolation,
  interpolateAction,
  interpolateString,
  InterpolationError,
} from '../interpolation/interpolate.js';
import { evaluateCheckpoint } from './checkpoint-evaluator.js';
import type { ReplayOptions } from './types.js';
import { PolicyDeniedError, ConfirmationRequiredError } from '../policy/enforced-surface.js';
import { HandoffCoordinator } from '../handoff/index.js';

/**
 * Deterministic Replay Engine.
 *
 * Executes a previously discovered CapabilityArtifact step-by-step
 * directly against a Surface without any LLM in the loop.
 */
export class ReplayEngine {
  constructor(
    private readonly surface: Surface,
    private readonly defaultOptions?: ReplayOptions,
  ) {}

  /**
   * Replay a capability artifact with optional invocation parameters.
   */
  async replay(
    artifact: CapabilityArtifact,
    params?: Record<string, unknown>,
    options?: ReplayOptions,
  ): Promise<ReplayResult> {
    const startTime = Date.now();
    const mergedOptions: ReplayOptions = {
      ...this.defaultOptions,
      ...options,
    };

    const runId = `replay-${Date.now()}`;
    let eventId = 0;
    const logger = mergedOptions.evidence;

    const emit = (event: Omit<EvidenceEvent, 'eventId' | 'timestamp' | 'runId'>) => {
      if (logger) {
        logger.log({
          ...event,
          eventId: eventId++,
          timestamp: new Date().toISOString(),
          runId,
        });
      }
    };

    // -------------------------------------------------------------------------
    // 1. Pre-execution artifact & interpolation validation
    // -------------------------------------------------------------------------
    const parsedArtifact = CapabilityArtifactSchema.safeParse(artifact);
    if (!parsedArtifact.success) {
      const errorMsg = `Invalid capability artifact: ${parsedArtifact.error.message}`;
      emit({
        type: 'error',
        controlMode: 'automation',
        data: { error: errorMsg },
      });
      emit({
        type: 'run_completed',
        controlMode: 'automation',
        message: errorMsg,
        data: { status: 'invalid_artifact' },
      });
      return {
        status: 'invalid_artifact',
        category: 'INVALID_ARTIFACT',
        message: errorMsg,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      validateArtifactInterpolation(artifact, params);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isInputIssue =
        err instanceof InterpolationError &&
        (errorMsg.startsWith('Missing required parameter') ||
          errorMsg.startsWith('Unknown parameter') ||
          errorMsg.includes('expected type') ||
          errorMsg.startsWith('No value provided'));

      const status = isInputIssue ? 'invalid_input' : 'invalid_artifact';
      const category = isInputIssue ? 'INVALID_INPUT' : 'INVALID_ARTIFACT';

      emit({
        type: 'error',
        controlMode: 'automation',
        data: { error: errorMsg, status },
      });
      emit({
        type: 'run_completed',
        controlMode: 'automation',
        message: errorMsg,
        data: { status },
      });
      return {
        status,
        category,
        message: errorMsg,
        durationMs: Date.now() - startTime,
      };
    }

    // -------------------------------------------------------------------------
    // 2. Start replay run & Initial Navigation
    // -------------------------------------------------------------------------
    const effectiveEntryPoint =
      mergedOptions.entryPoint ??
      (params ? interpolateString(artifact.entryPoint, artifact.inputs, params) : artifact.entryPoint);

    emit({
      type: 'run_started',
      controlMode: 'automation',
      stepIndex: 0,
      data: {
        artifactId: artifact.id,
        artifactName: artifact.name,
        entryPoint: effectiveEntryPoint,
        targetApp: artifact.targetApp,
        timeoutMs: mergedOptions.timeoutMs ?? artifact.policyConstraints?.maxDurationMs ?? 60_000,
      },
    });

    if (!mergedOptions.skipInitialNavigation) {
      try {
        await this.surface.navigate(effectiveEntryPoint);
        const obs = await this.surface.observe();
        emit({
          type: 'observation',
          controlMode: 'automation',
          stepIndex: 0,
          data: {
            url: obs.url,
            title: obs.title,
            visibleTextLength: obs.visibleText?.length ?? 0,
          },
        });
      } catch (err) {
        const errorMsg = `Initial navigation to ${effectiveEntryPoint} failed: ${err instanceof Error ? err.message : String(err)}`;
        emit({
          type: 'error',
          controlMode: 'automation',
          data: { error: errorMsg },
        });
        return {
          status: 'hard_failure',
          category: 'HARD_FAILURE',
          message: errorMsg,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // -------------------------------------------------------------------------
    // 3. Step-by-step ordered execution
    // -------------------------------------------------------------------------
    const sortedSteps = [...artifact.steps].sort((a, b) => a.index - b.index);

    for (const step of sortedSteps) {
      // Step Delay if configured
      if (mergedOptions.stepDelayMs && mergedOptions.stepDelayMs > 0) {
        await new Promise((r) => setTimeout(r, mergedOptions.stepDelayMs));
      }

      // Check timeout
      const maxDuration =
        mergedOptions.timeoutMs ?? artifact.policyConstraints?.maxDurationMs ?? 60_000;
      if (Date.now() - startTime > maxDuration) {
        const errorMsg = `Replay exceeded timeout of ${maxDuration}ms at step ${step.index}`;
        emit({
          type: 'error',
          controlMode: 'automation',
          stepIndex: step.index,
          data: { error: errorMsg },
        });
        return {
          status: 'hard_failure',
          category: 'HARD_FAILURE',
          message: errorMsg,
          failedAtStep: step.index,
          durationMs: Date.now() - startTime,
        };
      }

      // A. Evaluate Precondition (if present)
      if (step.precondition) {
        const interpolatedPrecondition = this.interpolateCheckpoint(
          step.precondition,
          artifact,
          params,
        );
        const checkResult = await evaluateCheckpoint(this.surface, interpolatedPrecondition);
        if (!checkResult.passed) {
          emit({
            type: 'checkpoint_failed',
            controlMode: 'automation',
            stepIndex: step.index,
            data: {
              checkpoint: step.precondition.description,
              expected: checkResult.expected,
              observed: checkResult.observed,
              reason: checkResult.reason,
            },
          });
          return {
            status: 'hard_failure',
            category: 'HARD_FAILURE',
            failedAtStep: step.index,
            message: `Precondition failed at step ${step.index}: ${checkResult.reason}`,
            expected: checkResult.expected,
            observed: checkResult.observed,
            durationMs: Date.now() - startTime,
          };
        }
        emit({
          type: 'checkpoint_passed',
          controlMode: 'automation',
          stepIndex: step.index,
          data: { checkpoint: step.precondition.description },
        });
      }

      // B. Interpolate Action
      const action = interpolateAction(step.action, artifact.inputs, params ?? {});

      // C. Log action proposed
      emit({
        type: 'action_proposed',
        controlMode: 'automation',
        stepIndex: step.index,
        action,
        data: { rationale: step.rationale },
      });

      // D. Dispatch action to Surface
      try {
        await this.executeAction(action);
      } catch (err) {
        if (err instanceof PolicyDeniedError) {
          emit({
            type: 'action_rejected',
            controlMode: 'automation',
            stepIndex: step.index,
            action,
            data: { reason: err.message },
          });
          return {
            status: 'hard_failure',
            category: 'HARD_FAILURE',
            failedAtStep: step.index,
            message: `Policy denied action at step ${step.index}: ${err.message}`,
            durationMs: Date.now() - startTime,
          };
        }

        if (err instanceof ConfirmationRequiredError) {
          if (mergedOptions.handoff) {
            const coordinator =
              typeof mergedOptions.handoff === 'function'
                ? new HandoffCoordinator({
                    handler: mergedOptions.handoff,
                    evidence: logger,
                  })
                : mergedOptions.handoff;

            const handoffResult = await coordinator.handleConfirmation({
              action,
              reason: err.policyResult.reason,
              surface: this.surface,
              runId,
              stepIndex: step.index,
              capabilityId: artifact.id,
            });

            if (handoffResult.status === 'resumed') {
              // Action approved! Re-evaluate and execute through PolicyEnforcedSurface
              try {
                await this.executeAction(action);
              } catch (retryErr) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                emit({
                  type: 'error',
                  controlMode: 'automation',
                  stepIndex: step.index,
                  action,
                  data: { error: retryMsg },
                });
                return {
                  status: 'hard_failure',
                  category: 'HARD_FAILURE',
                  failedAtStep: step.index,
                  message: `Action execution failed after approval at step ${step.index}: ${retryMsg}`,
                  durationMs: Date.now() - startTime,
                };
              }
            } else if (handoffResult.status === 'denied') {
              emit({
                type: 'run_completed',
                controlMode: 'automation',
                stepIndex: step.index,
                message: `Replay terminated: action denied by human at step ${step.index}`,
                data: { status: 'denied', reason: handoffResult.resolution?.reason },
              });
              return {
                status: 'denied',
                category: 'HUMAN_DENIAL',
                failedAtStep: step.index,
                message: `Action denied by human operator at step ${step.index}: ${handoffResult.resolution?.reason ?? 'No reason provided'}`,
                durationMs: Date.now() - startTime,
              };
            } else if (handoffResult.status === 'session_unavailable') {
              emit({
                type: 'error',
                controlMode: 'automation',
                stepIndex: step.index,
                message: handoffResult.error,
                data: { status: 'session_unavailable' },
              });
              return {
                status: 'recoverable_failure',
                category: 'RECOVERABLE',
                failedAtStep: step.index,
                message: handoffResult.error ?? `Session unavailable at step ${step.index}`,
                durationMs: Date.now() - startTime,
              };
            } else {
              // abandoned
              return {
                status: 'hard_failure',
                category: 'HARD_FAILURE',
                failedAtStep: step.index,
                message: handoffResult.error ?? `Human handoff abandoned at step ${step.index}`,
                durationMs: Date.now() - startTime,
              };
            }
          } else {
            // No handoff configured -> original recoverable failure behavior preserved
            emit({
              type: 'action_rejected',
              controlMode: 'automation',
              stepIndex: step.index,
              action,
              data: { reason: err.message },
            });
            return {
              status: 'recoverable_failure',
              category: 'RECOVERABLE',
              failedAtStep: step.index,
              message: `Confirmation required at step ${step.index}: ${err.message}`,
              durationMs: Date.now() - startTime,
            };
          }
        } else {
          // Generic execution error (when error was not handled by confirmation handoff)
          const errorMsg = err instanceof Error ? err.message : String(err);
          emit({
            type: 'error',
            controlMode: 'automation',
            stepIndex: step.index,
            action,
            data: { error: errorMsg },
          });

          // Determine if recoverable or hard failure
          const isRecoverable =
            errorMsg.toLowerCase().includes('timeout') ||
            errorMsg.toLowerCase().includes('waiting for');

          return {
            status: isRecoverable ? 'recoverable_failure' : 'hard_failure',
            category: isRecoverable ? 'RECOVERABLE' : 'HARD_FAILURE',
            failedAtStep: step.index,
            message: `Execution failed at step ${step.index} (${action.type}): ${errorMsg}`,
            durationMs: Date.now() - startTime,
          };
        }
      }

      // E. Log action executed
      emit({
        type: 'action_executed',
        controlMode: 'automation',
        stepIndex: step.index,
        action,
      });

      // F. Evaluate Postcondition (if present)
      if (step.postcondition) {
        const interpolatedPostcondition = this.interpolateCheckpoint(
          step.postcondition,
          artifact,
          params,
        );
        const checkResult = await evaluateCheckpoint(this.surface, interpolatedPostcondition);
        if (!checkResult.passed) {
          emit({
            type: 'checkpoint_failed',
            controlMode: 'automation',
            stepIndex: step.index,
            data: {
              checkpoint: step.postcondition.description,
              expected: checkResult.expected,
              observed: checkResult.observed,
              reason: checkResult.reason,
            },
          });
          return {
            status: 'hard_failure',
            category: 'HARD_FAILURE',
            failedAtStep: step.index,
            message: `Postcondition failed at step ${step.index}: ${checkResult.reason}`,
            expected: checkResult.expected,
            observed: checkResult.observed,
            durationMs: Date.now() - startTime,
          };
        }
        emit({
          type: 'checkpoint_passed',
          controlMode: 'automation',
          stepIndex: step.index,
          data: { checkpoint: step.postcondition.description },
        });
      }

      // G. Check Expected Business Outcomes
      if (artifact.expectedBusinessOutcomes && artifact.expectedBusinessOutcomes.length > 0) {
        for (const outcome of artifact.expectedBusinessOutcomes) {
          const interpolatedCheckpoint = this.interpolateCheckpoint(
            outcome.checkpoint,
            artifact,
            params,
          );
          const outcomeCheck = await evaluateCheckpoint(this.surface, interpolatedCheckpoint);
          if (outcomeCheck.passed) {
            emit({
              type: 'checkpoint_passed',
              controlMode: 'automation',
              stepIndex: step.index,
              data: {
                businessOutcome: outcome.code,
                description: outcome.description,
              },
            });
            emit({
              type: 'run_completed',
              controlMode: 'automation',
              stepIndex: step.index,
              message: outcome.description ?? `Business outcome: ${outcome.code}`,
              data: { code: outcome.code },
            });
            return {
              status: 'business_outcome',
              category: 'BUSINESS_OUTCOME',
              failedAtStep: step.index,
              message: outcome.description ?? `Business outcome: ${outcome.code}`,
              outputs: { code: outcome.code },
              durationMs: Date.now() - startTime,
            };
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 4. Success verification & output extraction
    // -------------------------------------------------------------------------
    const interpolatedSuccess = this.interpolateCheckpoint(
      artifact.successCondition,
      artifact,
      params,
    );
    const successResult = await evaluateCheckpoint(this.surface, interpolatedSuccess);

    if (!successResult.passed) {
      emit({
        type: 'checkpoint_failed',
        controlMode: 'automation',
        data: {
          checkpoint: artifact.successCondition.description,
          expected: successResult.expected,
          observed: successResult.observed,
          reason: successResult.reason,
        },
      });
      return {
        status: 'hard_failure',
        category: 'HARD_FAILURE',
        message: `Success condition failed: ${successResult.reason}`,
        expected: successResult.expected,
        observed: successResult.observed,
        durationMs: Date.now() - startTime,
      };
    }

    emit({
      type: 'checkpoint_passed',
      controlMode: 'automation',
      data: { checkpoint: artifact.successCondition.description },
    });

    // Extract declared outputs
    const extractedOutputs: Record<string, unknown> = {};
    for (const output of artifact.outputs) {
      try {
        const rawText = await this.surface.read(output.source);
        if (output.type === 'number') {
          const cleaned = rawText.replace(/[^0-9.-]/g, '');
          extractedOutputs[output.name] = Number(cleaned);
        } else if (output.type === 'boolean') {
          extractedOutputs[output.name] = Boolean(rawText && rawText.toLowerCase() !== 'false');
        } else {
          extractedOutputs[output.name] = rawText;
        }
      } catch (err) {
        const errorMsg = `Failed to extract declared output '${output.name}': ${err instanceof Error ? err.message : String(err)}`;
        emit({
          type: 'error',
          controlMode: 'automation',
          data: { error: errorMsg },
        });
        return {
          status: 'hard_failure',
          category: 'HARD_FAILURE',
          message: errorMsg,
          durationMs: Date.now() - startTime,
        };
      }
    }

    emit({
      type: 'run_completed',
      controlMode: 'automation',
      message: 'Replay completed successfully',
      data: { outputs: extractedOutputs },
    });

    return {
      status: 'success',
      outputs: extractedOutputs,
      message: 'Replay completed successfully',
      durationMs: Date.now() - startTime,
    };
  }

  private async executeAction(action: Action): Promise<void> {
    switch (action.type) {
      case 'click':
        await this.surface.click(action.target!);
        break;
      case 'type':
        await this.surface.type(action.target!, action.value ?? '');
        break;
      case 'navigate':
        await this.surface.navigate(action.value!);
        break;
      case 'read':
        await this.surface.read(action.target!);
        break;
      case 'wait':
        await this.surface.wait({
          target: action.target,
          durationMs: action.timeoutMs,
        });
        break;
      case 'screenshot':
        await this.surface.screenshot();
        break;
      default: {
        const exhaustiveCheck: never = action.type;
        throw new Error(`Unsupported action type: ${String(exhaustiveCheck)}`);
      }
    }
  }

  private interpolateCheckpoint(
    checkpoint: Checkpoint,
    artifact: CapabilityArtifact,
    params?: Record<string, unknown>,
  ): Checkpoint {
    if (!params) return checkpoint;

    return {
      ...checkpoint,
      expectedValue: checkpoint.expectedValue
        ? interpolateString(checkpoint.expectedValue, artifact.inputs, params)
        : undefined,
    };
  }
}
