import { PerspectiveCamera, Ray, Sphere, Vector3 } from 'three';

interface PickableGroup {
  positions: Float32Array;
  points: { visible: boolean };
}
interface Viewport { left: number; top: number; width: number; height: number }

/** Pick the nearest drawn dot in CSS pixels, using the current world-space
 * positions. Three's cached geometry bounds do not follow our moving buffers.
 */
export function pickSatellite<T extends PickableGroup>(groups: readonly T[], camera: PerspectiveCamera,
  viewport: Viewport, x: number, y: number, earthRadius: number, radius = 8): { g: T; i: number } | null {
  const { left, top, width, height } = viewport;
  if (width <= 0 || height <= 0 || x < left || x > left + width || y < top || y > top + height) return null;
  camera.updateMatrixWorld();
  const position = new Vector3();
  const projected = new Vector3();
  const ray = new Ray(camera.position.clone(), new Vector3());
  const earth = new Sphere(new Vector3(), earthRadius);
  const hit = new Vector3();
  let nearest = radius * radius;
  let nearestDepth = Infinity;
  let target: { g: T; i: number } | null = null;
  for (const g of groups) {
    if (!g.points.visible) continue;
    for (let offset = 0; offset < g.positions.length; offset += 3) {
      position.fromArray(g.positions, offset);
      projected.copy(position).applyMatrix4(camera.matrixWorldInverse);
      if (projected.z > -camera.near || projected.z < -camera.far) continue;
      projected.applyMatrix4(camera.projectionMatrix);
      if (!Number.isFinite(projected.x + projected.y + projected.z) || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) continue;
      const dx = left + (projected.x + 1) * width / 2 - x;
      const dy = top + (1 - projected.y) * height / 2 - y;
      const distance = dx * dx + dy * dy;
      if (distance > nearest) continue;
      const depth = camera.position.distanceTo(position);
      if (distance === nearest && depth >= nearestDepth) continue;
      ray.direction.subVectors(position, camera.position).normalize();
      if (ray.intersectSphere(earth, hit) && camera.position.distanceTo(hit) < depth - 1e-4) continue;
      nearest = distance;
      nearestDepth = depth;
      target = { g, i: offset / 3 };
    }
  }
  return target;
}

interface PointerSample { pointerId: number; button: number; clientX: number; clientY: number }

/** A tap must stay within the movement threshold for the entire gesture.
 * Releasing a pinch or dragging back to the start must never select a dot.
 */
export class SatelliteTapGesture {
  private pointers = new Set<number>();
  private press: { id: number; x: number; y: number; dragged: boolean } | null = null;

  get active() { return this.pointers.size > 0; }

  down(event: PointerSample) {
    this.pointers.add(event.pointerId);
    this.press = event.button === 0 && this.pointers.size === 1
      ? { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false } : null;
  }

  move(event: PointerSample) {
    if (this.press?.id === event.pointerId && Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) > 6) {
      this.press.dragged = true;
    }
  }

  up(event: PointerSample): boolean {
    this.move(event);
    const tap = event.button === 0 && this.press?.id === event.pointerId && !this.press.dragged && this.pointers.size === 1;
    this.cancel(event);
    return tap;
  }

  cancel(event: Pick<PointerSample, 'pointerId'>) {
    this.pointers.delete(event.pointerId);
    this.press = null;
  }
}
