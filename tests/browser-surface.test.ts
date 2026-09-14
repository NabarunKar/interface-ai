import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { createApp } from '../apps/bank-ops/src/server.js';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import type { Surface } from '../src/surface/types.js';

let server: http.Server;
let baseUrl: string;
let surface: Surface | undefined;

function activeSurface(): Surface {
  if (!surface) throw new Error('BrowserSurface was not initialized');
  return surface;
}

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  surface = await BrowserSurface.create({ headless: true });
});

afterEach(async () => {
  await surface?.close();
  surface = undefined;
});

describe('BrowserSurface integration', () => {
  it('should navigate to and observe the search page', async () => {
    const browser = activeSurface();
    await browser.navigate(baseUrl);
    const observation = await browser.observe();

    expect(observation.url).toBe(`${baseUrl}/`);
    expect(observation.title).toBe('Bank Operations Console');
    expect(observation.visibleText).toContain('MEMBER SEARCH');
    expect(observation.elements?.some((element) => element.tag === 'input' && element.attributes?.name === 'id')).toBe(true);
    expect(observation.elements?.some((element) => element.tag === 'button' && element.text === 'SEARCH')).toBe(true);
    expect(observation.elements?.some((element) => element.visible === true && element.enabled === true)).toBe(true);
  });

  it('should search for member 10234 using type and click', async () => {
    const browser = activeSurface();
    await browser.navigate(baseUrl);
    await browser.type({ strategy: 'label', value: 'Member ID:' }, '10234');
    await browser.click({ strategy: 'text', value: 'SEARCH' });
    await browser.wait({ text: 'MEMBER INFORMATION' });

    const text = await browser.pageText();
    expect(text).toContain('Jane Doe');
    expect(text).toContain('10234');
    expect(text).toContain('Active');
  });

  it('should view accounts and read the savings balance', async () => {
    const browser = activeSurface();
    await browser.navigate(`${baseUrl}/member?id=10234`);
    await browser.click({ strategy: 'text', value: 'View Accounts' });
    await browser.wait({ text: 'ACCOUNTS' });

    const balance = await browser.read({ strategy: 'css', value: 'tr:has-text("Savings") td:nth-child(3)' });
    expect(balance).toBe('$8,920.14');
  });

  it('should observe member-not-found state', async () => {
    const browser = activeSurface();
    await browser.navigate(baseUrl);
    await browser.type({ strategy: 'label', value: 'Member ID:' }, '99999');
    await browser.click({ strategy: 'role', value: "button[name='SEARCH']" });
    await browser.wait({ text: 'No member found with ID: 99999' });

    const observation = await browser.observe();
    expect(observation.visibleText).toContain('No member found with ID: 99999');
  });

  it('should observe validation-error state for invalid ID', async () => {
    const browser = activeSurface();
    await browser.navigate(baseUrl);
    await browser.type({ strategy: 'label', value: 'Member ID:' }, 'abc');
    await browser.click({ strategy: 'text', value: 'SEARCH' });
    await browser.wait({ text: 'VALIDATION ERROR' });

    const observation = await browser.observe();
    expect(observation.visibleText).toContain('VALIDATION ERROR');
    expect(observation.visibleText).toContain('Invalid Member ID format');
  });

  it('should use fallback locator when the primary locator is unavailable', async () => {
    const browser = activeSurface();
    await browser.navigate(baseUrl);
    await browser.type({ strategy: 'label', value: 'Member ID:' }, '10234');
    await browser.click({
      strategy: 'css',
      value: '#missing-search-button',
      fallbacks: [{ strategy: 'text', value: 'SEARCH' }],
    });
    await browser.wait({ text: 'MEMBER INFORMATION' });

    const text = await browser.pageText();
    expect(text).toContain('Jane Doe');
  });

  it('should create a screenshot file', async () => {
    const browser = activeSurface();
    await browser.navigate(baseUrl);
    const screenshotPath = path.join(os.tmpdir(), `browser-surface-${Date.now()}.png`);
    const result = await browser.screenshot(screenshotPath);

    expect(result).toBe(screenshotPath);
    await expect(access(screenshotPath)).resolves.toBeUndefined();
  });
});
