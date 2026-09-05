/** CelesTrak's OMM-compatible JSON subset. Numeric fields must be JSON numbers. */
export interface OmmRecord {
  [key: string]: unknown;
  OBJECT_NAME: string;
  OBJECT_ID: string;
  NORAD_CAT_ID: number;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
  EPHEMERIS_TYPE?: 0;
  CLASSIFICATION_TYPE?: "U" | "C";
  ELEMENT_SET_NO: number;
  REV_AT_EPOCH: number;
}

const NUMERIC_FIELDS = [
  'NORAD_CAT_ID', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR',
  'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'ELEMENT_SET_NO', 'REV_AT_EPOCH',
] as const;

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function epochMillis(value: string): number {
  // CelesTrak epochs without an offset are UTC, regardless of browser timezone.
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
}

export function validOmm(value: unknown): value is OmmRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  const fields = NUMERIC_FIELDS.filter(key => key !== 'ELEMENT_SET_NO' && key !== 'REV_AT_EPOCH');
  if (!fields.every(key => numberValue(r[key]) !== null) || typeof r.EPOCH !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.test(r.EPOCH) ||
      !Number.isFinite(epochMillis(r.EPOCH))) return false;
  const dateParts = r.EPOCH.slice(0, 19).split(/[-T:]/).map(Number);
  const [year, month, day, hour, minute, second] = dateParts;
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      hour > 23 || minute > 59 || second > 59) return false;
  const n = Object.fromEntries(NUMERIC_FIELDS.map(key => [key, numberValue(r[key]) ?? 0])) as unknown as OmmRecord;
  return Number.isInteger(n.NORAD_CAT_ID) && n.NORAD_CAT_ID > 0 && n.NORAD_CAT_ID < 1e9 &&
    n.MEAN_MOTION > 0 && n.MEAN_MOTION < 20 &&
    n.ECCENTRICITY >= 0 && n.ECCENTRICITY < 1 && n.INCLINATION >= 0 && n.INCLINATION <= 180 &&
    [n.RA_OF_ASC_NODE, n.ARG_OF_PERICENTER, n.MEAN_ANOMALY].every(v => v >= 0 && v < 360) &&
    (r.EPHEMERIS_TYPE === undefined || r.EPHEMERIS_TYPE === 0) &&
    (r.CENTER_NAME === undefined || r.CENTER_NAME === 'EARTH') &&
    (r.REF_FRAME === undefined || r.REF_FRAME === 'TEME') &&
    (r.TIME_SYSTEM === undefined || r.TIME_SYSTEM === 'UTC') &&
    (r.MEAN_ELEMENT_THEORY === undefined || r.MEAN_ELEMENT_THEORY === 'SGP4');
}

/** Converts either CelesTrak JSON or Space-Track-style quoted JSON to the
 * numeric shape expected by satellite.js. Optional derivative fields are zero
 * when a provider omits them. */
export function normalizeOmm(value: unknown): OmmRecord | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...r };
  for (const key of NUMERIC_FIELDS) {
    const number = numberValue(r[key]);
    if (number !== null) normalized[key] = number;
  }
  if (normalized.MEAN_MOTION_DDOT === undefined) normalized.MEAN_MOTION_DDOT = 0;
  if (normalized.MEAN_MOTION_DOT === undefined) normalized.MEAN_MOTION_DOT = 0;
  if (normalized.BSTAR === undefined) normalized.BSTAR = 0;
  if (normalized.EPHEMERIS_TYPE === '0') normalized.EPHEMERIS_TYPE = 0;
  if (!validOmm(normalized)) return null;
  return normalized as OmmRecord;
}
