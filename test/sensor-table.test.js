import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SENSOR_SOURCES, parseSensorArgs, RingBuffer, trailingMean, headingFromAlpha } from '../src/js/sensor-table.js';

test('parseSensorArgs: source, rate hint, averaging window, hold', () => {
  assert.deepEqual(parseSensorArgs(['pressure']), { source: 'pressure', rateHz: 10, avgS: 0, hold: false });
  assert.deepEqual(parseSensorArgs(['heading', '5 Hz']), { source: 'heading', rateHz: 5, avgS: 0, hold: false });
  assert.deepEqual(parseSensorArgs(['accel.z', 'avg 0.5 s']), { source: 'accel.z', rateHz: 10, avgS: 0.5, hold: false });
  assert.deepEqual(parseSensorArgs(['tilt', 'hold', 'avg 200 ms']), { source: 'tilt', rateHz: 10, avgS: 0.2, hold: true });
  assert.equal(parseSensorArgs(['nope']), null);
  assert.equal(parseSensorArgs([]), null);
});

test('every source names a unit and a physical stream', () => {
  for (const [name, s] of Object.entries(SENSOR_SOURCES)) {
    assert.ok(s.phys && s.unit && typeof s.pick === 'function', name);
  }
  assert.equal(SENSOR_SOURCES['accel.z'].pick([1, 2, 3]), 3);
  assert.equal(SENSOR_SOURCES.heading.pick({ heading: 42, beta: 1, gamma: 2 }), 42);
});

test('RingBuffer drops the oldest and answers "since"', () => {
  const b = new RingBuffer(3);
  b.push(1, 10); b.push(2, 20); b.push(3, 30); b.push(4, 40);
  assert.deepEqual(b.items.map(s => s.v), [20, 30, 40]);
  assert.deepEqual(b.since(3), [30, 40]);
  assert.equal(b.last.v, 40);
});

test('trailingMean: window 0 is the latest sample; otherwise the mean inside the window', () => {
  const b = new RingBuffer();
  for (let i = 0; i < 10; i++) b.push(i * 100, i);   // 0..9 at 100 ms steps
  assert.equal(trailingMean(b, 900, 0), 9);
  assert.equal(trailingMean(b, 900, 0.25), (7 + 8 + 9) / 3);   // t >= 650 → 7, 8, 9
  assert.equal(trailingMean(b, 5000, 0.1), 9);                 // nothing in window → latest
  assert.equal(trailingMean(new RingBuffer(), 0, 1), null);
});

test('headingFromAlpha turns counter-clockwise alpha into a clockwise compass heading', () => {
  assert.equal(headingFromAlpha(0), 0);
  assert.equal(headingFromAlpha(90), 270);
  assert.equal(headingFromAlpha(270), 90);
  assert.equal(headingFromAlpha(null), null);
});
