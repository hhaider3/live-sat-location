import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec, propagate, eciToEcf, ecfToLookAngles } from 'satellite.js';
import { validOmm, epochMillis } from '../shared/omm';
import { parseOmm, dataFreshness, deliveryStatus, loadGroup, GROUP_DEFS, eciPosition, eciState, gmst, geographicPosition, sampleGroundTrack, type LoadedGroup, type Sat } from '../src/satellites';
import { buildSnapshot, interpolatePositions, snapshotTime, HIDDEN_POSITION } from '../src/propagation';
import { predictPasses } from '../src/passes';
import { SimulationClock, formatSpeed } from '../src/time';
import { issOmm, tle } from './fixtures';

const epoch = epochMillis(issOmm.EPOCH);
const real = parseOmm([issOmm]).sats[0];
const fixtureGroup = (): LoadedGroup => ({ ...GROUP_DEFS[7], sats: [real], fetchedAt: epoch, servedStale: false, rejectedCount: 0 });

test('OMM preserves six- and nine-digit catalog IDs and treats bare epochs as UTC', () => {
  const sats = parseOmm([{ ...issOmm, NORAD_CAT_ID: 100608 }, { ...issOmm, NORAD_CAT_ID: 999999999 }]).sats;
  assert.deepEqual(sats.map(s => s.id), ['100608', '999999999']);
  assert.equal(epoch, Date.UTC(2019, 5, 5, 12, 12, 58));
  assert.equal(epochMillis('2019-06-05T05:12:58-07:00'), epoch);
  assert.equal(parseOmm([{ ...issOmm, EPOCH: '2019-06-05T05:12:58-07:00' }]).sats.length, 1);
});

test('OMM propagation matches equivalent TLE at epoch and a day later', () => {
  const satrec = twoline2satrec(tle[0], tle[1]);
  for (const offset of [0, 86400000]) {
    const date = new Date(epoch + offset);
    const old = propagate(satrec, date)!;
    const current = eciState(real, date)!;
    assert.ok(old && typeof old.position !== 'boolean');
    assert.ok(Math.hypot(current.x - old.position.x, current.y - old.position.y, current.z - old.position.z) < 0.02);
  }
});

test('malformed, duplicate, incompatible, and nonpropagatable records are excluded', () => {
  const invalid = [null, {}, { ...issOmm, MEAN_MOTION: '15' }, { ...issOmm, EPOCH: 'invalid' },
    { ...issOmm, INCLINATION: 181 }, { ...issOmm, ECCENTRICITY: NaN },
    { ...issOmm, NORAD_CAT_ID: 1.2 }, { ...issOmm, REF_FRAME: 'J2000' },
    { ...issOmm, MEAN_MOTION: 0 }, { ...issOmm, ECCENTRICITY: 0.99 }];
  const parsed = parseOmm([...invalid, issOmm, issOmm]);
  assert.equal(parsed.sats.length, 1); assert.equal(parsed.rejectedCount, invalid.length + 1);
  assert.throws(() => parseOmm({ error: 'upstream unavailable' }));
  assert.equal(validOmm({ ...issOmm, BSTAR: Infinity }), false);
});

test('element freshness is independent of transport age and missing legacy metadata', () => {
  assert.equal(dataFreshness(fixtureGroup(), epoch), 'Fresh');
  assert.equal(dataFreshness({ ...fixtureGroup(), servedStale: true }, epoch), 'Fresh');
  assert.equal(dataFreshness({ ...fixtureGroup(), fetchedAt: null }, epoch), 'Fresh');
  assert.equal(dataFreshness(fixtureGroup(), epoch + 3 * 3600000), 'Fresh');
  assert.match(deliveryStatus({ ...fixtureGroup(), servedStale: true }, epoch), /Refresh failed/);
  assert.match(deliveryStatus({ ...fixtureGroup(), fetchedAt: null }, epoch), /fetch time unknown/);
  assert.equal(dataFreshness({ ...fixtureGroup(), fetchedAt: epoch + 5 * 86400000 }, epoch + 5 * 86400000), 'Stale');
  assert.equal(dataFreshness({ ...fixtureGroup(), sats: GROUP_DEFS[7].fallback() }, epoch), 'Simulated');
});

test('one old satellite does not label an entire observed group stale', () => {
  assert.equal(real.kind, 'sgp4');
  const old = { ...real, epochMs: epoch - 5 * 86400000 } as Sat;
  const group = { ...fixtureGroup(), sats: [real, old] };
  assert.equal(dataFreshness(group, epoch), 'Mixed');
  assert.equal(dataFreshness(group, epoch, real), 'Fresh');
  assert.equal(dataFreshness(group, epoch, old), 'Stale');
});

test('OMM timeout leaves a full independent timeout for the TLE fallback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/api/omm')) return new Promise<Response>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('timeout')));
      started();
    });
    options.signal.throwIfAborted();
    return new Response(`${tle[0]}\n${tle[1]}\n`);
  });
  const pending = loadGroup(GROUP_DEFS[7]);
  await ready; t.mock.timers.tick(15001);
  const result = await pending;
  assert.equal(result.sats[0].kind, 'sgp4');
  assert.equal(result.fetchedAt, null);
  assert.equal(dataFreshness(result, epoch), 'Fresh');
});

test('client preserves stale/fetch headers and falls back on invalid JSON', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([issOmm]), { headers: {
    'X-Fetched-At': new Date(epoch).toISOString(), 'X-Served-Stale': '1', 'X-Rejected-Records': '2',
  } }));
  const result = await loadGroup(GROUP_DEFS[7]);
  assert.equal(result.fetchedAt, epoch); assert.equal(result.servedStale, true); assert.equal(result.rejectedCount, 2);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>outage</html>'));
  assert.equal(dataFreshness(await loadGroup(GROUP_DEFS[7])), 'Simulated');
});

test('client falls back to a previous Worker TLE route when the OMM route is unavailable', async t => {
  let requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    requests.push(String(url));
    if (String(url).includes('/api/omm')) return new Response('deployment not ready', { status: 404 });
    return new Response(`${tle[0]}\n${tle[1]}\n`, { headers: {
      'X-Fetched-At': new Date(epoch).toISOString(), 'X-Served-Stale': '0',
    } });
  });
  const result = await loadGroup(GROUP_DEFS[7]);
  assert.equal(result.sats.length, 1);
  assert.equal(result.sats[0].id, '25544');
  assert.equal(result.servedStale, false);
  assert.deepEqual(requests.map(url => url.includes('/api/omm') ? 'omm' : 'tle'), ['omm', 'tle']);
});

test('unmounted client requests abort rather than publishing synthetic fallback', async t => {
  const ctrl = new AbortController(); ctrl.abort();
  t.mock.method(globalThis, 'fetch', async (_url, options) => { options.signal.throwIfAborted(); return new Response(); });
  await assert.rejects(loadGroup(GROUP_DEFS[7], ctrl.signal));
});

test('every group shares a timestamp, including reverse snapshots and failed positions', () => {
  const sats = GROUP_DEFS[7].fallback();
  const groups = new Map([['a', sats], ['b', sats]]);
  const shot = buildSnapshot(groups, { type: 'sample', keys: ['a', 'b'], generation: 8, start: epoch, end: epoch - 10000 });
  assert.deepEqual(shot.groups[0].a, shot.groups[1].a);
  assert.deepEqual(shot.groups[0].b, shot.groups[1].b);
  assert.equal(snapshotTime(shot, epoch + 1e6), epoch);
  assert.equal(snapshotTime(shot, epoch - 1e6), epoch - 10000);
  const out = new Float32Array(shot.groups[0].a.length);
  interpolatePositions(shot.groups[0].a, shot.groups[0].b, 0.5, out);
  const p = eciPosition(sats[0], new Date(epoch - 5000))!;
  assert.ok(Math.hypot(out[0] - p.x / 1000, out[1] - p.z / 1000, out[2] + p.y / 1000) < 0.001);
  const failed = { ...real, satrec: { ...(real as Extract<Sat, { kind: 'sgp4' }>).satrec, ecco: 1.5 } } as Sat;
  assert.equal(eciPosition(failed, new Date(epoch)), null);
  assert.equal(eciState(failed, new Date(epoch)), null);
  const failShot = buildSnapshot(new Map([['bad', [failed]]]), { type: 'sample', keys: ['bad'], generation: 0, start: epoch, end: epoch });
  assert.equal(failShot.groups[0].a[0], HIDDEN_POSITION);
  interpolatePositions(new Float32Array([1, 2, 3]), new Float32Array([HIDDEN_POSITION, HIDDEN_POSITION, HIDDEN_POSITION]), 0.2, out.subarray(0, 3));
  assert.equal(out[0], HIDDEN_POSITION);
});

test('ground track starts under the satellite and stays on the surface', () => {
  const out = new Float32Array(128 * 3);
  assert.ok(sampleGroundTrack(real, new Date(epoch), 128, out));
  for (let i = 0; i < 128; i++) assert.ok(Math.abs(Math.hypot(...out.subarray(i * 3, i * 3 + 3)) - 6.391) < 1e-5);
  const gd = geographicPosition(real, new Date(epoch))!;
  assert.ok(Math.abs(Math.atan2(-out[2], out[0]) * 180 / Math.PI - gd.longitude) < 1e-4);
});

test('pass prediction brackets horizon crossings and reports propagation failures', () => {
  const observer = { latitude: 33.45, longitude: -112.07 };
  const result = predictPasses(real, observer, epoch);
  assert.equal(result.failed, false); assert.ok(result.passes.length > 0);
  for (const pass of result.passes) {
    assert.ok(pass.start <= pass.peak && pass.peak <= pass.end);
    assert.ok(pass.maxElevation >= 10);
    if (!pass.ongoing) {
      const date = new Date(pass.start);
      const p = eciPosition(real, date)!;
      const angle = ecfToLookAngles({ latitude: observer.latitude * Math.PI / 180, longitude: observer.longitude * Math.PI / 180, height: 0 }, eciToEcf(p, gmst(date))).elevation * 180 / Math.PI;
      assert.ok(Math.abs(angle - 10) < 0.2);
    }
  }
  assert.throws(() => predictPasses(real, { latitude: 91, longitude: 0 }, epoch));
});

test('return to live atomically resets reverse, pause, speed, and date; wall-clock drift recovers', () => {
  let now = epoch; const clock = new SimulationClock(() => now);
  clock.setSpeed(-86400); now += 1000; assert.equal(clock.time(), epoch - 86400000);
  clock.setPaused(true); const frozen = clock.time(); now += 5000; assert.equal(clock.time(), frozen);
  clock.setTime(epoch - 1e9); clock.returnToLive();
  assert.equal(clock.time(), now); assert.equal(clock.speed, 1); assert.equal(clock.paused, false);
  now += 3600000; assert.equal(clock.time(), now);
  clock.setTime(NaN); assert.equal(clock.time(), now);
  assert.equal(formatSpeed(Math.pow(10, Math.log10(86400))), '1.0 d/s');
});
