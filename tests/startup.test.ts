import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseOmmCsv } from '../shared/csv';
import { ACTIVE_SOURCE, readSnapshot, SNAPSHOT_PATH } from '../shared/snapshot';
import { GROUP_DEFS, loadGroup, parseOmm, eciState, type LoadedGroup } from '../src/satellites';
import { issOmm, ommCsv } from './fixtures';

const active = GROUP_DEFS.find(def => def.key === 'active')!;
const fetchedAt = new Date(Date.now() - 3600000).toISOString();
const snapshot = { version: 1, source: ACTIVE_SOURCE, fetchedAt, records: [issOmm] };
type TestContext = Parameters<Parameters<typeof test>[1]>[0];

function storage(t: TestContext, open: () => Promise<unknown>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { open } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'caches', previous) : Reflect.deleteProperty(globalThis, 'caches'));
}

test('first visitor sees observed satellites before a stalled API, without browser storage', async t => {
  storage(t, async () => { throw new Error('Storage disabled'); });
  let finish!: (response: Response) => void;
  let displayed!: (group: LoadedGroup) => void;
  const visible = new Promise<LoadedGroup>(resolve => { displayed = resolve; });
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requests.push(url);
    if (url === SNAPSHOT_PATH) return Response.json(snapshot);
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  const pending = loadGroup(active, undefined, displayed);
  const group = await visible;
  assert.equal(group.sats[0].kind, 'sgp4');
  assert.equal(group.fetchedAt, Date.parse(fetchedAt));
  assert.equal(group.catalogSnapshot, true);
  finish(new Response('unavailable', { status: 503, headers: { 'Retry-After': '7200' } }));
  const result = await pending;
  assert.equal(result.sats.length, 1);
  assert.equal(result.refreshState, 'failed');
  assert.equal(result.fetchedAt, Date.parse(fetchedAt));
  assert.deepEqual(requests.sort(), [active.url, SNAPSHOT_PATH].sort());
});

test('live recovery replaces the startup catalog and preserves the newer fetch timestamp', async t => {
  storage(t, async () => ({ match: async () => undefined }));
  let finish!: (response: Response) => void;
  let displayed!: () => void;
  const visible = new Promise<void>(resolve => { displayed = resolve; });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const newer = new Date().toISOString();
  t.mock.method(globalThis, 'fetch', async (url: string) => url === SNAPSHOT_PATH
    ? Response.json(snapshot) : new Promise<Response>(resolve => { finish = resolve; started(); }));
  const pending = loadGroup(active, undefined, displayed);
  await Promise.all([visible, ready]);
  finish(Response.json([{ ...issOmm, NORAD_CAT_ID: 100608 }], { headers: { 'X-Fetched-At': newer } }));
  const result = await pending;
  assert.equal(result.sats[0].id, '100608');
  assert.equal(result.fetchedAt, Date.parse(newer));
  assert.equal(result.catalogSnapshot, false);
});

test('an older live response cannot erase or roll back a newer startup catalog', async t => {
  storage(t, async () => ({ match: async () => undefined }));
  const published: LoadedGroup[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => url === SNAPSHOT_PATH
    ? Response.json(snapshot)
    : Response.json([{ ...issOmm, NORAD_CAT_ID: 100608 }], { headers: {
      'X-Fetched-At': new Date(Date.now() - 86400000).toISOString(),
    } }));
  const result = await loadGroup(active, undefined, group => published.push(group));
  assert.equal(result.sats[0].id, '25544');
  assert.equal(published.at(-1)!.sats[0].id, '25544');
  assert.equal(result.fetchedAt, Date.parse(fetchedAt));
});

test('a late startup response cannot replace a newer live catalog', async t => {
  storage(t, async () => ({ match: async () => undefined }));
  let finish!: (response: Response) => void;
  let displayed!: () => void;
  const visible = new Promise<void>(resolve => { displayed = resolve; });
  const published: LoadedGroup[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => url === SNAPSHOT_PATH
    ? new Promise<Response>(resolve => { finish = resolve; })
    : Response.json([{ ...issOmm, NORAD_CAT_ID: 100608 }], { headers: { 'X-Fetched-At': new Date().toISOString() } }));
  const pending = loadGroup(active, undefined, group => { published.push(group); displayed(); });
  await visible;
  finish(Response.json(snapshot));
  assert.equal((await pending).sats[0].id, '100608');
  assert.deepEqual(published.map(group => group.sats[0].id), ['100608']);
});

test('expired, corrupt and missing startup assets do not block the live API', async t => {
  storage(t, async () => { throw new Error('Storage disabled'); });
  for (const response of [new Response('missing', { status: 404 }), new Response('<html>app</html>'),
    Response.json({ ...snapshot, fetchedAt: new Date(Date.now() - 31 * 86400000).toISOString() })]) {
    t.mock.method(globalThis, 'fetch', async (url: string) => url === SNAPSHOT_PATH ? response
      : Response.json([issOmm], { headers: { 'X-Fetched-At': fetchedAt } }));
    const result = await loadGroup(active, undefined, () => {});
    assert.equal(result.sats.length, 1);
    assert.equal(result.catalogSnapshot, false);
    t.mock.restoreAll();
  }
});

test('cancelling startup aborts both requests and does not publish a fallback', async t => {
  storage(t, async () => ({ match: async () => undefined }));
  const controller = new AbortController();
  let start!: () => void;
  const ready = new Promise<void>(resolve => { start = resolve; });
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signals.push(options.signal);
    if (signals.length === 2) start();
    return new Promise<Response>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))));
  });
  const pending = loadGroup(active, controller.signal, () => assert.fail('cancelled load must not publish'));
  await ready; controller.abort();
  await assert.rejects(pending, /Aborted/);
  assert.ok(signals.every(signal => signal.aborted));
});

test('a hanging browser cache cannot hold up the API indefinitely', async t => {
  storage(t, async () => new Promise(() => {}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (url: string) => url === SNAPSHOT_PATH
    ? new Response('missing', { status: 404 }) : Response.json([issOmm]));
  const pending = loadGroup(active, undefined, () => {});
  t.mock.timers.tick(501);
  assert.equal((await pending).sats.length, 1);
});

test('CSV preserves extended IDs, quoted names, column order and SGP4 propagation', () => {
  const record = { ...issOmm, OBJECT_NAME: 'SAT "A", TEST', NORAD_CAT_ID: 799123456 };
  const text = '\uFEFF' + ommCsv([record]);
  const parsed = parseOmm(parseOmmCsv(text));
  assert.equal(parsed.rejectedCount, 0);
  assert.equal(parsed.sats[0].id, '799123456');
  assert.equal(parsed.sats[0].name, record.OBJECT_NAME);
  const date = new Date('2019-06-06T12:12:58Z');
  assert.deepEqual(eciState(parsed.sats[0], date), eciState(parseOmm([record]).sats[0], date));
  const rows = ommCsv([record]).trim().split('\r\n');
  // Reorder simple columns using a record without quotes in its name.
  const simple = ommCsv([issOmm]).trim().split('\r\n').map(row => row.split(',').reverse().join(',')).join('\n') + '\n';
  assert.equal(parseOmm(parseOmmCsv(simple)).sats[0].id, '25544');
  assert.throws(() => parseOmmCsv(rows.join('\r\n')), /Incomplete/);
  assert.throws(() => parseOmmCsv(ommCsv([record]).replace('"SAT ""A"", TEST"', '"SAT"extra')), /quoting/);
  assert.throws(() => parseOmmCsv('NORAD_CAT_ID,EPOCH\n1,bad\n'), /header/);
  assert.throws(() => parseOmmCsv(ommCsv([issOmm]) + '1,2\n'), /row/);
});

test('the shipped startup asset contains a complete, unique, propagatable observed catalog', async () => {
  const data = JSON.parse(await readFile('public/data/active.json', 'utf8'));
  // Validate at publication time so an offline build stays deterministic.
  const saved = readSnapshot(data, Date.parse(data.fetchedAt));
  const parsed = parseOmm(saved.records);
  assert.ok(parsed.sats.length >= 10000);
  assert.equal(parsed.rejectedCount, 0);
  assert.ok(parsed.sats.some(sat => sat.id === '25544'));
  assert.ok(parsed.sats.some(sat => Number(sat.id) >= 100000));
  assert.throws(() => readSnapshot({ ...snapshot, records: [issOmm, issOmm] }), /duplicate/);
  assert.throws(() => readSnapshot({ ...snapshot, fetchedAt: new Date(Date.now() + 86400000).toISOString() }), /Invalid/);
});
