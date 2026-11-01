import * as satlib from "satellite.js";
import { epochMillis, normalizeOmm } from "../shared/omm";
import { readSnapshot, SNAPSHOT_PATH } from '../shared/snapshot';

// ---------- Types ----------

export interface Sat { id: string; name: string; epochMs: number; satrec: satlib.SatRec }

export interface GroupDef {
  key: string;
  label: string;
  color: string; // hex
  url: string;
  legacyUrl: string;
}

export interface LoadedGroup extends GroupDef {
  sats: Sat[];
  fetchedAt: number | null;
  servedStale: boolean;
  refreshState?: string;
  catalogSnapshot?: boolean;
  rejectedCount: number;
  error?: string;
  /** When the Worker asked to be retried, in epoch milliseconds. */
  retryAt?: number;
}

export const R_EARTH = 6371; // km

// ---------- Position propagation ----------

/** Returns ECI position in km, or null if propagation failed. */
export function eciPosition(sat: Sat, date: Date): { x: number; y: number; z: number } | null {
  try {
    const pv = satlib.propagate(sat.satrec, date);
    const p = pv?.position;
    if (!p || typeof p === "boolean" || ![p.x, p.y, p.z].every(Number.isFinite)) return null;
    return p;
  } catch {
    return null;
  }
}

export interface EciState {
  x: number;
  y: number;
  z: number; // km
  vx: number;
  vy: number;
  vz: number; // km/s
}

/**
 * Full ECI state for a single satellite. Unlike eciPosition this returns a
 * fresh object and includes velocity — use it for the selection panel, not the
 * per-frame batch loop.
 */
export function eciState(sat: Sat, date: Date): EciState | null {
  try {
    const pv = satlib.propagate(sat.satrec, date);
    const p = pv?.position;
    const v = pv?.velocity;
    if (
      !p || typeof p === "boolean" || ![p.x, p.y, p.z].every(Number.isFinite) ||
      !v || typeof v === "boolean" || ![v.x, v.y, v.z].every(Number.isFinite)
    ) {
      return null;
    }
    return { x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z };
  } catch {
    return null;
  }
}

/** Orbital period in minutes, for sampling an orbit path. */
export function orbitPeriodMin(sat: Sat): number {
  return (2 * Math.PI) / sat.satrec.no; // satrec.no is rad/min
}

/**
 * Samples one full ECI orbit (positions in km) starting at `date` into `out`,
 * laid out as samples * 3 floats. Returns false if propagation fails partway.
 */
export function sampleOrbitPath(
  sat: Sat,
  date: Date,
  samples: number,
  out: Float32Array
): boolean {
  const periodMin = orbitPeriodMin(sat);
  const t0 = date.getTime();
  for (let k = 0; k < samples; k++) {
    const p = eciPosition(sat, new Date(t0 + (k / samples) * periodMin * 60000));
    if (!p) return false;
    out[k * 3] = p.x;
    out[k * 3 + 1] = p.y;
    out[k * 3 + 2] = p.z;
  }
  return true;
}

// ---------- Group catalogue ----------

const CT = (group: string) =>
  `/api/omm?group=${encodeURIComponent(group)}`;
const LEGACY_CT = (group: string) =>
  `/api/tle?group=${encodeURIComponent(group)}`;

export const GROUP_DEFS: GroupDef[] = [
  { key: "starlink", label: "Starlink", color: "#38bdf8", url: CT("starlink"), legacyUrl: LEGACY_CT("starlink") },
  { key: "oneweb", label: "OneWeb", color: "#a78bfa", url: CT("oneweb"), legacyUrl: LEGACY_CT("oneweb") },
  { key: "gps", label: "GPS", color: "#facc15", url: CT("gps-ops"), legacyUrl: LEGACY_CT("gps-ops") },
  { key: "glonass", label: "GLONASS", color: "#fb923c", url: CT("glo-ops"), legacyUrl: LEGACY_CT("glo-ops") },
  { key: "galileo", label: "Galileo", color: "#34d399", url: CT("galileo"), legacyUrl: LEGACY_CT("galileo") },
  { key: "beidou", label: "BeiDou", color: "#f472b6", url: CT("beidou"), legacyUrl: LEGACY_CT("beidou") },
  { key: "iridium", label: "Iridium NEXT", color: "#e879f9", url: CT("iridium-NEXT"), legacyUrl: LEGACY_CT("iridium-NEXT") },
  { key: "stations", label: "Space Stations", color: "#ef4444", url: CT("stations"), legacyUrl: LEGACY_CT("stations") },
  { key: "weather", label: "Weather", color: "#2dd4bf", url: CT("weather"), legacyUrl: LEGACY_CT("weather") },
  { key: "geo", label: "Geostationary", color: "#f8fafc", url: CT("geo"), legacyUrl: LEGACY_CT("geo") },
  { key: "science", label: "Science", color: "#4ade80", url: CT("science"), legacyUrl: LEGACY_CT("science") },
  { key: "kuiper", label: "Amazon Leo (Kuiper)", color: "#f59e0b", url: CT("kuiper"), legacyUrl: LEGACY_CT("kuiper") },
  { key: "active", label: "Other active satellites", color: "#94a3b8", url: CT("active"), legacyUrl: '' },
];

// ---------- Validated OMM data and freshness ----------

export type Freshness = "Fresh" | "Stale" | "Mixed" | "Unavailable";
export const ELEMENT_AGE_LIMIT_MS = 3.5 * 86400000;

export function dataFreshness(group: LoadedGroup, now = Date.now(), sat?: Sat): Freshness {
  if (!sat && !group.sats.length) return 'Unavailable';
  const epochs = sat ? [sat.epochMs] : group.sats.map(s => s.epochMs);
  // Element age and delivery/cache age are independent. Missing HTTP metadata
  // must not turn recent observed elements into stale data.
  const old = epochs.filter(epoch => !Number.isFinite(epoch) || Math.abs(now - epoch) > ELEMENT_AGE_LIMIT_MS).length;
  return old === epochs.length ? "Stale" : old > 0 ? "Mixed" : "Fresh";
}

export function deliveryStatus(group: LoadedGroup, now = Date.now()): string {
  if (!group.sats.length) return group.error ?? 'Observed data unavailable';
  if (group.catalogSnapshot) return group.refreshState === 'revalidating'
    ? 'Saved catalog; checking for updates' : 'Using saved catalog; live refresh pending';
  if (group.refreshState === 'revalidating') return 'Cached observations; refreshing in background';
  if (group.servedStale) return 'Refresh failed; using cached observations';
  if (group.fetchedAt === null) return 'Observed data; fetch time unknown';
  if (now - group.fetchedAt >= 2 * 3600000) return 'Cached observations; refresh due';
  return 'Recently fetched observations';
}

export function parseOmm(data: unknown): { sats: Sat[]; rejectedCount: number } {
  if (!Array.isArray(data)) throw new Error("Expected an orbital data array");
  const sats: Sat[] = [];
  const seen = new Set<string>();
  for (const record of data) {
    const normalized = normalizeOmm(record);
    if (!normalized) continue;
    const id = String(normalized.NORAD_CAT_ID);
    if (seen.has(id)) continue;
    try {
      const epochMs = epochMillis(normalized.EPOCH);
      const satrec = satlib.json2satrec({ ...normalized, EPOCH: new Date(epochMs).toISOString() });
      const sat: Sat = { id,
        name: typeof normalized.OBJECT_NAME === "string" && normalized.OBJECT_NAME.trim()
          ? normalized.OBJECT_NAME.trim() : `NORAD ${id}`, epochMs, satrec };
      // The parser can return an unusable record without throwing.
      if (!Number.isFinite(satrec.no) || satrec.no <= 0 || !eciState(sat, new Date(epochMs))) continue;
      sats.push(sat);
      seen.add(id);
    } catch { /* reject invalid elements */ }
  }
  return { sats, rejectedCount: data.length - sats.length };
}

export type CatalogKind = 'omm' | 'snapshot';
export interface ParsedCatalog { sats: Sat[]; rejectedCount: number; fetchedAt?: number }
type CatalogParser = (body: ArrayBuffer, kind: CatalogKind) => Promise<ParsedCatalog>;

export function parseCatalogBody(body: ArrayBuffer, kind: CatalogKind): ParsedCatalog {
  const data = JSON.parse(new TextDecoder().decode(body));
  if (kind === 'omm') return parseOmm(data);
  const snapshot = readSnapshot(data);
  return { ...parseOmm(snapshot.records), fetchedAt: Date.parse(snapshot.fetchedAt) };
}

let parseCatalog: CatalogParser = async (body, kind) => parseCatalogBody(body, kind);
/** The app supplies a Worker-backed parser so a large catalog cannot stall the page. */
export function setCatalogParser(parser: CatalogParser) { parseCatalog = parser; }

const LOCAL_CACHE = 'orbit-observations-v1';
// Cold regions answer from the Worker's stored catalog, so a healthy API
// responds well inside this. Only a stalled API costs the second download.
export const SNAPSHOT_HEAD_START_MS = 2500;
const MAX_RETRY_SECONDS = 300;

// Persist only observed OMM responses. Storage denial/eviction is harmless;
// a failed request cannot overwrite this copy.
async function savedResponse(def: GroupDef): Promise<Response | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const cache = await caches.open(LOCAL_CACHE);
        const response = await cache.match(def.url);
        const age = Date.now() - Date.parse(response?.headers.get('X-Fetched-At') ?? '');
        return response && age >= 0 && age < 30 * 86400000 ? response : undefined;
      })(),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 500); }),
    ]);
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

export async function loadGroup(def: GroupDef, signal?: AbortSignal,
  onCached?: (group: LoadedGroup) => void): Promise<LoadedGroup> {
  if (def.key !== 'active' || !onCached) return loadObservedGroup(def, signal, onCached);
  let best: LoadedGroup | undefined;
  const publish = (group: LoadedGroup) => {
    if (signal?.aborted || !group.sats.length) return;
    // An older edge/browser cache must never roll back a newer startup copy.
    if (best && (best.fetchedAt ?? -Infinity) > (group.fetchedAt ?? -Infinity)) return;
    best = group;
    onCached(group);
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let startup: Promise<void> | undefined;
  const startSnapshot = () => startup ??= (async () => {
    // Covers the download too, so it must allow for a slow connection.
    const timer = setTimeout(abort, 60000);
    try {
      const response = await fetch(SNAPSHOT_PATH, { signal: controller.signal });
      if (!response.ok) return;
      const parsed = await parseCatalog(await response.arrayBuffer(), 'snapshot');
      if (controller.signal.aborted) return;
      publish({ ...def, ...parsed, fetchedAt: parsed.fetchedAt!,
        servedStale: true, refreshState: 'revalidating', catalogSnapshot: true });
    } catch { /* live API and browser cache are independent recovery paths */ }
    finally { clearTimeout(timer); }
  })();
  const headStart = setTimeout(() => { if (!best) void startSnapshot(); }, SNAPSHOT_HEAD_START_MS);
  try {
    const current = await loadObservedGroup(def, signal, publish, ok => {
      clearTimeout(headStart);
      if (!ok) void startSnapshot();
    });
    publish(current);
    if (!current.sats.length || current.error) await startSnapshot();
    if (signal?.aborted) throw new Error('Aborted');
    if (best && best !== current) return { ...best, servedStale: true,
      refreshState: current.refreshState === 'revalidating' ? 'revalidating' : 'failed',
      error: current.error, retryAt: current.retryAt };
    return current;
  } finally {
    clearTimeout(headStart);
    signal?.removeEventListener('abort', abort);
    abort();
  }
}

async function loadObservedGroup(def: GroupDef, signal?: AbortSignal,
  onCached?: (group: LoadedGroup) => void, onResponse?: (ok: boolean) => void): Promise<LoadedGroup> {
  let saved: LoadedGroup | undefined;
  if (onCached) {
    const response = await savedResponse(def);
    if (signal?.aborted) throw new Error('Aborted');
    if (response) {
      try {
        const parsed = await parseCatalog(await response.arrayBuffer(), 'omm');
        if (parsed.sats.length) {
          saved = { ...def, ...parsed, fetchedAt: Date.parse(response.headers.get('X-Fetched-At')!),
            servedStale: true, refreshState: 'revalidating',
            catalogSnapshot: response.headers.get('X-Catalog-Snapshot') === '1' };
          onCached(saved);
        }
      } catch { /* ignore corrupt/old browser cache */ }
    }
  }
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) ctrl.abort();
  let timer = setTimeout(abort, def.key === 'active' ? 35000 : 15000);
  try {
    let firstError: unknown;
    try {
      const res = await fetch(def.url, { signal: ctrl.signal, cache: 'no-cache' });
      onResponse?.(res.ok);
      // The Worker has already tried the source and scheduled a retry. Asking
      // the same provider for TLEs would add another timeout and another error.
      if (!res.ok && res.headers.has('Retry-After')) {
        const seconds = Number(res.headers.get('Retry-After'));
        const retryAt = Date.now() + Math.min(Number.isFinite(seconds) ? seconds : 60, MAX_RETRY_SECONDS) * 1000;
        return saved ? { ...saved, refreshState: 'failed', retryAt }
          : { ...def, sats: [], fetchedAt: null, servedStale: false,
            rejectedCount: 0, error: 'Orbital source unavailable; retry scheduled', retryAt };
      }
      if (!res.ok) throw new Error(`OMM request failed (${res.status})`);
      const toSave = res.clone();
      const { sats, rejectedCount } = await parseCatalog(await res.arrayBuffer(), 'omm');
      if (!sats.length) throw new Error("No usable OMM records");
      void (async () => { try { await (await caches.open(LOCAL_CACHE)).put(def.url, toSave); } catch { /* optional storage */ } })();
      const fetched = Date.parse(res.headers.get("X-Fetched-At") ?? "");
      return { ...def, sats, fetchedAt: Number.isFinite(fetched) ? fetched : null,
        servedStale: res.headers.get("X-Served-Stale") === "1",
        refreshState: res.headers.get('X-Refresh-State') ?? undefined,
        catalogSnapshot: res.headers.get('X-Catalog-Snapshot') === '1',
        rejectedCount: rejectedCount + (Number(res.headers.get("X-Rejected-Records")) || 0) };
    } catch (error) {
      firstError = error;
      onResponse?.(false);
    }
    // Each request gets its own timeout. An OMM timeout must not abort the
    // compatibility request before it starts. Caller cancellation still wins.
    clearTimeout(timer);
    if (signal?.aborted || !def.legacyUrl) throw firstError;
    const legacyController = new AbortController();
    const abortLegacy = () => legacyController.abort();
    signal?.addEventListener('abort', abortLegacy, { once: true });
    timer = setTimeout(abortLegacy, 15000);
    // Compatibility path for a previous Worker deployment that still exposes
    // /api/tle, and a server-side OMM outage. This keeps observed data live while
    // retaining the modern OMM path whenever it is available.
    try {
      const legacy = await fetch(def.legacyUrl, { signal: legacyController.signal });
      if (!legacy.ok) throw firstError ?? new Error(`TLE request failed (${legacy.status})`);
      const sats = parseTle(await legacy.text());
      if (!sats.length) throw firstError ?? new Error("No usable TLE records");
      const fetched = Date.parse(legacy.headers.get("X-Fetched-At") ?? "");
      return { ...def, sats, fetchedAt: Number.isFinite(fetched) ? fetched : null,
        servedStale: legacy.headers.get("X-Served-Stale") === "1", rejectedCount: 0 };
    } finally { signal?.removeEventListener('abort', abortLegacy); }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (saved) return { ...saved, refreshState: 'failed', error: error instanceof Error ? error.message : 'Data unavailable' };
    return { ...def, sats: [], fetchedAt: null, servedStale: false,
      rejectedCount: 0, error: error instanceof Error ? error.message : "Data unavailable" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function parseTle(text: string): Sat[] {
  const lines = text.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  const sats: Sat[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].startsWith('1 ') || !lines[i + 1].startsWith('2 ')) continue;
    const name = i > 0 && !lines[i - 1].startsWith('1 ') && !lines[i - 1].startsWith('2 ')
      ? lines[i - 1].trim() : 'UNKNOWN';
    try {
      const satrec = satlib.twoline2satrec(lines[i], lines[i + 1]);
      const id = String(satrec.satnum);
      const epochMs = (satrec.jdsatepoch - 2440587.5) * 86400000;
      const sat: Sat = { id, name, epochMs, satrec };
      if (Number.isFinite(epochMs) && Number.isFinite(satrec.no) && satrec.no > 0 &&
          eciState(sat, new Date(epochMs))) sats.push(sat);
    } catch { /* skip malformed legacy element sets */ }
    i++;
  }
  return sats;
}

export function gmst(date: Date): number {
  return satlib.gstime(date);
}

export function geographicPosition(sat: Sat, date: Date) {
  const p = eciPosition(sat, date);
  if (!p) return null;
  const gd = satlib.eciToGeodetic(p, gmst(date));
  if (![gd.latitude, gd.longitude, gd.height].every(Number.isFinite)) return null;
  return { latitude: gd.latitude * 180 / Math.PI, longitude: gd.longitude * 180 / Math.PI, altitudeKm: gd.height };
}

/** Surface projection over the next orbit, in Earth-fixed scene coordinates. */
export function sampleGroundTrack(sat: Sat, date: Date, samples: number, out: Float32Array): boolean {
  const period = orbitPeriodMin(sat) * 60000;
  for (let i = 0; i < samples; i++) {
    const gd = geographicPosition(sat, new Date(date.getTime() + period * i / (samples - 1)));
    if (!gd) return false;
    const lat = gd.latitude * Math.PI / 180;
    const lon = gd.longitude * Math.PI / 180;
    const r = (R_EARTH + 20) / 1000;
    out[i * 3] = r * Math.cos(lat) * Math.cos(lon);
    out[i * 3 + 1] = r * Math.sin(lat);
    out[i * 3 + 2] = -r * Math.cos(lat) * Math.sin(lon);
  }
  return true;
}
