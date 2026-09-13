import { z } from 'zod';

/**
 * A normalized representation of what the agent can observe
 * from the surface at a point in time.
 */
export const PageElementSchema = z.object({
  /** Element tag or role */
  tag: z.string(),
  /** Visible text content */
  text: z.string().optional(),
  /** Key attributes (id, name, class, aria-label, etc.) */
  attributes: z.record(z.string(), z.string()).optional(),
  /** Whether the element is visible / interactable */
  visible: z.boolean().optional(),
  /** Whether the element is enabled */
  enabled: z.boolean().optional(),
});

export type PageElement = z.infer<typeof PageElementSchema>;

export const ObservationSchema = z.object({
  /** Current page URL */
  url: z.string(),
  /** Page title */
  title: z.string().optional(),
  /** Visible text content on the page (may be truncated) */
  visibleText: z.string().optional(),
  /** Key interactive elements found on the page */
  elements: z.array(PageElementSchema).optional(),
  /** Timestamp of the observation */
  timestamp: z.string().datetime(),
  /** Optional screenshot path or base64 (not stored inline in artifacts) */
  screenshotRef: z.string().optional(),
});

export type Observation = z.infer<typeof ObservationSchema>;
