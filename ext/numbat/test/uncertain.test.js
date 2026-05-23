// Uncertainty propagation — the Uncertain class, the `normal` builder,
// arithmetic sample-wise broadcasting, mean / stdev as collapsing
// reductions, and reproducibility. SPEC-UNCERTAINTY.md for the design.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Match the runtime ep ships.
if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../../temporal/temporal-polyfill.min.js');
}

const { Quantity, Uncertain, samplesOf, resetUncertaintyRng } = await import('../src/quantity.js');
const { Numbat } = await import('../src/api.js');

// ── helpers ───────────────────────────────────────────────────────

const close = (a, b, tol) => Math.abs(a - b) < tol;

function meanOf(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i];
  return s / samples.length;
}
function stdevOf(samples) {
  const m = meanOf(samples);
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += (samples[i] - m) ** 2;
  return Math.sqrt(s / samples.length);
}

function mkHost() {
  const n = new Numbat({ prelude: 'v0.1' });
  n.registerAllVendoredModules();
  n.use('core::strings');
  n.use('core::lists');
  n.use('math::statistics');
  // Mirror ep's evaluator: the .nbt versions of mean/stdev (etc) drop the
  // disp tag and don't recognize Uncertain — fall through to the iterative
  // BUILTIN_PROC natives instead.
  for (const name of ['range','map','filter','foldl','maximum','minimum','median','sum','mean','stdev']) {
    if (n.fns.has(name)) n.fns.delete(name);
  }
  // ep-original; signatures only. Runtime is in BUILTIN_PROCS.
  n.registerModule('uncertainty::functions', [
    'fn normal<D>(mu: D, sigma: D) -> D',
    'fn uniform<D>(lo: D, hi: D) -> D',
    'fn lognormal<D>(mu: D, sigma: D) -> D',
    'fn triangular<D>(lo: D, mode: D, hi: D) -> D',
    'fn percentile<D>(x: D, p: Scalar) -> D',
    'fn samples<D>(x: D) -> List<D>',
    'fn pdf<D>(x: D) -> Scalar',
    'fn cdf<D>(x: D) -> Scalar',
    '',
  ].join('\n'));
  n.use('uncertainty::functions');
  resetUncertaintyRng();
  return n;
}

// ── the Uncertain class ───────────────────────────────────────────

test('Uncertain: construct via normal — sample mean ≈ μ, stdev ≈ σ', () => {
  const n = mkHost();
  n.loadSource('let x = normal(10, 2)', '<t>');
  const x = n.values.get('x');
  assert.ok(x instanceof Uncertain);
  // With N=1000, the std error of the mean is σ/√N ≈ 0.063 — 0.2 is
  // generous enough that flaky failures are essentially impossible.
  assert.ok(close(meanOf(x.samples), 10, 0.2));
  assert.ok(close(stdevOf(x.samples), 2, 0.15));
});

test('Sample count = 1000 by default', () => {
  const n = mkHost();
  n.loadSource('let u = normal(0, 1)', '<t>');
  assert.equal(n.values.get('u').samples.length, 1000);
});

test('Uncertain preserves dim through construction', () => {
  const n = mkHost();
  n.loadSource('let d = normal(2.7 kilogram/meter^3, 0.1 kilogram/meter^3)', '<t>');
  const d = n.values.get('d');
  assert.ok(d instanceof Uncertain);
  assert.deepEqual(d.dim, { mass: 1, length: -3 });
});

test('normal: dim mismatch errors loudly', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let bad = normal(2 meter, 0.1 second)', '<t>'),
    /dim/i);
});

// ── arithmetic propagation ────────────────────────────────────────

test('Uncertain + Uncertain: variances add — stdev = √(σ₁² + σ₂²)', () => {
  const n = mkHost();
  n.loadSource('let a = normal(2, 0.3)\nlet b = normal(5, 0.4)\nlet c = a + b', '<t>');
  const c = n.values.get('c');
  assert.ok(c instanceof Uncertain);
  assert.ok(close(meanOf(c.samples), 7, 0.1));
  assert.ok(close(stdevOf(c.samples), 0.5, 0.05));   // √(0.09 + 0.16) = 0.5
});

test('Quantity ⊕ Uncertain commutes (mul + add)', () => {
  const n = mkHost();
  n.loadSource([
    'let u = normal(10, 1)',
    'let r1 = u * 3',
    'let r2 = 3 * u',
    'let s1 = u + 5',
    'let s2 = 5 + u',
  ].join('\n'), '<t>');
  const r1 = n.values.get('r1'), r2 = n.values.get('r2');
  const s1 = n.values.get('s1'), s2 = n.values.get('s2');
  for (const v of [r1, r2, s1, s2]) assert.ok(v instanceof Uncertain);
  assert.ok(close(meanOf(r1.samples), 30, 0.3));
  assert.ok(close(meanOf(r2.samples), 30, 0.3));
  assert.ok(close(meanOf(s1.samples), 15, 0.2));
  assert.ok(close(meanOf(s2.samples), 15, 0.2));
});

test('Quantity − Uncertain (non-commutative subtraction)', () => {
  const n = mkHost();
  n.loadSource('let u = normal(3, 0.5)\nlet r = 10 - u', '<t>');
  const r = n.values.get('r');
  assert.ok(r instanceof Uncertain);
  assert.ok(close(meanOf(r.samples), 7, 0.1));
  assert.ok(close(stdevOf(r.samples), 0.5, 0.1));
});

test('Quantity / Uncertain (non-commutative division)', () => {
  const n = mkHost();
  // σ small relative to μ so the distribution doesn't smear.
  n.loadSource('let u = normal(2, 0.01)\nlet r = 10 / u', '<t>');
  const r = n.values.get('r');
  assert.ok(r instanceof Uncertain);
  assert.ok(close(meanOf(r.samples), 5, 0.1));
});

test('Uncertain × Uncertain: product distribution', () => {
  const n = mkHost();
  // x~N(4, 0.1), y~N(5, 0.1); E[xy] ≈ 20; first-order
  // SD[xy] ≈ √(μy²σx² + μx²σy²) = √(0.25 + 0.16) = √0.41 ≈ 0.640.
  n.loadSource('let x = normal(4, 0.1)\nlet y = normal(5, 0.1)\nlet p = x * y', '<t>');
  const p = n.values.get('p');
  assert.ok(p instanceof Uncertain);
  assert.ok(close(meanOf(p.samples), 20, 0.2));
  assert.ok(close(stdevOf(p.samples), Math.sqrt(0.41), 0.08));
});

test('Uncertain ^ scalar: nonlinear propagation (squaring)', () => {
  const n = mkHost();
  // x ~ N(2, 0.1); x² has E[x²] = μ² + σ² = 4.01, first-order SD ≈ 2μσ = 0.4.
  n.loadSource('let x = normal(2, 0.1)\nlet y = x^2', '<t>');
  const y = n.values.get('y');
  assert.ok(y instanceof Uncertain);
  assert.ok(close(meanOf(y.samples), 4.01, 0.05));
  assert.ok(close(stdevOf(y.samples), 0.4, 0.05));
});

// ── reductions collapse to Quantity ───────────────────────────────

test('mean(uncertain) → regular Quantity (not Uncertain)', () => {
  const n = mkHost();
  n.loadSource('let u = normal(10, 2)\nlet m = mean(u)', '<t>');
  const m = n.values.get('m');
  assert.ok(m instanceof Quantity);
  assert.ok(!(m instanceof Uncertain));
  assert.ok(close(m.value, 10, 0.2));
});

test('stdev(uncertain) → regular Quantity', () => {
  const n = mkHost();
  n.loadSource('let u = normal(10, 2)\nlet s = stdev(u)', '<t>');
  const s = n.values.get('s');
  assert.ok(s instanceof Quantity);
  assert.ok(!(s instanceof Uncertain));
  assert.ok(close(s.value, 2, 0.15));
});

test('mean still works on plain lists', () => {
  const n = mkHost();
  n.loadSource('let xs = [1, 2, 3, 4, 5]\nlet m = mean(xs)', '<t>');
  assert.equal(n.values.get('m').value, 3);
});

// ── reproducibility ───────────────────────────────────────────────

test('Reproducibility: two fresh hosts with same seed produce identical samples', () => {
  const n1 = mkHost();
  n1.loadSource('let u = normal(0, 1)', '<t>');
  const s1 = Array.from(n1.values.get('u').samples);

  const n2 = mkHost();
  n2.loadSource('let u = normal(0, 1)', '<t>');
  const s2 = Array.from(n2.values.get('u').samples);

  assert.deepEqual(s1.slice(0, 10), s2.slice(0, 10));
});

// ── samplesOf helper ──────────────────────────────────────────────

test('samplesOf: a scalar Quantity lifts to a constant array', () => {
  const samples = samplesOf(new Quantity(7, {}), 100);
  assert.equal(samples.length, 100);
  assert.equal(samples[0], 7);
  assert.equal(samples[99], 7);
});

test('samplesOf: an Uncertain returns its own samples', () => {
  const u = new Uncertain(new Float64Array([1, 2, 3, 4]), {});
  assert.strictEqual(samplesOf(u, 4), u.samples);
});

// ── uniform ───────────────────────────────────────────────────────

test('uniform: mean ≈ (lo+hi)/2, stdev ≈ (hi-lo)/√12, samples in [lo, hi]', () => {
  const n = mkHost();
  n.loadSource('let x = uniform(10, 20)', '<t>');
  const x = n.values.get('x');
  assert.ok(x instanceof Uncertain);
  assert.ok(close(meanOf(x.samples), 15, 0.2));
  assert.ok(close(stdevOf(x.samples), (20 - 10) / Math.sqrt(12), 0.15));
  for (let i = 0; i < x.samples.length; i++) {
    assert.ok(x.samples[i] >= 10 && x.samples[i] <= 20);
  }
});

test('uniform: lo > hi rejects', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let bad = uniform(20, 10)', '<t>'),
    /lo/i);
});

// ── lognormal ─────────────────────────────────────────────────────

test('lognormal: real-space mean and stdev ≈ inputs', () => {
  const n = mkHost();
  n.loadSource('let g = lognormal(1.5, 0.4)', '<t>');
  const g = n.values.get('g');
  assert.ok(g instanceof Uncertain);
  // Tolerance is wider here — lognormal has heavier tails and the MC
  // estimator for stdev has higher variance.
  assert.ok(close(meanOf(g.samples), 1.5, 0.1));
  assert.ok(close(stdevOf(g.samples), 0.4, 0.1));
});

test('lognormal: all samples are positive', () => {
  const n = mkHost();
  n.loadSource('let g = lognormal(2, 1)', '<t>');
  const g = n.values.get('g');
  for (let i = 0; i < g.samples.length; i++) {
    assert.ok(g.samples[i] > 0, `sample ${i} = ${g.samples[i]}`);
  }
});

test('lognormal: μ ≤ 0 rejects (real-space mean must be positive)', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let bad = lognormal(-1, 0.1)', '<t>'),
    /positive|> 0/i);
});

// ── triangular ────────────────────────────────────────────────────

test('triangular: mean ≈ (lo+mode+hi)/3, samples in [lo, hi]', () => {
  const n = mkHost();
  n.loadSource('let r = triangular(0.82, 0.91, 0.95)', '<t>');
  const r = n.values.get('r');
  assert.ok(r instanceof Uncertain);
  assert.ok(close(meanOf(r.samples), (0.82 + 0.91 + 0.95) / 3, 0.01));
  for (let i = 0; i < r.samples.length; i++) {
    assert.ok(r.samples[i] >= 0.82 && r.samples[i] <= 0.95);
  }
});

test('triangular: lo ≤ mode ≤ hi required', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let bad = triangular(0, 5, 3)', '<t>'),
    /lo|mode|hi/i);
});

// ── percentile ────────────────────────────────────────────────────

test('percentile: P50 ≈ mean for a symmetric distribution', () => {
  const n = mkHost();
  n.loadSource('let u = normal(100, 5)\nlet p50 = percentile(u, 50)', '<t>');
  const p50 = n.values.get('p50');
  assert.ok(p50 instanceof Quantity);
  assert.ok(!(p50 instanceof Uncertain));
  assert.ok(close(p50.value, 100, 0.5));
});

test('percentile: P05 < P50 < P95', () => {
  const n = mkHost();
  n.loadSource([
    'let u = normal(0, 1)',
    'let p05 = percentile(u, 5)',
    'let p50 = percentile(u, 50)',
    'let p95 = percentile(u, 95)',
  ].join('\n'), '<t>');
  const p05 = n.values.get('p05').value;
  const p50 = n.values.get('p50').value;
  const p95 = n.values.get('p95').value;
  assert.ok(p05 < p50);
  assert.ok(p50 < p95);
  // Standard normal: P05 ≈ -1.645, P95 ≈ 1.645.
  assert.ok(close(p05, -1.645, 0.15));
  assert.ok(close(p95,  1.645, 0.15));
});

test('percentile: P0 = min, P100 = max', () => {
  const n = mkHost();
  n.loadSource([
    'let u = uniform(10, 20)',
    'let p0   = percentile(u, 0)',
    'let p100 = percentile(u, 100)',
  ].join('\n'), '<t>');
  const u = n.values.get('u').samples;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < u.length; i++) {
    if (u[i] < mn) mn = u[i];
    if (u[i] > mx) mx = u[i];
  }
  assert.equal(n.values.get('p0').value, mn);
  assert.equal(n.values.get('p100').value, mx);
});

test('percentile: rejects non-Uncertain first arg', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let bad = percentile(5, 50)', '<t>'),
    /uncertain/i);
});

test('percentile: rejects p outside [0, 100]', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let u = normal(0, 1)\nlet bad = percentile(u, 150)', '<t>'),
    /\[0, ?100\]|0,? 100/i);
});

// ── hist(uncertain) ───────────────────────────────────────────────

test('hist(uncertain) returns a Plot with a bins layer over the samples', () => {
  const n = mkHost();
  n.loadSource('let p = hist(normal(50, 5), "x", "count", "Distribution")', '<t>');
  const p = n.values.get('p');
  // hist now returns a Plot (SPEC-LAYERED-PLOTS) rather than emitting
  // a legacy descriptor — ep's auto-render handles the sink.
  assert.equal(p.__plot, true);
  assert.equal(p.family, 'hist');
  assert.equal(p.layers.length, 1);
  assert.equal(p.layers[0].kind, 'bins');
  assert.equal(p.layers[0].values.length, 1000);
  assert.equal(p.title, 'Distribution');
});

// ── samples / pdf / cdf ───────────────────────────────────────────

test('samples(uncertain) materializes as a List<Quantity>', () => {
  const n = mkHost();
  n.loadSource('let u = normal(10, 2)\nlet xs = samples(u)', '<t>');
  const xs = n.values.get('xs');
  assert.ok(Array.isArray(xs));
  assert.equal(xs.length, 1000);
  assert.ok(xs[0] instanceof Quantity);
  assert.deepEqual(xs[0].dim, {});      // dimensionless input
});

test('samples preserves dim on each element', () => {
  const n = mkHost();
  n.loadSource('let u = normal(2.7 kilogram/meter^3, 0.1 kilogram/meter^3)\nlet xs = samples(u)', '<t>');
  const xs = n.values.get('xs');
  assert.deepEqual(xs[0].dim, { mass: 1, length: -3 });
});

test('mean(samples(unc)) ≈ mean(unc)', () => {
  const n = mkHost();
  n.loadSource([
    'let u = normal(100, 5)',
    'let m1 = mean(u)',
    'let m2 = mean(samples(u))',
  ].join('\n'), '<t>');
  // Same samples, same mean — identical to within floating-point.
  assert.ok(close(n.values.get('m1').value, n.values.get('m2').value, 1e-9));
});

test('samples: rejects non-Uncertain argument', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let bad = samples(5)', '<t>'),
    /uncertain/i);
});

test('pdf(uncertain) emits a line plot with KDE curve', async () => {
  const { setPlotSink } = await import('../src/load.js');
  const captured = [];
  setPlotSink(d => captured.push(d));
  const n = mkHost();
  n.loadSource('let u = normal(0, 1)\nlet _p = pdf(u)', '<t>');
  setPlotSink(null);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].type, 'line');
  assert.equal(captured[0].xs.length, 100);
  assert.equal(captured[0].ys.length, 100);
  // Sanity: density is monotone-increasing then -decreasing; the
  // largest y value is somewhere near the middle of the xs grid.
  let peakIdx = 0;
  for (let i = 1; i < captured[0].ys.length; i++) {
    if (captured[0].ys[i] > captured[0].ys[peakIdx]) peakIdx = i;
  }
  assert.ok(peakIdx > 30 && peakIdx < 70, `peak index ${peakIdx} should be near the middle of [0, 100)`);
});

test('cdf(uncertain) emits a sorted-step line plot', async () => {
  const { setPlotSink } = await import('../src/load.js');
  const captured = [];
  setPlotSink(d => captured.push(d));
  const n = mkHost();
  n.loadSource('let u = normal(0, 1)\nlet _c = cdf(u)', '<t>');
  setPlotSink(null);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].type, 'line');
  // xs should be sorted (monotone non-decreasing).
  for (let i = 1; i < captured[0].xs.length; i++) {
    assert.ok(captured[0].xs[i] >= captured[0].xs[i - 1]);
  }
  // ys should run from 1/N to 1, monotone.
  assert.ok(close(captured[0].ys[0], 1 / captured[0].ys.length, 0.001));
  assert.equal(captured[0].ys[captured[0].ys.length - 1], 1);
});

test('pdf / cdf reject non-Uncertain argument', () => {
  const n = mkHost();
  assert.throws(() => n.loadSource('let _ = pdf(5)', '<t>'), /uncertain/i);
  assert.throws(() => n.loadSource('let _ = cdf(5)', '<t>'), /uncertain/i);
});
