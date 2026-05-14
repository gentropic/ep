import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dimEq, dimMul, dimDiv, dimPow, dimInv, dimEmpty, dimFormat,
} from '../src/dimensions.js';

test('dimEq: matches regardless of key order and skips zero entries', () => {
  assert.equal(dimEq({mass: 1, length: -3}, {length: -3, mass: 1}), true);
  assert.equal(dimEq({}, {}), true);
  assert.equal(dimEq({mass: 1}, {mass: 1, time: 0}), true);
  assert.equal(dimEq({mass: 1}, {mass: 2}), false);
  assert.equal(dimEq({mass: 1}, {length: 1}), false);
});

test('dimMul / dimDiv: componentwise add and subtract, drop zeros', () => {
  assert.deepEqual(dimMul({length: 1}, {length: 2}), {length: 3});
  assert.deepEqual(dimMul({mass: 1}, {length: -3}), {mass: 1, length: -3});
  assert.deepEqual(dimMul({mass: 1}, {mass: -1}), {});
  assert.deepEqual(dimDiv({mass: 1, length: 1}, {length: 1}), {mass: 1});
});

test('dimPow: scales exponents; zero exponent drops entry', () => {
  assert.deepEqual(dimPow({length: 1}, 3), {length: 3});
  assert.deepEqual(dimPow({mass: 1, length: -3}, 2), {mass: 2, length: -6});
  assert.deepEqual(dimPow({length: 1}, 0), {});
});

test('dimInv: negates all exponents', () => {
  assert.deepEqual(dimInv({length: 1, time: -1}), {length: -1, time: 1});
  assert.deepEqual(dimInv({}), {});
});

test('dimEmpty: true for scalar / dimensionless only', () => {
  assert.equal(dimEmpty({}), true);
  assert.equal(dimEmpty({mass: 1}), false);
  // Note: dimEmpty checks Object.keys, so a stored {length: 0} counts as non-empty.
  // Arithmetic always drops zero exponents, so {length: 0} shouldn't occur in practice.
  assert.equal(dimEmpty({length: 0}), false);
});

test('dimFormat: human-readable signature', () => {
  assert.equal(dimFormat({}), '-');
  assert.equal(dimFormat({mass: 1}), 'mass');
  assert.equal(dimFormat({mass: 1, length: -3}), 'mass·length^-3');
  assert.equal(dimFormat({length: 2}), 'length^2');
});
