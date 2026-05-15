import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

// ── assert ───────────────────────────────────────────────────────

test('assert(true): no throw', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let _ = assert(true)');
});

test('assert(false): throws', () => {
  const n = new Numbat({ prelude: 'none' });
  assert.throws(() => n.loadSource('let _ = assert(false)'), /assertion failed/);
});

test('assert: with comparison', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let _ = assert(3 < 5)');           // ok
  assert.throws(() => n.loadSource('let _ = assert(5 < 3)'), /assertion failed/);
});

test('assert: Quantity argument rejected (must be Bool)', () => {
  const n = new Numbat({ prelude: 'none' });
  assert.throws(() => n.loadSource('let _ = assert(5)'), /expected Bool/);
});

// ── assert_eq (strict) ───────────────────────────────────────────

test('assert_eq: scalars equal', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let _ = assert_eq(2, 2)');
});

test('assert_eq: scalars different throws', () => {
  const n = new Numbat({ prelude: 'none' });
  assert.throws(() => n.loadSource('let _ = assert_eq(2, 3)'), /assert_eq failed/);
});

test('assert_eq: same canonical value across units', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @metric_prefixes
    @aliases(m: short)
    unit metre: Length
    let _ = assert_eq(1000 m, 1 km)
  `);
});

test('assert_eq: dim mismatch throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    dimension Mass
    @aliases(m: short)
    unit metre: Length
    @aliases(g: short)
    unit gram: Mass
  `);
  assert.throws(() => n.loadSource('let _ = assert_eq(5 m, 5 g)'), /dim mismatch/);
});

// ── assert_eq (approximate) ──────────────────────────────────────

test('assert_eq with tolerance: within bounds', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let _ = assert_eq(2.00001, 2.0, 0.001)');
});

test('assert_eq with tolerance: outside bounds throws', () => {
  const n = new Numbat({ prelude: 'none' });
  assert.throws(
    () => n.loadSource('let _ = assert_eq(2.01, 2.0, 0.001)'),
    /assert_eq failed/,
  );
});

test('assert_eq: bool == bool', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let _ = assert_eq(true, true)');
  assert.throws(() => n.loadSource('let _ = assert_eq(true, false)'), /assert_eq failed/);
});

// ── upstream syntax-doc example ──────────────────────────────────

test('upstream: assert_eq with quantity tolerance', () => {
  // assert_eq(c, 300_000 km/s, 1% × c) — paraphrased; we don't have % yet.
  // Use a numeric tolerance instead.
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    dimension Time
    @metric_prefixes
    @aliases(m: short)
    unit metre: Length
    @metric_prefixes
    @aliases(s: short)
    unit second: Time
    let c = 299_792_458 m / s
    let _ = assert_eq(c, 300_000_000 m / s, 1_000_000 m / s)
  `);
});
