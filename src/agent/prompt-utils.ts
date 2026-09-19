import type { ModelInput } from './types.js';

/**
 * Build the standardized user message content from a ModelInput.
 * Shared across provider implementations (Gemini, TAMU) to ensure
 * identical prompt representation of goals, observations, and decisions.
 */
export function buildModelUserMessage(input: ModelInput): string {
  const parts: string[] = [];

  parts.push(`GOAL: ${input.goal.description}`);
  parts.push(`ENTRY POINT: ${input.goal.entryPoint}`);

  if (input.goal.parameters && Object.keys(input.goal.parameters).length > 0) {
    parts.push(`PARAMETERS: ${JSON.stringify(input.goal.parameters)}`);
  }

  parts.push(`\nSTEP: ${input.stepIndex + 1} of ${input.stepIndex + input.stepsRemaining}`);
  parts.push(`STEPS REMAINING: ${input.stepsRemaining}`);

  parts.push(`\nCURRENT OBSERVATION:`);
  parts.push(`URL: ${input.observation.url}`);
  if (input.observation.title) {
    parts.push(`PAGE TITLE: ${input.observation.title}`);
  }
  if (input.observation.visibleText) {
    parts.push(`VISIBLE TEXT:\n${input.observation.visibleText}`);
  }
  if (input.observation.elements && input.observation.elements.length > 0) {
    parts.push(`\nINTERACTIVE ELEMENTS:`);
    for (const el of input.observation.elements) {
      const attrs = el.attributes ? ` ${JSON.stringify(el.attributes)}` : '';
      const text = el.text ? ` "${el.text}"` : '';
      const state = [
        el.visible === false ? 'hidden' : null,
        el.enabled === false ? 'disabled' : null,
      ].filter(Boolean).join(', ');
      const stateStr = state ? ` [${state}]` : '';
      parts.push(`  <${el.tag}${text}${attrs}${stateStr}>`);
    }
  }

  if (input.previousDecisions && input.previousDecisions.length > 0) {
    const recent = input.previousDecisions.slice(-3);
    parts.push(`\nRECENT DECISIONS:`);
    for (const d of recent) {
      parts.push(`  ${JSON.stringify(d)}`);
    }
  }

  return parts.join('\n');
}
