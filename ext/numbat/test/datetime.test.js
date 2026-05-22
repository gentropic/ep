// DateTime value type — the affine-time-space algebra, FFI return types,
// date-shaped formatting, and the TDateTime typechecker type.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Match the runtime ep ships: a Temporal polyfill is bundled, so the
// strftime helper takes the TZ-aware path. Node doesn't ship Temporal.
if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../../temporal/temporal-polyfill.min.js');
}

const { Quantity, DateTime } = await import('../src/quantity.js');
const { formatParts } = await import('../src/format.js');
const { tDateTime, tBool, typeEq, formatType } = await import('../src/typecheck/types.js');
const { Numbat } = await import('../src/api.js');

const dur = (secs) => new Quantity(secs, { time: 1 });

// A host with the datetime module loaded (calendar_add, has_unit, etc.).
function mkHost() {
  const n = new Numbat({ prelude: 'v0.1' });
  n.registerAllVendoredModules();
  n.use('core::strings');
  n.use('datetime::functions');
  return n;
}

// ── the DateTime class ────────────────────────────────────────────

test('DateTime: is-a Quantity with the time dimension', () => {
  const dt = new DateTime(1000, 'UTC');
  assert.ok(dt instanceof Quantity);
  assert.ok(dt instanceof DateTime);
  assert.equal(dt.value, 1000);
  assert.deepEqual(dt.dim, { time: 1 });
  assert.equal(dt.tz, 'UTC');
  assert.equal(new DateTime(0).tz, null);
});

test('DateTime + duration → DateTime', () => {
  const r = new DateTime(1000, 'UTC').add(dur(60));
  assert.ok(r instanceof DateTime);
  assert.equal(r.value, 1060);
  assert.equal(r.tz, 'UTC');
});

test('duration + DateTime → DateTime (commuted via Quantity.add guard)', () => {
  const r = dur(60).add(new DateTime(1000, 'UTC'));
  assert.ok(r instanceof DateTime);
  assert.equal(r.value, 1060);
});

test('DateTime − DateTime → duration (a plain Quantity)', () => {
  const r = new DateTime(5000).sub(new DateTime(1000));
  assert.ok(r instanceof Quantity);
  assert.ok(!(r instanceof DateTime));
  assert.equal(r.value, 4000);
  assert.deepEqual(r.dim, { time: 1 });
});

test('DateTime − duration → DateTime', () => {
  const r = new DateTime(5000, 'UTC').sub(dur(1000));
  assert.ok(r instanceof DateTime);
  assert.equal(r.value, 4000);
});

test('DateTime + DateTime → error', () => {
  assert.throws(() => new DateTime(1).add(new DateTime(2)), /two datetimes/);
});

test('DateTime ± non-time quantity → error', () => {
  assert.throws(() => new DateTime(1).add(new Quantity(1, { length: 1 })), /datetime/);
  assert.throws(() => new DateTime(1).sub(new Quantity(1, { length: 1 })), /datetime/);
});

test('duration − DateTime → error (vector minus point)', () => {
  assert.throws(() => dur(10).sub(new DateTime(1)), /subtract a datetime/);
});

test('DateTime mul / div / pow / neg / convertTo → error', () => {
  const dt = new DateTime(1000);
  assert.throws(() => dt.mul(dur(2)), /multiply a datetime/);
  assert.throws(() => dt.div(dur(2)), /divide a datetime/);
  assert.throws(() => dt.pow(2), /datetime/);
  assert.throws(() => dt.neg(), /negate a datetime/);
  assert.throws(() => dt.convertTo('day', null), /datetime/);
});

test('quantity mul / div by a DateTime → error', () => {
  assert.throws(() => dur(2).mul(new DateTime(1)), /multiply by a datetime/);
  assert.throws(() => dur(2).div(new DateTime(1)), /divide by a datetime/);
});

// ── FFI return types ──────────────────────────────────────────────

test('now() and datetime() return DateTime values', () => {
  const n = new Numbat({ prelude: 'v0.1' });
  n.loadSource('let a = now()\nlet b = datetime("2026-05-17T15:30:00Z")', '<t>');
  assert.ok(n.values.get('a') instanceof DateTime);
  assert.ok(n.values.get('b') instanceof DateTime);
  assert.equal(n.values.get('b').value, 1779031800);
});

// ── formatting ────────────────────────────────────────────────────

test('formatParts renders a DateTime as a date string, no unit', () => {
  const p = formatParts(new DateTime(1779031800, 'UTC'), null);
  assert.equal(p.unit, null);
  assert.equal(p.num, '2026-05-17 15:30:00');
});

test('formatParts collapses a midnight DateTime to date-only', () => {
  const p = formatParts(new DateTime(1778976000, 'UTC'), null);
  assert.equal(p.num, '2026-05-17');
});

// ── the TDateTime typechecker type ────────────────────────────────

test('TDateTime: distinct nullary type', () => {
  assert.ok(typeEq(tDateTime(), tDateTime()));
  assert.ok(!typeEq(tDateTime(), tBool()));
  assert.equal(formatType(tDateTime()), 'DateTime');
});

// ── vendored datetime::functions module ───────────────────────────

test('datetime::functions loads; today / weekday / arithmetic evaluate', () => {
  const n = new Numbat({ prelude: 'v0.1' });
  n.registerAllVendoredModules();
  n.use('core::strings');
  n.use('datetime::functions');
  n.loadSource([
    'let t = today()',
    'let w = weekday(datetime("2026-12-25"))',
    'let later = now() + 1 hour',
    'let span = now() - now()',
  ].join('\n'), '<t>');
  assert.ok(n.values.get('t') instanceof DateTime);
  assert.equal(n.values.get('w'), 'Friday');
  assert.ok(n.values.get('later') instanceof DateTime);
  const span = n.values.get('span');
  assert.ok(span instanceof Quantity && !(span instanceof DateTime));
});

// ── calendar-aware arithmetic ─────────────────────────────────────

test('calendar_add: a month lands on the same day-of-month', () => {
  const n = mkHost();
  n.loadSource([
    'let base = datetime("2026-01-15 12:00:00 UTC")',
    'let plus1 = calendar_add(base, 1 month)',
    'let expect = datetime("2026-02-15 12:00:00 UTC")',
  ].join('\n'), '<t>');
  assert.ok(n.values.get('plus1') instanceof DateTime);
  assert.equal(n.values.get('plus1').value, n.values.get('expect').value);
});

test('calendar_add: a span of 0 returns the datetime unchanged', () => {
  const n = mkHost();
  n.loadSource('let b = datetime("2026-06-01 00:00:00 UTC")\nlet z = calendar_add(b, 0 seconds)', '<t>');
  assert.equal(n.values.get('z').value, n.values.get('b').value);
});

test('calendar_add: years and days', () => {
  const n = mkHost();
  n.loadSource([
    'let base = datetime("2026-03-10 08:00:00 UTC")',
    'let y = calendar_add(base, 1 year)',
    'let d = calendar_add(base, 10 days)',
    'let ey = datetime("2027-03-10 08:00:00 UTC")',
    'let ed = datetime("2026-03-20 08:00:00 UTC")',
  ].join('\n'), '<t>');
  assert.equal(n.values.get('y').value, n.values.get('ey').value);
  assert.equal(n.values.get('d').value, n.values.get('ed').value);
});

test('calendar_add: Jan 31 + 1 month constrains to Feb 29 in a leap year', () => {
  const n = mkHost();
  n.loadSource([
    'let base = datetime("2024-01-31 12:00:00 UTC")',
    'let feb = calendar_add(base, 1 month)',
    'let expect = datetime("2024-02-29 12:00:00 UTC")',
  ].join('\n'), '<t>');
  assert.equal(n.values.get('feb').value, n.values.get('expect').value);
});

test('has_unit: whole-unit approximation', () => {
  const n = mkHost();
  n.loadSource([
    'let a = has_unit(2 months, months)',
    'let b = has_unit(1 month, days)',
    'let c = has_unit(0 seconds, days)',
  ].join('\n'), '<t>');
  assert.equal(n.values.get('a'), true);
  assert.equal(n.values.get('b'), false);
  assert.equal(n.values.get('c'), true);
});

test('comparison: polymorphic zero compares across dimensions', () => {
  const n = mkHost();
  n.loadSource([
    'let a = (5 seconds) == 0',
    'let b = (0 seconds) == 0',
    'let c = (5 seconds) != 0',
    'let d = (5 seconds) > 0',
  ].join('\n'), '<t>');
  assert.equal(n.values.get('a'), false);
  assert.equal(n.values.get('b'), true);
  assert.equal(n.values.get('c'), true);
  assert.equal(n.values.get('d'), true);
});

// ── timezone conversion via `->` ──────────────────────────────────

test('-> tz("…") keeps the instant, swaps the display zone', () => {
  const n = mkHost();
  n.loadSource([
    'let base = datetime("2026-05-17 12:00:00 UTC")',
    'let tokyo = base -> tz("Asia/Tokyo")',
  ].join('\n'), '<t>');
  const base = n.values.get('base'), tokyo = n.values.get('tokyo');
  assert.ok(tokyo instanceof DateTime);
  assert.equal(tokyo.value, base.value);   // same point in time
  assert.equal(tokyo.tz, 'Asia/Tokyo');    // new display zone
});

test('-> UTC and -> local resolve the let-bound converters', () => {
  const n = mkHost();
  n.loadSource([
    'let base = datetime("2026-05-17 12:00:00 +0200")',
    'let u = base -> UTC',
    'let l = base -> local',
    'let lz = get_local_timezone()',
  ].join('\n'), '<t>');
  assert.equal(n.values.get('u').tz, 'UTC');
  assert.equal(n.values.get('u').value, n.values.get('base').value);
  assert.equal(n.values.get('l').tz, n.values.get('lz'));
});

test('-> tz conversions chain left to right', () => {
  const n = mkHost();
  n.loadSource([
    'let base = datetime("2026-05-17 12:00:00 UTC")',
    'let r = base -> tz("Asia/Tokyo") -> UTC',
  ].join('\n'), '<t>');
  assert.equal(n.values.get('r').tz, 'UTC');
  assert.equal(n.values.get('r').value, n.values.get('base').value);
});

test('format_datetime renders the converted zone', () => {
  const n = mkHost();
  n.loadSource(
    'let s = format_datetime("%H:%M", datetime("2026-05-17 12:00:00 UTC") -> tz("Asia/Tokyo"))',
    '<t>');
  assert.equal(n.values.get('s'), '21:00');   // UTC+9, no DST
});

test('-> tz on a non-datetime is rejected', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let bad = (5 meter) -> tz("Asia/Tokyo")', '<t>'),
    /datetime/i);
});
