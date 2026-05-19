import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/js/evaluator.js';

const bodyOf = (lines) => lines.map(src => ({src}));

// Pull the final-row result value out of an evaluation. Convenience for
// short test programs whose answer is the last expression's value.
const lastValue = (lines) => {
  const r = evaluate(bodyOf(lines));
  const row = r.rows[r.rows.length - 1];
  if (row.error) throw new Error(`evaluation failed: ${row.error}`);
  return row.result;
};

// Pull a scope binding's raw value out (lists land here as plain arrays
// of Quantity / Bool — same shape numbat-js's runtime hands back).
const scopeOf = (lines, name) => {
  const r = evaluate(bodyOf(lines));
  return r.scope[name];
};

// ── comparison broadcasting ───────────────────────────────────────

test('cmp broadcast: list > scalar → List<Bool>', () => {
  const v = scopeOf([
    'xs = [1, 5, 10]',
    'mask = xs > 5',
  ], 'mask');
  assert.ok(Array.isArray(v), 'mask should be an array');
  assert.deepEqual(v, [false, false, true]);
});

test('cmp broadcast: scalar < list → List<Bool>', () => {
  const v = scopeOf([
    'xs = [1, 5, 10]',
    'mask = 4 < xs',
  ], 'mask');
  assert.deepEqual(v, [false, true, true]);
});

test('cmp broadcast: list == scalar → List<Bool>', () => {
  const v = scopeOf([
    'xs = [1, 2, 1, 3]',
    'mask = xs == 1',
  ], 'mask');
  assert.deepEqual(v, [true, false, true, false]);
});

test('cmp broadcast: list != scalar → List<Bool>', () => {
  const v = scopeOf([
    'xs = [1, 2, 1]',
    'mask = xs != 1',
  ], 'mask');
  assert.deepEqual(v, [false, true, false]);
});

test('cmp broadcast: list >= list (same length) → List<Bool>', () => {
  const v = scopeOf([
    'xs = [1, 5, 10]',
    'ys = [2, 5, 9]',
    'mask = xs >= ys',
  ], 'mask');
  assert.deepEqual(v, [false, true, true]);
});

test('cmp broadcast: list/list length mismatch errors out', () => {
  const r = evaluate(bodyOf([
    'xs = [1, 2, 3]',
    'ys = [1, 2]',
    'mask = xs > ys',
  ]));
  // Row 3 (mask) carries the error; xs and ys evaluate fine.
  assert.ok(r.rows[2].error, 'expected an error on the mask row');
  assert.match(r.rows[2].error, /length mismatch/);
});

// ── logical-op broadcasting ───────────────────────────────────────

test('logical broadcast: List<Bool> && List<Bool> → List<Bool>', () => {
  const v = scopeOf([
    'xs = [1, 5, 10]',
    'mask = (xs > 2) && (xs < 9)',
  ], 'mask');
  assert.deepEqual(v, [false, true, false]);
});

test('logical broadcast: List<Bool> || scalar Bool broadcasts the scalar', () => {
  const v = scopeOf([
    'xs = [1, 5, 10]',
    'mask = (xs > 100) || true',
  ], 'mask');
  assert.deepEqual(v, [true, true, true]);
});

test('logical broadcast: unary ! over List<Bool>', () => {
  const v = scopeOf([
    'xs = [1, 5, 10]',
    'mask = !(xs > 5)',
  ], 'mask');
  assert.deepEqual(v, [true, true, false]);
});

// ── filter mask-form ──────────────────────────────────────────────

test('filter mask-form: filter(mask, xs) keeps where mask is true', () => {
  const v = scopeOf([
    'xs = [1, 5, 10, 15]',
    'big = filter(xs > 5, xs)',
  ], 'big');
  assert.ok(Array.isArray(v));
  assert.equal(v.length, 2);
  // Values are Quantities; pull canonical values for comparison.
  assert.equal(v[0].value, 10);
  assert.equal(v[1].value, 15);
});

test('filter mask-form: empty mask result returns empty list', () => {
  const v = scopeOf([
    'xs = [1, 2, 3]',
    'big = filter(xs > 100, xs)',
  ], 'big');
  assert.ok(Array.isArray(v));
  assert.equal(v.length, 0);
});

test('filter mask-form: mask length mismatch errors out', () => {
  const r = evaluate(bodyOf([
    'xs = [1, 2, 3]',
    'mask = [true, false]',
    'out = filter(mask, xs)',
  ]));
  assert.ok(r.rows[2].error, 'expected an error on the filter row');
  assert.match(r.rows[2].error, /length/);
});

test('filter functional form still works (function predicate)', () => {
  const v = scopeOf([
    'xs = [1, 5, 10, 15]',
    'big = filter(x => x > 5, xs)',
  ], 'big');
  assert.equal(v.length, 2);
  assert.equal(v[0].value, 10);
  assert.equal(v[1].value, 15);
});

// ── any / all / count mask reductions ─────────────────────────────

test('any: true when at least one element is true', () => {
  const v = scopeOf([
    'xs = [1, 5, 10]',
    'r = any(xs > 7)',
  ], 'r');
  assert.equal(v, true);
});

test('any: false on all-false mask', () => {
  const v = scopeOf([
    'xs = [1, 2, 3]',
    'r = any(xs > 100)',
  ], 'r');
  assert.equal(v, false);
});

test('any: short-circuits on first true (verified via long list)', () => {
  // No direct way to observe short-circuit from the outside other than
  // it not OOMing; assert correctness on a long input.
  const lines = ['xs = [' + Array.from({length: 1000}, (_, i) => i).join(', ') + ']'];
  lines.push('r = any(xs == 5)');
  const v = scopeOf(lines, 'r');
  assert.equal(v, true);
});

test('all: true on all-true mask', () => {
  const v = scopeOf([
    'xs = [1, 5, 10]',
    'r = all(xs > 0)',
  ], 'r');
  assert.equal(v, true);
});

test('all: false when any element fails', () => {
  const v = scopeOf([
    'xs = [1, 5, 10]',
    'r = all(xs > 3)',
  ], 'r');
  assert.equal(v, false);
});

test('count: number of trues in the mask', () => {
  const v = scopeOf([
    'xs = [1, 5, 10, 15, 20]',
    'r = count(xs > 7)',
  ], 'r');
  assert.equal(v.value, 3);
});

test('count: zero on all-false mask', () => {
  const v = scopeOf([
    'xs = [1, 2, 3]',
    'r = count(xs > 100)',
  ], 'r');
  assert.equal(v.value, 0);
});

test('any/all: reject non-Bool list', () => {
  const r = evaluate(bodyOf([
    'xs = [1, 2, 3]',
    'bad = any(xs)',
  ]));
  assert.ok(r.rows[1].error, 'expected any() to reject a List<Number>');
});
