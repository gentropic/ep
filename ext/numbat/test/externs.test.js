// Host-supplied implementations of upstream's bodiless (extern) prelude
// functions: core::quantities, core::numbers, trunc / fract, atan2, gamma.
// Inside the engine a literal carries no written-unit tag (ep adds that
// at the sheet level), so the tests pin the unit with `-> km`, which
// does tag the value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';
import { setUnitResolver } from '../src/load.js';

function mkHost() {
  const n = new Numbat({ prelude: 'v0.1' });
  n.registerAllVendoredModules();
  n.use('core::lists');
  n.use('core::quantities');
  setUnitResolver((name) => n.registry.resolve(name));
  return n;
}
const val = (n, k) => n.values.get(k);

test('value_of / unit_name / unit_of read the quantity in its carried unit, else the base unit', () => {
  const n = mkHost();
  n.loadSource('let a = value_of(3.5 km -> km)', '<t>');
  assert.equal(val(n, 'a').value, 3.5);
  n.loadSource('let a2 = value_of(3.5 km)', '<t>');
  assert.equal(val(n, 'a2').value, 3500);
  n.loadSource('let b = unit_name(3.5 km -> km)', '<t>');
  assert.equal(val(n, 'b'), 'km');
  n.loadSource('let c = unit_of(3.5 km -> km)', '<t>');
  assert.equal(val(n, 'c').value, 1000);     // one km, canonical metres (unit_of is x / value_of(x) upstream, so no tag survives)
});

test('base_unit_of strips the metric prefix via the host registry', () => {
  const n = mkHost();
  n.loadSource('let a = base_unit_of(5 km -> km)', '<t>');
  assert.equal(val(n, 'a').disp.name, 'm');
  assert.equal(val(n, 'a').value, 1);
  n.loadSource('let b = base_unit_of(5 m -> m)', '<t>');
  assert.equal(val(n, 'b').disp.name, 'm');
  n.loadSource('let m = base_unit_of(5 min -> min)', '<t>');   // not milli-inches
  assert.equal(val(n, 'm').disp.name, 'min');
  assert.throws(() => n.loadSource('let c = base_unit_of(0 m)', '<t>'), /evaluates to 0/);
});

test('is_dimensionless / quantity_cast / is_nan / is_infinite', () => {
  const n = mkHost();
  n.loadSource('let a = is_dimensionless(3)', '<t>');
  n.loadSource('let b = is_dimensionless(3 m)', '<t>');
  n.loadSource('let c = is_dimensionless(0 m)', '<t>');
  assert.deepEqual([val(n, 'a'), val(n, 'b'), val(n, 'c')], [true, false, true]);
  n.loadSource('let d = quantity_cast(3 m, 1 s)', '<t>');
  assert.deepEqual([val(n, 'd').value, val(n, 'd').dim], [3, { time: 1 }]);
  n.loadSource('let e = is_nan(0/0)', '<t>');
  n.loadSource('let f = is_infinite(1/0)', '<t>');
  n.loadSource('let g = is_infinite(1)', '<t>');
  assert.deepEqual([val(n, 'e'), val(n, 'f'), val(n, 'g')], [true, true, false]);
});

test('trunc / fract act on the number in its carried unit', () => {
  const n = mkHost();
  n.loadSource('let a = trunc(3.7)', '<t>');
  n.loadSource('let b = fract(3.7)', '<t>');
  assert.equal(val(n, 'a').value, 3);
  assert.ok(Math.abs(val(n, 'b').value - 0.7) < 1e-12);
  n.loadSource('let c = trunc(-2.5 km -> km)', '<t>');
  assert.equal(val(n, 'c').value, -2000);
});

test('atan2 and gamma', () => {
  const n = mkHost();
  n.loadSource('let a = atan2(1 m, -1 m)', '<t>');
  assert.ok(Math.abs(val(n, 'a').value - 3 * Math.PI / 4) < 1e-12);
  assert.throws(() => n.loadSource('let b = atan2(1 m, 1 s)', '<t>'), /share a dimension/);
  n.loadSource('let g = gamma(5)', '<t>');
  assert.ok(Math.abs(val(n, 'g').value - 24) < 1e-9);
  n.loadSource('let h = gamma(0.5)', '<t>');
  assert.ok(Math.abs(val(n, 'h').value - Math.sqrt(Math.PI)) < 1e-9);
});
