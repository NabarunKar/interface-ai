import type { TargetLocator } from '../domain/action.js';
import type { Observation } from '../domain/observation.js';

/**
 * Technology-neutral interface for a computer-use surface.
 *
 * This is the critical architectural seam between the automation logic
 * and the underlying UI technology (browser, desktop, etc.).
 *
 * The domain layer and replay engine interact ONLY through this interface.
 * Implementations handle the technology-specific details.
 */
export interface Surface {
  /** Get the current observation from the surface */
  observe(): Promise<Observation>;

  /** Click on a target element */
  click(target: TargetLocator): Promise<void>;

  /** Type text into a target element */
  type(target: TargetLocator, value: string): Promise<void>;

  /** Read text content from a target element */
  read(target: TargetLocator): Promise<string>;

  /** Navigate to a URL */
  navigate(url: string): Promise<void>;

  /** Wait for a condition or fixed duration */
  wait(options: WaitOptions): Promise<void>;

  /** Take a screenshot, returns a reference (path or base64) */
  screenshot(path?: string): Promise<string>;

  /** Get the current page URL */
  currentUrl(): Promise<string>;

  /** Check if an element matching the locator exists and is visible */
  isVisible(target: TargetLocator): Promise<boolean>;

  /** Get the text content of the entire page or a region */
  pageText(): Promise<string>;

  /** Close / cleanup the surface */
  close(): Promise<void>;
}

export interface WaitOptions {
  /** Wait for a specific element to appear */
  target?: TargetLocator;
  /** Wait for specific text to appear on the page */
  text?: string;
  /** Wait for a fixed duration in ms */
  durationMs?: number;
  /** Maximum wait time in ms (default 5000) */
  timeoutMs?: number;
}

/**
 * Factory for creating surface instances.
 * Different surface types (web, desktop) provide different factories.
 */
export interface SurfaceFactory {
  create(options: SurfaceCreateOptions): Promise<Surface>;
}

export interface SurfaceCreateOptions {
  /** Whether to run in headless mode (browser surfaces) */
  headless?: boolean;
  /** Initial viewport width */
  viewportWidth?: number;
  /** Initial viewport height */
  viewportHeight?: number;
}
