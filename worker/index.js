const CACHE_TTL_SECONDS = 2 * 60 * 60;
// How long the last good copy of a group stays readable as a stale fallback.
// TLEs propagate acceptably for visualization over days, so a month covers
// even long CelesTrak outages.
const STALE_TTL_SECONDS = 30 * 24 * 60 * 60;
const ALLOWED_GROUPS = new Set([
  "starlink",
  "oneweb",
  "gps-ops",
  "glo-ops",
  "galileo",
  "beidou",
  "iridium-NEXT",
  "stations",
  "geo",
  "science",
]);

function errorResponse(message, status, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function getCache() {
  try {
    return globalThis.caches?.default ?? null;
  } catch {
    return null;
  }
}

async function staleOrError(cache, cacheKey) {
  const cached = cache ? await cache.match(cacheKey).catch(() => null) : null;
  if (cached) {
    const response = new Response(cached.body, cached);
    response.headers.set("Cache-Control", "public, max-age=60");
    response.headers.set("X-Served-Stale", "1");
    return response;
  }
  return errorResponse("Orbital data source is unavailable", 502);
}

async function fetchTle(requestUrl, ctx) {
  const group = requestUrl.searchParams.get("group");
  if (!group || !ALLOWED_GROUPS.has(group)) {
    return errorResponse("Unknown satellite group", 400);
  }

  const cacheKey = new Request(requestUrl, { method: "GET" });
  const upstreamUrl = new URL("https://celestrak.org/NORAD/elements/gp.php");
  upstreamUrl.searchParams.set("GROUP", group);
  upstreamUrl.searchParams.set("FORMAT", "tle");

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: "text/plain",
        "User-Agent":
          "live-sat-location/1.0 (+https://github.com/hhaider3/live-sat-location)",
      },
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: {
          "200-299": CACHE_TTL_SECONDS,
          "300-399": 0,
          "400-499": 0,
          "500-599": 0,
        },
      },
    });
  } catch {
    return staleOrError(getCache(), cacheKey);
  }

  if (!upstreamResponse.ok) {
    return staleOrError(getCache(), cacheKey);
  }

  const response = new Response(upstreamResponse.body, upstreamResponse);
  response.headers.set(
    "Cache-Control",
    `public, max-age=300, s-maxage=${CACHE_TTL_SECONDS}`
  );
  response.headers.set("Content-Type", "text/plain; charset=utf-8");
  response.headers.set("X-Content-Type-Options", "nosniff");

  // Keep a copy that outlives the client-facing TTL so a later CelesTrak
  // outage can still be served stale instead of falling back to simulation.
  const cache = getCache();
  if (cache) {
    const staleCopy = response.clone();
    staleCopy.headers.set(
      "Cache-Control",
      `public, s-maxage=${STALE_TTL_SECONDS}`
    );
    ctx.waitUntil(
      cache.put(cacheKey, staleCopy).catch(() => {
        /* stale fallback is best-effort */
      })
    );
  }

  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/tle") {
      if (request.method !== "GET") {
        return errorResponse("Method not allowed", 405, { Allow: "GET" });
      }
      return fetchTle(url, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};
