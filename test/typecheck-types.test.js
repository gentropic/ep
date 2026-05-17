// Phase 1 of the typechecker: types, environment, name-gen.
//
// Tests at the source level (the typecheck/ subdir's .js files directly,
// not the bundled artifact) so failures land on the actual file being
// edited.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ratOf, ratIsZero, ratIsInt, ratIsOne, ratEq,
  ratAdd, ratSub, ratMul, ratDiv, ratNeg, ratFormat,
} from '../ext/numbat/src/typecheck/rat.js';

import {
  freshTVar, freshTDimVar, resetTypeIds,
  tVar, tDimVar, tDim, tBool, tString, tNever, tFn, tList, tStruct, tTuple, tScheme,
  T_SCALAR,
  dimExprEmpty, dimExprFromMap, dimExprFromVar, dimExprEq, dimExprIsConcrete, dimExprIsScalar, dimExprFormat,
  typeEq, formatType, freeVars,
} from '../ext/numbat/src/typecheck/types.js';

import {
  makeTypeEnv, typeEnvExtend,
  typeEnvBindValue, typeEnvBindFn, typeEnvBindDim, typeEnvBindStruct,
  typeEnvLookupValue, typeEnvLookupFn, typeEnvLookupDim, typeEnvLookupStruct,
} from '../ext/numbat/src/typecheck/env.js';

// ── Rat ───────────────────────────────────────────────────────────

test('rat: normalization', () => {
  assert.deepEqual(ratOf(4, 8),  { n: 1, d: 2 });
  assert.deepEqual(ratOf(-4, 8), { n: -1, d: 2 });
  assert.deepEqual(ratOf(4, -8), { n: -1, d: 2 });
  assert.deepEqual(ratOf(0, 5),  { n: 0, d: 1 });
});

test('rat: predicates', () => {
  assert.ok(ratIsZero(ratOf(0)));
  assert.ok(ratIsInt(ratOf(7)));
  assert.ok(!ratIsInt(ratOf(1, 2)));
  assert.ok(ratIsOne(ratOf(1)));
  assert.ok(!ratIsOne(ratOf(2)));
});

test('rat: arithmetic', () => {
  assert.ok(ratEq(ratAdd(ratOf(1, 2), ratOf(1, 3)), ratOf(5, 6)));
  assert.ok(ratEq(ratSub(ratOf(1, 2), ratOf(1, 3)), ratOf(1, 6)));
  assert.ok(ratEq(ratMul(ratOf(2, 3), ratOf(3, 4)), ratOf(1, 2)));
  assert.ok(ratEq(ratDiv(ratOf(2, 3), ratOf(4, 6)), ratOf(1)));
  assert.ok(ratEq(ratNeg(ratOf(3, 7)),              ratOf(-3, 7)));
});

test('rat: format', () => {
  assert.equal(ratFormat(ratOf(3)),       '3');
  assert.equal(ratFormat(ratOf(1, 2)),    '1/2');
  assert.equal(ratFormat(ratOf(-3, 4)),   '-3/4');
});

test('rat: zero denominator throws', () => {
  assert.throws(() => ratOf(1, 0));
  assert.throws(() => ratDiv(ratOf(1), ratOf(0)));
});

// ── DimExpr ───────────────────────────────────────────────────────

test('dimExpr: empty is scalar', () => {
  const d = dimExprEmpty();
  assert.ok(dimExprIsConcrete(d));
  assert.ok(dimExprIsScalar(d));
  assert.equal(dimExprFormat(d), '-');
});

test('dimExpr: lift from DimMap', () => {
  const d = dimExprFromMap({ length: 1, time: -1 });
  assert.ok(dimExprIsConcrete(d));
  assert.ok(!dimExprIsScalar(d));
  assert.equal(dimExprFormat(d), 'length·time^-1');
});

test('dimExpr: lift from var', () => {
  resetTypeIds();
  const v = freshTDimVar();
  const d = dimExprFromVar(v);
  assert.ok(!dimExprIsConcrete(d));
  assert.equal(dimExprFormat(d), '$0');
});

test('dimExpr: equality', () => {
  const a = dimExprFromMap({ length: 2 });
  const b = dimExprFromMap({ length: 2 });
  const c = dimExprFromMap({ length: 3 });
  assert.ok(dimExprEq(a, b));
  assert.ok(!dimExprEq(a, c));
});

// ── Name generation ───────────────────────────────────────────────

test('freshTVar: monotonic ids per reset', () => {
  resetTypeIds();
  assert.equal(freshTVar().id, 0);
  assert.equal(freshTVar().id, 1);
  assert.equal(freshTVar().id, 2);
});

test('freshTVar / freshTDimVar: separate spaces', () => {
  resetTypeIds();
  const a = freshTVar();
  const b = freshTDimVar();
  const c = freshTVar();
  assert.equal(a.id, 0);
  assert.equal(b.id, 0);   // separate counter
  assert.equal(c.id, 1);
});

// ── Type constructors + equality ──────────────────────────────────

test('typeEq: atoms', () => {
  assert.ok(typeEq(tBool(),   tBool()));
  assert.ok(typeEq(tString(), tString()));
  assert.ok(typeEq(tNever(),  tNever()));
  assert.ok(!typeEq(tBool(),  tString()));
});

test('typeEq: TVar by id', () => {
  assert.ok(typeEq(tVar(3),  tVar(3)));
  assert.ok(!typeEq(tVar(3), tVar(4)));
});

test('typeEq: TDim by dim equality', () => {
  const a = tDim(dimExprFromMap({ length: 1 }));
  const b = tDim(dimExprFromMap({ length: 1 }));
  const c = tDim(dimExprFromMap({ length: 2 }));
  assert.ok(typeEq(a, b));
  assert.ok(!typeEq(a, c));
});

test('typeEq: TFn structurally', () => {
  const f1 = tFn([tBool(), T_SCALAR], tBool());
  const f2 = tFn([tBool(), T_SCALAR], tBool());
  const f3 = tFn([tBool()],           tBool());
  assert.ok(typeEq(f1, f2));
  assert.ok(!typeEq(f1, f3));
});

test('typeEq: TList recurses', () => {
  const lA = tList(tBool());
  const lB = tList(tBool());
  const lC = tList(tString());
  assert.ok(typeEq(lA, lB));
  assert.ok(!typeEq(lA, lC));
});

test('typeEq: TStruct by name + fields', () => {
  const a = tStruct('P', { x: T_SCALAR, y: T_SCALAR });
  const b = tStruct('P', { y: T_SCALAR, x: T_SCALAR });   // field order doesn't matter
  const c = tStruct('P', { x: T_SCALAR });
  const d = tStruct('Q', { x: T_SCALAR, y: T_SCALAR });
  assert.ok(typeEq(a, b));
  assert.ok(!typeEq(a, c));
  assert.ok(!typeEq(a, d));
});

test('typeEq: TTuple structurally', () => {
  const a = tTuple([tBool(), T_SCALAR]);
  const b = tTuple([tBool(), T_SCALAR]);
  const c = tTuple([T_SCALAR, tBool()]);
  assert.ok(typeEq(a, b));
  assert.ok(!typeEq(a, c));
});

// ── formatType ────────────────────────────────────────────────────

test('formatType: covers all kinds', () => {
  assert.equal(formatType(tBool()),                           'Bool');
  assert.equal(formatType(tString()),                         'String');
  assert.equal(formatType(tNever()),                          '!');
  assert.equal(formatType(tVar(7)),                           "'a7");
  assert.equal(formatType(tDimVar(2)),                        '$2');
  assert.equal(formatType(T_SCALAR),                          'Scalar');
  assert.equal(formatType(tDim(dimExprFromMap({length: 1}))), 'length');
  assert.equal(formatType(tFn([tBool()], T_SCALAR)),          '(Bool) -> Scalar');
  assert.equal(formatType(tList(tBool())),                    'List<Bool>');
  assert.equal(formatType(tTuple([tBool(), T_SCALAR])),       '(Bool, Scalar)');
  assert.equal(formatType(tStruct('P', { x: T_SCALAR })),     'P');
});

// ── freeVars ──────────────────────────────────────────────────────

test('freeVars: collects from nested types', () => {
  const t = tFn([tVar(0), tList(tVar(1))], tDim(dimExprFromVar({ kind: 'TDimVar', id: 3 })));
  const fv = freeVars(t);
  assert.deepEqual([...fv.tvars].sort((a,b)=>a-b),   [0, 1]);
  assert.deepEqual([...fv.dimVars].sort((a,b)=>a-b), [3]);
});

// ── TypeEnv ───────────────────────────────────────────────────────

test('typeEnv: empty lookup returns undefined', () => {
  const env = makeTypeEnv();
  assert.equal(typeEnvLookupValue(env, 'x'), undefined);
});

test('typeEnv: bind and look up', () => {
  const env = makeTypeEnv();
  typeEnvBindValue(env, 'x', tBool());
  typeEnvBindFn(env, 'f', tScheme([], [], tFn([], tBool())));
  typeEnvBindDim(env, 'Length', { length: 1 });
  typeEnvBindStruct(env, 'P', tStruct('P', { x: T_SCALAR }));
  assert.ok(typeEq(typeEnvLookupValue(env, 'x'), tBool()));
  assert.equal(typeEnvLookupFn(env, 'f').kind,  'TScheme');
  assert.deepEqual(typeEnvLookupDim(env, 'Length'), { length: 1 });
  assert.equal(typeEnvLookupStruct(env, 'P').name, 'P');
});

test('typeEnv: child shadows parent', () => {
  const parent = makeTypeEnv();
  typeEnvBindValue(parent, 'x', tBool());
  const child = typeEnvExtend(parent);
  typeEnvBindValue(child, 'x', tString());
  assert.ok(typeEq(typeEnvLookupValue(child, 'x'),  tString()));
  assert.ok(typeEq(typeEnvLookupValue(parent, 'x'), tBool()));
});

test('typeEnv: child sees parent when not shadowed', () => {
  const parent = makeTypeEnv();
  typeEnvBindValue(parent, 'y', tBool());
  const child = typeEnvExtend(parent);
  assert.ok(typeEq(typeEnvLookupValue(child, 'y'), tBool()));
});

test('typeEnv: deep chain walks all the way up', () => {
  const a = makeTypeEnv();    typeEnvBindValue(a, 'z', tString());
  const b = typeEnvExtend(a);
  const c = typeEnvExtend(b);
  const d = typeEnvExtend(c);
  assert.ok(typeEq(typeEnvLookupValue(d, 'z'), tString()));
});

// ── Immutability ──────────────────────────────────────────────────

test('frozen: constructed types are deep-frozen', () => {
  const t = tFn([tBool()], T_SCALAR);
  assert.ok(Object.isFrozen(t));
  assert.ok(Object.isFrozen(t.params));
  const d = dimExprFromMap({ length: 1 });
  assert.ok(Object.isFrozen(d));
  assert.ok(Object.isFrozen(d.base));
  assert.ok(Object.isFrozen(d.vars));
});
