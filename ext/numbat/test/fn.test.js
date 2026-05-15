// fn / function call tests against the full Numbat class.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

// ── user-defined fn ──────────────────────────────────────────────

test('fn: zero-param fn returns a constant', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn answer() = 42');
  const ast = n.loadSource('let x = answer()');
  assert.equal(n.values.get('x').value, 42);
});

test('fn: single-param fn with arithmetic', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn double(x) = 2 * x');
  n.loadSource('let y = double(7)');
  assert.equal(n.values.get('y').value, 14);
});

test('fn: multi-param fn', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn add(a, b) = a + b');
  n.loadSource('let s = add(3, 4)');
  assert.equal(n.values.get('s').value, 7);
});

test('fn: typed param with dim annotation enforced at body', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    fn double_length(x: Length) -> Length = 2 * x
    let total: Length = double_length(5 metre)
  `);
  assert.equal(n.values.get('total').value, 10);
  assert.deepEqual(n.values.get('total').dim, { length: 1 });
});

test('fn: return-type mismatch throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    dimension Mass
    fn weird() -> Length = 5
  `);
  // 5 is scalar (dim {}), but return type says Length ({length: 1}).
  assert.throws(() => n.loadSource('let x = weird()'), /return type mismatch/);
});

test('fn: arg-count mismatch throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn add(a, b) = a + b');
  assert.throws(() => n.loadSource('let s = add(1)'), /expected 2 args, got 1/);
});

test('fn: recursive call across two fns (mutual recursion forbidden in pure-fn lexical scope here, just nesting)', () => {
  // Verify nested calls work
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn double(x) = 2 * x');
  n.loadSource('fn quadruple(x) = double(double(x))');
  n.loadSource('let r = quadruple(3)');
  assert.equal(n.values.get('r').value, 12);
});

test('fn: lexical scope reads outer let bindings', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let factor = 10');
  n.loadSource('fn scale(x) = factor * x');
  n.loadSource('let r = scale(3)');
  assert.equal(n.values.get('r').value, 30);
});

// ── built-in fns ─────────────────────────────────────────────────

test('builtin: sqrt of a Number', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let r = sqrt(9)');
  assert.equal(n.values.get('r').value, 3);
});

test('builtin: sqrt of a Length^2 yields Length', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    let area = (4 m) * (4 m)
    let side = sqrt(area)
  `);
  const side = n.values.get('side');
  assert.equal(side.value, 4);
  assert.deepEqual(side.dim, { length: 1 });
});

test('builtin: sqrt of odd-dim throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    let l = 5 m
  `);
  assert.throws(() => n.loadSource('let bad = sqrt(l)'), /odd exponent/);
});

test('builtin: trig functions need dimensionless input', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
  `);
  assert.throws(() => n.loadSource('let bad = sin(5 m)'), /sin: argument must be dimensionless/);
});

test('builtin: ln(e) ≈ 1', () => {
  const n = new Numbat({ prelude: 'none' });
  // 2.71828 ≈ e
  n.loadSource('let r = ln(2.7182818284)');
  assert.ok(Math.abs(n.values.get('r').value - 1) < 1e-9);
});

test('builtin: user-defined fn shadows builtin', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn sqrt(x) = 99');
  n.loadSource('let r = sqrt(4)');
  assert.equal(n.values.get('r').value, 99);
});

test('builtin: unknown function throws helpfully', () => {
  const n = new Numbat({ prelude: 'none' });
  assert.throws(() => n.loadSource('let r = mystery(5)'), /unknown function: mystery/);
});
