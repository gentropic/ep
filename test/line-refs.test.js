// Line references — `_N` (result of line N) and `above` (the running
// group of numeric results since the last blank line).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/js/evaluator.js';

const bodyOf = (lines) => lines.map(src => ({src}));
const val = (r, i) => r.rows[i].result && r.rows[i].result.value;

// ── above ─────────────────────────────────────────────────────────

test('above: sums the numeric lines above', () => {
  const r = evaluate(bodyOf(['10', '20', '5', 'sum(above)']));
  assert.equal(val(r, 3), 35);
});

test('above: a blank line resets the group — no double-count', () => {
  const r = evaluate(bodyOf([
    '10', '20', 't1 = sum(above)',
    '',
    '5', '7', 't2 = sum(above)',
  ]));
  assert.equal(val(r, 2), 30);   // 10 + 20
  assert.equal(val(r, 6), 12);   // 5 + 7 — NOT 5 + 7 + t1
});

test('above: empty group sums to 0', () => {
  const r = evaluate(bodyOf(['sum(above)']));
  assert.equal(val(r, 0), 0);
});

test('above: skips non-numeric lines', () => {
  const r = evaluate(bodyOf(['10', 'label = "site"', '20', 'sum(above)']));
  assert.equal(val(r, 3), 30);   // the string line contributes nothing
});

test('above: composes with mean', () => {
  const r = evaluate(bodyOf(['10', '20', '30', 'mean(above)']));
  assert.equal(val(r, 3), 20);
});

// ── _N ────────────────────────────────────────────────────────────

test('_N: references a line by its (1-indexed) number', () => {
  const r = evaluate(bodyOf(['100', '200', '_1 + _2']));
  assert.equal(val(r, 2), 300);
});

test('_N: a forward reference is an unknown identifier', () => {
  const r = evaluate(bodyOf(['_2', '5']));
  assert.match(r.rows[0].error, /unknown identifier/);
});

test('_N: comment / blank lines consume a number but bind nothing', () => {
  // body lines: 1=10, 2=comment, 3=20, 4=_1+_3
  const r = evaluate(bodyOf(['10', '# a note', '20', '_1 + _3']));
  assert.equal(val(r, 3), 30);
});

test('_N + above: a subtotal can be referenced later', () => {
  const r = evaluate(bodyOf([
    '10', '20', 't1 = sum(above)',
    '',
    '5', '7', 't2 = sum(above)',
    'grand = _3 + _7',
  ]));
  assert.equal(val(r, 7), 42);   // t1 (30) + t2 (12)
});
