// Lists: literal syntax, equality, primitives (head/tail/cons/cons_end/len/is_empty).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

// ── literals ─────────────────────────────────────────────────────

test('list literal: []', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let xs = []');
  const xs = n.values.get('xs');
  assert.ok(Array.isArray(xs));
  assert.equal(xs.length, 0);
});

test('list literal: numbers', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let xs = [1, 2, 3]');
  const xs = n.values.get('xs');
  assert.equal(xs.length, 3);
  assert.equal(xs[0].value, 1);
  assert.equal(xs[2].value, 3);
});

test('list literal: with arithmetic expressions', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let xs = [1+1, 2*2, 3^2]');
  const xs = n.values.get('xs');
  assert.equal(xs[0].value, 2);
  assert.equal(xs[1].value, 4);
  assert.equal(xs[2].value, 9);
});

test('list literal: with quantities', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    let xs = [1 m, 2 m, 3 m]
  `);
  const xs = n.values.get('xs');
  assert.equal(xs.length, 3);
  assert.deepEqual(xs[0].dim, { length: 1 });
});

// ── equality ─────────────────────────────────────────────────────

test('list equality: same lists', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let a = [1, 2, 3] == [1, 2, 3]');
  n.loadSource('let b = [1, 2, 3] == [1, 2]');
  n.loadSource('let c = [] == []');
  assert.equal(n.values.get('a'), true);
  assert.equal(n.values.get('b'), false);
  assert.equal(n.values.get('c'), true);
});

test('list equality: list-vs-scalar broadcasts (ep extension)', () => {
  // Previously rejected as "cannot compare List with non-List"; the
  // broadcasting work makes this a useful mask construction primitive.
  // Structural list-vs-list equality is still preserved (see test above).
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let m = [1, 2, 1] == 1');
  assert.deepEqual(n.values.get('m'), [true, false, true]);
});

test('list ordering: broadcasts element-wise (ep extension)', () => {
  // Previously rejected; now broadcasts so `xs < ys` returns a List<Bool>
  // mask. Lengths must match for list-vs-list.
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let m = [1, 5] < [3, 2]');
  assert.deepEqual(n.values.get('m'), [true, false]);
});

// ── primitives ───────────────────────────────────────────────────

test('len: list length', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn len<A>(xs: List<A>) -> Scalar');   // extern
  n.loadSource('let n = len([1, 2, 3, 4])');
  assert.equal(n.values.get('n').value, 4);
});

test('len: empty list → 0', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn len<A>(xs: List<A>) -> Scalar');
  n.loadSource('let n = len([])');
  assert.equal(n.values.get('n').value, 0);
});

test('head: first element', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn head<A>(xs: List<A>) -> A');
  n.loadSource('let h = head([10, 20, 30])');
  assert.equal(n.values.get('h').value, 10);
});

test('head: empty list throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn head<A>(xs: List<A>) -> A');
  assert.throws(() => n.loadSource('let h = head([])'), /empty list/);
});

test('tail: rest of list', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn tail<A>(xs: List<A>) -> List<A>');
  n.loadSource('let t = tail([10, 20, 30])');
  const t = n.values.get('t');
  assert.equal(t.length, 2);
  assert.equal(t[0].value, 20);
});

test('cons: prepend', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn cons<A>(x: A, xs: List<A>) -> List<A>');
  n.loadSource('let c = cons(1, [2, 3])');
  const c = n.values.get('c');
  assert.equal(c.length, 3);
  assert.equal(c[0].value, 1);
});

test('cons_end: append', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn cons_end<A>(x: A, xs: List<A>) -> List<A>');
  n.loadSource('let c = cons_end(99, [1, 2])');
  const c = n.values.get('c');
  assert.equal(c.length, 3);
  assert.equal(c[2].value, 99);
});

test('is_empty: derived via xs == []', () => {
  const n = new Numbat({ prelude: 'none' });
  // is_empty is NOT extern in upstream — it's defined as xs == [].
  n.loadSource('fn is_empty<A>(xs: List<A>) -> Bool = xs == []');
  n.loadSource('let e = is_empty([])');
  n.loadSource('let f = is_empty([1, 2])');
  assert.equal(n.values.get('e'), true);
  assert.equal(n.values.get('f'), false);
});

test('upstream-style: concat fn defined recursively', () => {
  // Mirrors upstream core::lists.concat
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    fn head<A>(xs: List<A>) -> A
    fn tail<A>(xs: List<A>) -> List<A>
    fn cons<A>(x: A, xs: List<A>) -> List<A>
    fn is_empty<A>(xs: List<A>) -> Bool = xs == []
    fn concat<A>(xs1: List<A>, xs2: List<A>) -> List<A> =
      if is_empty(xs1)
        then xs2
        else cons(head(xs1), concat(tail(xs1), xs2))
    let result = concat([1, 2], [3, 4, 5])
  `);
  const r = n.values.get('result');
  assert.equal(r.length, 5);
  assert.equal(r[0].value, 1);
  assert.equal(r[4].value, 5);
});
