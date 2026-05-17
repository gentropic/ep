// Phase 6 of the typechecker: integration with the runtime env.
//
// Verifies typecheckModule(ast, runtimeEnv) works against an env shaped
// the way load.js / ep's evaluator constructs them. Then runs a probe
// over a slice of the conformance corpus to surface real gaps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../ext/temporal/temporal-polyfill.min.js');
}

// Pull in ep's evaluator side-effect, which sets up the singleton host
// with the v0.1 prelude + ep-specific dim names + vendored .nbt modules.
globalThis.INITIAL_STATE = { name: 'test', body: [], ui: {} };
const { evaluate, DIMENSION_OF } = await import('../src/js/evaluator.js');
// Trigger host construction (lazy in evaluator.js).
evaluate([{ src: '1' }]);

const numbat = await import('../ext/numbat/dist/numbat.js');
const { typecheckModule, buildTypeEnv } = await import('../ext/numbat/src/typecheck/integration.js');

// Build a fresh Numbat host the way evaluator.js does — same v0.1
// prelude, same DIMENSION_OF seeding, same vendored .nbt modules.
function buildEpHost() {
  const host = new numbat.Numbat({ prelude: 'v0.1' });
  host.values.set('pi',  new numbat.Quantity(Math.PI,     {}));
  host.values.set('tau', new numbat.Quantity(Math.PI * 2, {}));
  host.values.set('e',   new numbat.Quantity(Math.E,      {}));
  host.values.set('NaN', new numbat.Quantity(NaN, {}));
  host.values.set('inf', new numbat.Quantity(Infinity, {}));
  for (const [name, dim] of Object.entries(DIMENSION_OF)) {
    host.dims.defineDerived(name, dim);
  }
  // Vendored .nbt modules (registered but not loaded — `use` opts in).
  if (typeof numbat.VENDORED_MODULES === 'object') {
    for (const [path, source] of Object.entries(numbat.VENDORED_MODULES)) {
      host.registerModule(path, source);
    }
  }
  return host;
}

function tcOk(src) {
  const host = buildEpHost();
  const ast = numbat.parse(numbat.tokenize(src, '<test>'), '<test>');
  return typecheckModule(ast, host);
}

// ── buildTypeEnv basics ──────────────────────────────────────────

test('buildTypeEnv lifts units into typed values', () => {
  const host = buildEpHost();
  const env = buildTypeEnv(host);
  // Units bound directly as TDim values
  assert.ok(env.values.has('m'),  'expected m');
  assert.ok(env.values.has('kg'), 'expected kg');
  assert.ok(env.values.has('s'),  'expected s');
  // pi from runtime values
  assert.ok(env.values.has('pi'), 'expected pi');
});

test('buildTypeEnv lifts dim names', () => {
  const host = buildEpHost();
  const env = buildTypeEnv(host);
  assert.deepEqual(env.dims.get('Length'), { length: 1 });
  assert.deepEqual(env.dims.get('Mass'),   { mass: 1 });
  assert.deepEqual(env.dims.get('Time'),   { time: 1 });
});

test('buildTypeEnv hand-rolls BUILTIN_FNS schemes', () => {
  const host = buildEpHost();
  const env = buildTypeEnv(host);
  assert.ok(env.fns.has('sqrt'));
  assert.ok(env.fns.has('sin'));
  assert.equal(env.fns.get('sqrt').kind, 'TScheme');
});

// ── typecheck a slice of typical programs ─────────────────────────

test('integration: arithmetic + units typecheck cleanly', () => {
  const cases = [
    'let a = 1 + 2',
    'let b = 1 m + 2 m',
    'let c = 60 mph -> km/h',
    'let d = 5 kg * 9.81 m/s^2',
    'let e = sqrt(144)',
    'let f = sin(pi / 2)',
  ];
  for (const src of cases) {
    const r = tcOk(src);
    assert.deepEqual(r.errors, [], `${src} should typecheck cleanly`);
  }
});

test('integration: dim mismatch surfaces as error', () => {
  const r = tcOk('let bad = 1 m + 2 s');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /dimension mismatch/);
});

test('integration: annotated let with wrong dim', () => {
  const r = tcOk('let bad : Time = 5 m');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /dimension mismatch/);
});

test('integration: fn decl + call', () => {
  const r = tcOk('fn area(x: Length, y: Length) -> Length^2 = x * y\nlet a = area(2 m, 3 m)');
  assert.deepEqual(r.errors, []);
});

test('integration: fn with wrong-dim arg surfaces error', () => {
  const r = tcOk('fn area(x: Length, y: Length) -> Length^2 = x * y\nlet a = area(2 m, 3 s)');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /dimension mismatch/);
});

test('integration: sqrt with proper dim arg', () => {
  const r = tcOk('let side = sqrt(4 m^2)');
  assert.deepEqual(r.errors, []);
});

test('integration: generic fn id<D> resolves per call site', () => {
  const r = tcOk('fn id<D: Dim>(x: D) -> D = x\nlet a = id(5 m)\nlet b = id(3 s)');
  assert.deepEqual(r.errors, []);
});

// ── Probe a SUBSET of the conformance corpus ──────────────────────
//
// Not the full corpus — most entries are bare expressions and Numbat's
// parser requires top-level decls. We wrap each with `let _N = ...` and
// run typecheck. Tracks how many of the wrapped corpus programs survive
// the typechecker — the number itself is the signal for follow-ups.

test('integration: typecheck corpus probe — most arithmetic+unit programs pass', () => {
  const programs = [
    '1 + 2',
    '1 m + 2 m',
    '60 mph -> km/h',
    '5 kg',
    '9.81 m/s^2',
    'sqrt(144)',
    'sin(pi / 2)',
    'cos(0)',
    'ln(e)',
    'exp(1)',
    'abs(-7)',
    'pi',
    '2 * pi',
    '100 cm to m',
    '1 hour to seconds',
    '200 m * 50 m * 8 m',   // volume
    '10 kg * 9.81 m/s^2',   // force
    '2.7 g/cm3',            // density
  ];
  let pass = 0, fail = 0;
  const failures = [];
  for (const p of programs) {
    const wrapped = `let _ = ${p}`;
    const r = tcOk(wrapped);
    if (r.errors.length === 0) pass++;
    else { fail++; failures.push(`${p} → ${r.errors[0].message}`); }
  }
  // Tighten this as the typechecker grows. Initial bar: 12+/18 (≥67%).
  // Surfaces what's still missing without blocking the test run.
  assert.ok(pass >= 12, `expected ≥12/${programs.length} passing, got ${pass}. Failures:\n  ${failures.join('\n  ')}`);
});
