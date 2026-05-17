// Glue between the typechecker and the runtime (load.js).
//
// `buildTypeEnv(runtimeEnv)` walks a freshly-constructed runtime env
// (dims registry, units registry, value table) and produces a parallel
// typed env. Hand-rolled schemes for the BUILTIN_FNS handle math
// primitives that aren't defined via vendored .nbt sources.
//
// `typecheckModule(ast, runtimeEnv)` runs the full pipeline (check →
// solve) and returns `{ subst, errors, env: typeEnv }`. Calling it
// before loadModule(ast, runtimeEnv) lets the runtime skip dim checks
// the typechecker already proved — and surfaces dim mismatches at
// parse/check time instead of at first-execution-of-the-bad-branch.

import { tDim, tBool, tString, tFn, tList, tStruct, freshTVar, freshTDimVar, dimExprFromMap, dimExprFromVar, dimExprPow, T_SCALAR } from './types.js';
import { ratOf } from './rat.js';
import { generalize } from './scheme.js';
import { makeTypeEnv, typeEnvBindValue, typeEnvBindDim, typeEnvBindFn, typeEnvBindStruct } from './env.js';
import { checkModule, evalTypeAnno } from './check.js';
import { solve } from './solve.js';

// ── Hand-rolled schemes for BUILTIN_FNS ───────────────────────────
//
// These mirror the upstream-Numbat-style declarations:
//   sqrt: <D>(D^2) -> D
//   abs:  <D>(D)   -> D
//   sin:  (Scalar) -> Scalar
// (Angle is represented as Scalar in our runtime, so sin accepts Scalar.)
//
// We build each scheme fresh so the dim-var ids stay unique. The
// generalize() call packages them as proper ∀-bound schemes.

function schemeUnaryPreserveDim() {
  const d = freshTDimVar();
  const td = tDim(dimExprFromVar(d));
  return generalize(tFn([td], td), [], [d]);
}

function schemeUnaryScalarToScalar() {
  return generalize(tFn([T_SCALAR], T_SCALAR), [], []);
}

function schemeRoot(n) {
  // sqrt: <D>(D^n) -> D
  const d = freshTDimVar();
  const dimExp = dimExprPow(dimExprFromVar(d), ratOf(n));
  return generalize(tFn([tDim(dimExp)], tDim(dimExprFromVar(d))), [], [d]);
}

const BUILTIN_FN_SCHEMES = {
  // Dim-preserving
  abs:   schemeUnaryPreserveDim,
  floor: schemeUnaryPreserveDim,
  ceil:  schemeUnaryPreserveDim,
  round: schemeUnaryPreserveDim,

  // Root extractors (handle even/cube exponents)
  sqrt:  () => schemeRoot(2),
  cbrt:  () => schemeRoot(3),

  // Trig + log + exp: dimensionless in and out
  sin:   schemeUnaryScalarToScalar,
  cos:   schemeUnaryScalarToScalar,
  tan:   schemeUnaryScalarToScalar,
  asin:  schemeUnaryScalarToScalar,
  acos:  schemeUnaryScalarToScalar,
  atan:  schemeUnaryScalarToScalar,
  log:   schemeUnaryScalarToScalar,
  log10: schemeUnaryScalarToScalar,
  log2:  schemeUnaryScalarToScalar,
  ln:    schemeUnaryScalarToScalar,
  exp:   schemeUnaryScalarToScalar,
  sinh:  schemeUnaryScalarToScalar,
  cosh:  schemeUnaryScalarToScalar,
  tanh:  schemeUnaryScalarToScalar,
  asinh: schemeUnaryScalarToScalar,
  acosh: schemeUnaryScalarToScalar,
  atanh: schemeUnaryScalarToScalar,

  // Factorial: scalar in, scalar out (Factorial node has its own infer
  // rule but `n!` invocations route through Call('factorial', [n]) too).
  factorial: schemeUnaryScalarToScalar,
};

// ── Building the typed env ────────────────────────────────────────

export function buildTypeEnv(runtimeEnv) {
  const tcEnv = makeTypeEnv();

  // Accepts either the makeEnv-shaped object (env.units is the unit
  // registry) OR a Numbat host instance directly (host.registry is the
  // unit registry). Normalize.
  const unitRegistry = runtimeEnv.units || runtimeEnv.registry || null;

  // Dims: copy the public name → DimMap mapping.
  if (runtimeEnv.dims?.list) {
    for (const { name, dim } of runtimeEnv.dims.list()) {
      typeEnvBindDim(tcEnv, name, dim);
    }
  }

  // Units: every unit lookup-name becomes a typed value `TDim(unit.dim)`.
  // We iterate the private map directly — it's the only exhaustive source
  // (the public list() filters out inputOnly entries, which we DO want
  // for typechecking).
  if (unitRegistry?._units) {
    for (const [name, entry] of unitRegistry._units) {
      if (!tcEnv.values.has(name)) {
        typeEnvBindValue(tcEnv, name, tDim(dimExprFromMap(entry.dim)));
      }
    }
  }

  // Constants and let-bindings already in the runtime values table.
  if (runtimeEnv.values) {
    for (const [name, val] of runtimeEnv.values) {
      if (tcEnv.values.has(name)) continue;
      if (val && typeof val === 'object' && 'dim' in val && 'value' in val) {
        // Quantity-shaped — register as a TDim.
        typeEnvBindValue(tcEnv, name, tDim(dimExprFromMap(val.dim)));
      }
      // Skip fn-typed values; they're handled below via env.fns.
    }
  }

  // Lift user structs — those declared via earlier loadModule passes
  // are stored in runtimeEnv.structs as { name, generics, fields }.
  // Convert each into a TScheme(TStruct) so type annotations referencing
  // these structs resolve.
  if (runtimeEnv.structs) {
    for (const [name, rec] of runtimeEnv.structs) {
      if (!tcEnv.structs.has(name)) {
        typeEnvBindStruct(tcEnv, name, structRecordToScheme(rec, tcEnv));
      }
    }
  }

  // Lift user fns. Runtime stores { generics, params, body, returnType, ... }.
  // We build a TScheme directly without re-running body inference —
  // hosts that want body validation should re-run checkModule.
  if (runtimeEnv.fns) {
    for (const [name, rec] of runtimeEnv.fns) {
      if (!tcEnv.fns.has(name)) {
        typeEnvBindFn(tcEnv, name, fnRecordToScheme(rec, tcEnv));
      }
    }
  }

  // BUILTINs: math primitives get hand-rolled schemes so user code can
  // call sqrt/sin/etc. and typecheck cleanly. Last so user-declared fns
  // and structs take priority (a user's `fn sin` overrides the BUILTIN).
  for (const [name, mkScheme] of Object.entries(BUILTIN_FN_SCHEMES)) {
    if (!tcEnv.fns.has(name)) typeEnvBindFn(tcEnv, name, mkScheme());
  }

  return tcEnv;
}

// ── Lifting helpers ───────────────────────────────────────────────

function fnRecordToScheme(rec, tcEnv) {
  const generics = new Map();
  const dimVars  = [];
  for (const g of rec.generics || []) {
    if (g.kind && g.kind !== 'Dim') continue;   // skip non-Dim generics for now
    const tdv = freshTDimVar();
    generics.set(g.name, tdv);
    dimVars.push(tdv);
  }
  const ctx = { generics };
  const paramTypes = (rec.params || []).map(p =>
    p.typeExpr ? evalTypeAnno(p.typeExpr, tcEnv, ctx) : freshTVar(),
  );
  const returnType = rec.returnType
    ? evalTypeAnno(rec.returnType, tcEnv, ctx)
    : freshTVar();
  return generalize(tFn(paramTypes, returnType), [], dimVars);
}

function structRecordToScheme(rec, tcEnv) {
  const generics = new Map();
  const dimVars  = [];
  for (const g of rec.generics || []) {
    if (g.kind && g.kind !== 'Dim') continue;
    const tdv = freshTDimVar();
    generics.set(g.name, tdv);
    dimVars.push(tdv);
  }
  const ctx = { generics };
  const fields = {};
  for (const f of rec.fields || []) {
    fields[f.name] = evalTypeAnno(f.type, tcEnv, ctx);
  }
  return generalize(tStruct(rec.name, fields), [], dimVars);
}

// One-shot: parse + check + solve, return diagnostics. Hosts that want
// to opt into typechecking call this before loadModule.
export function typecheckModule(ast, runtimeEnv) {
  const env = buildTypeEnv(runtimeEnv);
  const { constraints, errors: checkErrors } = checkModule(ast, env);
  const { subst, errors: solveErrors } = solve(constraints);
  return {
    env,
    subst,
    errors: [...checkErrors, ...solveErrors],
  };
}
