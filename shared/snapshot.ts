import { normalizeOmm, type OmmRecord } from './omm';

export const SNAPSHOT_PATH = '/data/active.json';
export const SNAPSHOT_MAX_AGE_MS = 30 * 86400000;
export const ACTIVE_SOURCE = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=CSV';
export const MIRROR_SOURCE = 'https://orbit-data.mikepreston.org/v1/gp/active.json';
export const MIRROR_STATUS = 'https://orbit-data.mikepreston.org/v1/status/gp/active.json';

export interface CatalogSnapshot {
  version: 1;
  fetchedAt: string;
  source: string;
  records: OmmRecord[];
}

/** A saved observation keeps its original fetch time, even when republished. */
export function readSnapshot(value: unknown, now = Date.now()): CatalogSnapshot {
  const snapshot = value as CatalogSnapshot | null;
  const age = now - Date.parse(snapshot?.fetchedAt ?? '');
  if (snapshot?.version !== 1 || !Number.isFinite(age) || age < 0 || age >= SNAPSHOT_MAX_AGE_MS ||
      ![ACTIVE_SOURCE, MIRROR_SOURCE].includes(snapshot.source) || !Array.isArray(snapshot.records)) {
    throw new Error('Invalid or expired catalog snapshot');
  }
  const records = snapshot.records.map(normalizeOmm);
  if (!records.length || records.some(record => !record) ||
      new Set(records.map(record => record!.NORAD_CAT_ID)).size !== records.length) {
    throw new Error('Invalid or duplicate snapshot records');
  }
  return { ...snapshot, records: records as OmmRecord[] };
}
