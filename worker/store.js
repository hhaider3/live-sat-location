// Scheduled copies of the catalog, shared by every Cloudflare region. A region
// with an empty edge cache can answer from here without waiting for upstream.
const PREFIX = 'omm:';
const keyFor = group => `${PREFIX}${group}`;

/** Streams the stored body, so a cold region spends no CPU re-parsing the catalog. */
export async function readStored(env, group) {
  if (!env?.CATALOG) return null;
  try {
    const { value, metadata } = await env.CATALOG.getWithMetadata(keyFor(group), { type: 'stream' });
    if (!value) return null;
    if (!metadata?.fetchedAt) { void value.cancel().catch(() => {}); return null; }
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=2592000',
      'X-Content-Type-Options': 'nosniff',
      'X-Fetched-At': metadata.fetchedAt,
      'X-Served-Stale': '0',
      'X-Rejected-Records': String(metadata.rejected ?? 0),
    });
    if (metadata.source) headers.set('X-Data-Source', metadata.source);
    return new Response(value, { headers });
  } catch { return null; }
}

export function writeStored(env, group, records, metadata) {
  return env.CATALOG.put(keyFor(group), JSON.stringify(records), { metadata });
}

/** Metadata only: reads the count and fetch time without downloading each body. */
export async function storedMetadata(env) {
  const { keys } = await env.CATALOG.list({ prefix: PREFIX });
  return new Map(keys.map(key => [key.name.slice(PREFIX.length), key.metadata]));
}
