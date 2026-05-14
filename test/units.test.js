import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Q, UNITS, lit, qAdd, qSub, qMul, qDiv, qPow, qConvert,
  dEq, dMul, dDiv, dEmpty, fmtDim, fmt, fmtNum,
} from '../src/js/units.js';

const approx = (a, b, eps = 1e-9) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// ── dimension primitives ──────────────────────────────────────────

test('dEq: equal sparse maps', () => {
  assert.equal(dEq({mass: 1}, {mass: 1}), true);
  assert.equal(dEq({}, {}), true);
  assert.equal(dEq({mass: 1, length: -3}, {length: -3, mass: 1}), true);
});

test('dEq: different exponents', () => {
  assert.equal(dEq({mass: 1}, {mass: 2}), false);
  assert.equal(dEq({mass: 1}, {length: 1}), false);
});

test('dMul / dDiv add and subtract exponents', () => {
  assert.deepEqual(dMul({mass: 1}, {length: -3}), {mass: 1, length: -3});
  assert.deepEqual(dMul({length: 1}, {length: 2}), {length: 3});
  assert.deepEqual(dDiv({mass: 1, length: 1}, {length: 1}), {mass: 1});
  assert.deepEqual(dMul({mass: 1}, {mass: -1}), {});  // zero exponents dropped
});

test('dEmpty', () => {
  assert.equal(dEmpty({}), true);
  assert.equal(dEmpty({mass: 1}), false);
});

test('fmtDim renders human-readable signatures', () => {
  assert.equal(fmtDim({}), '-');
  assert.equal(fmtDim({mass: 1}), 'mass');
  assert.equal(fmtDim({mass: 1, length: -3}), 'mass·length^-3');
});

// ── Q construction ────────────────────────────────────────────────

test('lit: dimensionless', () => {
  const q = lit(42);
  assert.equal(q.v, 42);
  assert.deepEqual(q.d, {});
  assert.equal(q.disp, null);
});

test('lit: known unit converts to canonical value', () => {
  const m = lit(3, 'km');
  assert.equal(m.v, 3000);
  assert.deepEqual(m.d, {length: 1});

  const d = lit(2.7, 'g/cm3');
  assert.equal(d.v, 2.7e6);  // canonical: g·m^-3 → 2.7 * 1e6
  assert.deepEqual(d.d, {mass: 1, length: -3});
});

test('lit: unknown unit throws', () => {
  assert.throws(() => lit(1, 'furlongs'), /unknown unit/);
});

// ── arithmetic ────────────────────────────────────────────────────

test('qAdd: same dim adds canonical values', () => {
  const r = qAdd(lit(1, 'km'), lit(500, 'm'));
  assert.equal(r.v, 1500);
  assert.deepEqual(r.d, {length: 1});
});

test('qAdd: dim mismatch throws with helpful message', () => {
  assert.throws(() => qAdd(lit(1, 'km'), lit(1, 'kg')), /can't add/);
});

test('qSub: same dim subtracts', () => {
  const r = qSub(lit(2, 'kg'), lit(500, 'g'));
  assert.equal(r.v, 1500);
});

test('qMul: composes dimensions', () => {
  const area = qMul(lit(3, 'm'), lit(4, 'm'));
  assert.equal(area.v, 12);
  assert.deepEqual(area.d, {length: 2});

  const force = qMul(lit(2, 'kg'), qDiv(lit(1, 'm'), qMul(lit(1, 's' in UNITS ? 's' : 'rad'), lit(1, 'rad'))));
  // (just exercises chained dim math; canonical 's' isn't in UNITS yet)
  assert.ok(typeof force.v === 'number');
});

test('qDiv: subtracts dimensions', () => {
  const grade = qDiv(lit(1, 'g'), lit(1, 't'));
  assert.equal(grade.v, 1 / 1e6);
  assert.deepEqual(grade.d, {});  // grade is dimensionless
});

test('qPow: integer power scales dim exponents', () => {
  const r = qPow(lit(3, 'm'), lit(2));
  assert.equal(r.v, 9);
  assert.deepEqual(r.d, {length: 2});
});

test('qPow: non-dimensionless exponent throws', () => {
  assert.throws(() => qPow(lit(2, 'm'), lit(1, 'kg')), /dimensionless/);
});

// ── conversion ────────────────────────────────────────────────────

test('qConvert: preserves canonical value, tags disp', () => {
  const m = lit(388800, 'g');
  const oz = qConvert(m, 'ozt');
  assert.equal(oz.v, 388800);              // canonical unchanged
  assert.deepEqual(oz.d, {mass: 1});
  assert.equal(oz.disp, 'ozt');            // display tag honored
});

test('qConvert: dim mismatch throws', () => {
  assert.throws(() => qConvert(lit(1, 'kg'), 'm'), /can't convert/);
});

test('qConvert: unknown unit throws', () => {
  assert.throws(() => qConvert(lit(1, 'kg'), 'furlongs'), /unknown unit/);
});

// ── fmt / fmtNum ──────────────────────────────────────────────────

test('fmtNum: small values use plain decimal', () => {
  assert.equal(fmtNum(0), '0');
  assert.equal(fmtNum(42), '42');
  assert.equal(fmtNum(3.14), '3.14');
});

test('fmtNum: large values get thousands separators', () => {
  assert.equal(fmtNum(1234), '1,234');
  assert.equal(fmtNum(80000), '80,000');
});

test('fmtNum: extreme values use scientific notation', () => {
  assert.equal(fmtNum(1e-6), '1.000e-6');
  assert.equal(fmtNum(2.16e11), '2.160e11');
});

test('fmt: dimensionless returns no unit', () => {
  const [n, u] = fmt(lit(0.5));
  assert.equal(n, '0.5');
  assert.equal(u, null);
});

test('fmt: auto-scales to a clean unit', () => {
  const tonnage = lit(2.16e11, 'g');     // 216 kt
  const [n, u] = fmt(tonnage);
  assert.equal(u, 'kt');
  assert.equal(n, '216');
});

test('fmt: large volume picks km³ at 4.4e10 m³', () => {
  const vol = new Q(4.444e10, {length: 3});
  const [n, u] = fmt(vol);
  assert.equal(u, 'km³');
  assert.ok(approx(parseFloat(n.replace(/,/g, '')), 44.44, 0.01));
});

test('fmt: honors qConvert disp tag instead of auto-scaling', () => {
  const oz = qConvert(lit(388800, 'g'), 'ozt');
  const [n, u] = fmt(oz);
  assert.equal(u, 'ozt');
  // 388800 / 31.1035 ≈ 12500.2 → toPrecision(5) → "12500" → "12,500"
  assert.equal(n, '12,500');
});

test('fmt: density displays as g/cm³', () => {
  const d = lit(2.7, 'g/cm3');
  const [n, u] = fmt(d);
  assert.equal(u, 'g/cm³');
  assert.equal(n, '2.7');
});
