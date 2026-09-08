import { normalizeOmm } from '../shared/omm.ts';

export const CACHE_TTL_SECONDS = 2 * 60 * 60;
export const STALE_TTL_SECONDS = 30 * 24 * 60 * 60;
const ALLOWED_GROUPS = new Set([
  'starlink', 'oneweb', 'gps-ops', 'glo-ops', 'galileo', 'beidou',
  'iridium-NEXT', 'stations', 'geo', 'science',
]);

export function errorResponse(message, status, extraHeaders = {}) {
  return new Response(message, { status, headers: {
    'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders,
  } });
}

function getCache() {
  try { return globalThis.caches?.default ?? null; } catch { return null; }
}

function clientResponse(cached, stale = false) {
  const response = new Response(cached.body, cached);
  response.headers.set('Cache-Control', `public, max-age=${stale ? 60 : 300}`);
  response.headers.set('X-Served-Stale', stale ? '1' : '0');
  return response;
}

// Cache API has no built-in stale-while-revalidate. Keep serving the validated
// body while waitUntil refreshes it, and store retry state separately so neither
// a failure nor a retry can change the original observation fetch timestamp.
async function serveCached(requestUrl, ctx, refresh) {
  const group = requestUrl.searchParams.get('group');
  if (!group || !ALLOWED_GROUPS.has(group)) return errorResponse('Unknown satellite group', 400);
  const canonical = new URL(requestUrl.pathname, requestUrl.origin);
  canonical.searchParams.set('group', group);
  const key = new Request(canonical);
  const stateUrl = new URL(canonical);
  stateUrl.searchParams.set('refresh-state', '1');
  const stateKey = new Request(stateUrl);
  const cache = getCache();
  if (!cache) return refresh(requestUrl, ctx);
  const [cached, state] = await Promise.all([
    cache.match(key).catch(() => null), cache.match(stateKey).catch(() => null),
  ]);
  const now = Date.now();
  const fetched = Date.parse(cached?.headers.get('X-Fetched-At') ?? '');
  const age = now - fetched;
  if (cached && age >= 0 && age < CACHE_TTL_SECONDS * 1000) return clientResponse(cached);
  const retentionAge = Number.isFinite(age) ? age
    : now - Date.parse(cached?.headers.get('Last-Modified') ?? '');
  const usable = cached && retentionAge >= 0 && retentionAge < STALE_TTL_SECONDS * 1000;
  const retryAt = Number(state?.headers.get('X-Retry-At') ?? 0);
  const waiting = retryAt > now;
  const status = waiting ? state.headers.get('X-Refresh-State') : 'revalidating';
  const writeState = async (status, seconds, reason = '') => {
    const response = new Response('', { headers: {
      'Cache-Control': `public, max-age=${seconds}`,
      'X-Refresh-State': status, 'X-Retry-At': String(Date.now() + seconds * 1000),
      'X-Upstream-Error': reason,
    } });
    await cache.put(stateKey, response).catch(() => {});
  };
  const run = async () => {
    // A short shared marker also suppresses duplicate refreshes across visits.
    await writeState('revalidating', 45);
    const writes = [];
    const response = await refresh(requestUrl, { waitUntil: p => writes.push(p) });
    await Promise.allSettled(writes);
    const reason = response.headers.get('X-Upstream-Error');
    if (!response.ok || reason) {
      const seconds = reason === 'http-403' || reason === 'http-429' ? CACHE_TTL_SECONDS : 15 * 60;
      await writeState('failed', seconds, reason ?? 'unavailable');
      response.headers.set('Retry-After', String(seconds));
      response.headers.set('X-Refresh-State', 'failed');
    } else {
      await writeState('ready', 1);
    }
    return response;
  };
  if (usable) {
    if (!waiting) ctx.waitUntil(run().then(response => {
      // A tee's cancellation can wait for another cache clone to be consumed.
      // It must not hold the background task open after the refresh completed.
      void response.body?.cancel().catch(() => {});
    }).catch(() => {}));
    const response = clientResponse(cached, true);
    response.headers.set('X-Refresh-State', status ?? 'failed');
    response.headers.set('Cache-Control', 'no-cache');
    if (waiting && state.headers.get('X-Upstream-Error')) response.headers.set('X-Upstream-Error', state.headers.get('X-Upstream-Error'));
    return response;
  }
  if (waiting) return errorResponse('Orbital data source is unavailable', 503, {
    'Retry-After': String(Math.ceil((retryAt - now) / 1000)),
    'X-Upstream-Error': state.headers.get('X-Upstream-Error') ?? 'refresh-in-progress',
  });
  return run();
}

export const fetchOmm = (url, ctx) => serveCached(url, ctx, refreshOmm);
export const fetchTle = (url, ctx) => serveCached(url, ctx, refreshTle);

async function refreshOmm(requestUrl, ctx) {
  const group = requestUrl.searchParams.get('group');
  if (!group || !ALLOWED_GROUPS.has(group)) return errorResponse('Unknown satellite group', 400);
  // Normalize query parameters and use a new namespace so legacy TLEs cannot enter this cache.
  const canonical = new URL('/api/omm', requestUrl.origin);
  canonical.searchParams.set('group', group);
  const key = new Request(canonical);
  const cache = getCache();
  const cached = cache ? await cache.match(key).catch(() => null) : null;
  const age = cached ? Date.now() - Date.parse(cached.headers.get('X-Fetched-At') ?? '') : Infinity;
  if (cached && age >= 0 && age < CACHE_TTL_SECONDS * 1000) return clientResponse(cached);
  const fallback = (reason) => {
    const response = cached && age >= 0 && age < STALE_TTL_SECONDS * 1000
      ? clientResponse(cached, true) : errorResponse('Orbital data source is unavailable', 502);
    response.headers.set('X-Upstream-Error', reason);
    return response;
  };

  const upstreamUrl = new URL('https://celestrak.org/NORAD/elements/gp.php');
  upstreamUrl.searchParams.set('GROUP', group);
  upstreamUrl.searchParams.set('FORMAT', 'JSON');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cached ? 25000 : 10000);
  try {
    const upstream = await fetch(upstreamUrl, { signal: controller.signal, headers: {
      Accept: 'application/json',
      'User-Agent': 'live-sat-location/2.0 (+https://github.com/hhaider3/live-sat-location)',
    } });
    if (!upstream.ok) return fallback(`http-${upstream.status}`);
    const data = await upstream.json();
    if (!Array.isArray(data)) return fallback('invalid-data');
    const records = data.map(normalizeOmm).filter(Boolean);
    if (!records.length) return fallback('invalid-data');
    const response = new Response(JSON.stringify(records), { headers: {
      'Cache-Control': `public, max-age=${STALE_TTL_SECONDS}`,
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Fetched-At': new Date().toISOString(),
      'X-Served-Stale': '0',
      'X-Rejected-Records': String(data.length - records.length),
    } });
    if (cache) ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
    return clientResponse(response);
  } catch {
    return fallback(controller.signal.aborted ? 'timeout' : 'request-or-parse-failed');
  } finally {
    clearTimeout(timer);
  }
}

// Kept for clients during a rolling deployment and as an outage fallback. The
// modern frontend can consume this endpoint when an older Worker is serving the
// static assets while its OMM route is being updated.
async function refreshTle(requestUrl, ctx) {
  const group = requestUrl.searchParams.get('group');
  if (!group || !ALLOWED_GROUPS.has(group)) return errorResponse('Unknown satellite group', 400);
  const key = new Request(new URL(`/api/tle?group=${encodeURIComponent(group)}`, requestUrl.origin));
  const cache = getCache();
  const cached = cache ? await cache.match(key).catch(() => null) : null;
  const fetched = Date.parse(cached?.headers.get('X-Fetched-At') ?? '');
  const age = Date.now() - fetched;
  if (cached && age >= 0 && age < CACHE_TTL_SECONDS * 1000) return clientResponse(cached);
  // Old deployments did not attach X-Fetched-At. Last-Modified can bound
  // fallback retention, but is not a successful fetch time and stays separate.
  const retentionAge = Number.isFinite(age) ? age
    : Date.now() - Date.parse(cached?.headers.get('Last-Modified') ?? '');
  const fallback = (reason) => {
    const response = cached && retentionAge >= 0 && retentionAge < STALE_TTL_SECONDS * 1000
      ? clientResponse(cached, true) : errorResponse('Orbital data source is unavailable', 502);
    response.headers.set('X-Upstream-Error', reason);
    return response;
  };
  const upstreamUrl = new URL('https://celestrak.org/NORAD/elements/gp.php');
  upstreamUrl.searchParams.set('GROUP', group);
  upstreamUrl.searchParams.set('FORMAT', 'TLE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cached ? 25000 : 10000);
  try {
    const upstream = await fetch(upstreamUrl, { signal: controller.signal, headers: {
      Accept: 'text/plain', 'User-Agent': 'live-sat-location/2.0 (+https://github.com/hhaider3/live-sat-location)',
    } });
    if (!upstream.ok) return fallback(`http-${upstream.status}`);
    const body = await upstream.text();
    if (!/^1 .+\r?\n2 .+/m.test(body)) return fallback('invalid-data');
    const response = new Response(body);
    response.headers.set('Content-Type', 'text/plain; charset=utf-8');
    response.headers.set('Cache-Control', `public, max-age=${STALE_TTL_SECONDS}`);
    response.headers.set('X-Fetched-At', new Date().toISOString());
    response.headers.set('X-Served-Stale', '0');
    if (cache) ctx.waitUntil(cache.put(key, response.clone()).catch(() => {}));
    return clientResponse(response);
  } catch {
    return fallback(controller.signal.aborted ? 'timeout' : 'request-or-parse-failed');
  } finally { clearTimeout(timer); }
}
