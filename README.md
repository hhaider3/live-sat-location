# Earth Orbit Live

![Earth Orbit Live showing multicolored satellite paths around the planet](public/assets/earth-orbit-social.png)

An interactive 3D satellite explorer built with React, Three.js, and satellite.js. Search the catalog, follow a satellite, explore its orbit and ground track, or calculate passes over a city.

**Live demo:** [live-sat-location.hasanhaider009.workers.dev](https://live-sat-location.hasanhaider009.workers.dev/)

Rendering and orbit propagation run in the browser. A small Cloudflare Worker serves and caches CelesTrak's OMM-compatible JSON feed; without that API, the app uses explicitly labeled simulated constellations.

## Features

- Search by satellite name or catalog ID, including six- and nine-digit IDs
- Find ISS, follow the selected satellite, and reset the camera
- Show/hide or isolate a constellation; restore all groups in one click
- Altitude, inertial velocity, geodetic latitude/longitude, orbital period, and inclination
- Selected orbit path and Earth-fixed ground track over the next orbit
- Optional equator and altitude reference rings for LEO, GPS, and GEO
- Satellite point size/brightness controls and a background-star toggle
- Independent playback status and Fresh / Stale / Simulated data indicators
- Element epoch and last successful fetch on the selected satellite
- Pause, reverse, logarithmic speed presets, local date entry, and an atomic return to live time
- Geometric pass predictions above 10° elevation over the next 24 hours for preset cities or custom coordinates
- Responsive panels, keyboard-accessible search, labeled controls, and visible focus indicators
- Background Web Workers for synchronized catalog propagation and pass calculations
- Incremental group updates that preserve existing scene objects and selection
- Single-file application build, including inline Web Workers

## Controls

| Control | Action |
| --- | --- |
| Drag / scroll / pinch | Rotate / zoom |
| Click a satellite | Show details and its orbit |
| `/` | Focus satellite search |
| Arrow down/up in results | Browse search results |
| Enter | Select a result (or the first match from the search input) |
| `Esc` | Clear search when searching; otherwise deselect |
| Space | Pause/play when outside an interactive control |
| Find ISS | Select the real ISS if available, or the labeled simulated ISS |
| Follow satellite | Move the camera along with the selected satellite |
| Reset view | Stop following and return to the initial Earth view |
| Constellation / ◎ | Toggle visibility / isolate that group |
| Show all | Restore every constellation, including groups still loading |
| Return to live | Current time, forward, 1×, unpaused |
| Jump & pause | Jump to the entered local time and pause |
| Upcoming passes → View peak | Pause at the predicted pass peak |

The main clock is UTC. Date entry is explicitly labeled with the browser's local timezone. Pass times are UTC. On smaller screens the constellation drawer and extra time controls start collapsed; the satellite detail panel can also be collapsed.

## Development

Node.js 20.19+ and npm are required.

```bash
npm ci

# Terminal 1: build assets and start the local Worker API on port 8787
npm run dev:worker

# Terminal 2: Vite app with /api proxied to the Worker
npm run dev
```

Open the URL printed by Vite, usually [localhost:5173](http://localhost:5173).

Without the Worker, the frontend falls back to simulated objects. `npm run preview` previews static assets only; use `npm run dev:worker` and open port 8787 to test the production build with its API. Editing app source requires rebuilding when viewing the Worker's static assets.

```bash
npm run check       # TypeScript, focused tests, production build
npm audit           # dependency advisories
npm run build       # produces dist/index.html
npm run deploy      # build and deploy Worker + assets to Cloudflare
```

For repeatable UI checks without CelesTrak, run `node scripts/preview-fixtures.mjs` in place of the Worker, then start Vite. This local-only API serves explicitly named test objects, a delayed 12,000-object group, a stale group, and one unavailable group. It is never bundled into the app.

The GitHub Actions workflow runs the checks and dependency audit on pushes and pull requests. Tests use fixed orbital fixtures and mocked upstream/cache responses, so they do not depend on a live data source.

## Data and freshness

`GET /api/omm?group=stations` requests a supported group. The proxy requests `FORMAT=JSON`, validates records, and caches a good response for two hours. A retained copy can be served during outages for up to 30 days, subject to Cloudflare cache eviction. Cache entries are best effort and are not durable storage. Invalid responses never replace a good cached copy. Upstream requests time out after 10 seconds. `/api/tle` remains available as a rolling-deployment compatibility endpoint; the client tries it automatically when an older Worker is still serving the site or the OMM route is temporarily unavailable.

Responses preserve `X-Fetched-At`, indicate stale fallback through `X-Served-Stale`, and report rejected records. The client validates elements again, checks propagation at the element epoch, deduplicates catalog IDs within each group, and ignores nonfinite states. Bare OMM epochs are interpreted as UTC.

- **Fresh:** fetched within two hours, with element epochs within 3.5 days of wall-clock time.
- **Stale:** old or unknown fetch time, older element epochs, or a cached response served during an outage.
- **Simulated:** a synthetic circular constellation, not observed satellite positions.

These freshness thresholds are display heuristics, not accuracy guarantees. A separate notice appears when the displayed simulation time is more than 3.5 days from a selected object's epoch. Live time only describes playback. A simulated object's selection and pass panels always identify it as simulated.

Groups refresh every two hours while visible and after returning to an expired catalog, with a manual refresh control. If a refresh fails, an already loaded observed group is retained and marked stale instead of being replaced by synthetic objects. Selection is preserved by group and catalog ID when data changes.

OMM avoids the legacy TLE catalog-number limit. See [CelesTrak's GP formats documentation](https://celestrak.org/NORAD/documentation/gp-data-formats.php) and [satellite.js](https://github.com/shashwatak/satellite-js).

## Simulation model

All visible groups are propagated in a Web Worker at the same pair of timestamps. Complete snapshots are published together, and the renderer uses one interpolation fraction for the entire catalog. Snapshot intervals are capped at 30 simulated seconds to limit straight-line interpolation error. At extreme playback speeds the view skips ahead between snapshots rather than interpolating across long orbital arcs. Displayed time, Earth rotation, and selected-object details follow the rendered snapshot. The simulation clock uses wall-clock anchors to avoid cumulative frame drift and recover after backgrounding. A synchronous snapshot fallback is available if Web Workers cannot start.

The Earth is rendered as a mean-radius sphere; latitude, longitude, and altitude use satellite.js's geodetic conversion. Guide rings illustrate equatorial radii, not orbital boundaries in every direction. The selected ground track projects future positions onto the rotating globe. The blue-marble texture is loaded from a CDN, with a procedural fallback if unavailable.

Pass predictions scan the next 24 hours at 10-second intervals, refine threshold crossings to about half a second, and report peak elevation at the sampling resolution. They assume a sea-level observer and a 10° minimum elevation. Daylight, clouds, terrain, and satellite illumination are not modeled; a geometric pass is not a promise of naked-eye visibility. Predictions are calculated on demand from the displayed time and must be recalculated after changing it. Simulated pass predictions are illustrative only.

This project is for visualization and education. Do not use it for navigation, conjunction assessment, or spacecraft operations.

## Structure

```text
src/
  App.tsx                 Interface, search, data lifecycle, and playback controls
  PassPlanner.tsx         City/coordinate input and pass results
  engine.ts               Three.js rendering, selection, tracking, and overlays
  satellites.ts           OMM ingestion, freshness, propagation, and synthetic groups
  propagation.ts          Timestamped snapshots and interpolation
  propagation.worker.ts   Background catalog propagation
  passes.ts               Geometric pass calculation
  passes.worker.ts        Background pass calculation
  time.ts                 Anchored simulation clock
shared/omm.ts             Shared orbital record validation
worker/index.js           Cloudflare request routing
worker/proxy.js           Cached CelesTrak JSON proxy
scripts/test.mjs          Isolated test build and runner
tests/                   Orbital, playback, and proxy regression tests
```
