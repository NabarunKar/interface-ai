import type { Action, TargetLocator } from '../domain/action.js';
import type { ArtifactInput, CapabilityArtifact, Checkpoint } from '../domain/artifact.js';

/**
 * Parameter interpolation contract for capability artifacts.
 *
 * Official syntax: {{parameterName}}
 *
 * Rules:
 * 1. parameterName must refer to a declared artifact input.
 * 2. Missing required parameters are rejected before any action executes.
 * 3. Unknown/undeclared placeholders are rejected.
 * 4. Extra invocation parameters are rejected.
 * 5. No expression evaluation.
 * 6. No arbitrary template language.
 * 7. Interpolation is simple deterministic substitution only.
 * 8. Supported in: action values including navigation URLs, locator.value,
 *    and checkpoint.expectedValue.
 * 9. locator.attributeName is intentionally literal. Attribute names identify
 *    page structure and should not vary per invocation parameter.
 * 10. Declared input types are validated before substitution.
 * 11. Secrets must not be persisted as part of the template itself.
 */

/** Regex to find all {{paramName}} placeholders */
const PLACEHOLDER_REGEX = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const PARAMETER_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Error thrown during parameter interpolation.
 */
export class InterpolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpolationError';
  }
}

/**
 * Validate that all required inputs are provided, no unknown
 * parameters are included, and types match declarations.
 *
 * Must be called before any interpolation or UI action execution.
 */
export function validateInputs(
  declaredInputs: ArtifactInput[],
  providedParams: Record<string, unknown>,
): void {
  const declaredNames = new Set(declaredInputs.map(i => i.name));
  const providedNames = new Set(Object.keys(providedParams));

  // Check for missing required parameters
  for (const input of declaredInputs) {
    if (input.required !== false && !providedNames.has(input.name)) {
      throw new InterpolationError(
        `Missing required parameter: '${input.name}'`
      );
    }
  }

  // Check for extra/unknown parameters
  for (const name of providedNames) {
    if (!declaredNames.has(name)) {
      throw new InterpolationError(
        `Unknown parameter: '${name}'. Declared inputs: [${[...declaredNames].join(', ')}]`
      );
    }
  }

  // Validate types
  for (const input of declaredInputs) {
    const value = providedParams[input.name];
    if (value === undefined) continue; // optional and not provided

    const actualType = typeof value;
    if (input.type === 'string' && actualType !== 'string') {
      throw new InterpolationError(
        `Parameter '${input.name}' expected type 'string', got '${actualType}'`
      );
    }
    if (input.type === 'number' && actualType !== 'number') {
      throw new InterpolationError(
        `Parameter '${input.name}' expected type 'number', got '${actualType}'`
      );
    }
    if (input.type === 'boolean' && actualType !== 'boolean') {
      throw new InterpolationError(
        `Parameter '${input.name}' expected type 'boolean', got '${actualType}'`
      );
    }
  }
}

/**
 * Validate placeholder syntax and declared input references in one string.
 */
export function validateTemplateString(
  template: string,
  declaredInputs: ArtifactInput[],
): void {
  const declaredNames = new Set(declaredInputs.map(i => i.name));
  const placeholders = extractPlaceholders(template);

  for (const name of placeholders) {
    if (!declaredNames.has(name)) {
      throw new InterpolationError(
        `Undeclared placeholder '{{${name}}}' in template. Declared inputs: [${[...declaredNames].join(', ')}]`
      );
    }
  }
}

/**
 * Interpolate all {{paramName}} placeholders in a string.
 *
 * Every placeholder must reference a declared input.
 * Every referenced input must have a provided value.
 * Substitution is simple string replacement — no expressions.
 */
export function interpolateString(
  template: string,
  declaredInputs: ArtifactInput[],
  params: Record<string, unknown>,
): string {
  validateTemplateString(template, declaredInputs);

  return template.replace(PLACEHOLDER_REGEX, (_match, paramName: string) => {
    const value = params[paramName];
    if (value === undefined) {
      throw new InterpolationError(
        `No value provided for placeholder '{{${paramName}}}'`
      );
    }
    return String(value);
  });
}

/**
 * Extract all placeholder names from a template string.
 * Returns unique names in order of first appearance.
 */
export function extractPlaceholders(template: string): string[] {
  assertValidPlaceholderSyntax(template);

  const names: string[] = [];
  let match;
  const regex = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  while ((match = regex.exec(template)) !== null) {
    if (!names.includes(match[1])) {
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * Validate every supported interpolatable field in an artifact.
 *
 * This is the pre-execution contract for future replay code: call this before
 * the first Surface action. If params are supplied, invocation inputs are also
 * validated for missing, extra, and incorrectly typed values.
 */
export function validateArtifactInterpolation(
  artifact: CapabilityArtifact,
  params?: Record<string, unknown>,
): void {
  if (params) {
    validateInputs(artifact.inputs, params);
  }

  for (const step of artifact.steps) {
    validateActionInterpolation(step.action, artifact.inputs, params);
    if (step.precondition) validateCheckpointInterpolation(step.precondition, artifact.inputs, params);
    if (step.postcondition) validateCheckpointInterpolation(step.postcondition, artifact.inputs, params);
  }

  validateCheckpointInterpolation(artifact.successCondition, artifact.inputs, params);

  for (const outcome of artifact.expectedBusinessOutcomes ?? []) {
    validateCheckpointInterpolation(outcome.checkpoint, artifact.inputs, params);
  }

  for (const output of artifact.outputs) {
    validateLocatorInterpolation(output.source, artifact.inputs, params);
  }
}

/**
 * Interpolate supported string fields in one action while preserving its shape.
 */
export function interpolateAction(
  action: Action,
  declaredInputs: ArtifactInput[],
  params: Record<string, unknown>,
): Action {
  return {
    ...action,
    value: action.value === undefined ? undefined : interpolateString(action.value, declaredInputs, params),
    target: action.target === undefined ? undefined : interpolateLocator(action.target, declaredInputs, params),
  };
}

function validateActionInterpolation(action: Action, declaredInputs: ArtifactInput[], params?: Record<string, unknown>): void {
  if (action.value !== undefined) validateInterpolatableString(action.value, declaredInputs, params);
  if (action.target !== undefined) validateLocatorInterpolation(action.target, declaredInputs, params);
}

function validateCheckpointInterpolation(checkpoint: Checkpoint, declaredInputs: ArtifactInput[], params?: Record<string, unknown>): void {
  if (checkpoint.expectedValue !== undefined) validateInterpolatableString(checkpoint.expectedValue, declaredInputs, params);
  if (checkpoint.target !== undefined) validateLocatorInterpolation(checkpoint.target, declaredInputs, params);
}

function validateLocatorInterpolation(locator: TargetLocator, declaredInputs: ArtifactInput[], params?: Record<string, unknown>): void {
  validateInterpolatableString(locator.value, declaredInputs, params);
  for (const fallback of locator.fallbacks ?? []) {
    validateInterpolatableString(fallback.value, declaredInputs, params);
  }
}

function validateInterpolatableString(
  template: string,
  declaredInputs: ArtifactInput[],
  params?: Record<string, unknown>,
): void {
  validateTemplateString(template, declaredInputs);
  if (!params) return;

  for (const name of extractPlaceholders(template)) {
    if (params[name] === undefined) {
      throw new InterpolationError(`No value provided for placeholder '{{${name}}}'`);
    }
  }
}

function interpolateLocator(
  locator: TargetLocator,
  declaredInputs: ArtifactInput[],
  params: Record<string, unknown>,
): TargetLocator {
  return {
    ...locator,
    value: interpolateString(locator.value, declaredInputs, params),
    fallbacks: locator.fallbacks?.map((fallback) => ({
      ...fallback,
      value: interpolateString(fallback.value, declaredInputs, params),
    })),
  };
}

function assertValidPlaceholderSyntax(template: string): void {
  let index = 0;

  while (index < template.length) {
    const open = template.indexOf('{{', index);
    const close = template.indexOf('}}', index);

    if (close !== -1 && (open === -1 || close < open)) {
      throw new InterpolationError(`Malformed placeholder syntax in template: '${template}'`);
    }

    if (open === -1) return;

    const end = template.indexOf('}}', open + 2);
    if (end === -1) {
      throw new InterpolationError(`Malformed placeholder syntax in template: '${template}'`);
    }

    const name = template.slice(open + 2, end);
    if (!PARAMETER_NAME_REGEX.test(name)) {
      throw new InterpolationError(`Malformed placeholder '{{${name}}}'. Expected syntax is '{{parameterName}}'`);
    }

    index = end + 2;
  }
}
