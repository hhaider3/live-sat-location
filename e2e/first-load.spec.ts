// Runs the built app in a real browser against the real Worker's static assets.
// Orbital API responses are mocked, so these tests need no upstream data source.
import { expect, test, type Page, type Route } from '@playwright/test';
import { issOmm } from '../tests/fixtures';
import { ACTIVE_SOURCE, SNAPSHOT_PATH } from '../shared/snapshot';

const records = (count: number) => Array.from({ length: count }, (_, i) => ({
  ...issOmm, EPOCH: new Date().toISOString(),
  OBJECT_NAME: i ? `TEST ${i}` : issOmm.OBJECT_NAME,
  NORAD_CAT_ID: i ? 200000 + i : issOmm.NORAD_CAT_ID,
  MEAN_ANOMALY: i * 0.2,
}));
const json = (route: Route, body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body),
  headers: { 'X-Fetched-At': new Date().toISOString(), 'X-Served-Stale': '0' } });
const summary = (page: Page) => page.locator('.catalog-summary');

declare global {
  interface Window { snapshots: number; hiddenUploads: number }
}

/** Counts completed position snapshots and position buffers uploaded with every dot hidden. */
function instrument() {
  window.snapshots = 0;
  window.hiddenUploads = 0;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener('message', event => { if (event.data?.groups?.length) window.snapshots++; });
    }
  };
  const bufferData = WebGL2RenderingContext.prototype.bufferData as (...args: unknown[]) => void;
  WebGL2RenderingContext.prototype.bufferData = function (this: WebGL2RenderingContext, ...args: unknown[]) {
    const data = args[1];
    if (data instanceof Float32Array && data.length && data.every(value => value === 1e6)) window.hiddenUploads++;
    return bufferData.apply(this, args);
  } as typeof WebGL2RenderingContext.prototype.bufferData;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(instrument);
  // Anything a test does not mock fails, as it would during an outage.
  await page.route('**/api/**', route => route.fulfill({ status: 404, body: 'not mocked' }));
  await page.route('**/api/omm?group=stations', route => json(route, records(1)));
});

test('a healthy first visit downloads the catalog once and runs under the security policy', async ({ page }) => {
  const violations: string[] = [];
  page.on('pageerror', error => violations.push(error.message));
  page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) violations.push(message.text()); });
  let snapshotRequests = 0;
  page.on('request', request => { if (request.url().endsWith(SNAPSHOT_PATH)) snapshotRequests++; });
  await page.route('**/api/omm?group=active', route => json(route, records(500)));

  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("default-src 'none'");
  await expect(summary(page)).toContainText('500 fresh');
  await page.waitForFunction(() => window.snapshots > 0);
  await page.getByRole('button', { name: 'Find ISS' }).click();
  await expect(page.locator('.selection-subtitle')).toContainText('#25544');
  await expect.poll(() => page.evaluate(() => {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return entries.find(entry => entry.name.endsWith('/assets/earth-blue-marble.jpg'))?.responseStatus;
  })).toBe(200);
  expect(snapshotRequests).toBe(0);
  expect(violations).toEqual([]);
});

test('a failing API falls back to the site-hosted catalog', async ({ page }) => {
  await page.route('**/api/omm?group=active', route => route.fulfill({ status: 500, body: 'down' }));
  await page.route(`**${SNAPSHOT_PATH}`, route => json(route, {
    version: 1, source: ACTIVE_SOURCE, fetchedAt: new Date(Date.now() - 3600000).toISOString(), records: records(50),
  }));
  await page.goto('/');
  await expect(summary(page)).toContainText('50 fresh');
  await expect(page.getByText('Showing a saved catalog')).toBeVisible();
});

test('Retry-After is followed even while a membership feed is stalled', async ({ page }) => {
  await page.route(`**${SNAPSHOT_PATH}`, route => route.fulfill({ status: 404, body: 'missing' }));
  await page.route('**/api/omm?group=geo', () => { /* never answers */ });
  let requests = 0;
  await page.route('**/api/omm?group=active', route => requests++ === 0
    ? route.fulfill({ status: 503, headers: { 'Retry-After': '1' }, body: 'refreshing' })
    : json(route, records(25)));
  await page.goto('/');
  await expect(summary(page)).toContainText('25 fresh', { timeout: 6000 });
  expect(requests).toBe(2);
});

test('a complete outage says so and invents no satellites', async ({ page }) => {
  await page.route('**/api/omm?group=stations', route => route.fulfill({ status: 500, body: 'down' }));
  await page.route('**/api/omm?group=active', route => route.fulfill({ status: 500, body: 'down' }));
  await page.route(`**${SNAPSHOT_PATH}`, route => route.fulfill({ status: 404, body: 'missing' }));
  await page.goto('/');
  await expect(summary(page)).toHaveText('Satellite data unavailable; retrying…');
  await expect(page.getByText('no inactive or simulated objects are substituted')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find ISS' })).toBeDisabled();
});

test('a membership feed arriving later does not hide satellites already on screen', async ({ page }) => {
  let release!: () => void;
  const late = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/omm?group=active', route => json(route, records(200)));
  await page.route('**/api/omm?group=geo', async route => { await late; await json(route, records(50).slice(10, 60)); });
  await page.goto('/');
  await expect(summary(page)).toContainText('200 fresh');
  await page.waitForFunction(() => window.snapshots > 0);
  await page.evaluate(() => { window.hiddenUploads = 0; });
  release();
  await expect(page.locator('.group-list li', { hasText: 'Geostationary' })).toContainText('40');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.hiddenUploads)).toBe(0);
});

test('normal playback recalculates about once a second, not continuously', async ({ page }) => {
  await page.route('**/api/omm?group=active', route => json(route, records(200)));
  await page.goto('/');
  await page.waitForFunction(() => window.snapshots > 0);
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => window.snapshots);
  await page.waitForTimeout(4000);
  const perSecond = (await page.evaluate(() => window.snapshots) - before) / 4;
  expect(perSecond).toBeGreaterThan(0.5);
  expect(perSecond).toBeLessThan(2.5);
});
