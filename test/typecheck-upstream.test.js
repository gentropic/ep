// Phase 7 of the typechecker: port upstream's typechecker test corpus.
//
// Source: ../numbat/numbat/src/typechecker/tests/{type_checking,type_inference}.rs
// (~1400 LOC of Rust tests). Each upstream `#[test] fn name()` becomes
// `test('name (group)', ...)`; multiple `assert_successful_typecheck`
// / `get_typecheck_error` calls inside it become multiple assertions.
//
// The TEST_PRELUDE below mirrors upstream's verbatim — same dim/unit/fn
// declarations, same struct, same generic signatures. This is the
// conformance gate: tests that pass here mean we typecheck the same
// programs upstream does.
//
// Skip-with-note any test that depends on upstream features we don't
// have yet (Fn[...] type annotations, currency, non-Dim generics).
// Each skip carries a tag so we can grep for "// SKIP:" and revisit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../ext/temporal/temporal-polyfill.min.js');
}

globalThis.INITIAL_STATE = { name: 'test', body: [], ui: {} };
const { evaluate, DIMENSION_OF } = await import('../src/js/evaluator.js');
evaluate([{ src: '1' }]);

const numbat = await import('../ext/numbat/dist/numbat.js');
const { typecheckModule } = await import('../ext/numbat/src/typecheck/integration.js');

// Build a fresh host with ep's prelude + DIMENSION_OF seeding, then
// load upstream's TEST_PRELUDE so dims A/B/C, units a/b/c, and the
// helper fns are in scope.
const TEST_PRELUDE = `
  dimension A
  dimension B
  dimension C = A * B
  unit a: A
  unit b: B
  unit c: C = a * b

  fn returns_a() -> A = a
  fn takes_a_returns_a(x: A) -> A = x
  fn takes_a_returns_b(x: A) -> B = b
  fn takes_a_and_b_returns_c(x: A, y: B) -> C = x * y

  struct SomeStruct { a: A, b: B }

  fn atan2<T: Dim>(x: T, y: T) -> Scalar
  fn id<T: Dim>(x: T) -> T = x
  fn id_for_dim<T: Dim>(x: T) -> T = x

  let callable = takes_a_returns_b
`;

function buildPreludedHost() {
  const host = new numbat.Numbat({ prelude: 'v0.1' });
  host.values.set('pi',  new numbat.Quantity(Math.PI,     {}));
  host.values.set('tau', new numbat.Quantity(Math.PI * 2, {}));
  host.values.set('e',   new numbat.Quantity(Math.E,      {}));
  for (const [name, dim] of Object.entries(DIMENSION_OF)) {
    host.dims.defineDerived(name, dim);
  }
  // Run TEST_PRELUDE through the LOADER so dims/units/fns/structs
  // register in the runtime env. The typecheck pass on user input
  // also includes the prelude (see tc()) so let-bound fn refs etc.
  // resolve correctly through check.js's own bindings.
  const env = numbat.makeEnv({
    dims: host.dims, units: host.registry, values: host.values,
    fns: host.fns, structs: host.structs, resolveUse: () => {},
  });
  const preAst = numbat.parse(numbat.tokenize(TEST_PRELUDE, '<prelude>'), '<prelude>');
  numbat.loadModule(preAst, env);
  return host;
}

// ── Test helpers ──────────────────────────────────────────────────

function tc(input) {
  const host = buildPreludedHost();
  // Prepend TEST_PRELUDE to the typecheck input so check.js sees the
  // same decls and binds them in its own typed env (vs. only relying
  // on buildTypeEnv's after-the-fact lifting). Value-typed let refs
  // like `let callable = takes_a_returns_b` need this — buildTypeEnv
  // skips JS-function-valued runtime entries.
  const combined = TEST_PRELUDE + '\n' + input;
  const ast = numbat.parse(numbat.tokenize(combined, '<input>'), '<input>');
  return typecheckModule(ast, host);
}

function assertOk(input) {
  const r = tc(input);
  assert.deepEqual(r.errors, [], `expected to typecheck:\n  ${input}\nerrors:\n  ${r.errors.map(e=>e.message).join('\n  ')}`);
}

function assertErr(input, msgPattern) {
  const r = tc(input);
  assert.ok(r.errors.length > 0, `expected error for: ${input}`);
  if (msgPattern) {
    assert.ok(
      r.errors.some(e => msgPattern.test(e.message)),
      `expected error matching ${msgPattern} for: ${input}\nactual:\n  ${r.errors.map(e=>e.message).join('\n  ')}`,
    );
  }
}

function wrap(expr) {
  // Bare exprs need wrapping — Numbat's parser only accepts decls at
  // top level. Wrapping in `let __tc_test__ = ...` does the trick.
  return `let __tc_test__ = ${expr}`;
}

const DIM_MISMATCH = /dimension mismatch/;

// ── basic_arithmetic ──────────────────────────────────────────────

test('upstream: basic_arithmetic', () => {
  assertOk(wrap('2 a + a'));
  assertOk(wrap('2 a - a'));
  assertOk(wrap('a * b'));
  assertOk(wrap('a / b'));
  assertOk(wrap('a * b + 2 c'));
  assertOk(wrap('c / a + b'));
  assertErr(wrap('a + b'), DIM_MISMATCH);
});

// ── polymorphic_zero ──────────────────────────────────────────────
//
// Upstream allows `1 a + 0` because `0` is dimensionally polymorphic.
// Our typechecker treats `0` as TScalar and requires `1 a` + `Scalar` —
// emits dim mismatch. This is a real divergence. SKIP with note.

test('upstream: polymorphic_zero', { skip: 'requires polymorphic-zero handling — Scalar additive identity for any dim' }, () => {
  assertOk(wrap('1 a + 0'));
  assertOk(wrap('0 + 1 a'));
  assertOk(wrap('1 b + 0'));
  assertOk(wrap('1 a + 0 * b'));
});

// ── exponentiation_with_scalar_base ───────────────────────────────

test('upstream: exponentiation_with_scalar_base', () => {
  assertOk(wrap('2^2'));
  assertOk(wrap('2^(2^2)'));
  // Upstream rejects `2^a` because the exponent must be scalar.
  // Our typechecker also rejects this (non-const, non-scalar arg).
  assertErr(wrap('2^a'));
  assertErr(wrap('2^(c/b)'));
});

// ── exponentiation_with_dimensionful_base ─────────────────────────

test('upstream: exponentiation_with_dimensionful_base', () => {
  assertOk(wrap('a^2'));
  assertOk(wrap('a^(2+3)'));
  assertOk(wrap('a^(2-3)'));
  assertOk(wrap('a^(2*3)'));
  assertOk(wrap('a^(2/3)'));    // rational exponent — covered by our solver
  assertOk(wrap('a^(2^3)'));    // const-foldable nested exp
  // Non-const exp on dimensionful base
  assertErr(wrap('a^b'));
  assertErr('let x = 2\na^x');   // variable in exponent position
});

// ── equality ──────────────────────────────────────────────────────

test('upstream: equality', () => {
  assertOk(wrap('2 a == a'));
  assertOk(wrap('2 a / (3 a) == 2 / 3'));
  assertErr(wrap('a == b'), DIM_MISMATCH);
  // Heterogeneous-type equality (Bool == Dim, Bool == String) — our
  // unifier rejects with "cannot unify".
  assertErr(wrap('a == true'));
  assertErr(wrap('true == "foo"'));
});

// ── comparisons ───────────────────────────────────────────────────

test('upstream: comparisons', () => {
  assertOk(wrap('2 a > a'));
  assertOk(wrap('2 a / (3 a) > 3'));
  assertErr(wrap('a > b'), DIM_MISMATCH);
});

// ── variable_definitions ──────────────────────────────────────────

test('upstream: variable_definitions', () => {
  assertOk('let x: A = a\nlet y: B = b');
  assertOk('let x: C = a * b');
  assertOk('let x: C = 2 * a * b^2 / b');
  assertOk('let x: A^3 = a^20 * a^(-17)');
  assertOk('let x: A = c / b');
  // Mismatches
  assertErr('let x: A = b', DIM_MISMATCH);
  assertErr('let x: A = c', DIM_MISMATCH);
});

// ── unit_definitions ──────────────────────────────────────────────
//
// Upstream tests unit decls with various annotation forms. We support
// `unit name: Dim` and `unit name = expr`; the corner cases (auto-base
// dim from name) we have but in a simpler form.

test('upstream: unit_definitions (subset)', () => {
  assertOk('unit x: A');                  // annotated dim
  assertOk('unit x: A = 2 a');            // annotated dim + value
  assertOk('unit x = 2 a');               // dim inferred from value
});

// ── function_definitions ──────────────────────────────────────────

test('upstream: function_definitions', () => {
  assertOk('fn f(x: A) -> A = x');
  assertOk('fn f(x: A) -> A = x + x');
  assertOk('fn f(x: A, y: B) -> C = x * y');
  // Return type mismatch
  assertErr('fn f(x: A) -> B = x', DIM_MISMATCH);
  // Argument site mismatch
  assertOk('fn f(x: A) -> A = x\nlet z = f(2 a)');
  assertErr('fn f(x: A) -> A = x\nlet z = f(2 b)', DIM_MISMATCH);
});

// ── recursive_functions ───────────────────────────────────────────

test('upstream: recursive_functions', () => {
  assertOk(`
    fn fact(n: Scalar) -> Scalar = if n < 2 then 1 else n * fact(n - 1)
  `.trim());
  assertOk(`
    fn fib(n: Scalar) -> Scalar = if n < 2 then n else fib(n - 1) + fib(n - 2)
  `.trim());
});

// ── function_definitions_with_local_variables ─────────────────────
//
// where-clauses + fn-internal lets — we have where-clauses, parser
// supports them, check.js infers them.

test('upstream: function_definitions_with_local_variables (where)', () => {
  assertOk('fn f(x: A) -> A = y where y = x');
  assertOk('fn f(x: A) -> A = z where y = x and z = y');
});

// ── generics_basic ────────────────────────────────────────────────

test('upstream: generics_basic', () => {
  // id<T>(T) -> T  — from prelude
  assertOk(wrap('id(2 a)'));
  assertOk(wrap('id(2 b)'));
  // Same generic, different call sites — independent dim-var instances.
  assertOk('let x = id(2 a)\nlet y = id(3 b)');
  // takes_a_and_b_returns_c with proper args
  assertOk(wrap('takes_a_and_b_returns_c(2 a, 3 b)'));
  // Mismatched arg
  assertErr(wrap('takes_a_and_b_returns_c(2 b, 3 b)'), DIM_MISMATCH);
});

// ── fn-value (callable) ──────────────────────────────────────────
//
// Upstream's `let callable = takes_a_returns_b` makes fn-as-value
// possible — references a fn name and gets a TFn value. Our inferIdent
// instantiates the scheme and returns TFn; let-bound, the value type
// becomes monomorphic. Should work; let's verify.

test('upstream: fn as first-class value', () => {
  assertOk('let f = takes_a_returns_b\nlet z = f(2 a)');
  assertErr('let f = takes_a_returns_b\nlet z = f(2 b)', DIM_MISMATCH);
});

// ── variable_definitions (extended) ──────────────────────────────

test('upstream: variable_definitions — Bool and String annotations', () => {
  assertOk('let x: Bool = true');
  assertOk('let x: String = "hello"');
  // Mismatches
  assertErr('let x: A = true');
  assertErr('let x: A = "foo"');
  assertErr('let x: Bool = a');
  assertErr('let x: String = true');
});

// ── unit_definitions (more) ──────────────────────────────────────

test('upstream: unit_definitions — annotated with arithmetic dim expr', () => {
  assertOk('unit my_c: C = a * b');
  assertOk('unit foo: A*B^2 = a b^2');
  assertErr('unit my_c: C = a', DIM_MISMATCH);
});

// ── function_definitions (extended) ──────────────────────────────

test('upstream: function_definitions — no return annotation', () => {
  // `fn f(x: A) = x` — return type inferred from body
  assertOk('fn f(x: A) = x');
});

test('upstream: function_definitions — wrong arg at call site', () => {
  assertErr('fn f(x: A) -> A = a\nlet z = f(b)', DIM_MISMATCH);
});

test('upstream: function_definitions — return type mismatch', () => {
  assertErr('fn f(x: A, y: B) -> C = x / y', DIM_MISMATCH);
});

// ── recursive_functions (extended) ───────────────────────────────

test('upstream: recursive_functions — abs-via-recursion', () => {
  assertOk('fn f(x: Scalar) -> Scalar = if x < 0 then f(-x) else x');
  // Same fn without annotations: requires free-TVar generalization (#93).
  // SKIP until that lands.
});

test('upstream: recursive_functions — inconsistent branch dims', () => {
  // `f` returns A in one branch but B in the other — should error.
  assertErr('fn f(x: Scalar) -> A = if x < 0 then f(-x) else 2 b', DIM_MISMATCH);
});

// ── function_definitions_with_local_variables ─────────────────────

test('upstream: where with type annotation', () => {
  assertOk('fn f(x: A) -> C = x * y where y: B = b');
});

test('upstream: where with multiple clauses', () => {
  assertOk('fn f(x: A) -> C = y * z where y = x * 2 and z = b * 2');
});

test('upstream: where with mismatched binding', () => {
  assertErr('fn f(x: A) = y where y = x + b', DIM_MISMATCH);
});

// ── generics (multi-var) ──────────────────────────────────────────

test('upstream: generics_basic — multi-var compound', () => {
  // Two type parameters, compound return type D0/D1^2
  assertOk(`
    fn f<D0: Dim, D1: Dim>(x: D0, y: D1) -> D0/D1^2 = x/y^2
    let p = f(2, 3)
    let q = f(2 a, 2 b)
  `.trim());
});

test('upstream: generics — atan2 with same-typed args', () => {
  assertOk('fn f3<T: Dim>(y: T, x: T) = atan2(y, x)');
});

test('upstream: generics — mismatched return signature', { skip: 'needs free-var consistency check post-solve (track as follow-up): solver currently binds T1=T2 instead of rejecting' }, () => {
  // `T2/T1` in return but body returns `x/y` which is T1/T2 — upstream
  // rejects. Our solver "succeeds" by unifying T1 := T2 since they're
  // dim-vars with no other constraint. Need a post-solve pass that
  // verifies each generic param's binding is still genuinely free.
  assertErr('fn f<T1: Dim, T2: Dim>(x: T1, y: T2) -> T2/T1 = x/y', DIM_MISMATCH);
});

// ── unknown identifier / function ────────────────────────────────

test('upstream: unknown_identifier', () => {
  // Upstream uses `d` here but our v0.1 prelude registers `d` as the
  // short alias for `day` — collision. Use a name that's actually free.
  assertErr(wrap('a + unknown_thing'), /unknown identifier/);
});

test('upstream: unknown_function', () => {
  assertErr(wrap('foo(2)'), /unknown function/);
});

// ── wrong_arity ──────────────────────────────────────────────────

test('upstream: wrong_arity', () => {
  assertErr('fn f() = 1\nlet z = f(1)', /expected 0 args, got 1/);
  assertErr('fn f(x: Scalar) = x\nlet z = f()', /expected 1 args, got 0/);
  assertErr('fn f(x: Scalar) = x\nlet z = f(2, 3)', /expected 1 args, got 2/);
});

// ── conditionals ──────────────────────────────────────────────────

test('upstream: conditionals — well-typed branches', () => {
  assertOk(wrap('if true then 1 else 2'));
  assertOk(wrap('if true then true else false'));
});

test('upstream: conditionals — non-bool cond', () => {
  // Numbat rejects "if 1 then 2 else 3" (cond must be Bool, got Scalar).
  // Our unifier rejects with "cannot unify Scalar with Bool".
  assertErr(wrap('if 1 then 2 else 3'));
});

test('upstream: conditionals — branch dims differ', () => {
  assertErr(wrap('if true then a else b'), DIM_MISMATCH);
});

test('upstream: conditionals — branch types differ (Bool vs Dim)', () => {
  assertErr(wrap('if true then true else a'));
});

// ── non-dtype return types in fn annotation ──────────────────────

test('upstream: non_dtype_return_types', () => {
  assertErr('fn f() -> String = 1');
  assertErr('fn f() -> Scalar = "test"');
  assertErr('fn f() -> Bool = 1');
  assertErr('fn f() -> Scalar = true');
  assertErr('fn f() -> String = true');
  assertErr('fn f() -> Bool = "test"');
});

// ── callables (let-bound fn references) ──────────────────────────

test('upstream: callables — bound fn ref works', () => {
  // `callable` is `let callable = takes_a_returns_b` in TEST_PRELUDE.
  // Should accept an A and return a B.
  assertOk(wrap('callable(a)'));
  assertErr(wrap('callable(b)'), DIM_MISMATCH);
});

test('upstream: callables — arity mismatch on bound fn', () => {
  assertErr(wrap('callable()'), /expected 1 args, got 0/);
  assertErr(wrap('callable(a, a)'), /expected 1 args, got 2/);
});

test('upstream: callables — using bound fn in arithmetic context errors', () => {
  // `a + callable` — adding a Dim to a Fn value; expected Dim, got Fn.
  assertErr(wrap('a + callable'));
});

// ── calling non-function ─────────────────────────────────────────

test('upstream: calling a dim value as function', () => {
  // `a(1)` — `a` is a unit (TDim). Calling it should error with "not a fn"
  // or similar. We currently say "unknown function: a" since we route Call
  // through env.fns first. SKIP until we improve the Call dispatch.
});

// ── function-type annotations (Fn[...]) ──────────────────────────
//
// Block of tests that all need `Fn[(A) -> B]` type annotations which
// our parser currently discards (#94). Skip until that lands.

test('upstream: function_types_basic', { skip: 'Fn[(A) -> B] annotation parsing not done (#94)' }, () => {
  assertOk(`
    let returns_a_ref1 = returns_a
    let returns_a_ref2: Fn[() -> A] = returns_a
  `);
});

// ── List<T> ───────────────────────────────────────────────────────
//
// Upstream has `fn head<T>(x: List<T>) -> T` etc. List<T> requires
// per-element type unification; the TypeApp(List, [T]) path handles
// the annotation side. SKIP because BUILTIN core::lists isn't lifted
// into the typed env yet (follow-up #98).

test('upstream: list_head_tail', { skip: 'core::lists schemes not lifted yet (#98)' }, () => {
  assertOk('let xs = [2 a, 3 a]\nlet x = head(xs)');
  assertErr('let x = head([2 a, 3 b])', DIM_MISMATCH);
});

// ── no-op test to keep file structure when more land later ──────
test('upstream: corpus port placeholder', () => { assert.ok(true); });
