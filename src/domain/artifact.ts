import { z } from 'zod';
import { ActionSchema } from './action.js';
import { TargetLocatorSchema } from './action.js';

/**
 * An input parameter declaration for a capability artifact.
 */
export const ArtifactInputSchema = z.object({
  /** Parameter name (used in step value interpolation) */
  name: z.string().min(1),
  /** Human-readable description */
  description: z.string().optional(),
  /** Expected type */
  type: z.enum(['string', 'number', 'boolean']),
  /** Whether this parameter is required */
  required: z.boolean().default(true),
  /** Example value for documentation */
  example: z.unknown().optional(),
});

export type ArtifactInput = z.infer<typeof ArtifactInputSchema>;

/**
 * An output declaration — data to extract from the surface.
 */
export const ArtifactOutputSchema = z.object({
  /** Output field name */
  name: z.string().min(1),
  /** Description of what this output represents */
  description: z.string().optional(),
  /** Locator for the element to read the value from */
  source: TargetLocatorSchema,
  /** Expected type of the extracted value */
  type: z.enum(['string', 'number', 'boolean']),
});

export type ArtifactOutput = z.infer<typeof ArtifactOutputSchema>;

/**
 * A checkpoint / success condition.
 */
export const CheckpointSchema = z.object({
  /** Description of what this checkpoint verifies */
  description: z.string(),
  /** Locator for the element to check */
  target: TargetLocatorSchema.optional(),
  /** Expected condition */
  condition: z.enum([
    'element_visible',
    'element_contains_text',
    'url_matches',
    'page_contains_text',
  ]),
  /** Expected value (text to match, URL pattern, etc.) */
  expectedValue: z.string().optional(),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

/**
 * A step in the capability artifact.
 * Extends Action with artifact-specific metadata.
 */
export const ArtifactStepSchema = z.object({
  /** Step index (0-based) */
  index: z.number().int().nonnegative(),
  /** The action to perform */
  action: ActionSchema,
  /** Pre-condition checkpoint (verify state before acting) */
  precondition: CheckpointSchema.optional(),
  /** Post-condition checkpoint (verify state after acting) */
  postcondition: CheckpointSchema.optional(),
  /** Human-readable rationale for this step */
  rationale: z.string().optional(),
});

export type ArtifactStep = z.infer<typeof ArtifactStepSchema>;

/**
 * The capability artifact — the central reusable unit.
 *
 * This is what gets recorded from a discovery run and
 * replayed deterministically in production.
 */
export const CapabilityArtifactSchema = z.object({
  /** Unique artifact identifier */
  id: z.string().min(1),
  /** Human-readable name for this capability */
  name: z.string().min(1),
  /** What this capability does */
  description: z.string(),
  /** Semantic version */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** Target application identifier */
  targetApp: z.string().min(1),
  /** Surface type this was recorded against */
  surfaceType: z.enum(['web', 'legacy-web', 'desktop']),
  /** Entry point URL or application path */
  entryPoint: z.string(),
  /** Declared input parameters */
  inputs: z.array(ArtifactInputSchema),
  /** Ordered steps to execute */
  steps: z.array(ArtifactStepSchema).min(1),
  /** Declared outputs to extract */
  outputs: z.array(ArtifactOutputSchema),
  /** Final success checkpoint */
  successCondition: CheckpointSchema,
  /** Policy metadata — which safety constraints apply */
  policyConstraints: z.object({
    /** Allowed domains/routes */
    allowedDomains: z.array(z.string()).optional(),
    /** Whether this artifact performs any write/mutating operations */
    readOnly: z.boolean().default(true),
    /** Maximum execution time in ms */
    maxDurationMs: z.number().positive().optional(),
  }).optional(),
  /** ISO datetime when this artifact was created */
  createdAt: z.string().datetime(),
  /** ISO datetime when this artifact was last modified */
  updatedAt: z.string().datetime(),
  /** ID of the discovery run that produced this artifact */
  sourceRunId: z.string().optional(),
  /** Tenant-specific overrides key (for multi-tenant reuse) */
  tenantOverrideKey: z.string().optional(),
});

export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
