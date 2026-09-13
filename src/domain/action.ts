import { z } from 'zod';

/**
 * Locator strategies for identifying UI elements.
 * Designed to support robust element targeting that works
 * across legacy and modern web surfaces.
 */
export const LocatorStrategySchema = z.enum([
  'role',       // ARIA role + accessible name
  'label',      // form label association
  'text',       // visible text content
  'attribute',  // arbitrary HTML attribute
  'css',        // CSS selector
  'coordinates', // absolute screen coordinates (last resort)
]);

export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

/**
 * A target element locator. Supports multiple strategies
 * for robustness — primary is preferred, fallbacks are tried in order.
 */
export const TargetLocatorSchema = z.object({
  /** Primary locator strategy */
  strategy: LocatorStrategySchema,
  /** The value for the primary strategy (e.g., CSS selector string, role name, etc.) */
  value: z.string(),
  /** Human-readable description of what this element is */
  description: z.string().optional(),
  /** Optional fallback locators tried in order if primary fails */
  fallbacks: z.array(
    z.object({
      strategy: LocatorStrategySchema,
      value: z.string(),
    })
  ).optional(),
});

export type TargetLocator = z.infer<typeof TargetLocatorSchema>;

/**
 * The types of actions the automation system can perform.
 */
export const ActionTypeSchema = z.enum([
  'navigate',
  'click',
  'type',
  'read',
  'wait',
  'screenshot',
]);

export type ActionType = z.infer<typeof ActionTypeSchema>;

/**
 * A single action the system performs on the surface.
 */
export const ActionSchema = z.object({
  /** Type of action */
  type: ActionTypeSchema,
  /** Target element (not required for navigate, screenshot, some waits) */
  target: TargetLocatorSchema.optional(),
  /** Value for the action (URL for navigate, text for type, etc.) */
  value: z.string().optional(),
  /** Step description for evidence/debugging */
  description: z.string().optional(),
  /** Timeout in milliseconds for this specific action */
  timeoutMs: z.number().positive().optional(),
});

export type Action = z.infer<typeof ActionSchema>;
