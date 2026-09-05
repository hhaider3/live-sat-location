import { validOmm } from '../shared/omm.ts';

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

export async function fetchOmm(requestUrl, ctx) {
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
  const fallback = () => cached && age >= 0 && age < STALE_TTL_SECONDS * 1000
    ? clientResponse(cached, true) : errorResponse('Orbital data source is unavailable', 502);

  const upstreamUrl = new URL('https://celestrak.org/NORAD/elements/gp.php');
  upstreamUrl.searchParams.set('GROUP', group);
  upstreamUrl.searchParams.set('FORMAT', 'JSON');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const upstream = await fetch(upstreamUrl, { signal: controller.signal, headers: {
      Accept: 'application/json',
      'User-Agent': 'live-sat-location/2.0 (+https://github.com/hhaider3/live-sat-location)',
    } });
    if (!upstream.ok) return fallback();
    const data = await upstream.json();
    if (!Array.isArray(data)) return fallback();
    const records = data.filter(validOmm);
    if (!records.length) return fallback();
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
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}

