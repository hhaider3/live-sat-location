// Local-only API fixtures for repeatable browser checks. Never used by production.
import { createServer } from 'node:http';
import { build } from 'esbuild';
const bundled = await build({ entryPoints: ['tests/fixtures.ts'], bundle: true, write: false, format: 'esm' });
const { issOmm } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const now = Date.now();
const current = { ...issOmm, EPOCH: new Date(now).toISOString(), OBJECT_NAME: 'ISS (test fixture)' };
const groups = ['starlink', 'oneweb', 'gps-ops', 'glo-ops', 'galileo', 'beidou', 'iridium-NEXT', 'stations', 'geo'];
const calls = new Map();
createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8787');
  const group = url.searchParams.get('group');
  const n = (calls.get(group) ?? 0) + 1; calls.set(group, n);
  if (url.pathname !== '/api/omm' || !groups.includes(group)) { res.writeHead(503); res.end('Fixture: unavailable group'); return; }
  const stale = group === 'oneweb';
  const fetchedAt = new Date(now - (stale ? 3 * 3600000 : 0)).toISOString();
  const count = group === 'starlink' ? 12000 : 1;
  const records = Array.from({ length: count }, (_, i) => ({ ...current,
    OBJECT_NAME: group === 'stations' ? current.OBJECT_NAME : `TEST ${group.toUpperCase()} ${i + 1}`,
    NORAD_CAT_ID: group === 'stations' ? 25544 : group === 'gps-ops' ? 100608 : 200000 + groups.indexOf(group) * 20000 + i,
    MEAN_MOTION: ['geo', 'gps-ops'].includes(group) ? (group === 'geo' ? 1.0027 : 2.0056) : current.MEAN_MOTION,
    MEAN_ANOMALY: (current.MEAN_ANOMALY + i * 0.23) % 360,
    RA_OF_ASC_NODE: (current.RA_OF_ASC_NODE + Math.floor(i / 22) * 4.7) % 360,
  }));
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Fetched-At': fetchedAt, 'X-Served-Stale': stale ? '1' : '0' });
    res.end(JSON.stringify(records));
  }, group === 'starlink' && n <= 2 ? 6000 : 0);
}).listen(8787, '127.0.0.1', () => console.log('TEST FIXTURES ONLY — API on http://127.0.0.1:8787; run npm run dev for the app.'));
