# Earth Orbit Live

An interactive 3D visualization of Earth-orbiting satellites, built with React, Three.js, and `satellite.js`. The app loads current TLE data from CelesTrak, propagates live objects with SGP4, and falls back to clearly labeled simulated constellations when a data source is unavailable.

The visualization runs entirely in the browser and requires no backend.

## Features

- Interactive 3D Earth with atmosphere, stars, sunlight, and a readable night side
- Live SGP4 orbit propagation using CelesTrak TLE data
- Offline simulated-orbit fallbacks for unavailable groups
- Clear `Live`, `Mixed`, `Offline`, and loading states
- Starlink, OneWeb, GPS, GLONASS, Galileo, BeiDou, Iridium, space station, geostationary, and science/weather groups
- Per-constellation visibility controls
- Pause, reverse, date selection, and return-to-now controls
- Logarithmic speed control from real time to accelerated simulation
- Responsive phone and desktop layouts
- Single-file production build for simple static hosting

## Controls

| Control | Action |
| --- | --- |
| Drag | Rotate the camera around Earth |
| Scroll or pinch | Zoom in and out |
| Pause/play | Stop or resume simulation time |
| Forward/reverse | Change the direction of time |
| Speed slider | Adjust the simulation speed |
| Speed presets | Select 1×, 60×, 10 min/s, 1 h/s, or 1 d/s |
| Date and time | Jump to a specific simulation time |
| Now | Return to the current time |
| Constellation entry | Show or hide that group |

The simulation starts at **1× real-time speed**. On phone-sized screens, the constellation panel starts collapsed to leave more room for the visualization.

## Getting Started

### Requirements

- Node.js 20.19 or newer
- npm
- A browser with WebGL support

### Install and run

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`.

### Production build

```bash
npm run build
```

The generated site is written to `dist/`. The build uses `vite-plugin-singlefile`, so the application code and styles are bundled into `dist/index.html`.

Preview the production build locally with:

```bash
npm run preview
```

## Deploying to GitHub Pages

This project is a static site. Configure GitHub Pages to deploy the `dist/` directory from a GitHub Actions workflow:

1. Install dependencies with `npm ci`.
2. Build the project with `npm run build`.
3. Upload `dist/` as the Pages artifact.
4. Deploy the artifact with GitHub's Pages deployment action.

Although the application is built as a single HTML file, it still requests live TLE data and the Blue Marble Earth texture at runtime. If those requests fail, the app uses its built-in orbital and procedural-Earth fallbacks.

## Data and Orbit Model

Live orbital elements are requested from [CelesTrak](https://celestrak.org/) in TLE format. Live satellite positions are propagated in the browser using [satellite.js](https://github.com/shashwatak/satellite-js) and the SGP4 model.

When a group cannot be fetched or parsed within the request timeout, the app creates a synthetic circular-orbit approximation for that group. Simulated groups are marked with `sim` in the constellation panel and are included in the `Mixed` or `Offline` status rather than being presented as live data.

## Technology

- [React](https://react.dev/) for the interface and application state
- [Three.js](https://threejs.org/) for WebGL rendering
- [satellite.js](https://github.com/shashwatak/satellite-js) for TLE parsing and SGP4 propagation
- [Tailwind CSS](https://tailwindcss.com/) for styling
- [Vite](https://vite.dev/) for development and production builds
- TypeScript for static type checking

## Project Structure

```text
src/
├── App.tsx         # Interface, controls, loading state, and constellation visibility
├── engine.ts       # Three.js scene, animation loop, rendering, and resource cleanup
├── satellites.ts   # TLE loading, SGP4 propagation, and simulated fallbacks
├── index.css       # Tailwind CSS entry point
└── main.tsx        # React application entry point
```

## Accuracy Notice

This project is intended for visualization and educational use. TLE-based positions are approximate and depend on the age and quality of the source elements. Simulated fallback objects do not represent current real-world satellite positions. Do not use this application for navigation, conjunction assessment, spacecraft operations, or other safety-critical decisions.

## Contributing

Issues and pull requests are welcome. For code changes, verify the project before submitting:

```bash
npx tsc --noEmit
npm run build
npm audit
```

