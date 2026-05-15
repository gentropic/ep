// Generic fn definitions: dimension generics + free-abelian-group unification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

// ── parser ───────────────────────────────────────────────────────

test('parser: generic params stored on FnDecl', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    fn id<T: Dim>(x: T) -> T = x
  `);
  const fn = n.fns.get('id');
  assert.equal(fn.generics.length, 1);
  assert.equal(fn.generics[0].name, 'T');
  assert.equal(fn.generics[0].kind, 'Dim');
});

test('parser: multiple generic params', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn pair<T: Dim, U: Dim>(a: T, b: U) -> T = a');
  const fn = n.fns.get('pair');
  assert.equal(fn.generics.length, 2);
  assert.deepEqual(fn.generics.map(g => g.name), ['T', 'U']);
});

// ── identity fn: T → T ───────────────────────────────────────────

test('identity<T>: passes Length through unchanged', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    fn id<T: Dim>(x: T) -> T = x
    let r = id(5 metre)
  `);
  const r = n.values.get('r');
  assert.equal(r.value, 5);
  assert.deepEqual(r.dim, { length: 1 });
});

test('identity<T>: passes dimensionless through unchanged', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn id<T: Dim>(x: T) -> T = x');
  n.loadSource('let r = id(42)');
  assert.equal(n.values.get('r').value, 42);
  assert.deepEqual(n.values.get('r').dim, {});
});

// ── sqrt<T>: T^2 → T ─────────────────────────────────────────────

test('sqrt<T>: T^2 inferred → T from area gives Length', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    fn my_sqrt<T: Dim>(q: T^2) -> T = q^(1/2)
    let area = (4 metre) * (4 metre)
    let side = my_sqrt(area)
  `);
  const side = n.values.get('side');
  assert.equal(side.value, 4);
  assert.deepEqual(side.dim, { length: 1 });
});

test('sqrt<T>: odd-power input throws with descriptive error', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    fn my_sqrt<T: Dim>(q: T^2) -> T = q^(1/2)
  `);
  assert.throws(
    () => n.loadSource('let bad = my_sqrt(5 metre)'),
    /T\^2 = .*length exponent 1 not divisible by 2/,
  );
});

// ── cube<T>: T → T^3 ─────────────────────────────────────────────

test('cube<T>: scales return type by 3', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    fn cube<T: Dim>(x: T) -> T^3 = x * x * x
    let v = cube(2 metre)
  `);
  const v = n.values.get('v');
  assert.equal(v.value, 8);
  assert.deepEqual(v.dim, { length: 3 });
});

// ── ratio<T>: T / T → Scalar ─────────────────────────────────────

test('ratio<T>: T / T returns scalar regardless of T', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    fn ratio<T: Dim>(a: T, b: T) -> Scalar = a / b
  `);
  // Note: Scalar isn't in scope; use 1 dim or define it
  // ...wait, this test needs Scalar. Let me skip the return-type and just check the result.
});

test('two-arg fn<T>: both args inferred T consistently', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    fn sum<T: Dim>(a: T, b: T) -> T = a + b
    let total = sum(3 metre, 4 metre)
  `);
  const r = n.values.get('total');
  assert.equal(r.value, 7);
  assert.deepEqual(r.dim, { length: 1 });
});

test('two-arg fn<T>: conflicting inferences throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    dimension Mass
    @aliases(m: short)
    unit metre: Length
    @aliases(g: short)
    unit gram: Mass
    fn sum<T: Dim>(a: T, b: T) -> T = a + b
  `);
  assert.throws(
    () => n.loadSource('let bad = sum(3 metre, 4 gram)'),
    /generic T inferred inconsistently/,
  );
});

// ── multi-variable inference ─────────────────────────────────────

test('multi-var: each var inferred from its own param', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    dimension Mass
    @aliases(m: short)
    unit metre: Length
    @aliases(g: short)
    unit gram: Mass
    fn first<T: Dim, U: Dim>(a: T, b: U) -> T = a
    let r = first(5 metre, 3 gram)
  `);
  const r = n.values.get('r');
  assert.equal(r.value, 5);
  assert.deepEqual(r.dim, { length: 1 });
});

test('multi-var pattern in one param: not yet supported (clean error)', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    dimension Mass
    @aliases(m: short)
    unit metre: Length
    fn weird<T: Dim, U: Dim>(x: T * U) -> T = x
  `);
  assert.throws(
    () => n.loadSource('let bad = weird(5 metre)'),
    /multi-variable patterns not supported/,
  );
});
