import { test } from 'node:test';
import assert from 'node:assert/strict';
import { format, formatParts, formatNumber } from '../src/format.js';
import { Quantity } from '../src/quantity.js';
import { UnitRegistry } from '../src/units.js';
import { loadPrelude } from '../src/prelude.js';

const reg = (() => { const r = new UnitRegistry(); loadPrelude(r); return r; })();
const Q = (v, d, disp) => new Quantity(v, d, disp);

test('formatNumber: small values plain decimal', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(42), '42');
  assert.equal(formatNumber(3.14), '3.14');
});

test('formatNumber: large values thousands-separated', () => {
  assert.equal(formatNumber(1234), '1,234');
  assert.equal(formatNumber(80000), '80,000');
});

test('formatNumber: extreme magnitudes use scientific notation', () => {
  assert.equal(formatNumber(1e-6), '1.000e-6');
  assert.equal(formatNumber(2.16e11), '2.160e11');
});

test('formatParts: dimensionless quantity has no unit', () => {
  assert.deepEqual(formatParts(Q(0.5, {}), reg), { num: '0.5', unit: null });
});

test('formatParts: mass auto-scales (216 GT canonical → 216 kt)', () => {
  const tonnage = Q(2.16e11, {mass: 1});
  const { num, unit } = formatParts(tonnage, reg);
  assert.equal(unit, 'kt');
  assert.equal(num, '216');
});

test('formatParts: volume picks km³ at 4.4e10 m³', () => {
  const vol = Q(4.444e10, {length: 3});
  const { num, unit } = formatParts(vol, reg);
  assert.equal(unit, 'km³');
  assert.match(num, /^44\.44/);
});

test('formatParts: honors disp tag instead of auto-scaling', () => {
  const q = Q(388800, {mass: 1}, 'ozt');
  const { num, unit } = formatParts(q, reg);
  assert.equal(unit, 'ozt');
  // 388800 / 31.1035 ≈ 12500.2 → toPrecision(5) → '12,500'
  assert.equal(num, '12,500');
});

test('format: combines num + unit with a space', () => {
  assert.equal(format(Q(5000, {length: 1}), reg), '5 km');
});

test('formatParts: density auto-scales to g/cm³', () => {
  const { unit } = formatParts(Q(2.7e6, {mass: 1, length: -3}), reg);
  assert.equal(unit, 'g/cm³');
});

test('formatParts: dimension with no candidate units shows raw signature', () => {
  // angle^-1 is not in the prelude
  const { unit } = formatParts(Q(1, {angle: -1}), reg);
  assert.equal(unit, '[angle^-1]');
});
