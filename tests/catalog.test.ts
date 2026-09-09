import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCatalog, loadInBatches } from '../src/catalog';
import { GROUP_DEFS, parseOmm, type LoadedGroup } from '../src/satellites';
import { issOmm } from './fixtures';

function source(key: string, ids: number[]): LoadedGroup {
  return { ...GROUP_DEFS.find(g => g.key === key)!,
    sats: parseOmm(ids.map(id => ({ ...issOmm, NORAD_CAT_ID: id }))).sats,
    fetchedAt: Date.now(), servedStale: false, rejectedCount: 0 };
}

test('complete active feed includes unlisted satellites once and excludes inactive group members', () => {
  const active = source('active', [1, 2, 3, 4, 5, 6]);
  const named = [source('starlink', [1, 2, 99]), source('kuiper', [2, 3]), source('science', [1])];
  const result = activeCatalog([...named, active]);
  const ids = result.flatMap(g => g.sats.map(s => s.id));
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);
  assert.ok(!ids.includes('99'));
  assert.deepEqual(result.find(g => g.key === 'active')!.sats.map(s => s.id), ['4', '5', '6']);
  assert.deepEqual(result.find(g => g.key === 'kuiper')!.sats.map(s => s.id), ['3']);
  assert.equal(result.find(g => g.key === 'starlink')!.sats[0], active.sats[0], 'use active-feed orbital records');
  assert.deepEqual(result.slice(0, 3).map(g => g.sats.length), [3, 2, 1]);
});

test('arriving group metadata reclassifies objects without losing or duplicating any', () => {
  const active = source('active', [1, 2, 3]);
  const first = activeCatalog([active]);
  assert.equal(first[0].key, 'active');
  const next = activeCatalog([active, source('kuiper', [1, 2])], first);
  assert.equal(next[0].key, 'kuiper', 'Amazon Leo rises above groups with fewer objects');
  assert.equal(next.flatMap(g => g.sats).length, 3);
  const stable = activeCatalog([active, source('kuiper', [1, 2])], next);
  assert.equal(stable[0].sats, next[0].sats, 'metadata updates should not rebuild unchanged rendering buffers');
});

test('cannot claim active membership without the active catalog or introduce simulated objects', () => {
  assert.deepEqual(activeCatalog([source('starlink', [1])]), []);
  const active = source('active', []);
  const named = { ...source('starlink', []), sats: GROUP_DEFS[0].fallback() };
  assert.equal(activeCatalog([active, named]).flatMap(g => g.sats).length, 0);
});

test('Amazon Leo is classified from explicit Kuiper names during a group-feed outage', () => {
  const active = source('active', [1, 2, 3]);
  active.sats = active.sats.map((sat, i) => ({ ...sat, name: ['KUIPER-00008', 'AMAZONAS 2', 'STARLINK-1008'][i] }));
  const result = activeCatalog([active]);
  assert.deepEqual(result.find(g => g.key === 'kuiper')!.sats.map(s => s.id), ['1']);
  assert.deepEqual(result.find(g => g.key === 'starlink')!.sats.map(s => s.id), ['3']);
  assert.deepEqual(result.find(g => g.key === 'active')!.sats.map(s => s.id), ['2']);
});

test('catalog requests are bounded and a failed group does not stop later ones', async () => {
  let running = 0;
  let max = 0;
  const completed: number[] = [];
  await loadInBatches([0, 1, 2, 3, 4, 5, 6], async n => {
    running++; max = Math.max(max, running);
    await new Promise(resolve => setTimeout(resolve, 1));
    running--; completed.push(n);
    if (n === 1) throw new Error('Group unavailable');
  });
  assert.equal(max, 3);
  assert.deepEqual(completed.sort(), [0, 1, 2, 3, 4, 5, 6]);
});
