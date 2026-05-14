import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parseExpr, applyFn } from '../src/js/parser.js';
import { Q, lit } from '../src/js/units.js';

const tokTypes = toks => toks.map(t => t.type);

// ── tokenizer ─────────────────────────────────────────────────────

test('tokenize: integers, decimals, scientific notation', () => {
  assert.deepEqual(tokenize('42'),    [{type: 'num', v: 42}]);
  assert.deepEqual(tokenize('3.14'),  [{type: 'num', v: 3.14}]);
  assert.deepEqual(tokenize('1.5e-3'),[{type: 'num', v: 1.5e-3}]);
  assert.deepEqual(tokenize('2E10'),  [{type: 'num', v: 2e10}]);
});

test('tokenize: digit separators stripped', () => {
  assert.deepEqual(tokenize('1_800'),  [{type: 'num', v: 1800}]);
  assert.deepEqual(tokenize('12_345'), [{type: 'num', v: 12345}]);
});

test('tokenize: # and -- comments cut to end of line', () => {
  assert.deepEqual(tokenize('5 # depth'),  [{type: 'num', v: 5}]);
  assert.deepEqual(tokenize('5 -- depth'), [{type: 'num', v: 5}]);
});

test('tokenize: unicode operator aliases', () => {
  assert.deepEqual(tokTypes(tokenize('2 × 3')), ['num', 'op', 'num']);
  assert.equal(tokenize('2 × 3')[1].v, '*');
  assert.equal(tokenize('6 ÷ 2')[1].v, '/');
  assert.deepEqual(tokenize('5²')[1], {type: 'op', v: '^'});
});

test('tokenize: → and to both become the -> operator', () => {
  assert.deepEqual(tokenize('1 km → m')[1], {type: 'op', v: '->'});
  assert.deepEqual(tokenize('1 km to m')[1], {type: 'op', v: '->'});
});

test('tokenize: number + unit collapses to qnum', () => {
  assert.deepEqual(tokenize('200 m'), [{type: 'qnum', v: 200, u: 'm'}]);
  assert.deepEqual(tokenize('2.7 g/cm3'), [{type: 'qnum', v: 2.7, u: 'g/cm3'}]);
});

test('tokenize: bare unit becomes qnum with v=1', () => {
  // `1 km to m` — the `m` at the end is a bare unit reference, turned into {qnum, v:1, u:'m'}
  const toks = tokenize('1 km -> m');
  assert.deepEqual(toks[2], {type: 'qnum', v: 1, u: 'm'});
});

test('tokenize: compound unit g/t recognized', () => {
  const toks = tokenize('1_800 g/t');
  assert.equal(toks.length, 1);
  assert.equal(toks[0].u, 'g/t');
});

test('tokenize: π expands to pi identifier', () => {
  assert.deepEqual(tokenize('π'), [{type: 'id', name: 'pi'}]);
});

// ── parser ────────────────────────────────────────────────────────

const evalSrc = (s, scope = {}) => parseExpr(tokenize(s), scope);

test('parseExpr: precedence — multiplication before addition', () => {
  const r = evalSrc('1 + 2 * 3');
  assert.equal(r.v, 7);
});

test('parseExpr: parens override precedence', () => {
  const r = evalSrc('(1 + 2) * 3');
  assert.equal(r.v, 9);
});

test('parseExpr: unary minus', () => {
  const r = evalSrc('-5 + 3');
  assert.equal(r.v, -2);
});

test('parseExpr: power is right-associative', () => {
  // 2^3^2 = 2^(3^2) = 2^9 = 512, not (2^3)^2 = 64
  const r = evalSrc('2^3^2');
  assert.equal(r.v, 512);
});

test('parseExpr: unit conversion sets disp tag', () => {
  const r = evalSrc('3 km -> m');
  assert.equal(r.v, 3000);       // canonical value preserved
  assert.equal(r.disp, 'm');
});

test('parseExpr: identifier resolves from scope', () => {
  const r = evalSrc('length * 2', {length: lit(5, 'm')});
  assert.equal(r.v, 10);
  assert.deepEqual(r.d, {length: 1});
});

test('parseExpr: undefined identifier throws', () => {
  assert.throws(() => evalSrc('foo + 1'), /undefined: foo/);
});

test('parseExpr: trailing input throws', () => {
  assert.throws(() => evalSrc('1 + 2 3'), /trailing input/);
});

test('parseExpr: pi and e are built-in constants', () => {
  assert.equal(evalSrc('pi').v, Math.PI);
  assert.equal(evalSrc('e').v, Math.E);
});

test('parseExpr: function call', () => {
  const r = evalSrc('sqrt(9)');
  assert.equal(r.v, 3);
});

// ── applyFn ───────────────────────────────────────────────────────

test('applyFn: sqrt halves dimension exponents on even powers', () => {
  const area = new Q(9, {length: 2});
  const side = applyFn('sqrt', area);
  assert.equal(side.v, 3);
  assert.deepEqual(side.d, {length: 1});
});

test('applyFn: sqrt on odd-dim exponent throws', () => {
  const odd = new Q(1, {length: 1});
  assert.throws(() => applyFn('sqrt', odd), /odd dim exponent/);
});

test('applyFn: log/ln/exp require dimensionless argument', () => {
  const meters = new Q(10, {length: 1});
  assert.throws(() => applyFn('log', meters), /dimensionless/);
  assert.throws(() => applyFn('ln',  meters), /dimensionless/);
  assert.throws(() => applyFn('exp', meters), /dimensionless/);
});

test('applyFn: unknown function throws', () => {
  assert.throws(() => applyFn('mystery', new Q(1, {})), /unknown fn/);
});
