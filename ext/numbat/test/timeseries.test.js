// Time-series operators — diff, cumsum, roll. Length-changing
// semantics (diff returns N-1, cumsum returns N, roll(xs, w) returns
// N-w+1). Dim preservation across all three.

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

// ── diff ────────────────────────────────────────────────────────

test('diff: forward differences, length N-1', () => {
  const n = mkHost();
  n.loadSource('let d = diff([10, 12, 11, 14])', '<t>');
  const d = n.values.get('d');
  assert.equal(d.length, 3);
  assert.equal(d[0].value, 2);
  assert.equal(d[1].value, -1);
  assert.equal(d[2].value, 3);
});

test('diff: preserves dim', () => {
  const n = mkHost();
  n.loadSource('let d = diff([10 m, 12 m, 11 m])', '<t>');
  const d = n.values.get('d');
  assert.equal(d.length, 2);
  assert.deepEqual(d[0].dim, { length: 1 });
  assert.equal(d[0].value, 2);
});

test('diff: empty list returns empty', () => {
  const n = mkHost();
  n.loadSource('let d = diff([])', '<t>');
  assert.deepEqual(n.values.get('d'), []);
});

test('diff: single-element list returns empty (need ≥ 2 to difference)', () => {
  const n = mkHost();
  n.loadSource('let d = diff([5 m])', '<t>');
  assert.deepEqual(n.values.get('d'), []);
});

test('diff: errors on mixed dims', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let d = diff([1 m, 2 s])', '<t>'),
    /diff: list dims must match/);
});

// ── cumsum ──────────────────────────────────────────────────────

test('cumsum: running totals, length N', () => {
  const n = mkHost();
  n.loadSource('let c = cumsum([1, 2, 3, 4])', '<t>');
  const c = n.values.get('c');
  assert.equal(c.length, 4);
  assert.deepEqual(c.map(q => q.value), [1, 3, 6, 10]);
});

test('cumsum: preserves dim', () => {
  const n = mkHost();
  n.loadSource('let c = cumsum([3 mm, 0 mm, 5 mm, 8 mm])', '<t>');
  const c = n.values.get('c');
  assert.equal(c.length, 4);
  assert.deepEqual(c.map(q => q.value), [0.003, 0.003, 0.008, 0.016]);   // canonical (m)
  assert.deepEqual(c[0].dim, { length: 1 });
});

test('cumsum: empty list returns empty', () => {
  const n = mkHost();
  n.loadSource('let c = cumsum([])', '<t>');
  assert.deepEqual(n.values.get('c'), []);
});

test('cumsum: errors on mixed dims', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let c = cumsum([1 m, 2 s])', '<t>'),
    /cumsum: list dims must match/);
});

// ── roll + compose ──────────────────────────────────────────────

test('roll: sliding windows, length N-w+1', () => {
  const n = mkHost();
  n.loadSource('let r = roll([1, 2, 3, 4, 5], 3)', '<t>');
  const r = n.values.get('r');
  assert.equal(r.length, 3);
  assert.deepEqual(r[0].map(q => q.value), [1, 2, 3]);
  assert.deepEqual(r[1].map(q => q.value), [2, 3, 4]);
  assert.deepEqual(r[2].map(q => q.value), [3, 4, 5]);
});

test('roll: window larger than list returns empty', () => {
  const n = mkHost();
  n.loadSource('let r = roll([1, 2], 5)', '<t>');
  assert.deepEqual(n.values.get('r'), []);
});

test('roll: errors on non-positive-integer window', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let r = roll([1, 2, 3], 0)', '<t>'),
    /window must be a positive integer/);
});

test('roll + map: rolling mean composes via map(mean, roll(...))', () => {
  const n = mkHost();
  n.loadSource('let rm = map(mean, roll([1, 2, 3, 4, 5], 3))', '<t>');
  const rm = n.values.get('rm');
  assert.equal(rm.length, 3);
  // Mean of [1,2,3]=2, [2,3,4]=3, [3,4,5]=4
  assert.deepEqual(rm.map(q => q.value), [2, 3, 4]);
});

// ── diff/cumsum round-trip ──────────────────────────────────────

test('cumsum after diff: round-trip from a starting value', () => {
  // diff([a, b, c, d]) = [b-a, c-b, d-c]
  // cumsum of that = [b-a, c-a, d-a]
  // So the round-trip recovers xs[i] - xs[0] for i ≥ 1.
  const n = mkHost();
  n.loadSource('let r = cumsum(diff([10, 12, 11, 14]))', '<t>');
  const r = n.values.get('r');
  assert.deepEqual(r.map(q => q.value), [2, 1, 4]);
});
