// Smoke test for the vendored upstream Numbat .nbt modules. Verifies that
// loadVendoredPrelude() can load core::dimensions, core::scalar, units::si,
// units::partsperx, and math::constants through our tokenize → parse → load
// pipeline without error, and that the resulting registries hold what we
// expect.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';
import { VENDORED_MODULES } from '../src/vendored.js';

// ── inventory ────────────────────────────────────────────────────

test('VENDORED_MODULES bundles the expected upstream files', () => {
  const expected = [
    'core::dimensions',
    'core::scalar',
    'extra::cooking',
    'math::constants',
    'physics::temperature_conversion',
    'units::astronomical',
    'units::bit',
    'units::currency',
    'units::nautical',
    'units::partsperx',
    'units::si',
    'units::time',
  ];
  assert.deepEqual(Object.keys(VENDORED_MODULES).sort(), expected);
});

test('each vendored source is non-empty UTF-8 text', () => {
  for (const [path, src] of Object.entries(VENDORED_MODULES)) {
    assert.ok(typeof src === 'string', `${path}: not a string`);
    assert.ok(src.length > 0,           `${path}: empty`);
    assert.ok(src.includes('\n'),       `${path}: looks single-line / suspicious`);
  }
});

// ── loadVendoredPrelude end-to-end ───────────────────────────────

test('loadVendoredPrelude: does not throw', () => {
  new Numbat({ prelude: 'vendored' });
});

test('loadVendoredPrelude: registers expected core dimensions', () => {
  const n = new Numbat({ prelude: 'vendored' });
  // Base dimensions defined by core::dimensions
  for (const name of ['Length', 'Mass', 'Time', 'Current', 'Temperature', 'AmountOfSubstance', 'LuminousIntensity', 'Scalar', 'Angle']) {
    assert.ok(n.dims.has(name), `expected dimension ${name}`);
  }
  // Derived dimensions
  assert.deepEqual(n.dims.resolve('Velocity'),     { length: 1, time: -1 });
  assert.deepEqual(n.dims.resolve('Area'),         { length: 2 });
  assert.deepEqual(n.dims.resolve('Volume'),       { length: 3 });
  assert.deepEqual(n.dims.resolve('Acceleration'), { length: 1, time: -2 });
});

test('loadVendoredPrelude: SI base units register with prefixes', () => {
  const n = new Numbat({ prelude: 'vendored' });
  // Canonical metre, plus short alias 'm' and metric variants
  assert.ok(n.hasUnit('metre'));
  assert.ok(n.hasUnit('m'));
  assert.ok(n.hasUnit('km'));
  assert.ok(n.hasUnit('mm'));
  assert.equal(n.resolve('km').mul, 1e3);
  assert.equal(n.resolve('mm').mul, 1e-3);
});

test('loadVendoredPrelude: long aliases (`meter`, `metres`) work', () => {
  const n = new Numbat({ prelude: 'vendored' });
  assert.equal(n.resolve('meter').mul,  1);
  assert.equal(n.resolve('metres').mul, 1);
  // Long aliases do NOT pick up prefixes
  assert.equal(n.resolve('kmetres'), null);
});

test('loadVendoredPrelude: tonne (defined inside si.nbt)', () => {
  const n = new Numbat({ prelude: 'vendored' });
  // upstream: unit tonne: Mass = 10^3 kilogram
  // canonical mass is gram in upstream → 10^3 * 1000 g = 1e6 g
  assert.equal(n.resolve('tonne').mul, 1e6);
  assert.deepEqual(n.resolve('tonne').dim, { mass: 1 });
});

test('loadVendoredPrelude: partsperx aliases ppm / ppb / ppt', () => {
  const n = new Numbat({ prelude: 'vendored' });
  assert.equal(n.resolve('ppm').mul, 1e-6);
  assert.equal(n.resolve('ppb').mul, 1e-9);
  assert.equal(n.resolve('ppt').mul, 1e-12);
  assert.deepEqual(n.resolve('ppm').dim, {});
});

test('loadVendoredPrelude: math constants π, τ, e from math::constants', () => {
  const n = new Numbat({ prelude: 'vendored' });
  // The pi-style alias is a long-form value; let bindings live in `values`
  const piVal = n.values.get('π') ?? n.values.get('pi');
  assert.ok(piVal, 'expected π or pi in let-binding scope');
  assert.ok(Math.abs(piVal.value - Math.PI) < 1e-9);
});

// ── computation against vendored prelude ─────────────────────────

test('Numbat: ore-body-style calculation against vendored prelude', () => {
  const n = new Numbat({ prelude: 'vendored' });
  // Match ep's default program: 200 m × 50 m × 8 m × 2.7 g/cm³ × 1800 ppb
  // Note: g/cm³ isn't in upstream by default; build it from base.
  const length    = n.q(200, 'm');
  const width     = n.q(50,  'm');
  const thickness = n.q(8,   'm');
  const grade     = n.q(1800,'ppb');
  // Density: 2.7 g per cm³ → 2.7 * gram / centimetre^3 numerically
  // We don't have g/cm3 as a single unit upstream, so compose:
  const gram = n.q(1, 'gram');
  const cm   = n.q(1, 'centimetre');
  const density = gram.mul(n.q(2.7, '')).div(cm.pow(3));
  // ^ this is a quick way; cleaner via parser in v0.3+

  const volume  = length.mul(width).mul(thickness);
  const tonnage = volume.mul(density);
  const metal   = tonnage.mul(grade);

  // Volume = 80,000 m³
  assert.equal(volume.value, 80000);
  assert.deepEqual(volume.dim, { length: 3 });
  // Tonnage = 80,000 m³ × 2.7 g/cm³ = 2.16e11 g = 216 kt
  assert.ok(Math.abs(tonnage.value - 2.16e11) < 1);
  assert.deepEqual(tonnage.dim, { mass: 1 });
  // Metal = 2.16e11 × 1.8e-6 = 388,800 g
  assert.ok(Math.abs(metal.value - 388800) < 0.1);
});

test('Numbat: format() against vendored prelude auto-scales mass', () => {
  const n = new Numbat({ prelude: 'vendored' });
  // 2.16e11 grams should format as some sensible mass scale.
  // Upstream gram has @metric_prefixes which generates Gg (gigagram, mul 1e9);
  // upstream tonne (mul 1e6) is NOT prefixed so no `kt`. Auto-scale picks the
  // largest unit landing in [1, 1000) — that's Gg.
  const q = n.q(2.16e11, 'g');
  const out = n.format(q);
  assert.match(out, /^216\s+(Gg|gigagram)$/);
});

// ── opt-in modules (via n.use) ───────────────────────────────────

test('opt-in: units::time loads with hour, day, year, etc.', () => {
  const n = new Numbat({ prelude: 'vendored' });
  n.use('units::time');
  assert.ok(n.hasUnit('hour'));
  assert.ok(n.hasUnit('day'));
  assert.ok(n.hasUnit('week'));
  assert.ok(n.hasUnit('year'));
  assert.equal(n.q(1, 'hour').value, 3600);
  assert.equal(n.q(1, 'day').value,  86400);
});

test('opt-in: units::astronomical loads with parsec, light_year', () => {
  const n = new Numbat({ prelude: 'vendored' });
  n.use('units::astronomical');
  assert.ok(n.hasUnit('parsec') || n.hasUnit('light_year'));
});

test('opt-in: units::nautical loads with knot, nautical_mile', () => {
  const n = new Numbat({ prelude: 'vendored' });
  n.use('units::nautical');
  assert.ok(n.hasUnit('knot') || n.hasUnit('nautical_mile'));
});

test('opt-in: units::bit loads with byte / bit', () => {
  const n = new Numbat({ prelude: 'vendored' });
  n.use('units::bit');
  assert.ok(n.hasUnit('byte') || n.hasUnit('bit'));
});

test('opt-in: physics::temperature_conversion loads (has fns like from_celsius)', () => {
  const n = new Numbat({ prelude: 'vendored' });
  n.use('physics::temperature_conversion');
  // We just verify it loads without error; the fns are usable via n.loadSource.
});
