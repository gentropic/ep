import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SENSOR_SOURCES, parseSensorArgs, RingBuffer, trailingMean, headingFromAlpha, attitudeFrom, captureEdits } from '../src/js/sensor-table.js';

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

test('attitudeFrom: flat phone, then the top edge raised 30° (plane dips south)', () => {
  const flat = attitudeFrom(0, 0, 0);
  assert.ok(Math.abs(flat.dip) < 1e-9 && Math.abs(flat.plunge) < 1e-9);
  // beta = +30: the top of the phone comes up, the back faces down-south.
  const a = attitudeFrom(0, 30, 0);
  assert.ok(Math.abs(a.dip - 30) < 1e-9, 'dip ' + a.dip);
  assert.ok(Math.abs(a.dipDirection - 180) < 1e-9, 'dip direction ' + a.dipDirection);
  assert.ok(Math.abs(a.strike - 90) < 1e-9, 'strike ' + a.strike);
  // the long edge plunges 30° toward the south; the dip line has rake 90
  assert.ok(Math.abs(a.trend - 180) < 1e-9, 'trend ' + a.trend);
  assert.ok(Math.abs(a.plunge - 30) < 1e-9, 'plunge ' + a.plunge);
  assert.ok(Math.abs(a.rake - 90) < 1e-9, 'rake ' + a.rake);
});

test('attitudeFrom: rolled about the long axis (gamma) dips east or west; alpha rotates the strike', () => {
  const east = attitudeFrom(0, 0, 20);     // right edge drops → back faces down-east? gamma>0 raises the right edge
  assert.ok(Math.abs(east.dip - 20) < 1e-9);
  assert.ok([90, 270].some(d => Math.abs(east.dipDirection - d) < 1e-9), 'dip direction ' + east.dipDirection);
  assert.ok(Math.abs(east.rake) < 1e-9 || Math.abs(east.rake - 180) < 1e-9, 'long edge along strike → rake 0/180, got ' + east.rake);
  const turned = attitudeFrom(90, 30, 0);   // same tilt, device yawed 90° counter-clockwise
  assert.ok(Math.abs(turned.dip - 30) < 1e-9);
  assert.ok(Math.abs(turned.dipDirection - 90) < 1e-9, 'dip direction ' + turned.dipDirection);
  assert.equal(attitudeFrom(null, 1, 2), null);
});

test('captureEdits: creates log lists under a measurements heading, then extends them in place', () => {
  const sheet = ['@sensor(dip)', 'dip = 0 deg', '@sensor(dip_direction)', 'dd = 0 deg', '', 'stereonet_planes(dd_log, dip_log)'];
  const once = captureEdits(sheet, [{ name: 'dd', text: '171.3 deg' }, { name: 'dip', text: '12.4 deg' }]);
  // the block lands after the last @sensor binding, before the line that uses the logs
  assert.deepEqual(once, ['@sensor(dip)', 'dip = 0 deg', '@sensor(dip_direction)', 'dd = 0 deg', '', '# measurements', 'dd_log = [171.3 deg]', 'dip_log = [12.4 deg]', '', 'stereonet_planes(dd_log, dip_log)']);
  const twice = captureEdits(once, [{ name: 'dd', text: '182 deg' }, { name: 'dip', text: '15.1 deg' }]);
  assert.deepEqual(twice.slice(5, 8), ['# measurements', 'dd_log = [171.3 deg, 182 deg]', 'dip_log = [12.4 deg, 15.1 deg]']);
  // a new binding logged later joins the block under the heading
  const more = captureEdits(twice, [{ name: 'dd', text: '1 deg' }, { name: 'dip', text: '2 deg' }, { name: 'rake', text: '88 deg' }]);
  assert.equal(more[8], 'rake_log = [88 deg]');
  assert.equal(more[more.length - 1], 'stereonet_planes(dd_log, dip_log)');
  // a trailing comment on the log line survives; an empty list fills
  const withComment = captureEdits(['x_log = []   # today'], [{ name: 'x', text: '1 m' }]);
  assert.deepEqual(withComment, ['x_log = [1 m]   # today']);
  // a heading with its own comment lines and pre-declared empty logs
  // (the compass example): new logs go after both, not between them
  const pre = ['# measurements — tap measure', '# every reading lands here', 'dd_log = []', 'dip_log = []', '', 'stereonet_planes(dd_log, dip_log)'];
  const filled = captureEdits(pre, [{ name: 'dd', text: '10 deg' }, { name: 'dip', text: '20 deg' }, { name: 'rake', text: '5 deg' }]);
  assert.deepEqual(filled, ['# measurements — tap measure', '# every reading lands here', 'dd_log = [10 deg]', 'dip_log = [20 deg]', 'rake_log = [5 deg]', '', 'stereonet_planes(dd_log, dip_log)']);
});
