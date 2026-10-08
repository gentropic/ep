import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smartInsertion } from '../src/js/insert.js';

const apply = (before, token, kind, after = '') => {
  const { trim, text } = smartInsertion(before, after, token, kind);
  return before.slice(0, before.length - trim) + text + after;
};

test('unit after a number gets one space, never two', () => {
  assert.equal(apply('3', 'km', 'unit'), '3 km');
  assert.equal(apply('3 ', 'km', 'unit'), '3 km');
  assert.equal(apply('3   ', 'km', 'unit'), '3 km');
  assert.equal(apply('x = 2.5', 'kg', 'unit'), 'x = 2.5 kg');
});

test('unit at line start or after an operator gets no space', () => {
  assert.equal(apply('', 'km', 'unit'), 'km');
  assert.equal(apply('3 km / ', 'min', 'unit'), '3 km / min');
  assert.equal(apply('speed -> ', 'km/h', 'unit'), 'speed -> km/h');
});

test('binary operators trim trailing spaces and pad both sides', () => {
  assert.equal(apply('3 km', '/', 'op'), '3 km / ');
  assert.equal(apply('3 km   ', '/', 'op'), '3 km / ');
  assert.equal(apply('a', '+', 'op'), 'a + ');
});

test('unary position: no trailing pad after ( or = or at line start', () => {
  assert.equal(apply('x = ', '-', 'op'), 'x = -');
  assert.equal(apply('x =', '-', 'op'), 'x = -');
  assert.equal(apply('(', '-', 'op'), '(-');
  assert.equal(apply('', '-', 'op'), '-');
});

test('power and close paren are tight; arrow is padded', () => {
  assert.equal(apply('x ', '^', 'pow'), 'x^');
  assert.equal(apply('(3 km ', ')', 'close'), '(3 km)');
  assert.equal(apply('3 km / 4 min', '->', 'arrow'), '3 km / 4 min -> ');
  assert.equal(apply('3 km / 4 min  ', '->', 'arrow'), '3 km / 4 min -> ');
});

test('open paren and functions sit tight only at line start or after a bracket', () => {
  assert.equal(apply('2 *', '(', 'open'), '2 * (');
  assert.equal(apply('2 * ', '(', 'open'), '2 * (');
  assert.equal(apply('x', '(', 'open'), 'x (');
  assert.equal(apply('(', '(', 'open'), '((');
  assert.equal(apply('', 'sqrt(', 'fn'), 'sqrt(');
  assert.equal(apply('y = ', 'sqrt(', 'fn'), 'y = sqrt(');
  assert.equal(apply('2', 'sqrt(', 'fn'), '2 sqrt(');
  assert.equal(apply('sqrt(', 'x', 'name'), 'sqrt(x');
});

test('variable chips follow the unit rule', () => {
  assert.equal(apply('total = walk +', 'ascent', 'name'), 'total = walk + ascent');
  assert.equal(apply('total = walk + ', 'ascent', 'name'), 'total = walk + ascent');
  assert.equal(apply('2', 'distance', 'name'), '2 distance');
});

test('raw inserts verbatim', () => {
  assert.equal(apply('abc  ', 'π', 'raw'), 'abc  π');
});
