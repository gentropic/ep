// Columnar Dataset value + column access (SPEC-DATASETS Phase 1.2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

// A small program: declare a struct, build a list of rows, columnarize.
const withRows = (tail) => `
  struct Row { grade: Scalar, tonnage: Scalar }
  let rows = [
    Row { grade: 2, tonnage: 100 },
    Row { grade: 5, tonnage: 40 },
    Row { grade: 8, tonnage: 25 },
  ]
  ${tail}
`;

test('dataset: columnarizes a list of structs', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(withRows('let d = dataset(rows)'));
  const d = n.values.get('d');
  assert.equal(d.__dataset, true);
  assert.equal(d.length, 3);
  assert.deepEqual([...d.columns.keys()], ['grade', 'tonnage']);
});

test('dataset: column access returns the column', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(withRows(`
    let d = dataset(rows)
    let g = d.grade
    let t = d.tonnage
  `));
  assert.deepEqual(n.values.get('g').map(q => q.value), [2, 5, 8]);
  assert.deepEqual(n.values.get('t').map(q => q.value), [100, 40, 25]);
});

test('dataset: column access composes with broadcasting + reductions', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(withRows(`
    let d = dataset(rows)
    let metal = d.grade * d.tonnage
  `));
  assert.deepEqual(n.values.get('metal').map(q => q.value), [200, 200, 200]);
});

test('dataset: unknown column throws with the available list', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(withRows('let d = dataset(rows)'));
  assert.throws(() => n.loadSource('let bad = d.depth'),
    /no column 'depth' in dataset \(have: grade, tonnage\)/);
});

test('dataset: len() returns the row count', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(withRows(`
    fn len<A>(xs: List<A>) -> Scalar
    let d = dataset(rows)
    let n_rows = len(d)
  `));
  assert.equal(n.values.get('n_rows').value, 3);
});

test('dataset: empty list yields an empty dataset', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    struct Row { grade: Scalar }
    let rows: List<Row> = []
    let d = dataset(rows)
  `);
  const d = n.values.get('d');
  assert.equal(d.__dataset, true);
  assert.equal(d.length, 0);
  assert.equal(d.columns.size, 0);
});

test('dataset: non-struct elements rejected', () => {
  const n = new Numbat({ prelude: 'none' });
  assert.throws(() => n.loadSource('let d = dataset([1, 2, 3])'),
    /list elements must be structs/);
});

test('dataset: a row missing a field is rejected', () => {
  const n = new Numbat({ prelude: 'none' });
  // Two different struct types with mismatched fields land in one list —
  // the runtime list is heterogeneous JS objects; datasetFromRows checks
  // every row carries the first row's columns.
  assert.throws(() => n.loadSource(`
    struct A { x: Scalar, y: Scalar }
    struct B { x: Scalar }
    let d = dataset([A { x: 1, y: 2 }, B { x: 3 }])
  `), /row 1 is missing field 'y'/);
});

// ── the `where` clause (datasets Phase 1.5) ──────────────────────

test('where: filters a dataset, predicate scoped to its columns', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(withRows(`
    let d = dataset(rows)
    let big = d where grade > 4
  `));
  const big = n.values.get('big');
  assert.equal(big.__dataset, true);
  assert.equal(big.length, 2);                       // grades 5 and 8
  assert.deepEqual(big.columns.get('grade').map(q => q.value), [5, 8]);
  assert.deepEqual(big.columns.get('tonnage').map(q => q.value), [40, 25]);
});

test('where: predicate can reference outer-scope bindings', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(withRows(`
    let cutoff = 4
    let d = dataset(rows)
    let big = d where grade > cutoff
  `));
  assert.equal(n.values.get('big').length, 2);
});

test('where: project a column after filtering', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(withRows(`
    let d = dataset(rows)
    let tons = (d where grade > 4).tonnage
  `));
  assert.deepEqual(n.values.get('tons').map(q => q.value), [40, 25]);
});

test('where: combined predicate with &&', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(withRows(`
    let d = dataset(rows)
    let mid = d where (grade > 3) && (tonnage > 30)
  `));
  // grade>3: rows 5/40 and 8/25. tonnage>30: only 5/40.
  assert.equal(n.values.get('mid').length, 1);
  assert.equal(n.values.get('mid').columns.get('grade')[0].value, 5);
});

test('where: on a plain list, the predicate is the mask', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let xs = [1, 5, 10, 15]');
  n.loadSource('let big = xs where xs > 5');
  assert.deepEqual(n.values.get('big').map(q => q.value), [10, 15]);
});

test('where: an unknown column in the predicate errors', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(withRows('let d = dataset(rows)'));
  assert.throws(() => n.loadSource('let bad = d where depth > 1'),
    /unknown identifier: depth/);
});

test('where: on a non-collection errors', () => {
  const n = new Numbat({ prelude: 'none' });
  assert.throws(() => n.loadSource('let bad = 5 where true'),
    /left side must be a dataset or a list/);
});

test('where: fn-body where-clauses still parse (not consumed as filter)', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn poly(x: Scalar) -> Scalar = a * x + b where a = 2 and b = 1');
  n.loadSource('let r = poly(10)');
  assert.equal(n.values.get('r').value, 21);
});

// ── comparison poison: unit-tagged value vs bare number ──────────
// A value that carries a display unit (a CSV column loaded with a
// `(unit)` header, or a `->` conversion result) must not be compared
// against a bare number — the bare number isn't in the value's unit.
// `->` is the easiest way to get a disp-tagged value in a test.

test('poison: a disp-tagged value compared to a bare number errors', () => {
  const n = new Numbat();
  n.loadSource('let x = 5 cm -> mm');           // x: 50, disp 'mm'
  assert.throws(() => n.loadSource('let bad = x > 3'), /in 'mm'/);
});

test('poison: comparing against a value WITH a unit is fine', () => {
  const n = new Numbat();
  n.loadSource('let x = 5 cm -> mm');
  n.loadSource('let ok = x > 3 mm');            // 50 mm > 3 mm
  assert.equal(n.values.get('ok'), true);
});

test('poison: a plain value compared to a bare number is unaffected', () => {
  const n = new Numbat();
  n.loadSource('let ok = (2 + 3) > 4');         // no disp tag anywhere
  assert.equal(n.values.get('ok'), true);
});
