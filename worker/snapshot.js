import { readSnapshot, SNAPSHOT_PATH, MIRROR_SOURCE, MIRROR_STATUS } from '../shared/snapshot.ts';

export function snapshotResponse(snapshot) {
  return new Response(JSON.stringify(snapshot.records), { headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=2592000',
    'X-Fetched-At': snapshot.fetchedAt,
    'X-Data-Source': snapshot.source,
    'X-Catalog-Snapshot': '1',
    'X-Served-Stale': '1',
  } });
}

export async function assetSnapshot(url, env) {
  if (!env?.ASSETS) return null;
  try {
    const response = await env.ASSETS.fetch(new Request(new URL(SNAPSHOT_PATH, url.origin)));
    if (!response.ok) return null;
    return snapshotResponse(readSnapshot(await response.json()));
  } catch { return null; }
}

/** This mirror publishes CelesTrak's active feed, with a timestamp and digest.
 * Check both so an interrupted download/publication cannot become a good copy.
 */
export async function fetchMirrorSnapshot(signal) {
  const statusResponse = await fetch(MIRROR_STATUS, { signal });
  if (!statusResponse.ok) throw new Error('Catalog mirror metadata unavailable');
  const status = await statusResponse.json();
  if (status.dataset !== 'active' || status.query !== 'GROUP' || status.value !== 'active' ||
      !Number.isInteger(status.record_count) || status.record_count < 10000 ||
      !/^[a-f0-9]{64}$/.test(status.sha256)) throw new Error('Invalid catalog mirror metadata');
  const response = await fetch(MIRROR_SOURCE, { signal });
  if (!response.ok) throw new Error('Catalog mirror unavailable');
  const bytes = await response.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  if (digest !== status.sha256) throw new Error('Catalog mirror digest mismatch');
  const records = JSON.parse(new TextDecoder().decode(bytes));
  if (records.length !== status.record_count) throw new Error('Incomplete catalog mirror');
  return readSnapshot({ version: 1, source: MIRROR_SOURCE, fetchedAt: status.last_success, records });
}
