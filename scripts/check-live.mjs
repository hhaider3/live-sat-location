// Scheduled by CI: fails, and so notifies the repository owner, when the live site's
// catalogs are going stale. Deliberately separate from the offline test suite.
const SITE = process.env.SITE_URL ?? 'https://live-sat-location.hasanhaider009.workers.dev';
const DAY_MS = 86400000;
const SNAPSHOT_MAX_AGE_MS = 30 * DAY_MS; // shared/snapshot.ts
const STORED_MAX_AGE_MS = 12 * 3600000; // several missed two-hour cron runs

const failures = [];
const snapshotResponse = await fetch(`${SITE}/data/active.json`);
const { fetchedAt } = await snapshotResponse.json();
const remainingDays = (Date.parse(fetchedAt) + SNAPSHOT_MAX_AGE_MS - Date.now()) / DAY_MS;
console.log(`Deployed startup catalog expires in ${remainingDays.toFixed(1)} days.`);
if (!(remainingDays > 7)) failures.push('The deployed startup catalog is about to expire. Run npm run deploy.');

const apiResponse = await fetch(`${SITE}/api/omm?group=active`);
await apiResponse.body?.cancel();
const apiAge = Date.now() - Date.parse(apiResponse.headers.get('X-Fetched-At') ?? '');
console.log(`Active catalog API: ${apiResponse.status}, ${(apiAge / 3600000).toFixed(1)} hours old.`);
if (!apiResponse.ok || !(apiAge < STORED_MAX_AGE_MS)) failures.push('The active catalog is stale. Check Cron Events for the Worker.');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
