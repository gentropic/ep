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

import { tDim, tBool, tString, tFn, tList, tStruct, tVar, tDimVar, tScheme, freshTVar, freshTDimVar, freeVars, dimExprFromMap, dimExprFromVar, dimExprPow, T_SCALAR } from './types.js';
import { ratOf } from './rat.js';
import { generalize } from './scheme.js';
import { makeTypeEnv, typeEnvBindValue, typeEnvBindDim, typeEnvBindFn, typeEnvBindStruct } from './env.js';
import { checkModule, checkDecl, evalTypeAnno } from './check.js';
import { solve } from './solve.js';
import { applyType, makeSubst } from './subst.js';
import { makeConstraintSet } from './constraints.js';

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

function liftGenerics(declGenerics) {
  // Returns { generics: Map<name, {kind,var}>, binders: [{kind,var,name}] }.
  // Used by fn and struct record lifters in declaration order.
  const generics = new Map();
  const binders  = [];
  for (const g of declGenerics || []) {
    if (g.kind === 'Dim') {
      const tdv = freshTDimVar();
      generics.set(g.name, { kind: 'D', var: tdv });
      binders.push({ kind: 'D', var: tdv, name: g.name });
    } else {
      // 'Type' (default) or anything else → unrestricted TVar.
      const tv = freshTVar();
      generics.set(g.name, { kind: 'T', var: tv });
      binders.push({ kind: 'T', var: tv, name: g.name });
    }
  }
  return { generics, binders };
}

function fnRecordToScheme(rec, tcEnv) {
  const { generics, binders } = liftGenerics(rec.generics);
  const ctx = { cs: makeConstraintSet(), generics };
  const paramTypes = (rec.params || []).map(p =>
    p.typeExpr ? evalTypeAnno(p.typeExpr, tcEnv, ctx) : freshTVar(),
  );
  const returnType = rec.returnType
    ? evalTypeAnno(rec.returnType, tcEnv, ctx)
    : freshTVar();
  const tvars   = binders.filter(b => b.kind === 'T').map(b => b.var);
  const dimVars = binders.filter(b => b.kind === 'D').map(b => b.var);
  const order   = binders.map(b => b.kind);
  return tScheme(tvars, dimVars, tFn(paramTypes, returnType), { binderOrder: order });
}

function structRecordToScheme(rec, tcEnv) {
  const { generics, binders } = liftGenerics(rec.generics);
  const ctx = { cs: makeConstraintSet(), generics };
  const fields = {};
  for (const f of rec.fields || []) {
    fields[f.name] = evalTypeAnno(f.type, tcEnv, ctx);
  }
  const tvars   = binders.filter(b => b.kind === 'T').map(b => b.var);
  const dimVars = binders.filter(b => b.kind === 'D').map(b => b.var);
  const order   = binders.map(b => b.kind);
  return tScheme(tvars, dimVars, tStruct(rec.name, fields), { binderOrder: order });
}

// One-shot: parse + check + solve + generalize, return diagnostics.
// Hosts that want to opt into typechecking call this before loadModule.
//
// Solves PER-DECL so each later decl sees earlier fns as fully-
// generalized schemes (proper HM let-generalization). Without this,
// `fn f(x) = x` would infer (α) -> α with α unbound — and the first
// call site would pin α to a concrete type, breaking polymorphic use.
export function typecheckModule(ast, runtimeEnv) {
  const env = buildTypeEnv(runtimeEnv);
  const errors = [];
  const allSubst = makeSubst();
  for (const decl of ast.decls) {
    const ctx = { cs: makeConstraintSet(), errors: [], generics: new Map() };
    try {
      checkDecl(decl, env, ctx);
    } catch (e) {
      errors.push({ message: e.message, span: e.span || null });
      continue;
    }
    if (ctx.errors.length) {
      errors.push(...ctx.errors);
      continue;
    }
    const { subst, errors: solveErrs } = solve(ctx.cs);
    errors.push(...solveErrs);
    if (solveErrs.length) continue;
    // Merge into the running subst — useful for hosts that want to
    // inspect resolved types after the whole module.
    for (const [k, v] of subst.tvars)   allSubst.tvars.set(k, v);
    for (const [k, v] of subst.dimVars) allSubst.dimVars.set(k, v);
    finalizeDecl(decl, env, subst);
  }
  return { env, subst: allSubst, errors };
}

// After per-decl solve, apply the substitution to anything this decl
// added to the env and generalize fn schemes.
function finalizeDecl(decl, env, subst) {
  if (decl.type === 'FnDecl') {
    const scheme = env.fns.get(decl.name);
    if (!scheme || scheme.kind !== 'TScheme') return;
    const resolvedBody = applyType(scheme.body, subst);
    // Re-derive binders purely from free vars in the resolved body —
    // this is the textbook HM "generalize" step. Original binders that
    // got constrained to concrete types drop out (their vars no longer
    // appear free). Original binders that stayed free are preserved.
    // Type-kinded generics that got promoted to TDim<$d> via dim-
    // arithmetic constraints get their $d in the body as a free dim-var,
    // so the scheme correctly reflects the inferred Dim restriction.
    const fv = freeVars(resolvedBody);
    const newT = [...fv.tvars].map(id => tVar(id));
    const newD = [...fv.dimVars].map(id => tDimVar(id));
    env.fns.set(decl.name, tScheme(newT, newD, resolvedBody));
  } else if (decl.type === 'LetDecl' || decl.type === 'UnitDecl') {
    const t = env.values.get(decl.name);
    if (t) env.values.set(decl.name, applyType(t, subst));
  } else if (decl.type === 'StructDecl') {
    const s = env.structs.get(decl.name);
    if (s && s.kind === 'TScheme') {
      // Same re-derivation for structs: free vars in the resolved body
      // are the binders. Preserves binder ORDER via binderOrder so
      // application sites (Wrapper<A>) bind positionally.
      const resolvedBody = applyType(s.body, subst);
      // We need to preserve the declaration order of the original
      // binders that survived (haven't been resolved to something
      // concrete). Walk s.binders, keep those whose var is still free
      // in resolved body.
      const fv = freeVars(resolvedBody);
      const survivingBinders = s.binders.filter(b =>
        b.kind === 'T' ? fv.tvars.has(b.var.id) : fv.dimVars.has(b.var.id),
      );
      const survT = survivingBinders.filter(b => b.kind === 'T').map(b => b.var);
      const survD = survivingBinders.filter(b => b.kind === 'D').map(b => b.var);
      const order = survivingBinders.map(b => b.kind);
      env.structs.set(decl.name, tScheme(survT, survD, resolvedBody, { binderOrder: order }));
    }
  }
}
