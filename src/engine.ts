import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  LoadedGroup,
  R_EARTH,
  Sat,
  eciPosition,
  eciState,
  geographicPosition,
  orbitPeriodMin,
  sampleGroundTrack,
  gmst,
  sampleOrbitPath,
} from "./satellites";

import PropagationWorker from './propagation.worker?worker&inline';
import { buildSnapshot, interpolatePositions, snapshotTime, type PropagationRequest, type Snapshot } from './propagation';
import { SimulationClock } from './time';

const KM_TO_UNITS = 1 / 1000; // 1 scene unit = 1000 km
const EARTH_RADIUS = 6371 * KM_TO_UNITS;
const HIDDEN = 1e6; // park failed sats far away

interface GroupRender {
  key: string;
  label: string;
  colorCss: string;
  sats: Sat[];
  points: THREE.Points;
  positions: Float32Array;
  data: LoadedGroup;
  baseSize: number;
}

export interface SatSelection {
  key: string;
  label: string;
  color: string;
  name: string;
  id: string;
  latitude: number;
  longitude: number;
  periodMin: number;
  inclination: number;
  following: boolean;
  altitudeKm: number;
  velocityKmS: number;
}

export interface Engine {
  setGroups(groups: LoadedGroup[]): void;
  setGroupVisible(key: string, visible: boolean): void;
  setSpeed(multiplier: number): void;
  setPaused(paused: boolean): void;
  setTime(ms: number): void;
  getTime(): number;
  returnToLive(): void;
  selectSatellite(key: string, id: string): void;
  setFollowing(follow: boolean): void;
  resetView(): void;
  setDisplay(options: DisplayOptions): void;
  clearSelection(): void;
  dispose(): void;
}

export interface DisplayOptions {
  pointSize: number;
  brightness: number;
  stars: boolean;
  groundTrack: boolean;
  guides: boolean;
}
export const DEFAULT_DISPLAY: DisplayOptions = { pointSize: 0.85, brightness: 0.75, stars: true, groundTrack: true, guides: false };

// ---------- Procedural fallback earth texture ----------
function proceduralEarthTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, "#0b2d52");
  grad.addColorStop(0.5, "#0e3a66");
  grad.addColorStop(1, "#0b2d52");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 512);
  // pseudo-random continents
  ctx.fillStyle = "#1d4d2b";
  let seed = 42;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 260; i++) {
    const x = rnd() * 1024;
    const y = 80 + rnd() * 350;
    const r = 8 + rnd() * 42;
    ctx.beginPath();
    ctx.ellipse(x, y, r * (0.6 + rnd()), r * 0.5, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // ice caps
  ctx.fillStyle = "#dbe9f4";
  ctx.fillRect(0, 0, 1024, 26);
  ctx.fillRect(0, 486, 1024, 26);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStars(): THREE.Points {
  const N = 4000;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(1500 + Math.random() * 800);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

function sunDirectionECI(date: Date): THREE.Vector3 {
  // Low-precision solar position (good enough for lighting)
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const g = ((357.529 + 0.98560028 * d) * Math.PI) / 180;
  const q = ((280.459 + 0.98564736 * d) * Math.PI) / 180;
  const L = q + ((1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI) / 180;
  const e = (23.439 * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(L), Math.cos(e) * Math.sin(L), Math.sin(e) * Math.sin(L));
}

const eciToScene = (p: { x: number; y: number; z: number }, out: THREE.Vector3) =>
  out.set(p.x * KM_TO_UNITS, p.z * KM_TO_UNITS, -p.y * KM_TO_UNITS);

export function createEngine(
  container: HTMLElement,
  onTick?: (simTimeMs: number, fps: number) => void,
  onSelect?: (selection: SatSelection | null) => void
): Engine {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  renderer.domElement.setAttribute("aria-label", "3D Earth and satellite orbits. Use satellite search to select an object with the keyboard.");
  renderer.domElement.setAttribute("role", "img");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x01020a);
  let disposed = false;

  const camera = new THREE.PerspectiveCamera(
    50,
    container.clientWidth / container.clientHeight,
    0.05,
    6000
  );
  camera.position.set(18, 10, 22).multiplyScalar(Math.max(1, 0.7 / camera.aspect));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = EARTH_RADIUS * 1.15;
  controls.maxDistance = 300;

  // Lights
  const sun = new THREE.DirectionalLight(0xfff5e0, 2.6);
  scene.add(sun);
  // A cool ambient fill keeps the night-side texture legible without flattening the sun lighting.
  scene.add(new THREE.AmbientLight(0x789bc4, 1.15));

  // Earth
  const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS, 96, 96);
  const fallbackEarthTexture = proceduralEarthTexture();
  const earthTextures = new Set<THREE.Texture>([fallbackEarthTexture]);
  const earthMat = new THREE.MeshPhongMaterial({
    map: fallbackEarthTexture,
    specular: new THREE.Color(0x111a2a),
    shininess: 12,
  });
  const earth = new THREE.Mesh(earthGeo, earthMat);
  scene.add(earth);

  // Try loading a real Blue Marble texture from CDN
  const remoteEarthTexture = new THREE.TextureLoader().load(
    "https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg",
    (tex) => {
      if (disposed) return;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      earthMat.map = tex;
      earthMat.needsUpdate = true;
      fallbackEarthTexture.dispose();
      earthTextures.delete(fallbackEarthTexture);
    },
    undefined,
    () => {/* keep procedural texture */}
  );
  earthTextures.add(remoteEarthTexture);

  // Atmosphere glow (backside shell)
  const atmMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    uniforms: { c: { value: new THREE.Color(0x4a9eff) } },
    vertexShader: `
      varying vec3 vN; varying vec3 vP;
      void main(){ vN = normalize(normalMatrix * normal); vP = (modelViewMatrix * vec4(position,1.)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `
      uniform vec3 c; varying vec3 vN; varying vec3 vP;
      void main(){ float i = pow(0.72 - dot(vN, normalize(-vP)), 3.5);
        gl_FragColor = vec4(c, clamp(i, 0., 1.) * 0.9); }`,
  });
  const atmGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.09, 64, 64);
  const atmosphere = new THREE.Mesh(atmGeo, atmMat);
  scene.add(atmosphere);

  const stars = makeStars();
  scene.add(stars);

  // ---------- Satellite groups ----------
  let groupRenders: GroupRender[] = [];
  let display = { ...DEFAULT_DISPLAY };

  function circleSprite(): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,255,255,0.9)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  }
  const sprite = circleSprite();

  function ringSprite(): THREE.Texture {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(32, 32, 24, 0, Math.PI * 2);
    ctx.stroke();
    return new THREE.CanvasTexture(c);
  }

  function clearGroupRenders() {
    if (selected) selectTarget(null);
    for (const gr of groupRenders) {
      scene.remove(gr.points);
      gr.points.geometry.dispose();
      (gr.points.material as THREE.Material).dispose();
    }
    groupRenders = [];

  }

  function setGroups(groups: LoadedGroup[]) {
    if (disposed) return;
    const previous = selected ? { key: selected.g.key, id: selected.g.sats[selected.i].id, following } : null;
    let changed = false;
    for (const old of [...groupRenders]) {
      if (groups.some(g => g.key === old.key && g.sats === old.sats)) {
        old.data = groups.find(g => g.key === old.key)!;
        continue;
      }
      scene.remove(old.points);
      old.points.geometry.dispose();
      (old.points.material as THREE.Material).dispose();
      groupRenders = groupRenders.filter(g => g !== old);
      propagationWorker?.postMessage({ type: 'remove', key: old.key });
      changed = true;
    }
    for (const g of groups) {
      if (groupRenders.some(old => old.key === g.key)) continue;
      const positions = new Float32Array(g.sats.length * 3).fill(HIDDEN);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      const baseSize = g.key === 'stations' ? 9 : g.key === 'starlink' ? 3.2 : 4.4;
      const mat = new THREE.PointsMaterial({ color: new THREE.Color(g.color),
        size: baseSize * display.pointSize, sizeAttenuation: false, map: sprite,
        transparent: true, opacity: display.brightness, depthWrite: false, blending: THREE.AdditiveBlending });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      scene.add(points);
      groupRenders.push({ key: g.key, label: g.label, colorCss: g.color, sats: g.sats,
        points, positions, data: g, baseSize });
      propagationWorker?.postMessage({ type: 'upsert', key: g.key, sats: g.sats });
      changed = true;
    }
    if (previous && !groupRenders.includes(selected!.g)) {
      const g = groupRenders.find(g => g.key === previous.key);
      const i = g?.sats.findIndex(s => s.id === previous.id) ?? -1;
      selectTarget(g && i >= 0 ? { g, i } : null);
      following = !!selected && previous.following;
    }
    if (changed) invalidateSnapshots();
  }

  // ---------- Time and propagation ----------
  const clock = new SimulationClock();
  let simTime = clock.time(); // timestamp shared by all currently rendered objects
  let snapshot: Snapshot | null = null;
  let generation = 0;
  let pending = false;
  let lastRequest = -Infinity;
  let propagationWorker: Worker | null = null;
  try {
    propagationWorker = new PropagationWorker();
    propagationWorker.onmessage = (event: MessageEvent<Snapshot>) => {
      pending = false;
      if (!disposed && event.data.generation === generation) snapshot = event.data;
    };
    propagationWorker.onerror = () => {
      propagationWorker?.terminate(); propagationWorker = null; pending = false;
    };
  } catch { /* same snapshot algorithm remains available without Worker support */ }

  function invalidateSnapshots() {
    generation++;
    snapshot = null;
    lastRequest = -Infinity;
  }

  function updatePositions(now: number) {
    const desired = clock.time();
    const running = !clock.paused;
    const step = running ? Math.sign(clock.speed) * Math.min(30000, Math.max(1000, Math.abs(clock.speed) * 120)) : 0;
    const interval = Math.max(16, Math.min(100, 10000 / Math.max(1, Math.abs(clock.speed))));
    if (!pending && (!snapshot || (running && now - lastRequest >= interval))) {
      const request: Extract<PropagationRequest, { type: 'sample' }> = {
        type: 'sample', keys: groupRenders.filter(g => g.points.visible).map(g => g.key),
        generation, start: desired, end: desired + step,
      };
      lastRequest = now;
      if (propagationWorker) { pending = true; propagationWorker.postMessage(request); }
      else snapshot = buildSnapshot(new Map(groupRenders.map(g => [g.key, g.sats])), request);
    }
    if (!snapshot) {
      if (!groupRenders.length) simTime = desired;
      return;
    }
    simTime = snapshotTime(snapshot, desired);
    const alpha = snapshot.end === snapshot.start ? 0 : (simTime - snapshot.start) / (snapshot.end - snapshot.start);
    for (const pair of snapshot.groups) {
      const g = groupRenders.find(g => g.key === pair.key);
      if (!g || g.positions.length !== pair.a.length) continue;
      interpolatePositions(pair.a, pair.b, alpha, g.positions);
      (g.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  // ---------- Selection & hover ----------
  const ORBIT_SAMPLES = 256;
  const ORBIT_REFRESH_MS = 5 * 60 * 1000; // re-sample the path as it precesses

  const ringTex = ringSprite();
  const ringMat = new THREE.SpriteMaterial({
    map: ringTex,
    color: 0xffffff,
    transparent: true,
    depthTest: false, // the marker stays findable even behind Earth
  });
  const selectionRing = new THREE.Sprite(ringMat);
  selectionRing.visible = false;
  scene.add(selectionRing);

  const orbitGeometry = new THREE.BufferGeometry();
  const orbitPositions = new Float32Array(ORBIT_SAMPLES * 3);
  orbitGeometry.setAttribute("position", new THREE.BufferAttribute(orbitPositions, 3));
  const orbitMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.55,
  });
  const orbitLine = new THREE.LineLoop(orbitGeometry, orbitMat);
  orbitLine.frustumCulled = false;
  orbitLine.visible = false;
  scene.add(orbitLine);

  let selected: { g: GroupRender; i: number } | null = null;
  let orbitEpochMs = 0;
  let following = false;
  const previousTarget = new THREE.Vector3();
  const trackGeometry = new THREE.BufferGeometry();
  const trackPositions = new Float32Array(ORBIT_SAMPLES * 3);
  trackGeometry.setAttribute('position', new THREE.BufferAttribute(trackPositions, 3));
  const trackMaterial = new THREE.LineBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.85 });
  const track = new THREE.Line(trackGeometry, trackMaterial);
  track.frustumCulled = false;
  track.visible = false;
  scene.add(track);

  const guides = new THREE.Group();
  for (const [altitude, color] of [[0, 0x5eead4], [2000, 0x38bdf8], [20180, 0xfacc15], [35786, 0xc4b5fd]]) {
    const r = (R_EARTH + altitude + 15) * KM_TO_UNITS;
    const points = Array.from({ length: 256 }, (_, i) => new THREE.Vector3(r * Math.cos(i / 256 * Math.PI * 2), 0, r * Math.sin(i / 256 * Math.PI * 2)));
    guides.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 })));
  }
  guides.visible = false;
  scene.add(guides);

  function setFollowing(value: boolean) {
    following = value && !!selected;
    if (following && selected) {
      const p = eciPosition(selected.g.sats[selected.i], new Date(simTime));
      if (p) {
        eciToScene(p, previousTarget);
        controls.target.copy(previousTarget);
        camera.position.copy(previousTarget).add(previousTarget.clone().normalize().multiplyScalar(12));
        controls.minDistance = 1;
      }
    } else {
      controls.target.set(0, 0, 0);
      controls.minDistance = EARTH_RADIUS * 1.15;
    }
    controls.update();
    emitSelection();
  }

  function resetView() {
    following = false;
    controls.target.set(0, 0, 0);
    camera.position.set(18, 10, 22).multiplyScalar(Math.max(1, 0.7 / camera.aspect));
    controls.minDistance = EARTH_RADIUS * 1.15;
    controls.update();
    emitSelection();
  }


  // Engine-owned tooltip so hover never triggers React renders.
  const tooltip = document.createElement("div");
  tooltip.style.cssText = [
    "position:absolute",
    "left:0",
    "top:0",
    "z-index:30",
    "pointer-events:none",
    "padding:4px 9px",
    "border-radius:8px",
    "background:rgba(2,6,23,0.85)",
    "border:1px solid rgba(255,255,255,0.18)",
    "color:#e2e8f0",
    "font:600 11px/1.4 ui-sans-serif,system-ui,sans-serif",
    "white-space:nowrap",
    "display:none",
  ].join(";");
  container.appendChild(tooltip);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const earthSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), EARTH_RADIUS);
  const pickDir = new THREE.Vector3();
  const pickRay = new THREE.Ray();
  const sphereHit = new THREE.Vector3();

  let pointerX = 0;
  let pointerY = 0;
  let pointerMoved = false;
  let pointerIsMouse = false;
  let downX = 0;
  let downY = 0;

  function isOccludedByEarth(p: THREE.Vector3): boolean {
    pickDir.subVectors(p, camera.position);
    const dist = pickDir.length();
    pickRay.origin.copy(camera.position);
    pickRay.direction.copy(pickDir.normalize());
    const hit = pickRay.intersectSphere(earthSphere, sphereHit);
    return hit !== null && camera.position.distanceTo(hit) < dist - 1e-4;
  }

  function pickAt(x: number, y: number): { g: GroupRender; i: number } | null {
    const visible = groupRenders.filter((g) => g.points.visible);
    if (visible.length === 0) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    raycaster.params.Points.threshold = Math.max(0.1, camera.position.distanceTo(controls.target) * 0.007);
    const hits = raycaster.intersectObjects(
      visible.map((g) => g.points),
      false
    );
    for (const hit of hits) {
      if (hit.index === undefined) continue;
      const g = visible.find((gr) => gr.points === hit.object);
      if (!g || g.positions[hit.index * 3] >= HIDDEN * 0.5) continue;
      const actual = new THREE.Vector3().fromArray(g.positions, hit.index * 3);
      if (!isOccludedByEarth(actual)) return { g, i: hit.index };
    }
    return null;
  }

  function rebuildOrbit() {
    if (!selected) return;
    const sat = selected.g.sats[selected.i];
    const ok = sampleOrbitPath(sat, new Date(simTime), ORBIT_SAMPLES, orbitPositions);
    if (ok) {
      for (let k = 0; k < ORBIT_SAMPLES; k++) {
        const x = orbitPositions[k * 3];
        const y = orbitPositions[k * 3 + 1];
        const z = orbitPositions[k * 3 + 2];
        // ECI (x, y, z) -> scene (x, z, -y)
        orbitPositions[k * 3] = x * KM_TO_UNITS;
        orbitPositions[k * 3 + 1] = z * KM_TO_UNITS;
        orbitPositions[k * 3 + 2] = -y * KM_TO_UNITS;
      }
      (orbitGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      orbitEpochMs = simTime;
    }
    orbitLine.visible = ok;
    const trackOk = display.groundTrack && sampleGroundTrack(sat, new Date(simTime), ORBIT_SAMPLES, trackPositions);
    track.visible = trackOk;
    if (trackOk) (trackGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  function emitSelection() {
    if (!onSelect) return;
    if (!selected) {
      onSelect(null);
      return;
    }
    const sat = selected.g.sats[selected.i];
    const st = eciState(sat, new Date(simTime));
    const gd = geographicPosition(sat, new Date(simTime));
    onSelect({
      key: selected.g.key,
      label: selected.g.label,
      color: selected.g.colorCss,
      name: sat.name,
      id: sat.id,
      latitude: gd?.latitude ?? NaN,
      longitude: gd?.longitude ?? NaN,
      periodMin: orbitPeriodMin(sat),
      inclination: (sat.kind === 'sgp4' ? sat.satrec.inclo : sat.inc) * 180 / Math.PI,
      following,
      altitudeKm: gd?.altitudeKm ?? NaN,
      velocityKmS: st ? Math.hypot(st.vx, st.vy, st.vz) : NaN,
    });
  }

  function selectTarget(target: { g: GroupRender; i: number } | null) {
    if (disposed) {
      selected = null;
      return;
    }
    const wasFollowing = following;
    following = false;
    selected = target;
    if (selected) {
      orbitMat.color.set(selected.g.colorCss);
      rebuildOrbit();
    } else {
      orbitLine.visible = false;
      selectionRing.visible = false;
      track.visible = false;
    }
    if (wasFollowing) setFollowing(!!selected);
    emitSelection();
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
  };
  const onPointerMove = (e: PointerEvent) => {
    pointerX = e.clientX;
    pointerY = e.clientY;
    pointerIsMouse = e.pointerType === "mouse";
    pointerMoved = true;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // Only treat it as a click when the drag never really started; otherwise
    // it was a camera rotate/zoom.
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    selectTarget(pickAt(e.clientX, e.clientY));
  };
  const onPointerLeave = () => {
    pointerMoved = false;
    tooltip.style.display = "none";
    renderer.domElement.style.cursor = "";
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea, select")) selectTarget(null);
  };
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("keydown", onKeyDown);

  function updateHover() {
    if (!pointerMoved || !pointerIsMouse) return;
    pointerMoved = false;
    const target = pickAt(pointerX, pointerY);
    if (target) {
      tooltip.textContent = `${target.g.sats[target.i].name} · ${target.g.label}`;
      const rect = renderer.domElement.getBoundingClientRect();
      tooltip.style.transform = `translate(${pointerX - rect.left + 14}px, ${
        pointerY - rect.top - 34
      }px)`;
      tooltip.style.display = "block";
      renderer.domElement.style.cursor = "pointer";
    } else {
      tooltip.style.display = "none";
      renderer.domElement.style.cursor = "";
    }
  }

  function updateSelectionVisuals() {
    if (!selected) return;
    const i3 = selected.i * 3;
    const x = selected.g.positions[i3];
    if (x >= HIDDEN * 0.5) {
      selectionRing.visible = false; // propagation parked this satellite
    } else {
      selectionRing.visible = true;
      selectionRing.position.set(x, selected.g.positions[i3 + 1], selected.g.positions[i3 + 2]);
      selectionRing.scale.setScalar(camera.position.distanceTo(selectionRing.position) * 0.025);
      if (following) {
        camera.position.add(selectionRing.position.clone().sub(previousTarget));
        controls.target.copy(selectionRing.position);
        previousTarget.copy(selectionRing.position);
      }
    }
    if (Math.abs(simTime - orbitEpochMs) > ORBIT_REFRESH_MS) rebuildOrbit();
    track.rotation.y = gmst(new Date(simTime));
  }

  // ---------- Loop ----------
  const timer = new THREE.Timer();
  timer.connect(document);
  let raf = 0;
  let fpsAcc = 0;
  let fpsFrames = 0;
  let fps = 60;
  let lastUi = 0;


  function animate(timestamp?: number) {
    raf = requestAnimationFrame(animate);
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.25);
    updatePositions(performance.now());
    const date = new Date(simTime);

    // Earth rotation (GMST) — the equirectangular texture's prime meridian is
    // centered on local +X, so no additional longitude offset is needed.
    earth.rotation.y = gmst(date);

    // Sun direction
    const s = sunDirectionECI(date);
    sun.position.set(s.x * 100, s.z * 100, -s.y * 100);

    updateHover();
    updateSelectionVisuals();

    controls.update();
    renderer.render(scene, camera);

    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc >= 0.5) {
      fps = fpsFrames / fpsAcc;
      fpsAcc = 0;
      fpsFrames = 0;
    }
    const now = performance.now();
    if (onTick && now - lastUi > 200) {
      lastUi = now;
      onTick(simTime, fps);
      if (selected) emitSelection();
    }
  }
  animate();

  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener("resize", onResize);

  return {
    setGroups,
    setGroupVisible(key, visible) {
      const g = groupRenders.find((r) => r.key === key);
      if (g && g.points.visible !== visible) { g.points.visible = visible; invalidateSnapshots(); }
      if (!visible && selected?.g.key === key) selectTarget(null);
    },
    setSpeed(m) {
      if (clock.speed !== m) { clock.setSpeed(m); invalidateSnapshots(); }
    },
    setPaused(p) {
      if (clock.paused !== p) { clock.setPaused(p); invalidateSnapshots(); }
    },
    setTime(ms) { clock.setTime(ms); invalidateSnapshots(); orbitEpochMs = -Infinity; },
    returnToLive() { clock.returnToLive(); invalidateSnapshots(); orbitEpochMs = -Infinity; },
    selectSatellite(key, id) {
      const g = groupRenders.find(g => g.key === key);
      const i = g?.sats.findIndex(s => s.id === id) ?? -1;
      if (!g || i < 0) return;
      selectTarget({ g, i });
      if (!following) {
        const p = eciPosition(g.sats[i], new Date(simTime));
        if (p) {
          const v = new THREE.Vector3(); eciToScene(p, v);
          controls.target.set(0, 0, 0);
          camera.position.copy(v).normalize().multiplyScalar(Math.max(18, v.length() * 1.7));
          controls.update();
        }
      }
    },
    setFollowing,
    resetView,
    setDisplay(options) {
      display = { ...options };
      stars.visible = display.stars;
      guides.visible = display.guides;
      for (const g of groupRenders) {
        const mat = g.points.material as THREE.PointsMaterial;
        mat.size = g.baseSize * display.pointSize;
        mat.opacity = display.brightness;
      }
      if (selected) rebuildOrbit();
    },
    getTime() {
      return simTime;
    },
    clearSelection() {
      selectTarget(null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      propagationWorker?.terminate();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      timer.dispose();
      controls.dispose();
      clearGroupRenders();
      earthGeo.dispose();
      earthMat.dispose();
      earthTextures.forEach((texture) => texture.dispose());
      atmGeo.dispose();
      atmMat.dispose();
      stars.geometry.dispose();
      (stars.material as THREE.Material).dispose();
      sprite.dispose();
      ringTex.dispose();
      ringMat.dispose();
      orbitGeometry.dispose();
      orbitMat.dispose();
      trackGeometry.dispose(); trackMaterial.dispose();
      for (const line of guides.children as THREE.LineLoop[]) {
        line.geometry.dispose(); (line.material as THREE.Material).dispose();
      }
      tooltip.remove();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
