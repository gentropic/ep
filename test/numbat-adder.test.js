// @gcu/numbat adder bridge — exercises the Python-shape adapter against the
// real engine namespace (the same dist the .gcupkg ships as index.js). The
// adapter's window-bridge block is skipped under node (no `window`), so we
// import the `makeNumbat` factory and drive it directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../ext/numbat/dist/numbat.js';
import { makeNumbat } from '../ext/numbat/pkg/adder.js';

const N = makeNumbat(engine);
const { Q, u, normal, sweep, mean, stdev, percentile, solve_for, maximize, diff, cumsum } = N;
const show = (q) => q.__repr__();

test('units: builders pin the requested display unit', () => {
  assert.equal(show(Q(10, 'm')), '10 m');        // a bare literal would auto-scale to "1 dam"
  assert.equal(show(Q(5, 'm')), '5 m');
  assert.equal(show(Q(60, 'km/h')), '60 km/h');  // compound disp resolves
  assert.equal(show(u.newton), '1 N');
});

test('arithmetic: dimensional algebra + sensible units', () => {
  assert.equal(show(Q(5, 'm').__mul__(Q(3, 'm'))), '15 m²');
  assert.equal(show(Q(2, 'kg').__mul__(Q(3, 'm/s^2'))), '6 N');
  assert.equal(show(Q(10, 'm').__truediv__(Q(2, 's'))), '5 m/s');
});

test('arithmetic: scaling by a pure number preserves the unit', () => {
  assert.equal(show(Q(5, 'm').__mul__(2)), '10 m');   // not "1 dam"
  assert.equal(show(Q(5, 'm').__rmul__(2)), '10 m');  // reflected: 2 * len
  assert.equal(show(Q(10, 'm').__truediv__(2)), '5 m');
  assert.equal(show(Q(5, 'm').__radd__(Q(2, 'm'))), '7 m');
});

test('conversion: .to(unit)', () => {
  assert.equal(show(Q(60, 'km/h').to('m/s')), '16.667 m/s');
  assert.equal(show(Q(6, 'ft').to('m')), '1.8288 m');  // imperial input still resolves
});

test('dimension mismatch throws', () => {
  assert.throws(() => Q(5, 'm').__add__(Q(60, 'km/h')), /can't add/);
});

test('uncertainty: dimensioned Monte-Carlo + mean ± stdev display', () => {
  const rho = normal(Q(2.7, 'g/cm^3'), Q(0.1, 'g/cm^3'));
  const r = show(rho);
  assert.match(r, /^2\.70\d* ± 0\.\d+ g\/cm³$/, `got: ${r}`);
  assert.match(show(mean(rho)), /g\/cm³$/);
  assert.match(show(stdev(rho)), /g\/cm³$/);
  assert.match(show(percentile(rho, 95)), /g\/cm³$/);
});

test('sweep renders as a min … max range', () => {
  assert.equal(show(sweep(Q(1, 'm'), Q(10, 'm'), 5)), '1 … 10 m');
});

test('solvers: the callback sees + returns adapter Quantities', () => {
  // x where x² = 16 m²  → 4 m
  const root = solve_for((x) => x.__mul__(x), Q(16, 'm^2'), Q(0, 'm'), Q(10, 'm'));
  assert.equal(show(root), '4 m');
  // argmax of 5 - (x-3)²  → 3
  const top = maximize((x) => Q(5, '').__sub__(x.__sub__(Q(3, '')).__pow__(2)), Q(0, ''), Q(6, ''));
  assert.equal(show(top), '3');
});

test('time-series over lists of quantities', () => {
  assert.deepEqual(diff([Q(1, 'm'), Q(3, 'm'), Q(6, 'm')]).map(show), ['2 m', '3 m']);
  assert.deepEqual(cumsum([Q(1, 'm'), Q(2, 'm'), Q(3, 'm')]).map(show), ['1 m', '3 m', '6 m']);
});

test('_repr_html_ wraps the text form', () => {
  const html = Q(5, 'm').__mul__(Q(3, 'm'))._repr_html_();
  assert.match(html, /15 m²/);
  assert.match(html, /^<span/);
});
