// Updates the site-hosted startup catalog atomically. Builds remain offline.
import { build } from 'esbuild';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';

const bundled = await build({ stdin: { contents: `
  export * from './shared/snapshot.ts';
  export { parseOmmCsv } from './shared/csv.ts';
  export { fetchMirrorSnapshot } from './worker/snapshot.js';
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { readSnapshot, ACTIVE_SOURCE, fetchMirrorSnapshot, parseOmmCsv } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const target = new URL('../public/data/active.json', import.meta.url);
let previous;
try { previous = readSnapshot(JSON.parse(await readFile(target, 'utf8'))); } catch { /* first snapshot */ }
if (previous && Date.now() - Date.parse(previous.fetchedAt) < 2 * 3600000) {
  console.log(`Startup catalog is already current (${previous.fetchedAt}); no download needed.`);
  process.exit(0);
}
let snapshot;
try {
  const response = await fetch(ACTIVE_SOURCE, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`CelesTrak returned ${response.status}`);
  snapshot = readSnapshot({ version: 1, source: ACTIVE_SOURCE,
    fetchedAt: new Date().toISOString(), records: parseOmmCsv(await response.text()) });
  if (snapshot.records.length < 10000) throw new Error('Incomplete active catalog');
} catch (error) {
  console.warn(`Primary catalog unavailable: ${error.message}. Trying the catalog mirror.`);
  try { snapshot = await fetchMirrorSnapshot(AbortSignal.timeout(15000)); }
  catch (error) {
    if (!previous || !process.argv.includes('--allow-existing')) throw error;
    console.warn(`Keeping the validated snapshot from ${previous.fetchedAt}: ${error.message}`);
    process.exit(0);
  }
}
if (previous && Date.parse(snapshot.fetchedAt) < Date.parse(previous.fetchedAt)) {
  console.log('Keeping the newer existing catalog snapshot.');
} else {
  if (previous && snapshot.records.length < previous.records.length * 0.8) {
    throw new Error('Refusing to replace the snapshot after an unexpected catalog count drop');
  }
  await mkdir(new URL('../public/data/', import.meta.url), { recursive: true });
  const temporary = new URL(`${target.href}.tmp`);
  await writeFile(temporary, JSON.stringify(snapshot) + '\n');
  await rename(temporary, target);
  console.log(`Saved ${snapshot.records.length} observed satellites from ${snapshot.fetchedAt}.`);
}
