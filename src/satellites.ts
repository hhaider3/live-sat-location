import * as satlib from "satellite.js";

// ---------- Types ----------

export type Sat =
  | { kind: "sgp4"; name: string; satrec: satlib.SatRec }
  | {
      kind: "kepler";
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
  live: boolean; // true if real TLE data was fetched
}

const KEPLER_EPOCH_MS = Date.UTC(2024, 0, 1);
const MU = 398600.4418; // km^3/s^2
const R_EARTH = 6371;

// ---------- Position propagation ----------

const scratch = { x: 0, y: 0, z: 0 };

/** Returns ECI position in km, or null if propagation failed. */
export function eciPosition(sat: Sat, date: Date): { x: number; y: number; z: number } | null {
  if (sat.kind === "sgp4") {
    try {
      const pv = satlib.propagate(sat.satrec, date);
      const p = pv?.position;
      if (!p || typeof p === "boolean" || !isFinite(p.x)) return null;
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
      sats.push({ kind: "kepler", name: `${namePrefix}-${p + 1}-${s + 1}`, radiusKm: r, inc, raan, m0, n });
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
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;

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

// ---------- TLE fetching / parsing ----------

function parseTle(text: string): Sat[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const sats: Sat[] = [];
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    if (lines[i].startsWith("1 ") && i + 1 < lines.length && lines[i + 1].startsWith("2 ")) {
      const name = i > 0 && !lines[i - 1].startsWith("1 ") && !lines[i - 1].startsWith("2 ")
        ? lines[i - 1].trim()
        : "UNKNOWN";
      try {
        const satrec = satlib.twoline2satrec(lines[i], lines[i + 1]);
        sats.push({ kind: "sgp4", name, satrec });
      } catch {
        /* skip malformed */
      }
      i++;
    }
  }
  return sats;
}

async function fetchWithTimeout(url: string, ms: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function loadGroup(def: GroupDef): Promise<LoadedGroup> {
  try {
    const text = await fetchWithTimeout(def.url, 15000);
    const sats = parseTle(text);
    if (sats.length > 0) return { ...def, sats, live: true };
    throw new Error("empty");
  } catch {
    return { ...def, sats: def.fallback(), live: false };
  }
}

export function gmst(date: Date): number {
  return satlib.gstime(date);
}
