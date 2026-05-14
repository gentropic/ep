import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quantity } from '../src/quantity.js';
import { UnitRegistry } from '../src/units.js';
import { loadPrelude } from '../src/prelude.js';

const reg = (() => { const r = new UnitRegistry(); loadPrelude(r); return r; })();

const Q = (v, d, disp) => new Quantity(v, d, disp);

test('construct: stores value, dim, disp', () => {
  const q = Q(5, {length: 1});
  assert.equal(q.value, 5);
  assert.deepEqual(q.dim, {length: 1});
  assert.equal(q.disp, null);
});

test('add: same dim sums values; mismatch throws', () => {
  const a = Q(1, {length: 1}), b = Q(2, {length: 1});
  assert.equal(a.add(b).value, 3);
  assert.throws(() => a.add(Q(1, {mass: 1})), /can't add/);
});

test('sub: same dim subtracts values; mismatch throws', () => {
  const a = Q(5, {mass: 1}), b = Q(2, {mass: 1});
  assert.equal(a.sub(b).value, 3);
  assert.throws(() => a.sub(Q(1, {length: 1})), /can't subtract/);
});

test('mul / div: compose dimensions', () => {
  const a = Q(3, {length: 1});
  const b = Q(4, {length: 1});
  const area = a.mul(b);
  assert.equal(area.value, 12);
  assert.deepEqual(area.dim, {length: 2});

  const t = Q(2, {time: 1});
  const vel = a.div(t);
  assert.equal(vel.value, 1.5);
  assert.deepEqual(vel.dim, {length: 1, time: -1});
});

test('pow: integer power; accepts number or dimensionless Quantity', () => {
  const r = Q(3, {length: 1});
  assert.equal(r.pow(2).value, 9);
  assert.deepEqual(r.pow(2).dim, {length: 2});
  assert.equal(r.pow(Q(2, {})).value, 9);
});

test('pow: dimensional exponent throws', () => {
  assert.throws(() => Q(2, {length: 1}).pow(Q(1, {mass: 1})), /dimensionless/);
});

test('neg: negates value, preserves dim and disp', () => {
  const q = Q(5, {length: 1}, 'km').neg();
  assert.equal(q.value, -5);
  assert.deepEqual(q.dim, {length: 1});
  assert.equal(q.disp, 'km');
});

test('convertTo: preserves canonical value, sets disp tag', () => {
  const grams = Q(388800, {mass: 1});
  const oz = grams.convertTo('ozt', reg);
  assert.equal(oz.value, 388800);   // unchanged
  assert.deepEqual(oz.dim, {mass: 1});
  assert.equal(oz.disp, 'ozt');
});

test('convertTo: dim mismatch throws', () => {
  assert.throws(() => Q(1, {mass: 1}).convertTo('m', reg), /can't convert/);
});

test('convertTo: unknown unit throws', () => {
  assert.throws(() => Q(1, {mass: 1}).convertTo('furlongs', reg), /unknown unit/);
});

test('arithmetic is immutable (returns new Quantity)', () => {
  const a = Q(1, {length: 1});
  const b = Q(2, {length: 1});
  const c = a.add(b);
  assert.notEqual(c, a);
  assert.equal(a.value, 1);  // unchanged
});
