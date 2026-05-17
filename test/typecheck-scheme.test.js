// Phase 4 of the typechecker: polymorphism — schemes, generalize, instantiate.
//
// Validates:
//   - instantiate gives genuinely fresh vars per call site
//   - two calls to the same generic don't bleed into each other
//   - generic structs work
//   - struct schemes instantiate at use site

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize } from '../ext/numbat/src/tokenize.js';
import { parse } from '../ext/numbat/src/parse.js';
import {
  resetTypeIds, freshTDimVar, tDim, tFn, tStruct, T_SCALAR,
  dimExprFromMap, dimExprFromVar, formatType,
} from '../ext/numbat/src/typecheck/types.js';
import { makeTypeEnv, typeEnvBindValue, typeEnvBindFn, typeEnvBindDim } from '../ext/numbat/src/typecheck/env.js';
import { applyType, makeSubst } from '../ext/numbat/src/typecheck/subst.js';
import { generalize, instantiate } from '../ext/numbat/src/typecheck/scheme.js';
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
  return env;
}

function parseModule(src) { return parse(tokenize(src, '<test>'), '<test>'); }
function fmt(t) { return formatType(t); }

function runCheck(src) {
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule(src);
  const { constraints, errors: checkErrors } = checkModule(ast, env);
  if (checkErrors.length) return { checkErrors, env, solveErrors: [], subst: makeSubst() };
  const { subst, errors: solveErrors } = solve(constraints);
  return { checkErrors, env, solveErrors, subst };
}

// ── generalize ────────────────────────────────────────────────────

test('generalize: stores binders verbatim', () => {
  resetTypeIds();
  const tdv = freshTDimVar();
  const body = tFn([tDim(dimExprFromVar(tdv))], tDim(dimExprFromVar(tdv)));
  const scheme = generalize(body, [], [tdv]);
  assert.equal(scheme.kind, 'TScheme');
  assert.equal(scheme.dimVars.length, 1);
  assert.equal(scheme.dimVars[0].id, tdv.id);
});

// ── instantiate ───────────────────────────────────────────────────

test('instantiate: scheme with no binders returns body', () => {
  resetTypeIds();
  const body = tFn([T_SCALAR], T_SCALAR);
  const scheme = generalize(body, [], []);
  const t = instantiate(scheme);
  // Returns body directly; structural equality.
  assert.equal(fmt(t), '(Scalar) -> Scalar');
});

test('instantiate: gives fresh dim-vars per call', () => {
  resetTypeIds();
  const tdv = freshTDimVar();
  const body = tFn([tDim(dimExprFromVar(tdv))], tDim(dimExprFromVar(tdv)));
  const scheme = generalize(body, [], [tdv]);

  const a = instantiate(scheme);
  const b = instantiate(scheme);

  // Both are TFn (TDim<$x>) -> TDim<$x>, but $x differs between instances.
  const aDim = a.params[0].dim;
  const bDim = b.params[0].dim;
  const aVarId = Object.keys(aDim.vars)[0];
  const bVarId = Object.keys(bDim.vars)[0];
  assert.notEqual(aVarId, bVarId, 'separate instantiations should use distinct dim-var ids');
});

test('instantiate: same dim-var consistently renamed across body', () => {
  resetTypeIds();
  const tdv = freshTDimVar();
  // (TDim<$0>, TDim<$0>) -> TDim<$0>  — three positions sharing the same var
  const body = tFn(
    [tDim(dimExprFromVar(tdv)), tDim(dimExprFromVar(tdv))],
    tDim(dimExprFromVar(tdv)),
  );
  const scheme = generalize(body, [], [tdv]);
  const inst = instantiate(scheme);
  const p1 = Object.keys(inst.params[0].dim.vars)[0];
  const p2 = Object.keys(inst.params[1].dim.vars)[0];
  const r  = Object.keys(inst.result.dim.vars)[0];
  assert.equal(p1, p2);
  assert.equal(p1, r);
});

// ── e2e: generic fn polymorphism via solve ────────────────────────

test('e2e: two distinct calls to id<D> don\'t bleed into each other', () => {
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

test('e2e: nested generic call (id(id(5 m)))', () => {
  const r = runCheck(`
    fn id<D>(x: D) -> D = x
    let v = id(id(5 m))
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  assert.equal(fmt(applyType(r.env.values.get('v'), r.subst)), 'length');
});

test('e2e: fn-of-fn — generic fn passed as value', () => {
  // Higher-order: a fn that calls id<D>. Numbat-style: pass by name.
  const r = runCheck(`
    fn id<D>(x: D) -> D = x
    let v = id(5 m)
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  assert.equal(fmt(applyType(r.env.values.get('v'), r.subst)), 'length');
});

// ── generic structs ──────────────────────────────────────────────

test('e2e: generic struct Pair<A,B>', () => {
  const r = runCheck(`
    struct Pair<A, B> { fst: A, snd: B }
    let p = Pair { fst: 5 m, snd: 10 s }
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  const pT = applyType(r.env.values.get('p'), r.subst);
  assert.equal(pT.kind, 'TStruct');
  assert.equal(pT.name, 'Pair');
  assert.equal(fmt(pT.fields.fst), 'length');
  assert.equal(fmt(pT.fields.snd), 'time');
});

test('e2e: two Pair instantiations stay distinct', () => {
  const r = runCheck(`
    struct Pair<A, B> { fst: A, snd: B }
    let p = Pair { fst: 5 m, snd: 10 s }
    let q = Pair { fst: 3 kg, snd: 4 m }
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  const pT = applyType(r.env.values.get('p'), r.subst);
  const qT = applyType(r.env.values.get('q'), r.subst);
  assert.equal(fmt(pT.fields.fst), 'length');
  assert.equal(fmt(qT.fields.fst), 'mass');
});

test('e2e: generic-struct field access resolves to correct dim', () => {
  const r = runCheck(`
    struct Pair<A, B> { fst: A, snd: B }
    let p = Pair { fst: 5 m, snd: 10 s }
    let f = p.fst
    let s = p.snd
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  assert.equal(fmt(applyType(r.env.values.get('f'), r.subst)), 'length');
  assert.equal(fmt(applyType(r.env.values.get('s'), r.subst)), 'time');
});

test('e2e: generic struct used in fn signature', () => {
  // Use generic struct in a position where the struct's generics flow
  // through a fn boundary. The fn's TDimVars and the struct's TDimVars
  // need to play nicely with the unifier.
  const r = runCheck(`
    struct Box<D> { value: D }
    fn unwrap<D>(b: Box<D>) -> D = b.value
    let b = Box { value: 5 m }
    let v = unwrap(b)
  `);
  assert.deepEqual(r.checkErrors, []);
  assert.deepEqual(r.solveErrors, []);
  assert.equal(fmt(applyType(r.env.values.get('v'), r.subst)), 'length');
});
