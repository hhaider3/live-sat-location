import { GROUP_DEFS, type LoadedGroup, type Sat } from './satellites';

// Explicit catalog naming conventions keep these constellations classified
// even while their membership endpoint is unavailable. AMAZONAS is unrelated.
const constellationNames: Record<string, RegExp> = {
  starlink: /^STARLINK-\d+$/i,
  oneweb: /^ONEWEB-\d+$/i,
  kuiper: /^KUIPER-\d+$/i,
};

/** Active feed owns the objects and epochs; named feeds supply membership only.
 * Stable definition order resolves overlapping memberships before count sorting.
 */
export function activeCatalog(sources: LoadedGroup[], previous: LoadedGroup[] = []): LoadedGroup[] {
  const active = sources.find(g => g.key === 'active');
  if (!active) return [];
  const remaining = new Map(active.sats.filter(s => s.kind === 'sgp4').map(s => [s.id, s]));
  const groups = GROUP_DEFS.map(def => {
    const sats: Sat[] = [];
    const membership = sources.find(g => g.key === def.key);
    if (def.key === 'active') {
      sats.push(...remaining.values());
      remaining.clear();
    } else {
      for (const member of membership?.sats ?? []) {
        if (member.kind !== 'sgp4') continue;
        const sat = remaining.get(member.id);
        if (sat) { sats.push(sat); remaining.delete(member.id); }
      }
      const pattern = constellationNames[def.key];
      if (pattern) for (const sat of remaining.values()) {
        if (pattern.test(sat.name)) { sats.push(sat); remaining.delete(sat.id); }
      }
    }
    const old = previous.find(g => g.key === def.key);
    const unchanged = old?.sats.length === sats.length && old.sats.every((sat, i) => sat === sats[i]);
    return { ...active, ...def, sats: unchanged ? old.sats : sats,
      error: !active.sats.length ? active.error ?? 'Active catalog unavailable; retry scheduled'
        : !sats.length && def.key !== 'active' && (!membership || membership.error)
          ? 'Grouping unavailable; included in Other active satellites' : active.error,
      // Rejections belong to the complete source, not every partition.
      rejectedCount: def.key === 'active' ? active.rejectedCount : 0 };
  });
  return groups.sort((a, b) => b.sats.length - a.sats.length || a.label.localeCompare(b.label));
}

/** Bound upstream bursts while letting each completed group publish immediately. */
export async function loadInBatches<T>(items: T[], load: (item: T) => Promise<void>, concurrency = 3): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await load(item); } catch { /* remaining groups should still load */ }
    }
  }));
}
