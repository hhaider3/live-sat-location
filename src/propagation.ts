import { eciPosition, type Sat } from './satellites';

export const HIDDEN_POSITION = 1e6;
export interface Snapshot {
  generation: number;
  start: number;
  end: number;
  groups: { key: string; a: Float32Array; b: Float32Array }[];
}
export type PropagationRequest =
  | { type: 'upsert'; key: string; sats: Sat[] }
  | { type: 'remove'; key: string }
  | { type: 'sample'; keys: string[]; generation: number; start: number; end: number };

export function samplePositions(sats: Sat[], ms: number): Float32Array {
  const out = new Float32Array(sats.length * 3);
  const date = new Date(ms);
  sats.forEach((sat, i) => {
    const p = eciPosition(sat, date);
    out[i * 3] = p ? p.x / 1000 : HIDDEN_POSITION;
    out[i * 3 + 1] = p ? p.z / 1000 : HIDDEN_POSITION;
    out[i * 3 + 2] = p ? -p.y / 1000 : HIDDEN_POSITION;
  });
  return out;
}

/** Every group and every object is evaluated at the same two timestamps. */
export function buildSnapshot(groups: Map<string, Sat[]>, request: Extract<PropagationRequest, { type: 'sample' }>): Snapshot {
  return { generation: request.generation, start: request.start, end: request.end,
    groups: request.keys.flatMap(key => {
      const sats = groups.get(key);
      return sats ? [{ key, a: samplePositions(sats, request.start), b: samplePositions(sats, request.end) }] : [];
    }) };
}

export function snapshotTime(snapshot: Snapshot, desired: number): number {
  return Math.min(Math.max(desired, Math.min(snapshot.start, snapshot.end)), Math.max(snapshot.start, snapshot.end));
}

export function interpolatePositions(a: Float32Array, b: Float32Array, alpha: number, out: Float32Array) {
  for (let i = 0; i < out.length; i += 3) {
    const failed = a[i] === HIDDEN_POSITION || b[i] === HIDDEN_POSITION;
    for (let axis = 0; axis < 3; axis++) {
      const k = i + axis;
      out[k] = failed ? HIDDEN_POSITION : a[k] + (b[k] - a[k]) * alpha;
    }
  }
}
