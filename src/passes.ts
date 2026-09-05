import { ecfToLookAngles, eciToEcf } from 'satellite.js';
import { eciPosition, gmst, type Sat } from './satellites';

export interface Observer { latitude: number; longitude: number; }
export interface Pass { start: number; end: number; peak: number; maxElevation: number; ongoing: boolean; continues: boolean; }
export interface PassResult { passes: Pass[]; failed: boolean; }
export const CITIES = [
  { name: 'Phoenix', latitude: 33.45, longitude: -112.07 },
  { name: 'New York', latitude: 40.71, longitude: -74.01 },
  { name: 'London', latitude: 51.51, longitude: -0.13 },
  { name: 'Tokyo', latitude: 35.68, longitude: 139.69 },
  { name: 'Sydney', latitude: -33.87, longitude: 151.21 },
];

export function validObserver(observer: Observer) {
  return Number.isFinite(observer.latitude) && Math.abs(observer.latitude) <= 90 &&
    Number.isFinite(observer.longitude) && Math.abs(observer.longitude) <= 180;
}

/** Geometric passes above 10°, independent of daylight, clouds, and satellite illumination. */
export function predictPasses(sat: Sat, observer: Observer, start: number, hours = 24): PassResult {
  if (!validObserver(observer) || !Number.isFinite(start) || hours <= 0 || hours > 48) {
    throw new Error('Invalid observer or prediction window');
  }
  const gd = { latitude: observer.latitude * Math.PI / 180, longitude: observer.longitude * Math.PI / 180, height: 0 };
  const elevation = (time: number) => {
    const date = new Date(time);
    const p = eciPosition(sat, date);
    if (!p) return NaN;
    return ecfToLookAngles(gd, eciToEcf(p, gmst(date))).elevation * 180 / Math.PI;
  };
  const crossing = (lo: number, hi: number, rising: boolean) => {
    while (hi - lo > 500) {
      const mid = (lo + hi) / 2;
      if ((elevation(mid) >= 10) === rising) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  };
  const passes: Pass[] = [];
  let pass: Pass | null = null;
  const end = start + hours * 3600000;
  let previous = start;
  for (let t = start; t <= end; t += 10000) {
    const angle = elevation(t);
    if (!Number.isFinite(angle)) return { passes: [], failed: true };
    if (angle >= 10) {
      if (!pass) pass = { start: t === start ? t : crossing(previous, t, true), end: t,
        peak: t, maxElevation: angle, ongoing: t === start, continues: false };
      if (angle > pass.maxElevation) { pass.maxElevation = angle; pass.peak = t; }
    } else if (pass) {
      pass.end = crossing(previous, t, false); passes.push(pass); pass = null;
    }
    previous = t;
  }
  if (pass) { pass.end = end; pass.continues = true; passes.push(pass); }
  return { passes, failed: false };
}
