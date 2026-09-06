import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fetchOmm, fetchTle, STALE_TTL_SECONDS } from '../worker/proxy.js';
import { issOmm, tle } from './fixtures';

function setup(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const store = new Map<string, Response>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    match: async (key: Request) => store.get(key.url)?.clone(),
    put: async (key: Request, response: Response) => { store.set(key.url, response.clone()); },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'caches', previous); else Reflect.deleteProperty(globalThis, 'caches'); });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
  return { store, ctx, flush: () => Promise.all(pending) };
}
const url = new URL('https://orbit.test/api/omm?group=stations');

test('JSON upstream query supports new catalog IDs, caches valid records and canonicalizes keys', async t => {
  const { store, ctx, flush } = setup(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    calls++; assert.equal(input.searchParams.get('FORMAT'), 'JSON');
    return new Response(JSON.stringify([{ ...issOmm, NORAD_CAT_ID: 100608 }, { invalid: true }]));
  });
  const first = await fetchOmm(new URL(`${url}&extra=ignored`), ctx);
  assert.equal(first.status, 200); assert.equal(first.headers.get('X-Rejected-Records'), '1');
  assert.equal((await first.json())[0].NORAD_CAT_ID, 100608);
  assert.ok(Number.isFinite(Date.parse(first.headers.get('X-Fetched-At')!)));
  await flush(); assert.equal(store.size, 1);
  const second = await fetchOmm(url, ctx);
  assert.equal(second.headers.get('X-Served-Stale'), '0'); assert.equal(calls, 1);
});

test('outage serves last good data without rewriting the original fetch time', async t => {
  const { store, ctx } = setup(t);
  const fetched = new Date(Date.now() - 3 * 3600000).toISOString();
  store.set(url.href, new Response(JSON.stringify([issOmm]), { headers: { 'X-Fetched-At': fetched } }));
  t.mock.method(globalThis, 'fetch', async () => new Response('rate limited', { status: 429 }));
  const response = await fetchOmm(url, ctx);
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Served-Stale'), '1');
  assert.equal(response.headers.get('X-Fetched-At'), fetched);
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60');
  assert.equal(response.headers.get('X-Upstream-Error'), 'http-429');
  assert.deepEqual(await response.json(), [issOmm]);
});

test('legacy cache without fetch metadata attempts refresh and preserves outage provenance', async t => {
  const { store, ctx } = setup(t);
  const legacyUrl = new URL('https://orbit.test/api/tle?group=stations');
  const modified = new Date(Date.now() - 86400000).toISOString();
  store.set(legacyUrl.href, new Response(tle.join('\n'), { headers: { 'Last-Modified': modified } }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('offline', { status: 503 }); });
  const response = await fetchTle(legacyUrl, ctx);
  assert.equal(calls, 1);
  assert.equal(response.headers.get('X-Served-Stale'), '1');
  assert.equal(response.headers.get('X-Fetched-At'), null);
  assert.equal(response.headers.get('X-Upstream-Error'), 'http-503');
  assert.equal(await response.text(), tle.join('\n'));
});

test('TLE refresh replaces old cache, validates the body, and bounds retention', async t => {
  const { store, ctx, flush } = setup(t);
  const legacyUrl = new URL('https://orbit.test/api/tle?group=stations');
  const old = new Date(Date.now() - 3 * 3600000).toISOString();
  store.set(legacyUrl.href, new Response(tle.join('\n'), { headers: { 'X-Fetched-At': old } }));
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>maintenance</html>'));
  const invalid = await fetchTle(legacyUrl, ctx);
  assert.equal(invalid.headers.get('X-Served-Stale'), '1');
  assert.equal(invalid.headers.get('X-Fetched-At'), old);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(tle.join('\n')));
  const refreshed = await fetchTle(legacyUrl, ctx);
  assert.equal(refreshed.headers.get('X-Served-Stale'), '0');
  assert.notEqual(refreshed.headers.get('X-Fetched-At'), old);
  await flush();
  assert.equal(store.get(legacyUrl.href)!.headers.get('Cache-Control'), `public, max-age=${STALE_TTL_SECONDS}`);
  store.set(legacyUrl.href, new Response(tle.join('\n'), { headers: {
    'Last-Modified': new Date(Date.now() - (STALE_TTL_SECONDS + 1) * 1000).toISOString(),
  } }));
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('offline', { status: 503 }));
  assert.equal((await fetchTle(legacyUrl, ctx)).status, 502);
});

test('malformed successful responses cannot replace cached orbital data', async t => {
  const { store, ctx } = setup(t);
  const fetched = new Date(Date.now() - 4 * 3600000).toISOString();
  store.set(url.href, new Response(JSON.stringify([issOmm]), { headers: { 'X-Fetched-At': fetched } }));
  for (const body of ['<html>maintenance</html>', '{"error":"unavailable"}', '[{"bad":true}]', '[]']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body));
    const response = await fetchOmm(url, ctx);
    assert.equal(response.headers.get('X-Served-Stale'), '1');
    assert.deepEqual(await response.json(), [issOmm]);
    t.mock.restoreAll();
  }
});

test('expired fallback and missing fallback return an error', async t => {
  const { store, ctx } = setup(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal((await fetchOmm(url, ctx)).status, 502);
  store.set(url.href, new Response(JSON.stringify([issOmm]), { headers: {
    'X-Fetched-At': new Date(Date.now() - (STALE_TTL_SECONDS + 1) * 1000).toISOString(),
  } }));
  assert.equal((await fetchOmm(url, ctx)).status, 502);
});

test('stalled upstream request times out and serves stale data', async t => {
  const { store, ctx } = setup(t);
  store.set(url.href, new Response(JSON.stringify([issOmm]), { headers: { 'X-Fetched-At': new Date(Date.now() - 3 * 3600000).toISOString() } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let notifyStart!: () => void;
  const started = new Promise<void>(resolve => { notifyStart = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted'))); notifyStart();
  }));
  const pending = fetchOmm(url, ctx); await started; t.mock.timers.tick(10001);
  assert.equal((await pending).headers.get('X-Served-Stale'), '1');
});

test('unknown groups, legacy API, and non-GET methods do not reach upstream', async t => {
  setup(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  const env = { ASSETS: { fetch: async () => new Response('app') } };
  const ctx = { waitUntil() {} };
  assert.equal((await worker.fetch(new Request('https://orbit.test/api/omm?group=bad'), env, ctx)).status, 400);
  assert.equal((await worker.fetch(new Request(url, { method: 'POST' }), env, ctx)).status, 405);
  assert.equal((await worker.fetch(new Request('https://orbit.test/api/tle'), env, ctx)).status, 400);
  assert.equal(await (await worker.fetch(new Request('https://orbit.test/'), env, ctx)).text(), 'app');
});
