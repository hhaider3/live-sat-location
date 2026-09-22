import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferAttribute, BufferGeometry, PerspectiveCamera, Points, PointsMaterial, Raycaster, Vector2, Vector3 } from 'three';
import { pickSatellite, SatelliteTapGesture } from '../src/picking';

const viewport = { left: 40, top: 20, width: 800, height: 600 };
const center = { x: 440, y: 320 };
const camera = new PerspectiveCamera(50, viewport.width / viewport.height, 0.05, 6000);
camera.position.set(0, 0, 20);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const group = (...positions: number[]) => ({ points: { visible: true }, positions: new Float32Array(positions) });

test('satellites remain clickable after hovering before their first position update', () => {
  const positions = new Float32Array([1e6, 1e6, 1e6]);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const points = new Points(geometry, new PointsMaterial());
  const ray = new Raycaster();
  ray.setFromCamera(new Vector2(), camera);
  ray.intersectObject(points); // Initializes cached bounds at the parked coordinates.
  positions.set([0, 0, 2]);
  const moving = { positions, points };
  assert.deepEqual(pickSatellite([moving], camera, viewport, center.x, center.y, 1), { g: moving, i: 0 });
  positions.set([2, 0, 2]);
  const screen = new Vector3(2, 0, 2).project(camera);
  assert.equal(pickSatellite([moving], camera, viewport, viewport.left + (screen.x + 1) * viewport.width / 2, center.y, 1)?.i, 0);
  geometry.dispose(); (points.material as PointsMaterial).dispose();
});

test('pick the dot nearest the click, rather than a different satellite closer to the camera', () => {
  const satellites = group(0, 0, 2, 0.05, 0, 10);
  assert.equal(pickSatellite([satellites], camera, viewport, center.x, center.y, 1)?.i, 0);
  const overlapping = group(0, 0, 2, 0, 0, 10);
  assert.equal(pickSatellite([overlapping], camera, viewport, center.x, center.y, 1)?.i, 1);
});

test('pixel hit targets stay consistent at different zoom levels and support a larger touch radius', () => {
  for (const distance of [8, 30, 300]) {
    const zoomed = camera.clone(); zoomed.position.z = distance;
    const satellites = group(0, 0, 2);
    assert.equal(pickSatellite([satellites], zoomed, viewport, center.x + 7, center.y, 1)?.i, 0);
    assert.equal(pickSatellite([satellites], zoomed, viewport, center.x + 10, center.y, 1), null);
    assert.equal(pickSatellite([satellites], zoomed, viewport, center.x + 16, center.y, 1, 18)?.i, 0);
  }
});

test('Earth-hidden, filtered, offscreen, clipped and invalid satellites cannot be selected', () => {
  const hidden = group(0, 0, 2); hidden.points.visible = false;
  assert.equal(pickSatellite([hidden], camera, viewport, center.x, center.y, 1), null);
  for (const satellites of [group(0, 0, -2), group(0, 0, 0), group(0, 0, 21),
    group(1e6, 1e6, 1e6), group(NaN, 0, 2), group(100, 0, 2), group(0, 0, -7000)]) {
    assert.equal(pickSatellite([satellites], camera, viewport, center.x, center.y, 1), null);
  }
  const front = group(0, 0, 2);
  assert.equal(pickSatellite([front], camera, { ...viewport, width: 0 }, center.x, center.y, 1), null);
  assert.equal(pickSatellite([front], camera, viewport, 0, 0, 1), null);
});

const pointer = (pointerId = 1, clientX = 10, clientY = 10, button = 0) => ({ pointerId, clientX, clientY, button });

test('only a primary-button click or short single-finger tap selects a satellite', () => {
  const gesture = new SatelliteTapGesture();
  assert.equal(gesture.up(pointer()), false, 'release without a press');
  gesture.down(pointer()); gesture.move(pointer(1, 12));
  assert.equal(gesture.up(pointer(1, 13)), true);
  assert.equal(gesture.active, false);
  gesture.down(pointer(1, 10, 10, 2));
  assert.equal(gesture.up(pointer(1, 10, 10, 2)), false);
});

test('dragging out and back, pinching, and pointer cancellation never select a satellite', () => {
  const gesture = new SatelliteTapGesture();
  gesture.down(pointer()); gesture.move(pointer(1, 25)); gesture.move(pointer());
  assert.equal(gesture.up(pointer()), false);
  gesture.down(pointer()); gesture.down(pointer(2));
  assert.equal(gesture.up(pointer(2)), false);
  assert.equal(gesture.up(pointer()), false);
  gesture.down(pointer()); gesture.cancel(pointer());
  assert.equal(gesture.up(pointer()), false);
  gesture.down(pointer());
  assert.equal(gesture.up(pointer()), true, 'the next gesture should work after cancellation');
});
