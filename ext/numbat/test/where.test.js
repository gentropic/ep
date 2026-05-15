// `where` clauses on fn definitions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

test('where: single clause', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn square(x) = y where y = x * x');
  n.loadSource('let r = square(5)');
  assert.equal(n.values.get('r').value, 25);
});

test('where: upstream syntax-doc example (power_4)', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn power_4(x: Scalar) = z where y = x * x and z = y * y');
  n.loadSource('let r = power_4(3)');
  assert.equal(n.values.get('r').value, 81);
});

test('where: clause references earlier clause', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    fn series(x) = c
      where a = x + 1
      and   b = a * 2
      and   c = b - 3
  `);
  n.loadSource('let r = series(5)');
  // a = 6, b = 12, c = 9
  assert.equal(n.values.get('r').value, 9);
});

test('where: clause references param', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    fn rect_area(w, h) = w_h
      where w_h = w * h
  `);
  n.loadSource('let a = rect_area(3, 4)');
  assert.equal(n.values.get('a').value, 12);
});

test('where: clauses with units', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    fn rect_area(w: Length, h: Length) = a
      where a = w * h
  `);
  n.loadSource('let total = rect_area(2 metre, 3 metre)');
  assert.equal(n.values.get('total').value, 6);
  assert.deepEqual(n.values.get('total').dim, { length: 2 });
});

test('where: forward reference (clause uses later clause) throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    fn bad(x) = z
      where z = y * 2
      and   y = x + 1
  `);
  // z references y but y is defined after z; clauses evaluate in order.
  assert.throws(() => n.loadSource('let r = bad(5)'), /unknown identifier: y/);
});
