// if/then/else + comparison op tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

// ── comparisons ──────────────────────────────────────────────────

test('comparison: ==, != on numbers', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let a = 5 == 5');
  n.loadSource('let b = 5 == 6');
  n.loadSource('let c = 5 != 6');
  assert.equal(n.values.get('a'), true);
  assert.equal(n.values.get('b'), false);
  assert.equal(n.values.get('c'), true);
});

test('comparison: <, <=, >, >= on numbers', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let a = 3 < 5');
  n.loadSource('let b = 5 <= 5');
  n.loadSource('let c = 7 > 2');
  n.loadSource('let d = 2 >= 3');
  assert.equal(n.values.get('a'), true);
  assert.equal(n.values.get('b'), true);
  assert.equal(n.values.get('c'), true);
  assert.equal(n.values.get('d'), false);
});

test('comparison: same-dim quantities compared', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @metric_prefixes
    @aliases(m: short)
    unit metre: Length
    let a = 3 m < 5 m
    let b = 1000 m == 1 km
  `);
  assert.equal(n.values.get('a'), true);
  assert.equal(n.values.get('b'), true);
});

test('comparison: dim mismatch throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    dimension Mass
    @aliases(m: short)
    unit metre: Length
    @aliases(g: short)
    unit gram: Mass
  `);
  assert.throws(() => n.loadSource('let bad = 5 m < 5 g'), /dim mismatch/);
});

// ── booleans ─────────────────────────────────────────────────────

test('Bool literals: true / false', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let t = true');
  n.loadSource('let f = false');
  assert.equal(n.values.get('t'), true);
  assert.equal(n.values.get('f'), false);
});

test('Bool ==', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let a = true == true');
  n.loadSource('let b = true != false');
  assert.equal(n.values.get('a'), true);
  assert.equal(n.values.get('b'), true);
});

test('Bool: ordering rejected', () => {
  const n = new Numbat({ prelude: 'none' });
  assert.throws(() => n.loadSource('let x = true < false'), /ordering not defined on booleans/);
});

test('Bool: compare Bool to Quantity rejected', () => {
  const n = new Numbat({ prelude: 'none' });
  assert.throws(() => n.loadSource('let x = true == 5'), /cannot compare Bool with Quantity/);
});

// ── if-then-else ─────────────────────────────────────────────────

test('if: takes the then-branch when true', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let r = if true then 1 else 2');
  assert.equal(n.values.get('r').value, 1);
});

test('if: takes the else-branch when false', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let r = if false then 1 else 2');
  assert.equal(n.values.get('r').value, 2);
});

test('if: with comparison condition', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let r = if 3 < 5 then 100 else 0');
  assert.equal(n.values.get('r').value, 100);
});

test('if: nested if in else-branch', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    fn sign(x) =
      if x > 0 then 1
      else if x < 0 then -1
      else 0
  `);
  n.loadSource('let a = sign(5)');
  n.loadSource('let b = sign(-3)');
  n.loadSource('let c = sign(0)');
  assert.equal(n.values.get('a').value, 1);
  assert.equal(n.values.get('b').value, -1);
  assert.equal(n.values.get('c').value, 0);
});

test('if: non-Bool condition rejected', () => {
  const n = new Numbat({ prelude: 'none' });
  assert.throws(() => n.loadSource('let r = if 5 then 1 else 2'), /if-condition must be a Bool/);
});

test('if: in fn body', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn max2(a, b) = if a > b then a else b');
  n.loadSource('let m = max2(7, 3)');
  assert.equal(n.values.get('m').value, 7);
});
