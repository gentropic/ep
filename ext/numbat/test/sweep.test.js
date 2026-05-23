// Sensitivity sweep — the Swept class, the `sweep` builder, arithmetic
// sample-wise broadcasting carrying the input axis through, and the
// "same sweep" identity rule. SPEC-UNCERTAINTY's companion deterministic
// branch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../../temporal/temporal-polyfill.min.js');
}

const { Quantity, Uncertain, Swept, sweepSamplesOf } = await import('../src/quantity.js');
const { Numbat } = await import('../src/api.js');

const close = (a, b, tol) => Math.abs(a - b) < tol;

function mkHost() {
  const n = new Numbat({ prelude: 'v0.1' });
  n.registerAllVendoredModules();
  n.use('core::strings');
  n.use('core::lists');
  n.use('math::statistics');
  for (const name of ['range','map','filter','foldl','maximum','minimum','median','sum','mean','stdev']) {
    if (n.fns.has(name)) n.fns.delete(name);
  }
  n.registerModule('uncertainty::functions', [
    'fn normal<D>(mu: D, sigma: D) -> D',
    '',
  ].join('\n'));
  n.use('uncertainty::functions');
  n.registerModule('sweep::functions', [
    'fn sweep<D>(start: D, end: D, n: Scalar) -> D',
    '',
  ].join('\n'));
  n.use('sweep::functions');
  return n;
}

// ── the Swept class + sweep builder ───────────────────────────────

test('sweep: linspaced samples, n points', () => {
  const n = mkHost();
  n.loadSource('let x = sweep(180, 220, 5)', '<t>');
  const x = n.values.get('x');
  assert.ok(x instanceof Swept);
  assert.equal(x.samples.length, 5);
  assert.deepEqual(Array.from(x.samples), [180, 190, 200, 210, 220]);
  // The initial sweep's samples and inputSamples are the same array.
  assert.strictEqual(x.samples, x.inputSamples);
});

test('sweep preserves dim through construction', () => {
  const n = mkHost();
  n.loadSource('let L = sweep(180 m, 220 m, 5)', '<t>');
  const L = n.values.get('L');
  assert.ok(L instanceof Swept);
  assert.deepEqual(L.dim, { length: 1 });
  assert.deepEqual(L.inputDim, { length: 1 });
});

test('sweep rejects n < 2', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let bad = sweep(0, 1, 1)', '<t>'),
    /n must be an integer/);
});

test('sweep rejects dim mismatch', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let bad = sweep(0 m, 1 second, 5)', '<t>'),
    /dim mismatch/i);
});

// ── arithmetic + input-axis propagation ───────────────────────────

test('Swept × Quantity: scalar broadcasts; input axis preserved by reference', () => {
  const n = mkHost();
  n.loadSource([
    'let L = sweep(180 m, 220 m, 5)',
    'let A = L * 50 m',
  ].join('\n'), '<t>');
  const L = n.values.get('L');
  const A = n.values.get('A');
  assert.ok(A instanceof Swept);
  assert.strictEqual(A.inputSamples, L.inputSamples);   // same reference = same sweep
  assert.deepEqual(A.dim, { length: 2 });
  // 180*50 ... 220*50 in canonical units (m × m).
  assert.deepEqual(Array.from(A.samples), [9000, 9500, 10000, 10500, 11000]);
});

test('Quantity − Swept: non-commutative; result inherits input axis', () => {
  const n = mkHost();
  n.loadSource([
    'let L = sweep(180 m, 220 m, 5)',
    'let r = 250 m - L',
  ].join('\n'), '<t>');
  const r = n.values.get('r');
  assert.ok(r instanceof Swept);
  assert.deepEqual(Array.from(r.samples), [70, 60, 50, 40, 30]);
});

test('Quantity / Swept: input axis preserved', () => {
  const n = mkHost();
  n.loadSource([
    'let L = sweep(180 m, 220 m, 5)',
    'let r = 1000 m / L',
  ].join('\n'), '<t>');
  const r = n.values.get('r');
  assert.ok(r instanceof Swept);
  assert.deepEqual(r.dim, {});
});

test('Swept × Swept (same sweep): elementwise', () => {
  const n = mkHost();
  n.loadSource([
    'let L = sweep(1, 5, 5)',
    'let r = L * L',
  ].join('\n'), '<t>');
  const r = n.values.get('r');
  assert.ok(r instanceof Swept);
  assert.deepEqual(Array.from(r.samples), [1, 4, 9, 16, 25]);
});

test('Swept × Swept (different sweeps): rejects', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource([
      'let a = sweep(0, 1, 5)',
      'let b = sweep(10, 20, 5)',
      'let r = a * b',
    ].join('\n'), '<t>'),
    /input axes incompatible|only one sweep/i);
});

test('Swept ^ scalar: input axis preserved', () => {
  const n = mkHost();
  n.loadSource([
    'let L = sweep(1, 4, 4)',
    'let r = L^2',
  ].join('\n'), '<t>');
  const r = n.values.get('r');
  assert.deepEqual(Array.from(r.samples), [1, 4, 9, 16]);
});

test('Chained propagation: volume = L × W × T preserves the L sweep', () => {
  const n = mkHost();
  n.loadSource([
    'let L = sweep(180 m, 220 m, 5)',
    'let W = 50 m',
    'let T = 8 m',
    'let V = L * W * T',
  ].join('\n'), '<t>');
  const L = n.values.get('L');
  const V = n.values.get('V');
  assert.ok(V instanceof Swept);
  assert.strictEqual(V.inputSamples, L.inputSamples);
  assert.deepEqual(V.dim, { length: 3 });
  // 180*50*8 ... 220*50*8 = 72000 ... 88000
  assert.deepEqual(Array.from(V.samples), [72000, 76000, 80000, 84000, 88000]);
});

// ── cross-rejections: Swept × Uncertain (and vice versa) ──────────

test('Swept × Uncertain rejects (Phase 1)', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource([
      'let s = sweep(0, 1, 5)',
      'let u = normal(10, 1)',
      'let r = s * u',
    ].join('\n'), '<t>'),
    /Phase 1|combine.*Swept.*Uncertain|combine.*Uncertain.*Swept/i);
});

test('Uncertain + Swept rejects (Phase 1)', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource([
      'let s = sweep(0, 1, 5)',
      'let u = normal(10, 1)',
      'let r = u + s',
    ].join('\n'), '<t>'),
    /Phase 1|combine/i);
});

// ── sweepSamplesOf helper ─────────────────────────────────────────

test('sweepSamplesOf: scalar Quantity lifts to constant array', () => {
  const inputAxis = new Float64Array([1, 2, 3, 4]);
  const ref = new Swept(new Float64Array([10, 20, 30, 40]), {}, null, inputAxis, {});
  const r = sweepSamplesOf(new Quantity(7, {}), ref);
  assert.equal(r.length, 4);
  assert.equal(r[0], 7);
  assert.equal(r[3], 7);
});

test('sweepSamplesOf: same-sweep Swept returns its samples', () => {
  const inputAxis = new Float64Array([1, 2, 3]);
  const a = new Swept(new Float64Array([100, 200, 300]), {}, null, inputAxis, {});
  const b = new Swept(new Float64Array([10, 20, 30]),    {}, null, inputAxis, {});
  // b shares inputAxis ref → compatible.
  assert.strictEqual(sweepSamplesOf(b, a), b.samples);
});

test('sweepSamplesOf: different-sweep Swept rejects', () => {
  const a = new Swept(new Float64Array([1,2,3]), {}, null, new Float64Array([1,2,3]), {});
  const b = new Swept(new Float64Array([4,5,6]), {}, null, new Float64Array([4,5,6]), {});
  assert.throws(() => sweepSamplesOf(b, a), /input axes incompatible|only one sweep/i);
});
