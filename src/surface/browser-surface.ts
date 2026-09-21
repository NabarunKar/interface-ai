import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Surface, WaitOptions, SurfaceFactory, SurfaceCreateOptions } from './types.js';
import type { TargetLocator } from '../domain/action.js';
import type { Observation, PageElement } from '../domain/observation.js';

const DEFAULT_TIMEOUT_MS = 5000;
const OBSERVATION_TEXT_LIMIT = 8000;
const OBSERVATION_ELEMENT_LIMIT = 50;

interface BrowserSurfaceOptions extends SurfaceCreateOptions {
  page?: Page;
}

interface ResolvedLocator {
  locator?: Locator;
  coordinates?: { x: number; y: number };
  source: TargetLocator;
}

export class BrowserSurfaceError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly target?: TargetLocator,
    public readonly currentUrl?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BrowserSurfaceError';
  }
}

export class LocatorNotFoundError extends BrowserSurfaceError {
  constructor(operation: string, target: TargetLocator, currentUrl?: string, cause?: unknown) {
    super(`Unable to resolve locator for ${operation}: ${describeLocator(target)}`, operation, target, currentUrl, cause);
    this.name = 'LocatorNotFoundError';
  }
}

export class NavigationError extends BrowserSurfaceError {
  constructor(url: string, currentUrl?: string, cause?: unknown) {
    super(`Navigation failed for '${url}' from '${currentUrl ?? 'unknown'}'`, 'navigate', undefined, currentUrl, cause);
    this.name = 'NavigationError';
  }
}

export class BrowserClosedError extends Error {
  constructor() {
    super('BrowserSurface is closed');
    this.name = 'BrowserClosedError';
  }
}

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
  readonly sessionId: string;
  private readonly page: Page;
  private readonly context?: BrowserContext;
  private readonly browser?: Browser;
  private closed = false;

  constructor(page: Page, context?: BrowserContext, browser?: Browser, sessionId?: string) {
    this.sessionId = sessionId ?? randomUUID();
    this.page = page;
    this.context = context;
    this.browser = browser;
  }

  /**
   * Test/debug accessor for verifying underlying Playwright Page object identity.
   * This is a concrete implementation detail and is NOT part of the technology-neutral Surface interface.
   */
  getDebugPage(): Page {
    return this.page;
  }

  static async create(options: BrowserSurfaceOptions = {}): Promise<BrowserSurface> {
    if (options.page) {
      return new BrowserSurface(options.page);
    }

    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      viewport: {
        width: options.viewportWidth ?? 1280,
        height: options.viewportHeight ?? 720,
      },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
    return new BrowserSurface(page, context, browser);
  }

  async observe(): Promise<Observation> {
    this.assertOpen();
    try {
      const [title, visibleText, elements] = await Promise.all([
        this.page.title(),
        this.page.locator('body').innerText({ timeout: DEFAULT_TIMEOUT_MS }).catch(() => ''),
        this.extractElements(),
      ]);

      return {
        url: this.page.url(),
        title: title || undefined,
        visibleText: truncate(visibleText, OBSERVATION_TEXT_LIMIT),
        elements,
        timestamp: new Date().toISOString(),
      };
    } catch (cause) {
      throw new BrowserSurfaceError('Failed to observe browser page', 'observe', undefined, this.page.url(), cause);
    }
  }

  async click(target: TargetLocator): Promise<void> {
    this.assertOpen();
    try {
      const resolved = await this.resolveUsableTarget(target, 'click');
      if (resolved.coordinates) {
        await this.page.mouse.click(resolved.coordinates.x, resolved.coordinates.y);
        return;
      }
      await resolved.locator!.click({ timeout: DEFAULT_TIMEOUT_MS });
    } catch (cause) {
      if (cause instanceof BrowserSurfaceError) throw cause;
      throw new BrowserSurfaceError(`Click failed for ${describeLocator(target)}`, 'click', target, this.page.url(), cause);
    }
  }

  async type(target: TargetLocator, value: string): Promise<void> {
    this.assertOpen();
    try {
      const resolved = await this.resolveUsableTarget(target, 'type');
      if (resolved.coordinates) {
        await this.page.mouse.click(resolved.coordinates.x, resolved.coordinates.y);
        await this.page.keyboard.insertText(value);
        return;
      }
      await resolved.locator!.fill(value, { timeout: DEFAULT_TIMEOUT_MS });
    } catch (cause) {
      if (cause instanceof BrowserSurfaceError) throw cause;
      throw new BrowserSurfaceError(`Type failed for ${describeLocator(target)}`, 'type', target, this.page.url(), cause);
    }
  }

  async read(target: TargetLocator): Promise<string> {
    this.assertOpen();
    try {
      const resolved = await this.resolveExistingTarget(target, 'read');
      if (resolved.coordinates) {
        throw new BrowserSurfaceError('Cannot read text directly from coordinate locator', 'read', target, this.page.url());
      }

      const locator = resolved.locator!;
      const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
        return await locator.inputValue({ timeout: DEFAULT_TIMEOUT_MS });
      }

      const text = await locator.innerText({ timeout: DEFAULT_TIMEOUT_MS }).catch(async () => await locator.textContent({ timeout: DEFAULT_TIMEOUT_MS }));
      return text?.trim() ?? '';
    } catch (cause) {
      if (cause instanceof BrowserSurfaceError) throw cause;
      throw new BrowserSurfaceError(`Read failed for ${describeLocator(target)}`, 'read', target, this.page.url(), cause);
    }
  }

  async navigate(url: string): Promise<void> {
    this.assertOpen();
    const currentUrl = this.page.url();
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS });
    } catch (cause) {
      throw new NavigationError(url, currentUrl, cause);
    }
  }

  async wait(options: WaitOptions): Promise<void> {
    this.assertOpen();
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      if (options.durationMs !== undefined) {
        await this.page.waitForTimeout(options.durationMs);
      }
      if (options.text !== undefined) {
        await this.page.getByText(options.text).first().waitFor({ state: 'visible', timeout });
      }
      if (options.target !== undefined) {
        const resolved = await this.resolveExistingTarget(options.target, 'wait');
        if (resolved.locator) {
          await resolved.locator.waitFor({ state: 'visible', timeout });
        }
      }
    } catch (cause) {
      throw new BrowserSurfaceError('Wait failed', 'wait', options.target, this.page.url(), cause);
    }
  }

  async screenshot(pathArg?: string): Promise<string> {
    this.assertOpen();
    const screenshotPath = pathArg ?? path.join(process.cwd(), 'evidence', `screenshot-${Date.now()}.png`);
    try {
      await mkdir(path.dirname(screenshotPath), { recursive: true });
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      return screenshotPath;
    } catch (cause) {
      throw new BrowserSurfaceError(`Screenshot failed for '${screenshotPath}'`, 'screenshot', undefined, this.page.url(), cause);
    }
  }

  async currentUrl(): Promise<string> {
    this.assertOpen();
    return this.page.url();
  }

  async isVisible(target: TargetLocator): Promise<boolean> {
    this.assertOpen();
    try {
      const resolved = await this.resolveExistingTarget(target, 'isVisible');
      if (resolved.coordinates) {
        return true;
      }
      return await resolved.locator!.isVisible({ timeout: DEFAULT_TIMEOUT_MS });
    } catch (cause) {
      if (cause instanceof LocatorNotFoundError) return false;
      throw new BrowserSurfaceError(`Visibility check failed for ${describeLocator(target)}`, 'isVisible', target, this.page.url(), cause);
    }
  }

  async pageText(): Promise<string> {
    this.assertOpen();
    try {
      return await this.page.locator('body').innerText({ timeout: DEFAULT_TIMEOUT_MS });
    } catch (cause) {
      throw new BrowserSurfaceError('Failed to read page text', 'pageText', undefined, this.page.url(), cause);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.page.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new BrowserClosedError();
    }
  }

  private async resolveUsableTarget(target: TargetLocator, operation: string): Promise<ResolvedLocator> {
    const resolved = await this.resolveExistingTarget(target, operation);
    if (resolved.coordinates) return resolved;

    const locator = resolved.locator!;
    const visible = await locator.isVisible({ timeout: DEFAULT_TIMEOUT_MS });
    const enabled = await locator.isEnabled({ timeout: DEFAULT_TIMEOUT_MS }).catch(() => true);
    if (!visible || !enabled) {
      throw new BrowserSurfaceError(
        `Resolved locator is not usable for ${operation}: ${describeLocator(resolved.source)} (visible=${visible}, enabled=${enabled})`,
        operation,
        resolved.source,
        this.page.url(),
      );
    }
    return resolved;
  }

  private async resolveExistingTarget(target: TargetLocator, operation: string): Promise<ResolvedLocator> {
    const candidates = [target, ...(target.fallbacks ?? [])];
    const failures: string[] = [];

    for (const candidate of candidates) {
      if (candidate.strategy === 'coordinates') {
        const coordinates = parseCoordinates(candidate.value);
        if (coordinates) return { coordinates, source: candidate };
        failures.push(`${describeLocator(candidate)}: invalid coordinate format`);
        continue;
      }

      if (candidate.strategy === 'text') {
        const textLocator = await this.resolveTextTarget(candidate);
        if (textLocator) {
          return { locator: textLocator, source: candidate };
        }
        failures.push(`${describeLocator(candidate)}: not found`);
        continue;
      }

      const locator = this.locatorFor(candidate).first();
      const count = await locator.count().catch((error: unknown) => {
        failures.push(`${describeLocator(candidate)}: ${stringifyError(error)}`);
        return 0;
      });

      if (count > 0) {
        return { locator, source: candidate };
      }

      failures.push(`${describeLocator(candidate)}: not found`);
    }

    throw new LocatorNotFoundError(operation, target, this.page.url(), failures.join('; '));
  }

  private locatorFor(target: TargetLocator): Locator {
    switch (target.strategy) {
      case 'role': {
        const parsed = parseRoleLocator(target.value);
        return parsed.name === undefined
          ? this.page.getByRole(parsed.role as never)
          : this.page.getByRole(parsed.role as never, { name: parsed.name });
      }
      case 'label':
        return this.page.getByLabel(target.value);
      case 'text':
        return this.page.getByText(target.value);
      case 'attribute':
        if (!target.attributeName) {
          throw new LocatorNotFoundError('resolve', target, this.page.url(), 'attributeName is required');
        }
        assertSafeAttributeName(target.attributeName, target);
        return this.page.locator(`[${target.attributeName}=${JSON.stringify(target.value)}]`);
      case 'css':
        return this.page.locator(target.value);
      case 'coordinates':
        throw new LocatorNotFoundError('resolve', target, this.page.url(), 'coordinates are handled outside locatorFor');
    }
  }

  private async resolveTextTarget(target: TargetLocator): Promise<Locator | undefined> {
    const candidates = [
      this.page.getByRole('button', { name: target.value, exact: false }),
      this.page.getByRole('link', { name: target.value, exact: false }),
      this.page.getByText(target.value, { exact: true }),
      this.page.getByText(target.value),
    ];

    for (const locator of candidates) {
      if (await locator.first().count().catch(() => 0) > 0) {
        return locator.first();
      }
    }

    return undefined;
  }

  private async extractElements(): Promise<PageElement[]> {
    return await this.page.evaluate((limit) => {
      const selectors = [
        'a',
        'button',
        'input',
        'select',
        'textarea',
        '[role]',
        '[tabindex]',
      ];

      const elements = Array.from(document.querySelectorAll<HTMLElement>(selectors.join(',')));

      return elements.slice(0, limit).map((element) => {
        const attributes: Record<string, string> = {};
        for (const attr of ['id', 'name', 'class', 'type', 'href', 'aria-label', 'role', 'placeholder']) {
          const value = element.getAttribute(attr);
          if (value) attributes[attr] = value;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;

        return {
          tag: element.getAttribute('role') || element.tagName.toLowerCase(),
          text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('value') || '').trim() || undefined,
          attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
          visible,
          enabled: !('disabled' in element) || !(element as HTMLButtonElement | HTMLInputElement).disabled,
        };
      });
    }, OBSERVATION_ELEMENT_LIMIT);
  }
}

/**
 * Factory for creating BrowserSurface instances.
 * Phase 1 will launch Playwright browser and create pages.
 */
export class BrowserSurfaceFactory implements SurfaceFactory {
  async create(options: SurfaceCreateOptions): Promise<Surface> {
    return BrowserSurface.create(options);
  }
}

function parseRoleLocator(value: string): { role: string; name?: string | RegExp } {
  const match = value.match(/^([A-Za-z0-9_-]+)(?:\[name=(['"])(.*?)\2\])?$/);
  if (!match) {
    return { role: value };
  }
  return { role: match[1], name: match[3] };
}

function parseCoordinates(value: string): { x: number; y: number } | undefined {
  const json = parseJsonCoordinates(value);
  if (json) return json;

  const pair = value.match(/^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/);
  if (!pair) return undefined;
  return { x: Number(pair[1]), y: Number(pair[2]) };
}

function parseJsonCoordinates(value: string): { x: number; y: number } | undefined {
  try {
    const parsed = JSON.parse(value) as { x?: unknown; y?: unknown };
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // Not JSON; caller will try comma-separated format.
  }
  return undefined;
}

function assertSafeAttributeName(attributeName: string, target: TargetLocator): void {
  if (!/^[A-Za-z_][A-Za-z0-9_:-]*$/.test(attributeName)) {
    throw new LocatorNotFoundError('resolve', target, undefined, `Invalid attributeName '${attributeName}'`);
  }
}

function describeLocator(target: TargetLocator): string {
  const attribute = target.attributeName ? `, attributeName=${target.attributeName}` : '';
  return `{ strategy=${target.strategy}, value=${target.value}${attribute} }`;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
