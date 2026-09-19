import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CapabilityArtifactSchema,
  type CapabilityArtifact,
  type ArtifactInput,
  type ArtifactStep,
  type ArtifactOutput,
  type Checkpoint,
  type BusinessOutcome,
} from '../domain/artifact.js';
import type { TargetLocator } from '../domain/action.js';
import type { Goal } from '../domain/goal.js';
import { validateArtifactInterpolation } from '../interpolation/interpolate.js';
import type {
  DiscoveredStepRecord,
  ArtifactRecorderOptions,
  RecordArtifactParams,
  RecordArtifactResult,
} from './types.js';

export class ArtifactValidationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(`Artifact validation failed: ${message}`);
    this.name = 'ArtifactValidationError';
  }
}

/**
 * ArtifactRecorder records executed discovery actions into a validated,
 * reusable CapabilityArtifact that can be persisted and deterministically
 * replayed by ReplayEngine without an LLM.
 */
export class ArtifactRecorder {
  private readonly options: Required<Pick<ArtifactRecorderOptions, 'outputDir' | 'saveToDisk'>> &
    ArtifactRecorderOptions;

  constructor(options?: ArtifactRecorderOptions) {
    this.options = {
      outputDir: options?.outputDir ?? resolve(process.cwd(), 'evidence', 'artifacts'),
      saveToDisk: options?.saveToDisk ?? true,
      ...options,
    };
  }

  /**
   * Record executed discovery actions into a CapabilityArtifact, validate it,
   * and optionally persist to disk.
   */
  async record(params: RecordArtifactParams): Promise<RecordArtifactResult> {
    const { goal, steps, outputs, runId, entryPoint = goal.entryPoint } = params;
    const effectiveEntryPoint = this.options.canonicalEntryPoint ?? entryPoint;

    // 1. Extract and declare parameters
    const paramEntries = this.extractParameters(goal);
    const declaredInputs: ArtifactInput[] = paramEntries.map(([name, val]) => ({
      name,
      description: `The ${name} to look up`,
      type: 'string',
      required: true,
      example: val,
    }));

    // 2. Transform executed steps into parameterized ArtifactSteps
    const artifactSteps = this.transformSteps(steps, paramEntries);

    // 3. Declare outputs
    const artifactOutputs = this.extractOutputs(outputs);

    // 4. Determine success condition & business outcomes
    const successCondition = this.determineSuccessCondition(goal);
    const expectedBusinessOutcomes = this.determineBusinessOutcomes(goal);

    // 5. Determine policy constraints
    let allowedHost = 'localhost';
    try {
      allowedHost = new URL(effectiveEntryPoint).hostname;
    } catch {
      // Fall back to localhost if invalid URL
    }

    const now = new Date().toISOString();
    const artifactId = this.deriveArtifactId(goal);
    const artifactName = this.deriveArtifactName(goal);

    const artifactCandidate: CapabilityArtifact = {
      id: artifactId,
      name: artifactName,
      description: goal.description,
      version: '1.0.0',
      targetApp: this.options.targetApp ?? goal.targetApp,
      surfaceType: this.options.surfaceType ?? 'web',
      entryPoint: effectiveEntryPoint,
      inputs: declaredInputs,
      steps: artifactSteps,
      outputs: artifactOutputs,
      successCondition,
      expectedBusinessOutcomes:
        expectedBusinessOutcomes.length > 0 ? expectedBusinessOutcomes : undefined,
      policyConstraints: {
        allowedDomains: Array.from(new Set([allowedHost, 'localhost', '127.0.0.1'])),
        readOnly: true,
        maxDurationMs: 30_000,
      },
      createdAt: now,
      updatedAt: now,
      sourceRunId: runId,
    };

    // 6. Strict validation against Zod schema and interpolation rules before persistence
    const parsed = CapabilityArtifactSchema.safeParse(artifactCandidate);
    if (!parsed.success) {
      throw new ArtifactValidationError(parsed.error.message, parsed.error);
    }

    try {
      validateArtifactInterpolation(parsed.data);
    } catch (err) {
      throw new ArtifactValidationError(
        err instanceof Error ? err.message : String(err),
        err,
      );
    }

    const validatedArtifact = parsed.data;

    // 7. Persist to disk if enabled
    let filePath: string | undefined;
    if (this.options.saveToDisk) {
      mkdirSync(this.options.outputDir, { recursive: true });
      filePath = resolve(this.options.outputDir, `${validatedArtifact.id}.json`);
      writeFileSync(filePath, JSON.stringify(validatedArtifact, null, 2) + '\n', 'utf-8');
    }

    return {
      artifact: validatedArtifact,
      filePath,
    };
  }

  /**
   * Extract input parameter key-value pairs from goal parameters, options, or goal description.
   */
  private extractParameters(goal: RecordArtifactParams['goal']): [string, string][] {
    const paramsMap = new Map<string, string>();

    // 1. Explicit parameter mappings in recorder options
    if (this.options.parameterMappings) {
      for (const [k, v] of Object.entries(this.options.parameterMappings)) {
        if (v) paramsMap.set(k, String(v));
      }
    }

    // 2. Goal structured parameters
    if (goal.parameters) {
      for (const [k, v] of Object.entries(goal.parameters)) {
        if (v !== undefined && v !== null) paramsMap.set(k, String(v));
      }
    }

    // 3. Fallback: Extract from natural language goal description if missing
    if (!paramsMap.has('memberId')) {
      const memberMatch = goal.description.match(/member\s+(?:id\s+)?([A-Za-z0-9_-]+)/i);
      if (memberMatch && memberMatch[1]) {
        paramsMap.set('memberId', memberMatch[1]);
      }
    }

    return Array.from(paramsMap.entries());
  }

  /**
   * Transform discovery steps into validated ArtifactSteps with parameter placeholders.
   */
  private transformSteps(
    steps: DiscoveredStepRecord[],
    parameters: [string, string][],
  ): ArtifactStep[] {
    if (steps.length === 0) {
      throw new ArtifactValidationError('Cannot record an artifact with 0 executed steps');
    }

    return steps.map((step, idx) => {
      let actionValue = step.action.value;
      let targetLocator = step.action.target;

      // Parameterize action.value and target values
      for (const [paramName, concreteVal] of parameters) {
        if (actionValue && typeof actionValue === 'string') {
          actionValue = actionValue.replaceAll(concreteVal, `{{${paramName}}}`);
        }
        if (targetLocator && typeof targetLocator.value === 'string') {
          const templatedTargetValue = targetLocator.value.replaceAll(
            concreteVal,
            `{{${paramName}}}`,
          );
          if (templatedTargetValue !== targetLocator.value) {
            targetLocator = {
              ...targetLocator,
              value: templatedTargetValue,
            };
          }
        }
      }

      // Infer postcondition from URL changes if not already provided
      let postcondition = step.postcondition;
      if (!postcondition && step.preUrl && step.postUrl && step.preUrl !== step.postUrl) {
        try {
          const prePath = new URL(step.preUrl).pathname;
          const postUrlObj = new URL(step.postUrl);
          const postPath = postUrlObj.pathname;

          if (postPath !== prePath && postPath !== '/') {
            if (postPath.includes('/accounts')) {
              postcondition = {
                description: 'Navigated to accounts page',
                condition: 'url_matches',
                expectedValue: '/accounts',
              };
            } else if (postPath.includes('/member')) {
              postcondition = {
                description: 'Navigated to member profile or error page',
                condition: 'url_matches',
                expectedValue: '/member',
              };
            } else {
              postcondition = {
                description: `Navigated to ${postPath}`,
                condition: 'url_matches',
                expectedValue: postPath,
              };
            }
          }
        } catch {
          // Ignore URL parsing errors on relative or malformed URLs
        }
      }

      return {
        index: idx,
        action: {
          ...step.action,
          value: actionValue,
          target: targetLocator,
        },
        precondition: step.precondition,
        postcondition,
        rationale: step.rationale ?? `Step ${idx}: execute ${step.action.type}`,
      };
    });
  }

  /**
   * Extract declared output parameters from verified outputs.
   */
  private extractOutputs(verifiedOutputs?: Record<string, unknown>): ArtifactOutput[] {
    if (!verifiedOutputs || Object.keys(verifiedOutputs).length === 0) {
      return [];
    }

    const outputs: ArtifactOutput[] = [];

    for (const [name, val] of Object.entries(verifiedOutputs)) {
      if (name === 'modelClaimed') continue; // internal verification metadata

      let locator: TargetLocator;
      if (this.options.outputLocators?.[name]) {
        locator = this.options.outputLocators[name];
      } else if (name === 'savingsBalance') {
        locator = {
          strategy: 'css',
          value: 'tr:nth-child(3) td:nth-child(3)',
        };
      } else {
        locator = {
          strategy: 'css',
          value: `[data-output="${name}"]`,
        };
      }

      outputs.push({
        name,
        description: `Extracted ${name}`,
        source: locator,
        type: typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string',
      });
    }

    return outputs;
  }

  private determineSuccessCondition(goal: Goal): Checkpoint {
    const desc = goal.description.toLowerCase();
    if (desc.includes('saving') || desc.includes('balance') || goal.targetApp === 'bank-ops') {
      return {
        description: 'Accounts page is displayed with savings balance',
        condition: 'page_contains_text',
        expectedValue: 'Savings',
      };
    }

    return {
      description: 'Page loaded successfully',
      condition: 'page_contains_text',
      expectedValue: 'Console',
    };
  }

  private determineBusinessOutcomes(goal: Goal): BusinessOutcome[] {
    const desc = goal.description.toLowerCase();
    if (desc.includes('member') || goal.targetApp === 'bank-ops') {
      return [
        {
          code: 'MEMBER_NOT_FOUND',
          description: 'Member not found in database',
          checkpoint: {
            description: 'Page displays not found message',
            condition: 'page_contains_text',
            expectedValue: 'No member found',
          },
        },
      ];
    }
    return [];
  }

  private deriveArtifactId(goal: Goal): string {
    const desc = goal.description.toLowerCase();
    if (desc.includes('member') && (desc.includes('saving') || desc.includes('balance'))) {
      return 'lookup-member-savings-balance';
    }

    // Generic slugify
    const slug = goal.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || `artifact-${Date.now()}`;
  }

  private deriveArtifactName(goal: Goal): string {
    const desc = goal.description.toLowerCase();
    if (desc.includes('member') && (desc.includes('saving') || desc.includes('balance'))) {
      return 'Lookup Member Savings Balance';
    }

    return goal.description
      .split(' ')
      .slice(0, 5)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
}
