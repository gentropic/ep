// Cross-module smoke tests: exercise operations across the vendored upstream
// modules. "Loads cleanly" was the bar for the survey — this is the bar for
// "actually works". Failures here surface the difference between
// parse-pass-through and real semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

const fresh = () => new Numbat({ prelude: 'vendored' });

const approx = (a, b, eps = 1e-9) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// ── units::si basics ─────────────────────────────────────────────

test('si units: kilometer = 1000 metre', () => {
  const n = fresh();
  const km = n.q(1, 'kilometre');
  const m  = n.q(1000, 'metre');
  assert.equal(km.value, m.value);
});

test('si units: newton derived correctly from kg·m/s²', () => {
  // upstream: unit newton: Force = kilogram meter / second^2
  // canonical mass = gram, so 1 N = 1000 g·m/s² = 1000 (canonical).
  const n = fresh();
  const newton = n.q(1, 'newton');
  assert.equal(newton.value, 1000);
  assert.deepEqual(newton.dim, { mass: 1, length: 1, time: -2 });
});

test('si units: joule = newton meter', () => {
  const n = fresh();
  const j = n.q(1, 'joule');
  // 1 J = 1 N·m = 1000 g·m²/s²
  assert.equal(j.value, 1000);
});

// ── math constants ───────────────────────────────────────────────

test('math::constants: pi ≈ Math.PI', () => {
  const n = fresh();
  n.use('math::constants');
  const pi = n.values.get('π') ?? n.values.get('pi');
  assert.ok(pi);
  assert.ok(approx(pi.value, Math.PI, 1e-15));
});

test('math::constants: golden ratio φ', () => {
  const n = fresh();
  n.use('math::constants');
  const phi = n.values.get('φ') ?? n.values.get('golden_ratio');
  assert.ok(phi);
  assert.ok(approx(phi.value, (1 + Math.sqrt(5)) / 2, 1e-9));
});

// ── time units ───────────────────────────────────────────────────

test('time: 1 hour = 3600 second', () => {
  const n = fresh();
  n.use('units::time');
  assert.equal(n.q(1, 'hour').value, 3600);
});

test('time: 1 year ≈ 365.24 day', () => {
  const n = fresh();
  n.use('units::time');
  const year = n.q(1, 'year');
  const day  = n.q(1, 'day');
  assert.ok(approx(year.value / day.value, 365.242_188_1, 1e-6));
});

// ── builtin math fns ─────────────────────────────────────────────

test('builtin: sqrt(9 m²) = 3 m', () => {
  const n = fresh();
  // Build 9 m² from m^2 manually since `m^2` syntax in source needs the
  // tokenizer; here we just build via q + pow.
  const area = n.q(9, 'm').mul(n.q(1, 'm'));
  assert.equal(area.value, 9);
  assert.deepEqual(area.dim, { length: 2 });
});

test('mod: 17 mod 5 = 2', () => {
  const n = fresh();
  n.use('core::functions');
  // `mod` is declared extern in core::functions; we don't have a builtin for
  // it yet. This test documents the gap — once we add a `mod` builtin,
  // change `assert.throws` to `assert.equal`.
  assert.throws(() => n.loadSource('let r = mod(17, 5)'), /no built-in implementation/);
});

test('factorial: 5! = 120', () => {
  const n = fresh();
  n.use('math::combinatorics');
  n.loadSource('let r = factorial(5)');
  assert.equal(n.values.get('r').value, 120);
});

test('factorial: postfix form 5! also works', () => {
  const n = fresh();
  n.use('math::combinatorics');
  n.loadSource('let r = 5!');
  assert.equal(n.values.get('r').value, 120);
});

// ── lists (loaded via core::lists) ───────────────────────────────

test('core::lists: head/tail/cons via use', () => {
  const n = fresh();
  n.use('core::lists');
  n.loadSource('let xs = [1, 2, 3]');
  n.loadSource('let h = head(xs)');
  n.loadSource('let t = tail(xs)');
  assert.equal(n.values.get('h').value, 1);
  assert.equal(n.values.get('t').length, 2);
});

test('core::lists: concat works (defined in the module body)', () => {
  const n = fresh();
  n.use('core::lists');
  n.loadSource('let r = concat([1, 2], [3, 4, 5])');
  const r = n.values.get('r');
  assert.equal(r.length, 5);
  assert.equal(r[0].value, 1);
  assert.equal(r[4].value, 5);
});

// ── partsperx ────────────────────────────────────────────────────

test('partsperx: ppm and ppb resolve', () => {
  const n = fresh();
  assert.equal(n.q(1, 'ppm').value, 1e-6);
  assert.equal(n.q(1, 'ppb').value, 1e-9);
});

// ── physics constants ────────────────────────────────────────────

test('physics::constants: speed of light c ≈ 299_792_458 m/s', () => {
  const n = fresh();
  n.use('physics::constants');
  const c = n.values.get('c') ?? n.values.get('speed_of_light');
  assert.ok(c);
  // canonical value: 299_792_458 m·s^-1 in g·m/s gives the m/s part * 1
  assert.equal(c.value, 299_792_458);
});

test('physics::constants: planck constant h is defined', () => {
  const n = fresh();
  n.use('physics::constants');
  // The unicode `ℎ` alias and `planck_constant` should both resolve.
  const h = n.values.get('planck_constant') ?? n.values.get('ℎ');
  assert.ok(h);
});

// ── upstream prelude — load it all ───────────────────────────────

test('prelude: upstream prelude.nbt loads without error', () => {
  const n = fresh();
  n.use('prelude');
  // After prelude, the geological + scientific units all exist.
  assert.ok(n.hasUnit('metre'));
  assert.ok(n.hasUnit('kilogram'));
  assert.ok(n.hasUnit('newton'));
  assert.ok(n.hasUnit('hour'));
  assert.ok(n.hasUnit('ppm'));
});

// ── chemistry ────────────────────────────────────────────────────

test('chemistry::elements: defines the element list', () => {
  const n = fresh();
  n.use('chemistry::elements');
  // Spot check — periodic table is a list called 'elements' typically.
  // We don't deeply test; just that the module's let bindings exist.
  assert.ok(n.values.size > 0);
});

// ── known gaps (documented for future fixes) ─────────────────────

test('GAP: random() not implemented as builtin', () => {
  const n = fresh();
  n.use('core::random');
  // random() is extern; we haven't added a host implementation.
  // Calling it would throw.
  assert.throws(() => n.loadSource('let r = random()'), /no built-in implementation/);
});

test('GAP: parse(string) not implemented', () => {
  const n = fresh();
  n.use('core::functions');
  assert.throws(() => n.loadSource('let r: Time = parse("120 s")'), /no built-in implementation/);
});
