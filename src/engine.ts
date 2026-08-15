import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  LoadedGroup,
  R_EARTH,
  Sat,
  eciPosition,
  eciState,
  gmst,
  sampleOrbitPath,
} from "./satellites";

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
}

export interface SatSelection {
  key: string;
  label: string;
  color: string;
  name: string;
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
  clearSelection(): void;
  dispose(): void;
}

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
    opacity: 0.75,
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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x01020a);
  let disposed = false;

  const camera = new THREE.PerspectiveCamera(
    50,
    container.clientWidth / container.clientHeight,
    0.05,
    6000
  );
  camera.position.set(18, 10, 22);

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
  let flat: { g: GroupRender; i: number }[] = [];
  let cursor = 0;

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
    flat = [];
  }

  function setGroups(groups: LoadedGroup[]) {
    if (disposed) return;
    clearGroupRenders();
    const now = new Date(simTime);
    for (const g of groups) {
      const positions = new Float32Array(g.sats.length * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < g.sats.length; i++) {
        const p = eciPosition(g.sats[i], now);
        if (p) {
          eciToScene(p, v);
          positions.set([v.x, v.y, v.z], i * 3);
        } else {
          positions.set([HIDDEN, HIDDEN, HIDDEN], i * 3);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: new THREE.Color(g.color),
        size: g.key === "stations" ? 9 : g.key === "starlink" ? 3.2 : 4.4,
        sizeAttenuation: false,
        map: sprite,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      scene.add(points);
      const gr: GroupRender = {
        key: g.key,
        label: g.label,
        colorCss: g.color,
        sats: g.sats,
        points,
        positions,
      };
      groupRenders.push(gr);
      for (let i = 0; i < g.sats.length; i++) flat.push({ g: gr, i });
    }
    cursor = 0;
  }

  // ---------- Time control ----------
  let simTime = Date.now();
  let speed = 1;
  let paused = false;

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
    raycaster.params.Points.threshold = Math.max(0.1, camera.position.length() * 0.012);
    const hits = raycaster.intersectObjects(
      visible.map((g) => g.points),
      false
    );
    for (const hit of hits) {
      if (hit.index === undefined || !hit.point) continue;
      if (isOccludedByEarth(hit.point)) continue;
      const g = visible.find((gr) => gr.points === hit.object);
      if (g) return { g, i: hit.index };
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
  }

  function emitSelection() {
    if (!onSelect) return;
    if (!selected) {
      onSelect(null);
      return;
    }
    const sat = selected.g.sats[selected.i];
    const st = eciState(sat, new Date(simTime));
    onSelect({
      key: selected.g.key,
      label: selected.g.label,
      color: selected.g.colorCss,
      name: sat.name,
      altitudeKm: st ? Math.hypot(st.x, st.y, st.z) - R_EARTH : NaN,
      velocityKmS: st ? Math.hypot(st.vx, st.vy, st.vz) : NaN,
    });
  }

  function selectTarget(target: { g: GroupRender; i: number } | null) {
    if (disposed) {
      selected = null;
      return;
    }
    selected = target;
    if (selected) {
      orbitMat.color.set(selected.g.colorCss);
      rebuildOrbit();
    } else {
      orbitLine.visible = false;
      selectionRing.visible = false;
    }
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
    if (e.key === "Escape") selectTarget(null);
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
      selectionRing.scale.setScalar(camera.position.length() * 0.035);
    }
    if (Math.abs(simTime - orbitEpochMs) > ORBIT_REFRESH_MS) rebuildOrbit();
  }

  // ---------- Loop ----------
  const timer = new THREE.Timer();
  timer.connect(document);
  const tmp = new THREE.Vector3();
  let raf = 0;
  let fpsAcc = 0;
  let fpsFrames = 0;
  let fps = 60;
  let lastUi = 0;

  const BATCH = 2600;

  function animate(timestamp?: number) {
    raf = requestAnimationFrame(animate);
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.25);
    if (!paused) simTime += dt * 1000 * speed;
    const date = new Date(simTime);

    // Earth rotation (GMST) — the equirectangular texture's prime meridian is
    // centered on local +X, so no additional longitude offset is needed.
    earth.rotation.y = gmst(date);

    // Sun direction
    const s = sunDirectionECI(date);
    sun.position.set(s.x * 100, s.z * 100, -s.y * 100);

    // Propagate a batch of satellites
    if (flat.length > 0) {
      const n = Math.min(BATCH, flat.length);
      const touched = new Set<GroupRender>();
      for (let k = 0; k < n; k++) {
        const { g, i } = flat[cursor];
        cursor = (cursor + 1) % flat.length;
        if (!g.points.visible) continue;
        const p = eciPosition(g.sats[i], date);
        if (p) {
          eciToScene(p, tmp);
          g.positions[i * 3] = tmp.x;
          g.positions[i * 3 + 1] = tmp.y;
          g.positions[i * 3 + 2] = tmp.z;
        } else {
          g.positions[i * 3] = HIDDEN;
        }
        touched.add(g);
      }
      for (const g of touched)
        (g.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }

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
      if (g) g.points.visible = visible;
      if (!visible && selected?.g.key === key) selectTarget(null);
    },
    setSpeed(m) {
      speed = m;
    },
    setPaused(p) {
      paused = p;
    },
    setTime(ms) {
      simTime = ms;
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
      tooltip.remove();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
