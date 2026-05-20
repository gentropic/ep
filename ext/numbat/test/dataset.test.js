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
