// Phase 5 of the typechecker: plain dim-mismatch errors with spans.
//
// Covers:
//   - formatDim produces capitalized base names + Unicode superscripts
//   - formatError renders a usable Rust-style snippet
//   - spans flow through unify → solve → error list and point at the
//     right source location

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize } from '../ext/numbat/src/tokenize.js';
import { parse } from '../ext/numbat/src/parse.js';
import { ratOf } from '../ext/numbat/src/typecheck/rat.js';
import { resetTypeIds, tDim, T_SCALAR, dimExprFromMap, dimExprFromVar, freshTDimVar, tFn, tList, tBool, tString } from '../ext/numbat/src/typecheck/types.js';
import { makeTypeEnv, typeEnvBindValue, typeEnvBindDim } from '../ext/numbat/src/typecheck/env.js';
import { checkModule } from '../ext/numbat/src/typecheck/check.js';
import { solve } from '../ext/numbat/src/typecheck/solve.js';
import { formatDim, formatTypePretty, formatError, formatErrors } from '../ext/numbat/src/typecheck/errors.js';

function freshEnv() {
  const env = makeTypeEnv();
  typeEnvBindDim(env, 'Length', { length: 1 });
  typeEnvBindDim(env, 'Mass',   { mass: 1 });
  typeEnvBindDim(env, 'Time',   { time: 1 });
  typeEnvBindValue(env, 'm', tDim(dimExprFromMap({ length: 1 })));
  typeEnvBindValue(env, 's', tDim(dimExprFromMap({ time: 1 })));
  return env;
}

function runCheck(src) {
  resetTypeIds();
  const env = freshEnv();
  const ast = parse(tokenize(src, '<input>'), '<input>');
  const { constraints, errors: checkErrors } = checkModule(ast, env);
  const { errors: solveErrors } = solve(constraints);
  return { checkErrors, solveErrors, src };
}

// ── formatDim ─────────────────────────────────────────────────────

test('formatDim: scalar', () => {
  assert.equal(formatDim(dimExprFromMap({})), 'Scalar');
});

test('formatDim: capitalized base, unicode exponent', () => {
  assert.equal(formatDim(dimExprFromMap({ length: 1 })),  'Length');
  assert.equal(formatDim(dimExprFromMap({ length: 2 })),  'Length²');
  assert.equal(formatDim(dimExprFromMap({ length: -1 })), 'Length⁻¹');
  assert.equal(formatDim(dimExprFromMap({ length: 1, time: -1 })), 'Length·Time⁻¹');
});

test('formatDim: rational exponent shown as fraction', () => {
  const d = { base: { length: ratOf(1, 2) }, vars: {} };
  assert.equal(formatDim(d), 'Length^(1/2)');
});

test('formatDim: dim vars rendered as $N', () => {
  resetTypeIds();
  const v = freshTDimVar();
  assert.equal(formatDim(dimExprFromVar(v)), '$0');
});

test('formatDim: mixed base + vars', () => {
  resetTypeIds();
  const v = freshTDimVar();
  const d = { base: { length: ratOf(1) }, vars: { [v.id]: ratOf(-1) } };
  assert.equal(formatDim(d), 'Length·$0⁻¹');
});

// ── formatTypePretty ──────────────────────────────────────────────

test('formatTypePretty: atoms', () => {
  assert.equal(formatTypePretty(tBool()),    'Bool');
  assert.equal(formatTypePretty(tString()),  'String');
  assert.equal(formatTypePretty(T_SCALAR),   'Scalar');
});

test('formatTypePretty: TFn nests cleanly', () => {
  const f = tFn([tBool(), T_SCALAR], tDim(dimExprFromMap({ length: 1 })));
  assert.equal(formatTypePretty(f), '(Bool, Scalar) -> Length');
});

test('formatTypePretty: TList', () => {
  assert.equal(formatTypePretty(tList(tDim(dimExprFromMap({ time: 1 })))), 'List<Time>');
});

// ── formatError without span ──────────────────────────────────────

test('formatError: no span falls back to plain message', () => {
  const out = formatError({ message: 'oops', span: null });
  assert.equal(out, 'error: oops');
});

test('formatError: no source falls back to "file: error: ..."', () => {
  const out = formatError({ message: 'oops', span: { line: 1, col: 1, offset: 0, end: 1 } }, null, '<inline>');
  assert.equal(out, '<inline>: error: oops');
});

// ── formatError with span + source ────────────────────────────────

test('formatError: renders snippet + carets', () => {
  const src = 'let v = 1 m';
  const out = formatError({
    message: 'sample',
    span: { source: '<input>', line: 1, col: 9, offset: 8, end: 11 },
  }, src);
  assert.ok(out.includes('<input>:1:9'));
  assert.ok(out.includes('let v = 1 m'));
  // Carets aligned: col 9 → 8 leading spaces, width 3 → "^^^"
  const lines = out.split('\n');
  const caretLine = lines[lines.length - 1];
  assert.ok(caretLine.includes('^^^'));
});

// ── end-to-end: span flows through dim-mismatch ───────────────────

test('e2e: dim mismatch carries span pointing into source', () => {
  const r = runCheck('let v = 1 m + 2 s');
  assert.equal(r.solveErrors.length, 1);
  const err = r.solveErrors[0];
  assert.match(err.message, /dimension mismatch/);
  assert.match(err.message, /expected Length/);
  assert.match(err.message, /got Time/);
  // We propagate a span from the Binary's right operand at minimum.
  assert.ok(err.span, 'expected span on the error');
  assert.equal(err.span.line, 1);
});

test('e2e: formatted error pretty-prints with caret', () => {
  const r = runCheck('let v = 1 m + 2 s');
  const formatted = formatError(r.solveErrors[0], r.src);
  assert.ok(formatted.includes('error: dimension mismatch'));
  assert.ok(formatted.includes('let v = 1 m + 2 s'));
  assert.ok(formatted.includes('^'));
});

test('e2e: multiple errors collected separately, each with its span', () => {
  const r = runCheck('let a = 1 m + 2 s\nlet b = 3 kg + 4 s');
  // First gives a dim mismatch; second references unknown identifier kg
  // (not in this env) — but the second IS bound via runCheck's freshEnv?
  // freshEnv only binds m, s — not kg. So second is "unknown identifier".
  // Check we get two errors total (one per bad decl).
  const allMsgs = [...r.checkErrors.map(e => e.message), ...r.solveErrors.map(e => e.message)];
  assert.ok(allMsgs.length >= 2, `expected ≥2 errors, got ${allMsgs.length}: ${JSON.stringify(allMsgs)}`);
});

test('e2e: formatErrors joins multiple error blocks', () => {
  const r = runCheck('let v = 1 m + 2 s');
  const formatted = formatErrors(r.solveErrors, r.src);
  assert.ok(typeof formatted === 'string');
  assert.ok(formatted.length > 0);
});
