import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

test('Numbat: q() constructs Quantity at canonical value', () => {
  const n = new Numbat();
  const m = n.q(3, 'km');
  assert.equal(m.value, 3000);
  assert.deepEqual(m.dim, {length: 1});
});

test('Numbat: q() with no unit name → dimensionless', () => {
  const n = new Numbat();
  const x = n.q(42);
  assert.equal(x.value, 42);
  assert.deepEqual(x.dim, {});
});

test('Numbat: q() unknown unit throws', () => {
  const n = new Numbat();
  assert.throws(() => n.q(1, 'furlongs'), /unknown unit/);
});

test('Numbat: hasUnit()', () => {
  const n = new Numbat();
  assert.equal(n.hasUnit('m'),   true);
  assert.equal(n.hasUnit('km'),  true);
  assert.equal(n.hasUnit('ppb'), true);
  assert.equal(n.hasUnit('g/t'), true);
  assert.equal(n.hasUnit('xyz'), false);
});

test('Numbat: convertTo() round-trips canonical value', () => {
  const n = new Numbat();
  const g = n.q(388800, 'g');
  const oz = n.convertTo(g, 'ozt');
  assert.equal(oz.value, 388800);
  assert.equal(oz.disp, 'ozt');
});

test('Numbat: format() ore-body program quantities', () => {
  const n = new Numbat();
  // Reproduce the ore_body program by hand.
  const length    = n.q(200, 'm');
  const width     = n.q(50,  'm');
  const thickness = n.q(8,   'm');
  const density   = n.q(2.7, 'g/cm3');
  const grade     = n.q(1800, 'ppb');

  const volume  = length.mul(width).mul(thickness);
  const tonnage = volume.mul(density);
  const metal   = tonnage.mul(grade);
  const metalOz = n.convertTo(metal, 'ozt');

  assert.equal(n.format(volume),  '80,000 m³');
  assert.equal(n.format(tonnage), '216 kt');
  assert.equal(n.format(metal),   '388.8 kg');
  assert.equal(n.format(metalOz), '12,500 ozt');
});
