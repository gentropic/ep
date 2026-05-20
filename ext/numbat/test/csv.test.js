// CSV → Dataset parsing (SPEC-DATASETS Phase 1.3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, detectCsvConfig } from '../src/load.js';
import { Quantity } from '../src/quantity.js';

// Convenience: pull a column's plain values (Quantity → .value).
const col = (ds, name) => ds.columns.get(name);
const nums = (ds, name) => col(ds, name).map(q => q.value);

// ── basic parsing ────────────────────────────────────────────────

test('parseCsv: comma-delimited with header', () => {
  const ds = parseCsv('grade,tonnage\n2,100\n5,40\n8,25');
  assert.equal(ds.__dataset, true);
  assert.equal(ds.length, 3);
  assert.deepEqual([...ds.columns.keys()], ['grade', 'tonnage']);
  assert.deepEqual(nums(ds, 'grade'), [2, 5, 8]);
  assert.deepEqual(nums(ds, 'tonnage'), [100, 40, 25]);
});

test('parseCsv: trailing newline does not add an empty row', () => {
  const ds = parseCsv('x\n1\n2\n');
  assert.equal(ds.length, 2);
});

test('parseCsv: CRLF line endings', () => {
  const ds = parseCsv('x,y\r\n1,2\r\n3,4');
  assert.equal(ds.length, 2);
  assert.deepEqual(nums(ds, 'y'), [2, 4]);
});

// ── delimiter detection ──────────────────────────────────────────

test('detectCsvConfig: sniffs a semicolon delimiter + pairs comma decimal', () => {
  const cfg = detectCsvConfig('a;b;c\n1;2;3\n4;5;6');
  assert.equal(cfg.delimiter, ';');
  assert.equal(cfg.decimal, ',');
});

test('parseCsv: auto-detects a tab delimiter', () => {
  const ds = parseCsv('x\ty\n1\t2\n3\t4');
  assert.deepEqual([...ds.columns.keys()], ['x', 'y']);
  assert.deepEqual(nums(ds, 'y'), [2, 4]);
});

test('parseCsv: semicolon delimiter with comma decimals', () => {
  const ds = parseCsv('grade;depth\n2,5;100\n1,75;200');
  assert.deepEqual(nums(ds, 'grade'), [2.5, 1.75]);
  assert.deepEqual(nums(ds, 'depth'), [100, 200]);
});

// ── quoting ──────────────────────────────────────────────────────

test('parseCsv: quoted field containing the delimiter', () => {
  const ds = parseCsv('name,note\n"Smith, J.",ok\n"Doe, A.",fine');
  assert.deepEqual(col(ds, 'name'), ['Smith, J.', 'Doe, A.']);
});

test('parseCsv: quoted field containing a newline', () => {
  const ds = parseCsv('id,desc\n1,"line one\nline two"\n2,plain');
  assert.equal(ds.length, 2);
  assert.equal(col(ds, 'desc')[0], 'line one\nline two');
});

test('parseCsv: escaped quote ("") inside a quoted field', () => {
  const ds = parseCsv('q\n"she said ""hi"""');
  assert.equal(col(ds, 'q')[0], 'she said "hi"');
});

// ── comments + skiprows ──────────────────────────────────────────

test('parseCsv: comment lines are dropped', () => {
  const ds = parseCsv('# generated 2026\nx,y\n# a note\n1,2\n3,4');
  assert.equal(ds.length, 2);
  assert.deepEqual(nums(ds, 'x'), [1, 3]);
});

test('parseCsv: skipRows drops leading preamble lines', () => {
  const ds = parseCsv('REPORT v3\nsite: Pirita\nx,y\n1,2\n3,4', { skipRows: 2 });
  assert.deepEqual([...ds.columns.keys()], ['x', 'y']);
  assert.equal(ds.length, 2);
});

// ── header handling ──────────────────────────────────────────────

test('parseCsv: hasHeader false synthesizes col1..colN', () => {
  const ds = parseCsv('1,2,3\n4,5,6', { hasHeader: false });
  assert.deepEqual([...ds.columns.keys()], ['col1', 'col2', 'col3']);
  assert.equal(ds.length, 2);
});

test('parseCsv: duplicate header names are de-duped', () => {
  const ds = parseCsv('x,x,x\n1,2,3');
  assert.deepEqual([...ds.columns.keys()], ['x', 'x_2', 'x_3']);
});

test('parseCsv: header unit suffix is split off the column name', () => {
  // No resolver passed — the suffix is stripped, column stays Scalar.
  const ds = parseCsv('grade (g/t),depth (m)\n2,100');
  assert.deepEqual([...ds.columns.keys()], ['grade', 'depth']);
});

test('parseCsv: header unit applied when a resolver is supplied', () => {
  // Stub resolver: g/t → 1e-6 dimensionless, m → 1 with a length dim.
  const resolveUnit = (u) =>
    u === 'g/t' ? new Quantity(1e-6, {}) : new Quantity(1, { length: 1 });
  const ds = parseCsv('grade (g/t),depth (m)\n2.5,100', {}, { resolveUnit });
  // 2.5 * 1e-6 — compare with tolerance (float multiply isn't exact).
  assert.ok(Math.abs(col(ds, 'grade')[0].value - 2.5e-6) < 1e-15);
  assert.deepEqual(col(ds, 'depth')[0].dim, { length: 1 });
  assert.equal(col(ds, 'depth')[0].value, 100);
});

// ── type inference ───────────────────────────────────────────────

test('parseCsv: bool column inference', () => {
  const ds = parseCsv('ok\ntrue\nfalse\nTRUE');
  assert.deepEqual(col(ds, 'ok'), [true, false, true]);
});

test('parseCsv: string column inference', () => {
  const ds = parseCsv('hole\nDH-001\nDH-002');
  assert.deepEqual(col(ds, 'hole'), ['DH-001', 'DH-002']);
});

test('parseCsv: a column mixing numbers and words is a string column', () => {
  const ds = parseCsv('v\n1\ntwo\n3');
  assert.deepEqual(col(ds, 'v'), ['1', 'two', '3']);
});

// ── empty cells ──────────────────────────────────────────────────

test('parseCsv: empty numeric cell becomes NaN', () => {
  const ds = parseCsv('x\n1\n\n3');
  const xs = col(ds, 'x');
  assert.equal(xs[0].value, 1);
  assert.ok(Number.isNaN(xs[1].value));
  assert.equal(xs[2].value, 3);
});

test('parseCsv: empty string / bool cells', () => {
  const sds = parseCsv('s\na\n\nc');
  assert.deepEqual(col(sds, 's'), ['a', '', 'c']);
  const bds = parseCsv('b\ntrue\n\nfalse');
  assert.deepEqual(col(bds, 'b'), [true, false, false]);
});

// ── ragged rows ──────────────────────────────────────────────────

test('parseCsv: a short row is padded, extra cells are ignored', () => {
  const ds = parseCsv('x,y,z\n1,2\n4,5,6,7');
  assert.deepEqual(nums(ds, 'x'), [1, 4]);
  assert.deepEqual(nums(ds, 'y'), [2, 5]);
  // z: row 0 had no z cell → NaN; row 1's extra 4th cell ignored.
  const zs = col(ds, 'z');
  assert.ok(Number.isNaN(zs[0].value));
  assert.equal(zs[1].value, 6);
});

// ── empty input ──────────────────────────────────────────────────

test('parseCsv: empty text yields an empty dataset', () => {
  const ds = parseCsv('');
  assert.equal(ds.__dataset, true);
  assert.equal(ds.length, 0);
  assert.equal(ds.columns.size, 0);
});
