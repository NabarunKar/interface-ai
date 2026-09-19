import type { Surface } from '../surface/types.js';
import type { Checkpoint } from '../domain/artifact.js';

export interface CheckpointEvaluationResult {
  passed: boolean;
  reason?: string;
  expected?: string;
  observed?: string;
}

/**
 * Evaluates a Checkpoint condition against a Surface.
 *
 * Implements the domain Checkpoint conditions:
 * - element_visible: checks whether checkpoint.target is visible on the surface.
 * - element_contains_text: reads text from checkpoint.target and checks for expectedValue.
 * - url_matches: checks current page URL against expectedValue substring.
 * - page_contains_text: checks whether page body text contains expectedValue.
 */
export async function evaluateCheckpoint(
  surface: Surface,
  checkpoint: Checkpoint,
): Promise<CheckpointEvaluationResult> {
  const expected = checkpoint.expectedValue ?? '';

  switch (checkpoint.condition) {
    case 'element_visible': {
      if (!checkpoint.target) {
        return {
          passed: false,
          reason: 'element_visible checkpoint requires a target locator',
          expected: 'target locator defined',
          observed: 'undefined',
        };
      }
      try {
        const visible = await surface.isVisible(checkpoint.target);
        return {
          passed: visible,
          reason: visible
            ? `Element '${checkpoint.target.strategy}=${checkpoint.target.value}' is visible`
            : `Element '${checkpoint.target.strategy}=${checkpoint.target.value}' is not visible`,
          expected: 'visible',
          observed: visible ? 'visible' : 'not visible',
        };
      } catch (err) {
        return {
          passed: false,
          reason: `Error checking visibility: ${err instanceof Error ? err.message : String(err)}`,
          expected: 'visible',
          observed: 'error checking visibility',
        };
      }
    }

    case 'element_contains_text': {
      if (!checkpoint.target) {
        return {
          passed: false,
          reason: 'element_contains_text checkpoint requires a target locator',
          expected: 'target locator defined',
          observed: 'undefined',
        };
      }
      try {
        const text = await surface.read(checkpoint.target);
        const passed = text.includes(expected);
        return {
          passed,
          reason: passed
            ? `Element contains expected text '${expected}'`
            : `Element text '${text}' does not contain expected '${expected}'`,
          expected,
          observed: text,
        };
      } catch (err) {
        return {
          passed: false,
          reason: `Failed to read target element: ${err instanceof Error ? err.message : String(err)}`,
          expected,
          observed: 'element read failed',
        };
      }
    }

    case 'url_matches': {
      try {
        const currentUrl = await surface.currentUrl();
        const passed = currentUrl.includes(expected);
        return {
          passed,
          reason: passed
            ? `URL '${currentUrl}' matches expected '${expected}'`
            : `URL '${currentUrl}' does not match expected '${expected}'`,
          expected,
          observed: currentUrl,
        };
      } catch (err) {
        return {
          passed: false,
          reason: `Failed to get current URL: ${err instanceof Error ? err.message : String(err)}`,
          expected,
          observed: 'url retrieval failed',
        };
      }
    }

    case 'page_contains_text': {
      try {
        const pageText = await surface.pageText();
        const passed = pageText.includes(expected);
        return {
          passed,
          reason: passed
            ? `Page contains expected text '${expected}'`
            : `Page does not contain expected text '${expected}'`,
          expected,
          observed: pageText.slice(0, 200),
        };
      } catch (err) {
        return {
          passed: false,
          reason: `Failed to get page text: ${err instanceof Error ? err.message : String(err)}`,
          expected,
          observed: 'page text retrieval failed',
        };
      }
    }

    default: {
      const exhaustiveCheck: never = checkpoint.condition;
      return {
        passed: false,
        reason: `Unsupported checkpoint condition: ${String(exhaustiveCheck)}`,
      };
    }
  }
}
