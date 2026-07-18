const CACHE_TTL_SECONDS = 2 * 60 * 60;
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

async function fetchTle(requestUrl) {
  const group = requestUrl.searchParams.get("group");
  if (!group || !ALLOWED_GROUPS.has(group)) {
    return errorResponse("Unknown satellite group", 400);
  }

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
    return errorResponse("Orbital data source is unavailable", 502);
  }

  if (!upstreamResponse.ok) {
    return errorResponse("Orbital data source is unavailable", 502);
  }

  const response = new Response(upstreamResponse.body, upstreamResponse);
  response.headers.set(
    "Cache-Control",
    `public, max-age=300, s-maxage=${CACHE_TTL_SECONDS}`
  );
  response.headers.set("Content-Type", "text/plain; charset=utf-8");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/tle") {
      if (request.method !== "GET") {
        return errorResponse("Method not allowed", 405, { Allow: "GET" });
      }
      return fetchTle(url);
    }

    return env.ASSETS.fetch(request);
  },
};
