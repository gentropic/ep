// Phase 3 of the typechecker: unifier + dim equation solver + top-level solve.
//
// Mixes direct unifier tests (synthetic Types) with end-to-end tests that
// run a small program through check.js → solve and assert on the
// resolved types.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize } from '../ext/numbat/src/tokenize.js';
import { parse } from '../ext/numbat/src/parse.js';
import { ratOf } from '../ext/numbat/src/typecheck/rat.js';
import {
  resetTypeIds, freshTVar, freshTDimVar, tVar, tDim, tBool, tString, tFn, tList, tStruct, tTuple, T_SCALAR,
  dimExprFromMap, dimExprFromVar, dimExprEmpty, formatType,
} from '../ext/numbat/src/typecheck/types.js';
import { makeTypeEnv, typeEnvBindValue, typeEnvBindFn, typeEnvBindDim, typeEnvBindStruct } from '../ext/numbat/src/typecheck/env.js';
import { makeSubst, applyType, applyDimExpr, extendTVar, extendDimVar, UnifyError } from '../ext/numbat/src/typecheck/subst.js';
import { unify } from '../ext/numbat/src/typecheck/unify.js';
import { solveDimEq } from '../ext/numbat/src/typecheck/dim-solve.js';
import { checkModule } from '../ext/numbat/src/typecheck/check.js';
import { solve } from '../ext/numbat/src/typecheck/solve.js';

function freshEnv() {
  const env = makeTypeEnv();
  typeEnvBindDim(env, 'Length', { length: 1 });
  typeEnvBindDim(env, 'Mass',   { mass: 1 });
  typeEnvBindDim(env, 'Time',   { time: 1 });
  typeEnvBindValue(env, 'm',  tDim(dimExprFromMap({ length: 1 })));
  typeEnvBindValue(env, 's',  tDim(dimExprFromMap({ time: 1 })));
  typeEnvBindValue(env, 'kg', tDim(dimExprFromMap({ mass: 1 })));
  typeEnvBindValue(env, 'pi', T_SCALAR);
  return env;
}

function parseModule(src) { return parse(tokenize(src, '<test>'), '<test>'); }
function fmt(t) { return formatType(t); }

// ── direct unifier tests ──────────────────────────────────────────

test('unify: identical atoms', () => {
  const s = unify(tBool(), tBool(), makeSubst());
  assert.equal(s.tvars.size, 0);
});

test('unify: TVar with concrete type binds', () => {
  resetTypeIds();
  const v = freshTVar();
  const s = unify(v, tBool(), makeSubst());
  assert.ok(s.tvars.has(v.id));
  assert.equal(fmt(applyType(v, s)), 'Bool');
});

test('unify: same TVar twice no-ops', () => {
  resetTypeIds();
  const v = freshTVar();
  const s = unify(v, v, makeSubst());
  assert.equal(s.tvars.size, 0);
});

test('unify: occurs check rejects α := f(α)', () => {
  resetTypeIds();
  const v = freshTVar();
  assert.throws(() => unify(v, tFn([v], tBool()), makeSubst()), /occurs check/);
});

test('unify: TFn structural', () => {
  resetTypeIds();
  const a = freshTVar(), b = freshTVar();
  const f1 = tFn([a],       tBool());
  const f2 = tFn([T_SCALAR], b);
  const s  = unify(f1, f2, makeSubst());
  assert.equal(fmt(applyType(a, s)), 'Scalar');
  assert.equal(fmt(applyType(b, s)), 'Bool');
});

test('unify: TFn arity mismatch throws', () => {
  assert.throws(() => unify(tFn([tBool()], tBool()), tFn([], tBool()), makeSubst()), /arity/);
});

test('unify: TList recurses', () => {
  resetTypeIds();
  const v = freshTVar();
  const s = unify(tList(v), tList(tBool()), makeSubst());
  assert.equal(fmt(applyType(v, s)), 'Bool');
});

test('unify: TTuple recurses + arity check', () => {
  resetTypeIds();
  const v = freshTVar();
  const s = unify(tTuple([v, tBool()]), tTuple([T_SCALAR, tBool()]), makeSubst());
  assert.equal(fmt(applyType(v, s)), 'Scalar');
  assert.throws(() => unify(tTuple([tBool()]), tTuple([tBool(), tBool()]), makeSubst()), /arity/);
});

test('unify: TStruct same name + fields', () => {
  resetTypeIds();
  const v = freshTVar();
  const sA = tStruct('Pt', { x: v });
  const sB = tStruct('Pt', { x: tBool() });
  const s = unify(sA, sB, makeSubst());
  assert.equal(fmt(applyType(v, s)), 'Bool');
});

test('unify: TStruct different names fail', () => {
  assert.throws(
    () => unify(tStruct('Pt', { x: tBool() }), tStruct('Vec', { x: tBool() }), makeSubst()),
    /struct mismatch/,
  );
});

test('unify: incompatible kinds throw', () => {
  assert.throws(() => unify(tBool(), tString(), makeSubst()), /cannot unify/);
});

// ── dim-solve direct tests ────────────────────────────────────────

test('dim-solve: trivially equal', () => {
  const d = dimExprFromMap({ length: 1 });
  const s = solveDimEq(d, d, makeSubst());
  assert.equal(s.dimVars.size, 0);
});

test('dim-solve: solves $0 = Length', () => {
  resetTypeIds();
  const v = freshTDimVar();
  const s = solveDimEq(dimExprFromVar(v), dimExprFromMap({ length: 1 }), makeSubst());
  const resolved = applyDimExpr(dimExprFromVar(v), s);
  assert.deepEqual(resolved.base, { length: ratOf(1) });
});

test('dim-solve: solves $0 · Mass = Length^3 → $0 := Length^3 / Mass', () => {
  resetTypeIds();
  const v = freshTDimVar();
  // $0 · Mass on the left, Length^3 on the right.
  const lhs = { base: Object.freeze({ mass: ratOf(1) }), vars: Object.freeze({ 0: ratOf(1) }) };
  const rhs = dimExprFromMap({ length: 3 });
  const s = solveDimEq(Object.freeze(lhs), rhs, makeSubst());
  const r = applyDimExpr(dimExprFromVar(v), s);
  assert.deepEqual(r.base, { length: ratOf(3), mass: ratOf(-1) });
});

test('dim-solve: solves fractional exponent ($0^2 = Length → $0 := Length^(1/2))', () => {
  resetTypeIds();
  const v = freshTDimVar();
  const lhs = { base: Object.freeze({}), vars: Object.freeze({ 0: ratOf(2) }) };
  const s = solveDimEq(Object.freeze(lhs), dimExprFromMap({ length: 1 }), makeSubst());
  const r = applyDimExpr(dimExprFromVar(v), s);
  assert.deepEqual(r.base, { length: ratOf(1, 2) });
});

test('dim-solve: inconsistent constants throw', () => {
  assert.throws(
    () => solveDimEq(dimExprFromMap({ length: 1 }), dimExprFromMap({ mass: 1 }), makeSubst()),
    /dimension mismatch/,
  );
});

// ── solve: end-to-end through checkModule ─────────────────────────

function runCheck(src) {
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule(src);
  const { constraints, errors: checkErrors } = checkModule(ast, env);
  if (checkErrors.length) return { checkErrors, env, solveErrors: [], subst: makeSubst() };
  const { subst, errors: solveErrors } = solve(constraints);
  return { checkErrors, env, solveErrors, subst };
}

test('solve e2e: simple let resolves', () => {
  const r = runCheck('let v = 1 m + 2 m');
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  assert.equal(fmt(applyType(r.env.values.get('v'), r.subst)), 'length');
});

test('solve e2e: dim mismatch surfaces as error', () => {
  const r = runCheck('let v = 1 m + 2 s');
  assert.deepEqual(r.checkErrors, []);
  assert.equal(r.solveErrors.length, 1);
  assert.match(r.solveErrors[0].message, /dimension mismatch/);
});

test('solve e2e: LetDecl annotation enforced', () => {
  const r = runCheck('let bad: Time = 5 m');
  assert.deepEqual(r.checkErrors, []);
  assert.equal(r.solveErrors.length, 1);
  assert.match(r.solveErrors[0].message, /dimension mismatch/);
});

test('solve e2e: LetDecl with matching annotation', () => {
  const r = runCheck('let v: Length / Time = 60 m / 1 s');
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  assert.equal(fmt(applyType(r.env.values.get('v'), r.subst)), 'length·time^-1');
});

test('solve e2e: generic id<D>(D) -> D resolves at call site', () => {
  const r = runCheck(`
    fn id<D>(x: D) -> D = x
    let a = id(5 m)
    let b = id(10 s)
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  assert.equal(fmt(applyType(r.env.values.get('a'), r.subst)), 'length');
  assert.equal(fmt(applyType(r.env.values.get('b'), r.subst)), 'time');
});

test('solve e2e: multi-var compound divide<A,B>(a,b) -> A/B', () => {
  const r = runCheck(`
    fn divide<A, B>(a: A, b: B) -> A / B = a / b
    let speed = divide(60 m, 1 s)
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  assert.equal(fmt(applyType(r.env.values.get('speed'), r.subst)), 'length·time^-1');
});

test('solve e2e: arity mismatch at call surfaces', () => {
  const r = runCheck(`
    fn f(x: Length) -> Length = x
    let oops = f(1 m, 2 m)
  `);
  // Arity mismatch is thrown by check (during inferDirectFnCall), so it
  // lands in checkErrors, not solveErrors.
  assert.equal(r.checkErrors.length, 1);
  assert.match(r.checkErrors[0].message, /expected 1 args, got 2/);
});

test('solve e2e: dim mismatch in fn arg', () => {
  const r = runCheck(`
    fn area(x: Length, y: Length) -> Length^2 = x * y
    let bad = area(1 m, 2 s)
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.equal(r.solveErrors.length, 1);
  assert.match(r.solveErrors[0].message, /dimension mismatch/);
});

test('solve e2e: sqrt-style fractional exponent flows through', () => {
  // sqrt-as-pow — base is the value, exponent is 1/2.
  const r = runCheck(`
    fn root_area<D>(a: D) -> D = a
    let len = root_area(1 m)
  `);
  // Trivial case (returns input) — the real fractional-exp test is the
  // direct dim-solve test above. This just verifies the e2e pipe works
  // with generics that touch the dim solver.
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  assert.equal(fmt(applyType(r.env.values.get('len'), r.subst)), 'length');
});

test('solve e2e: struct construction + field access', () => {
  const r = runCheck(`
    struct Pt { x: Length, y: Length }
    let p = Pt { x: 1 m, y: 2 m }
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  assert.equal(fmt(applyType(r.env.values.get('p'), r.subst)), 'Pt');
});

test('solve e2e: struct field dim mismatch', () => {
  const r = runCheck(`
    struct Pt { x: Length, y: Length }
    let bad = Pt { x: 1 m, y: 2 s }
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.equal(r.solveErrors.length, 1);
  assert.match(r.solveErrors[0].message, /dimension mismatch/);
});
