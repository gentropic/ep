// solve_for — bracketed Brent's method + secant from a guess. Verifies
// dim preservation, target / function dim-mismatch errors, no-sign-
// change error (bracketed form), and Excel-Goal-Seek-style convergence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../../temporal/temporal-polyfill.min.js');
}

const { Quantity } = await import('../src/quantity.js');
const { Numbat } = await import('../src/api.js');

function mkHost() {
  const n = new Numbat({ prelude: 'v0.1' });
  n.registerAllVendoredModules();
  n.use('core::strings');
  n.use('core::lists');
  n.use('math::statistics');
  for (const name of ['range','map','filter','foldl','maximum','minimum','median','sum','mean','stdev']) {
    if (n.fns.has(name)) n.fns.delete(name);
  }
  return n;
}

const close = (a, b, tol) => Math.abs(a - b) < tol;

// ── Bracketed Brent ─────────────────────────────────────────────────

test('solve_for (bracketed): finds the root of x^2 = 4 over [0, 5]', () => {
  const n = mkHost();
  n.loadSource([
    'fn sq(x: Scalar) -> Scalar = x^2',
    'let x = solve_for(sq, 4, 0, 5)',
  ].join('\n'), '<t>');
  const x = n.values.get('x');
  assert.ok(x instanceof Quantity);
  assert.ok(close(x.value, 2, 1e-8), `expected ≈ 2, got ${x.value}`);
});

test('solve_for (bracketed): preserves input dim — solves Length²-shaped problem', () => {
  const n = mkHost();
  n.loadSource([
    'fn area(L: Length) -> Area = L^2',
    'let side = solve_for(area, 25 m^2, 0 m, 10 m)',
  ].join('\n'), '<t>');
  const side = n.values.get('side');
  assert.ok(close(side.value, 5, 1e-8), `expected 5 m, got ${side.value} ${JSON.stringify(side.dim)}`);
  assert.deepEqual(side.dim, { length: 1 });
});

test('solve_for (bracketed): errors when target is not bracketed', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource([
      'fn sq(x: Scalar) -> Scalar = x^2',
      'let x = solve_for(sq, 4, 3, 5)',
    ].join('\n'), '<t>'),
    /target is not bracketed/);
});

test('solve_for (bracketed): errors on input dim mismatch (lo vs hi)', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource([
      'fn area(L: Length) -> Area = L^2',
      'let x = solve_for(area, 25 m^2, 0 m, 10 s)',
    ].join('\n'), '<t>'),
    /lo .* and hi .* must have the same dim/);
});

test('solve_for (bracketed): errors on output dim mismatch (target vs f result)', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource([
      'fn area(L: Length) -> Area = L^2',
      'let x = solve_for(area, 25 m, 0 m, 10 m)',
    ].join('\n'), '<t>'),
    /function output dim .* doesn't match target dim/);
});

// ── Secant from a guess ─────────────────────────────────────────────

test('solve_for (secant from guess): finds the root of x^2 = 4 from x0 = 1', () => {
  const n = mkHost();
  n.loadSource([
    'fn sq(x: Scalar) -> Scalar = x^2',
    'let x = solve_for(sq, 4, 1)',
  ].join('\n'), '<t>');
  const x = n.values.get('x');
  assert.ok(close(x.value, 2, 1e-8), `expected ≈ 2, got ${x.value}`);
});

test('solve_for (secant from guess): preserves input dim and disp from x0', () => {
  const n = mkHost();
  n.loadSource([
    'fn area(L: Length) -> Area = L^2',
    'let side = solve_for(area, 25 m^2, 1 m)',
  ].join('\n'), '<t>');
  const side = n.values.get('side');
  assert.ok(close(side.value, 5, 1e-6), `expected ≈ 5 m, got ${side.value}`);
  assert.deepEqual(side.dim, { length: 1 });
});

test('solve_for (secant): can land on the negative root when x0 < 0', () => {
  const n = mkHost();
  n.loadSource([
    'fn sq(x: Scalar) -> Scalar = x^2',
    'let x = solve_for(sq, 4, -1)',
  ].join('\n'), '<t>');
  const x = n.values.get('x');
  assert.ok(close(x.value, -2, 1e-8), `expected ≈ -2, got ${x.value}`);
});

// ── Arity validation ────────────────────────────────────────────────

test('solve_for: errors on too-few args', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource([
      'fn sq(x: Scalar) -> Scalar = x^2',
      'let x = solve_for(sq, 4)',
    ].join('\n'), '<t>'),
    /expected 3..4 args/);
});

test('solve_for: errors when first arg is not a function', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let x = solve_for(42, 4, 0, 5)', '<t>'),
    /first arg must be a function/);
});
