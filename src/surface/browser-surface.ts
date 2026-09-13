import type { Surface, WaitOptions, SurfaceFactory, SurfaceCreateOptions } from './types.js';
import type { TargetLocator } from '../domain/action.js';
import type { Observation } from '../domain/observation.js';

/**
 * Browser-based Surface implementation using Playwright.
 *
 * Phase 0: Interface and structure are defined.
 * The actual Playwright integration will be implemented in Phase 1.
 *
 * This adapter translates the technology-neutral Surface interface
 * into Playwright-specific calls.
 */
export class BrowserSurface implements Surface {
  private page: unknown; // Will be Playwright Page in Phase 1
  private closed = false;

  constructor(page: unknown) {
    this.page = page;
  }

  async observe(): Promise<Observation> {
    this.assertOpen();
    // Phase 1: Extract observation from Playwright page
    throw new Error('BrowserSurface.observe() not yet implemented — Phase 1');
  }

  async click(target: TargetLocator): Promise<void> {
    this.assertOpen();
    // Phase 1: Resolve locator and click
    throw new Error('BrowserSurface.click() not yet implemented — Phase 1');
  }

  async type(target: TargetLocator, value: string): Promise<void> {
    this.assertOpen();
    // Phase 1: Resolve locator and type
    throw new Error('BrowserSurface.type() not yet implemented — Phase 1');
  }

  async read(target: TargetLocator): Promise<string> {
    this.assertOpen();
    // Phase 1: Resolve locator and read text content
    throw new Error('BrowserSurface.read() not yet implemented — Phase 1');
  }

  async navigate(url: string): Promise<void> {
    this.assertOpen();
    // Phase 1: Navigate via Playwright
    throw new Error('BrowserSurface.navigate() not yet implemented — Phase 1');
  }

  async wait(_options: WaitOptions): Promise<void> {
    this.assertOpen();
    // Phase 1: Wait using Playwright's built-in waiting
    throw new Error('BrowserSurface.wait() not yet implemented — Phase 1');
  }

  async screenshot(_path?: string): Promise<string> {
    this.assertOpen();
    // Phase 1: Take screenshot via Playwright
    throw new Error('BrowserSurface.screenshot() not yet implemented — Phase 1');
  }

  async currentUrl(): Promise<string> {
    this.assertOpen();
    throw new Error('BrowserSurface.currentUrl() not yet implemented — Phase 1');
  }

  async isVisible(_target: TargetLocator): Promise<boolean> {
    this.assertOpen();
    throw new Error('BrowserSurface.isVisible() not yet implemented — Phase 1');
  }

  async pageText(): Promise<string> {
    this.assertOpen();
    throw new Error('BrowserSurface.pageText() not yet implemented — Phase 1');
  }

  async close(): Promise<void> {
    this.closed = true;
    // Phase 1: Close browser context
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Surface is closed');
    }
  }
}

/**
 * Factory for creating BrowserSurface instances.
 * Phase 1 will launch Playwright browser and create pages.
 */
export class BrowserSurfaceFactory implements SurfaceFactory {
  async create(_options: SurfaceCreateOptions): Promise<Surface> {
    // Phase 1: Launch Playwright browser, create context and page
    throw new Error('BrowserSurfaceFactory.create() not yet implemented — Phase 1');
  }
}
