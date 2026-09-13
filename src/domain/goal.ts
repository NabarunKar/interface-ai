import { z } from 'zod';

/**
 * A Goal represents a natural-language objective for the automation system.
 */
export const GoalSchema = z.object({
  /** Unique identifier for this goal instance */
  id: z.string().min(1),
  /** Natural language description of what to accomplish */
  description: z.string().min(1),
  /** Target application identifier (e.g., 'bank-ops') */
  targetApp: z.string().min(1),
  /** Entry point URL or application path */
  entryPoint: z.string().url(),
  /** Input parameters the goal requires */
  parameters: z.record(z.string(), z.unknown()).optional(),
  /** Maximum number of steps before timeout */
  maxSteps: z.number().positive().int().optional(),
  /** Maximum time in ms before timeout */
  timeoutMs: z.number().positive().optional(),
});

export type Goal = z.infer<typeof GoalSchema>;
