// Numbat conformance corpus — ~50 programs with expected outputs
// computed from first principles or by cross-reference to upstream
// numbat. The corpus IS the compatibility surface: anything that
// changes ep's evaluator output for one of these programs needs an
// explicit decision (update the expected, or revert).
//
// Pinned values:
//   - All canonical numbat units (meter for length, gram for mass,
//     second for time, second for time, radian≡{} for angle).
//   - Values comparable via approxEq (relative+absolute tolerance) for
//     transcendentals; exact equality where it should hold.
//
// To extend: add an entry to CORPUS. For ergonomics, every entry has a
// short `name`, a `source` (multi-line OK), and one of:
//   value:  numeric scalar          (asserts dim is {})
//   q:      { value, dim }          (asserts both value and dim)
//   text:   "string"                (asserts last row is a string)
//   error:  /regex/                 (asserts last row errored matching)
// Either `last` (default) or `row: N` picks which row to assert against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Bootstrap: load Temporal polyfill before evaluator imports, so datetime
// stubs see globalThis.Temporal in Node (which doesn't ship it natively
// as of v24). The polyfill is a self-conditional IIFE — runs only when
// Temporal is missing.
if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../ext/temporal/temporal-polyfill.min.js');
}

globalThis.INITIAL_STATE = { name: 'test', body: [], ui: {} };
const { evaluate } = await import('../src/js/evaluator.js');
const { setPrintSink } = await import('../ext/numbat/dist/numbat.js');

const CORPUS = [
  // ─── 1. Numeric literals + basic arithmetic ─────────────────────
  { name: 'lit: integer',                source: '42',                value: 42 },
  { name: 'lit: float',                  source: '3.14',              value: 3.14 },
  { name: 'lit: leading-dot float',      source: '.5',                value: 0.5 },
  { name: 'lit: underscore separator',   source: '1_000_000',         value: 1_000_000 },
  { name: 'lit: scientific positive',    source: '1.5e3',             value: 1500 },
  { name: 'lit: scientific negative',    source: '2.5e-2',            value: 0.025 },
  { name: 'lit: hexadecimal',            source: '0xFF',              value: 255 },
  { name: 'lit: octal',                  source: '0o755',             value: 0o755 },
  { name: 'lit: binary',                 source: '0b1010_1010',       value: 0b10101010 },
  { name: 'arith: add',                  source: '2 + 3',             value: 5 },
  { name: 'arith: sub',                  source: '10 - 7',            value: 3 },
  { name: 'arith: mul',                  source: '6 * 7',             value: 42 },
  { name: 'arith: div',                  source: '100 / 4',           value: 25 },
  { name: 'arith: pow caret',            source: '2^10',              value: 1024 },
  { name: 'arith: pow python',           source: '3**4',              value: 81 },
  { name: 'arith: unicode square',       source: '5²',                value: 25 },
  { name: 'arith: unicode cube',         source: '3³',                value: 27 },
  { name: 'arith: precedence',           source: '2 + 3 * 4',         value: 14 },
  { name: 'arith: parens',               source: '(2 + 3) * 4',       value: 20 },
  { name: 'arith: negative',             source: '-5 + 10',           value: 5 },
  { name: 'arith: divide by float',      source: '1 / 3',             value: 1/3 },
  { name: 'arith: unicode div mul',      source: '12 ÷ 4 × 3',        value: 9 },

  // ─── 2. Units & conversions ─────────────────────────────────────
  { name: 'unit: meter literal',         source: '5 m',               q: { value: 5,     dim: {length: 1} } },
  { name: 'unit: kilometer canonical',   source: '2 km',              q: { value: 2000,  dim: {length: 1} } },
  { name: 'unit: kilogram canonical',    source: '3 kg',              q: { value: 3000,  dim: {mass: 1} } },
  { name: 'unit: foot to meter',         source: '10 ft',             q: { value: 3.048, dim: {length: 1} } },
  { name: 'unit: mile to meter',         source: '1 mile',            q: { value: 1609.344, dim: {length: 1} } },
  { name: 'unit: kg per cubic-m',        source: '1 kg/m^3',          q: { value: 1000, dim: {mass: 1, length: -3} } },
  { name: 'conv: 1 yard to meter',       source: '1 yard -> m',       q: { value: 0.9144, dim: {length: 1} } },
  // Conversion sets the `.disp` tag for output formatting but the
  // canonical .value stays in base units (m/s here).
  { name: 'conv: 60 mph to km/h',        source: '60 mph -> km/h',    q: { value: 26.8224, dim: {length: 1, time: -1} } },
  { name: 'conv: 100 cm to m',           source: '100 cm to m',       q: { value: 1, dim: {length: 1} } },
  { name: 'conv: 1 hour to seconds',     source: '1 hour to seconds', q: { value: 3600, dim: {time: 1} } },
  { name: 'compound: density',           source: '2.7 g/cm3',         q: { value: 2.7e6, dim: {mass: 1, length: -3} } },
  { name: 'compound: 9.81 m/s^2',        source: '9.81 m/s^2',        q: { value: 9.81, dim: {length: 1, time: -2} } },
  { name: 'compound: 1 N = 1 kg m/s^2',  source: '1 N',               q: { value: 1000, dim: {mass: 1, length: 1, time: -2} } },
  { name: 'compound: implicit mul',      source: '2 pi',              value: 2 * Math.PI },
  { name: 'compound: per keyword',       source: '10 meter per second', q: { value: 10, dim: {length: 1, time: -1} } },
  { name: 'compute: volume',             source: '200 m * 50 m * 8 m', q: { value: 80000, dim: {length: 3} } },
  { name: 'compute: F = m·a',            source: '10 kg * 9.81 m/s^2', q: { value: 98100, dim: {mass: 1, length: 1, time: -2} } },

  // ─── 3. Constants + transcendentals ──────────────────────────────
  { name: 'const: pi',                   source: 'pi',                value: Math.PI },
  { name: 'const: tau',                  source: 'tau',               value: 2 * Math.PI },
  { name: 'const: e',                    source: 'e',                 value: Math.E },
  { name: 'const: NaN',                  source: 'NaN',               value: NaN },
  { name: 'const: inf',                  source: 'inf',               value: Infinity },
  { name: 'fn: sin pi/2',                source: 'sin(pi / 2)',       value: 1 },
  { name: 'fn: cos 0',                   source: 'cos(0)',            value: 1 },
  { name: 'fn: sqrt 144',                source: 'sqrt(144)',         value: 12 },
  { name: 'fn: ln(e)',                   source: 'ln(e)',             value: 1 },
  // log10 / max / min live in upstream numbat modules — bring them
  // into scope first. (`use math::transcendental` for log10;
  // `use core::functions` for max/min.)
  { name: 'fn: log10 1000',              source: 'use math::transcendental\nlog10(1000)', value: 3 },
  { name: 'fn: exp(1)',                  source: 'exp(1)',            value: Math.E },
  { name: 'fn: abs negative',            source: 'abs(-7)',           value: 7 },
  { name: 'fn: mod',                     source: 'mod(17, 5)',        value: 2 },
  { name: 'fn: max',                     source: 'use core::functions\nmax(3, 7, 4)', value: 7 },
  { name: 'fn: min',                     source: 'use core::functions\nmin(3, 7, 4)', value: 3 },

  // ─── 4. Bindings + annotations ──────────────────────────────────
  { name: 'let: simple',                 source: 'let x = 5\nx + 3',  value: 8 },
  { name: 'let: with unit',              source: 'let l = 10 m\nl * 2', q: { value: 20, dim: {length: 1} } },
  { name: 'let: type annotation',        source: 'let v: Velocity = 60 km/h\nv', q: { value: 60 / 3.6, dim: {length: 1, time: -1} } },
  { name: 'let: compound anno',          source: 'let a: Length / Time = 5 m/s\na', q: { value: 5, dim: {length: 1, time: -1} } },
  { name: 'binding: chained',            source: 'let a = 2\nlet b = a * 3\nlet c = b + 1\nc', value: 7 },
  { name: 'binding: ans',                source: '3 + 4\nans * 2',    value: 14 },
  { name: 'binding: underscore',         source: '5 m\n_ + 3 m',      q: { value: 8, dim: {length: 1} } },

  // ─── 5. fn / generics / where ───────────────────────────────────
  { name: 'fn: simple',                  source: 'fn double(x) = 2 * x\ndouble(7)',          value: 14 },
  { name: 'fn: typed',                   source: 'fn area(r: Length) = pi * r^2\narea(2 m)', q: { value: 4 * Math.PI, dim: {length: 2} } },
  { name: 'fn: generic sqrt',            source: 'fn rmsqr<T: Dim>(q: T^2) -> T = q^(1/2)\nrmsqr(16 m^2)', q: { value: 4, dim: {length: 1} } },
  { name: 'fn: returning Bool',          source: 'fn pos(x: Scalar) -> Bool = x >= 0\npos(5)\npos(-3)', row: 2, bool: false },
  { name: 'fn: pipe operator',           source: '16 |> sqrt',         value: 4 },
  { name: 'fn: where-and clauses',       source: 'fn p4(x: Scalar) = z\n  where y = x * x\n  and z = y * y\np4(3)', value: 81 },

  // ─── 6. Control flow ────────────────────────────────────────────
  { name: 'if: inline true',             source: 'if 1 == 1 then 42 else 99', value: 42 },
  { name: 'if: inline false',            source: 'if 2 < 1 then 42 else 99', value: 99 },
  { name: 'if: nested in fn (positive)', source: 'fn sign(x: Scalar) = if x > 0 then 1 else if x < 0 then -1 else 0\nsign(7)',  value: 1 },
  { name: 'if: nested in fn (negative)', source: 'fn sign(x: Scalar) = if x > 0 then 1 else if x < 0 then -1 else 0\nsign(-5)', value: -1 },
  { name: 'if: nested in fn (zero)',     source: 'fn sign(x: Scalar) = if x > 0 then 1 else if x < 0 then -1 else 0\nsign(0)',  value: 0 },

  // ─── 7. Declarations ────────────────────────────────────────────
  { name: 'dim: derived',                source: 'dimension Decel = Length / Time^2', skipValue: true },
  { name: 'unit: derived',               source: 'unit quork = 0.35 m\n5 quork', q: { value: 1.75, dim: {length: 1} } },
  { name: 'unit: aliases',               source: '@aliases(quorks)\nunit quork = 0.35 m\n2 quorks', q: { value: 0.7, dim: {length: 1} } },
  { name: 'unit: auto-base dim',         source: 'unit widget\nlet x: Widget = 3 widget\nx', q: { value: 3, dim: {widget: 1} } },
  { name: 'struct: define + use',        source: 'struct V2 { x: Scalar, y: Scalar }\nlet v = V2 { x: 3, y: 4 }\nv.x + v.y', value: 7 },

  // ─── 8. ep-specific (drillcore + sieve) ─────────────────────────
  { name: 'ep: NQ_core diameter',        source: 'NQ_core',           q: { value: 0.0476, dim: {length: 1} } },
  { name: 'ep: HQ_hole diameter',        source: 'HQ_hole',           q: { value: 0.0960, dim: {length: 1} } },
  // Canonical length is meters; mesh200 = 75 µm = 75e-6 m. (The `-> um`
  // unit is `micrometer`; `um` alone is just an alias if available — use
  // the long form to avoid lookup ambiguity.)
  { name: 'ep: mesh200 = 75 microns',    source: 'mesh200 -> micrometer', q: { value: 75e-6, dim: {length: 1} } },
  // Sample mass: pi/4 · (0.0476 m)^2 · 5 m · 2.7e6 g/m³ — canonical grams.
  { name: 'ep: sample_mass',             source: 'sample_mass(NQ_core, 5 m, 2.7 g/cm3)', q: { value: 24023.570526442, dim: {mass: 1} } },

  // ─── 9. Errors ──────────────────────────────────────────────────
  { name: 'err: dim mismatch',           source: '1 m + 1 kg',        error: /can't add/ },
  { name: 'err: anno mismatch',          source: 'let l: Length = 5 kg', error: /annotated/ },
  { name: 'err: unknown id',             source: 'unknown_thing + 1', error: /unknown identifier/ },
  { name: 'err: unknown unit',           source: '5 quux',            error: /unknown identifier|unknown unit/ },

  // ─── 10. type() ─────────────────────────────────────────────────
  { name: 'type: velocity',              source: 'type(2 m/s)',       text: /Length.*Time\^-1/ },
  { name: 'type: mass',                  source: 'type(5 kg)',        text: 'Mass' },
  { name: 'type: scalar',                source: 'type(42)',          text: 'Scalar' },

  // ─── 11. String interpolation ───────────────────────────────────
  { name: 'interp: bare value',          source: 'let x = 42\n"answer is {x}"', text: 'answer is 42' },
  { name: 'interp: arith',               source: '"{2 + 3 * 4}"',     text: '14' },
  { name: 'interp: double-brace literal',source: '"{{not interp}}"',  text: '{not interp}' },
  // 60 mph canonicalizes to ~26.8 m/s; the formatter auto-scales to
  // the SI base when no disp tag is set. Single-unit `-> name` sets disp.
  { name: 'interp: quantity auto-scaled', source: 'let v = 60 mph\n"v = {v}"',         text: /v = .*m\/s/ },
  { name: 'interp: inline conversion',    source: 'let h = 500 m\n"h = {h -> ft}"',    text: /h = .* ft/ },
  { name: 'interp: format .3',           source: '"pi = {pi:.3}"',    text: 'pi = 3.14' },
  { name: 'interp: format n2',           source: '"x = {1/3:n2}"',    text: 'x = 0.33' },
  { name: 'interp: str_append uses interp', source: 'use core::strings\nstr_append("foo", "bar")', text: 'foobar' },

  // ─── 12. String functions (core::strings) ───────────────────────
  { name: 'str: length',                 source: 'use core::strings\nstr_length("hello")', value: 5 },
  { name: 'str: slice',                  source: 'use core::strings\nstr_slice(0, 3, "hello")', text: 'hel' },
  { name: 'str: uppercase',              source: 'use core::strings\nuppercase("foo")', text: 'FOO' },
  { name: 'str: chr 65',                 source: 'use core::strings\nchr(65)', text: 'A' },
  { name: 'str: ord A',                  source: 'use core::strings\nord("A")', value: 65 },
  { name: 'str: eq same',                source: 'use core::strings\nstr_eq("a","a")', bool: true },
  { name: 'str: eq diff',                source: 'use core::strings\nstr_eq("a","b")', bool: false },

  // ─── 13. Datetime (Temporal-backed) ─────────────────────────────
  { name: 'dt: ISO parse',               source: 'datetime("2026-05-17T15:30:00Z")', q: { value: 1779031800, dim: {time: 1} } },
  { name: 'dt: plus one hour',           source: 'datetime("2026-05-17T00:00:00Z") + 1 hour', q: { value: 1778976000 + 3600, dim: {time: 1} } },
  { name: 'dt: format ISO date',         source: 'format_datetime("%Y-%m-%d", datetime("2026-05-17T12:00:00Z"), tz("UTC"))', text: '2026-05-17' },
  { name: 'dt: format month name',       source: 'format_datetime("%B %d, %Y", datetime("2026-05-17T12:00:00Z"), tz("UTC"))', text: 'May 17, 2026' },
  { name: 'dt: format tz-aware',         source: 'format_datetime("%H:%M %Z", datetime("2026-05-17T12:00:00Z"), tz("America/New_York"))', text: /08:00 America\/New_York/ },
  { name: 'dt: days between',            source: '(datetime("2027-01-01T00:00:00Z") - datetime("2026-05-17T00:00:00Z")) -> day', q: { value: 19785600, dim: {time: 1} } },
];

// ── helpers ────────────────────────────────────────────────────────

function approxEq(a, b, eps = 1e-9) {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= scale * eps + 1e-12;
}

function dimEqual(a, b) {
  a = a || {}; b = b || {};
  const ak = Object.keys(a).filter(k => a[k] !== 0);
  const bk = Object.keys(b).filter(k => b[k] !== 0);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

// ── run ────────────────────────────────────────────────────────────

// print sink — tests can swap in a buffer to capture print output. ep's
// production code leaves the sink unset (print is a silent no-op until
// a UI panel is wired).
test('print: settable sink captures output (not wired in ep yet)', () => {
  const out = [];
  setPrintSink(text => out.push(text));
  try {
    const r = evaluate([{src: 'print("hello world")'}, {src: 'print("foo", " ", "bar")'}]);
    for (const row of r.rows) assert.equal(row.error, null);
    assert.deepEqual(out, ['hello world', 'foo   bar']);
  } finally {
    setPrintSink(null);   // restore — don't leak into other tests
  }
});

test('print: with interpolation', () => {
  const out = [];
  setPrintSink(text => out.push(text));
  try {
    const r = evaluate([
      {src: 'let n = 42'},
      {src: 'print("answer: {n}")'},
    ]);
    for (const row of r.rows) assert.equal(row.error, null);
    assert.deepEqual(out, ['answer: 42']);
  } finally {
    setPrintSink(null);
  }
});

for (const c of CORPUS) {
  test('conformance: ' + c.name, () => {
    const body = c.source.split('\n').map(s => ({ src: s }));
    const r = evaluate(body);
    const idx = c.row !== undefined ? c.row : r.rows.length - 1;
    const row = r.rows[idx];
    assert.ok(row, `no row at index ${idx} for ${c.name}`);

    if (c.error !== undefined) {
      const anyErr = r.rows.find(rr => rr.error);
      assert.ok(anyErr, `${c.name}: expected error, got none`);
      assert.match(anyErr.error, c.error);
      return;
    }

    // No expected error — but the evaluator shouldn't have produced one either.
    const unexpected = r.rows.find(rr => rr.error);
    if (unexpected) {
      throw new Error(`${c.name}: unexpected evaluator error: ${unexpected.error}`);
    }

    if (c.skipValue) return;

    if (c.text !== undefined) {
      const v = row.result;
      assert.ok(v != null, `${c.name}: expected text result, got null`);
      if (c.text instanceof RegExp) assert.match(v, c.text);
      else                          assert.equal(v, c.text);
      return;
    }

    if (c.bool !== undefined) {
      assert.equal(row.result, c.bool,
        `${c.name}: expected bool ${c.bool}, got ${row.result}`);
      return;
    }

    const q = row.result;
    assert.ok(q != null && typeof q.value === 'number',
      `${c.name}: expected Quantity result, got ${JSON.stringify(q)}`);

    if (c.value !== undefined) {
      assert.ok(approxEq(q.value, c.value),
        `${c.name}: expected ${c.value}, got ${q.value}`);
      assert.ok(dimEqual(q.dim, {}),
        `${c.name}: expected dimensionless, got ${JSON.stringify(q.dim)}`);
    } else if (c.q !== undefined) {
      assert.ok(approxEq(q.value, c.q.value),
        `${c.name}: expected value ${c.q.value}, got ${q.value}`);
      assert.ok(dimEqual(q.dim, c.q.dim),
        `${c.name}: expected dim ${JSON.stringify(c.q.dim)}, got ${JSON.stringify(q.dim)}`);
    } else {
      throw new Error(`${c.name}: missing expected value/q/text/error`);
    }
  });
}
