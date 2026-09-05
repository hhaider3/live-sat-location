import * as satlib from "satellite.js";
import { epochMillis, validOmm } from "../shared/omm";

// ---------- Types ----------

export type Sat =
  | { kind: "sgp4"; id: string; name: string; epochMs: number; satrec: satlib.SatRec }
  | {
      kind: "kepler";
      id: string;
      name: string;
      radiusKm: number;
      inc: number; // rad
      raan: number; // rad
      m0: number; // rad at epoch
      n: number; // rad / sec
    };

export interface GroupDef {
  key: string;
  label: string;
  color: string; // hex
  url: string;
  fallback: () => Sat[];
}

export interface LoadedGroup extends GroupDef {
  sats: Sat[];
  fetchedAt: number | null;
  servedStale: boolean;
  rejectedCount: number;
  error?: string;
}

const KEPLER_EPOCH_MS = Date.UTC(2024, 0, 1);
const MU = 398600.4418; // km^3/s^2
export const R_EARTH = 6371; // km

// ---------- Position propagation ----------

const scratch = { x: 0, y: 0, z: 0 };

/** Returns ECI position in km, or null if propagation failed. */
export function eciPosition(sat: Sat, date: Date): { x: number; y: number; z: number } | null {
  if (sat.kind === "sgp4") {
    try {
      const pv = satlib.propagate(sat.satrec, date);
      const p = pv?.position;
      if (!p || typeof p === "boolean" || ![p.x, p.y, p.z].every(Number.isFinite)) return null;
      return p;
    } catch {
      return null;
    }
  }
  // Simple circular Keplerian orbit
  const t = (date.getTime() - KEPLER_EPOCH_MS) / 1000;
  const u = sat.m0 + sat.n * t;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const cO = Math.cos(sat.raan);
  const sO = Math.sin(sat.raan);
  const ci = Math.cos(sat.inc);
  const si = Math.sin(sat.inc);
  scratch.x = sat.radiusKm * (cO * cu - sO * su * ci);
  scratch.y = sat.radiusKm * (sO * cu + cO * su * ci);
  scratch.z = sat.radiusKm * (su * si);
  return scratch;
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
  if (sat.kind === "sgp4") {
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
  // Circular Keplerian orbit: v = (dp/du) * n
  const t = (date.getTime() - KEPLER_EPOCH_MS) / 1000;
  const u = sat.m0 + sat.n * t;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const cO = Math.cos(sat.raan);
  const sO = Math.sin(sat.raan);
  const ci = Math.cos(sat.inc);
  const si = Math.sin(sat.inc);
  const R = sat.radiusKm;
  const rn = R * sat.n;
  return {
    x: R * (cO * cu - sO * su * ci),
    y: R * (sO * cu + cO * su * ci),
    z: R * (su * si),
    vx: rn * (-cO * su - sO * cu * ci),
    vy: rn * (-sO * su + cO * cu * ci),
    vz: rn * (cu * si),
  };
}

/** Orbital period in minutes, for sampling an orbit path. */
export function orbitPeriodMin(sat: Sat): number {
  if (sat.kind === "sgp4") return (2 * Math.PI) / sat.satrec.no; // satrec.no is rad/min
  return (2 * Math.PI) / sat.n / 60;
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
  if (sat.kind === "kepler") {
    const cO = Math.cos(sat.raan);
    const sO = Math.sin(sat.raan);
    const ci = Math.cos(sat.inc);
    const si = Math.sin(sat.inc);
    const R = sat.radiusKm;
    for (let k = 0; k < samples; k++) {
      const u = (k / samples) * 2 * Math.PI;
      const cu = Math.cos(u);
      const su = Math.sin(u);
      out[k * 3] = R * (cO * cu - sO * su * ci);
      out[k * 3 + 1] = R * (sO * cu + cO * su * ci);
      out[k * 3 + 2] = R * (su * si);
    }
    return true;
  }
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

// ---------- Synthetic constellation generators (offline fallback) ----------

function meanMotion(radiusKm: number): number {
  return Math.sqrt(MU / (radiusKm * radiusKm * radiusKm)); // rad/s
}

function walker(
  namePrefix: string,
  planes: number,
  perPlane: number,
  altKm: number,
  incDeg: number,
  phaseF = 1
): Sat[] {
  const sats: Sat[] = [];
  const r = R_EARTH + altKm;
  const n = meanMotion(r);
  const inc = (incDeg * Math.PI) / 180;
  for (let p = 0; p < planes; p++) {
    const raan = (2 * Math.PI * p) / planes;
    for (let s = 0; s < perPlane; s++) {
      const m0 =
        (2 * Math.PI * s) / perPlane + (2 * Math.PI * phaseF * p) / (planes * perPlane);
      sats.push({ kind: "kepler", id: `sim:${namePrefix}-${p + 1}-${s + 1}`, name: `${namePrefix}-${p + 1}-${s + 1}`, radiusKm: r, inc, raan, m0, n });
    }
  }
  return sats;
}

const fallbackStarlink = (): Sat[] => [
  ...walker("STARLINK-A", 72, 22, 550, 53),
  ...walker("STARLINK-B", 72, 22, 540, 53.2, 17),
  ...walker("STARLINK-C", 36, 20, 570, 70, 9),
  ...walker("STARLINK-D", 6, 58, 560, 97.6, 3),
  ...walker("STARLINK-E", 28, 30, 525, 43, 11),
];
const fallbackOneWeb = () => walker("ONEWEB", 12, 49, 1200, 87.4);
const fallbackGps = () => walker("GPS", 6, 5, 20180, 55);
const fallbackGlonass = () => walker("GLONASS", 3, 8, 19130, 64.8);
const fallbackGalileo = () => walker("GALILEO", 3, 8, 23222, 56);
const fallbackBeidou = () => [...walker("BEIDOU-M", 3, 8, 21528, 55), ...walker("BEIDOU-G", 1, 6, 35786, 1)];
const fallbackIridium = () => walker("IRIDIUM", 6, 11, 780, 86.4);
const fallbackStations = (): Sat[] => [
  ...walker("ISS", 1, 1, 420, 51.6),
  ...walker("CSS-TIANHE", 1, 1, 390, 41.5),
];
const fallbackGeo = () => walker("GEOSAT", 1, 140, 35786, 0.5);
const fallbackOther = (): Sat[] => [
  ...walker("NOAA", 1, 5, 850, 98.7),
  ...walker("SENTINEL", 1, 6, 700, 98.2),
  ...walker("CUBESAT", 8, 12, 500, 97.4, 5),
  ...walker("MOLNIYA", 2, 2, 26560, 63.4),
];

// ---------- Group catalogue ----------

const CT = (group: string) =>
  `/api/omm?group=${encodeURIComponent(group)}`;

export const GROUP_DEFS: GroupDef[] = [
  { key: "starlink", label: "Starlink", color: "#38bdf8", url: CT("starlink"), fallback: fallbackStarlink },
  { key: "oneweb", label: "OneWeb", color: "#a78bfa", url: CT("oneweb"), fallback: fallbackOneWeb },
  { key: "gps", label: "GPS", color: "#facc15", url: CT("gps-ops"), fallback: fallbackGps },
  { key: "glonass", label: "GLONASS", color: "#fb923c", url: CT("glo-ops"), fallback: fallbackGlonass },
  { key: "galileo", label: "Galileo", color: "#34d399", url: CT("galileo"), fallback: fallbackGalileo },
  { key: "beidou", label: "BeiDou", color: "#f472b6", url: CT("beidou"), fallback: fallbackBeidou },
  { key: "iridium", label: "Iridium NEXT", color: "#e879f9", url: CT("iridium-NEXT"), fallback: fallbackIridium },
  { key: "stations", label: "Space Stations", color: "#ef4444", url: CT("stations"), fallback: fallbackStations },
  { key: "geo", label: "Geostationary", color: "#f8fafc", url: CT("geo"), fallback: fallbackGeo },
  { key: "science", label: "Science / Weather", color: "#4ade80", url: CT("science"), fallback: fallbackOther },
];

// ---------- Validated OMM data and freshness ----------

export type Freshness = "Fresh" | "Stale" | "Simulated";
export const ELEMENT_AGE_LIMIT_MS = 3.5 * 86400000;

export function dataFreshness(group: LoadedGroup, now = Date.now(), sat?: Sat): Freshness {
  const real = sat ? sat.kind === "sgp4" : group.sats.some(s => s.kind === "sgp4");
  if (!real) return "Simulated";
  const epochs = sat?.kind === "sgp4" ? [sat.epochMs]
    : group.sats.flatMap(s => s.kind === "sgp4" ? [s.epochMs] : []);
  return group.servedStale || group.fetchedAt === null || now - group.fetchedAt > 2 * 3600000 ||
    epochs.some(epoch => Math.abs(now - epoch) > ELEMENT_AGE_LIMIT_MS) ? "Stale" : "Fresh";
}

export function parseOmm(data: unknown): { sats: Sat[]; rejectedCount: number } {
  if (!Array.isArray(data)) throw new Error("Expected an orbital data array");
  const sats: Sat[] = [];
  const seen = new Set<string>();
  for (const record of data) {
    if (!validOmm(record)) continue;
    const id = String(record.NORAD_CAT_ID);
    if (seen.has(id)) continue;
    try {
      const epochMs = epochMillis(record.EPOCH);
      const satrec = satlib.json2satrec({ ...record, EPOCH: new Date(epochMs).toISOString() });
      const sat: Sat = { kind: "sgp4", id,
        name: typeof record.OBJECT_NAME === "string" && record.OBJECT_NAME.trim()
          ? record.OBJECT_NAME.trim() : `NORAD ${id}`, epochMs, satrec };
      // The parser can return an unusable record without throwing.
      if (!Number.isFinite(satrec.no) || satrec.no <= 0 || !eciState(sat, new Date(epochMs))) continue;
      sats.push(sat);
      seen.add(id);
    } catch { /* reject invalid elements */ }
  }
  return { sats, rejectedCount: data.length - sats.length };
}

export async function loadGroup(def: GroupDef, signal?: AbortSignal): Promise<LoadedGroup> {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) ctrl.abort();
  const timer = setTimeout(abort, 15000);
  try {
    const res = await fetch(def.url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Data request failed (${res.status})`);
    const { sats, rejectedCount } = parseOmm(await res.json());
    if (!sats.length) throw new Error("No usable orbital records");
    const fetched = Date.parse(res.headers.get("X-Fetched-At") ?? "");
    return { ...def, sats, fetchedAt: Number.isFinite(fetched) ? fetched : null,
      servedStale: res.headers.get("X-Served-Stale") === "1",
      rejectedCount: rejectedCount + (Number(res.headers.get("X-Rejected-Records")) || 0) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...def, sats: def.fallback(), fetchedAt: null, servedStale: false,
      rejectedCount: 0, error: error instanceof Error ? error.message : "Data unavailable" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
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
