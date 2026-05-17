// Substitutions and type-application for the typechecker.
//
// A substitution has two parts (mirrors the two var spaces from types.js):
//
//   { tvars:   Map<TVarId,    Type>,
//     dimVars: Map<TDimVarId, DimExpr> }
//
// The invariant we maintain is **idempotence**: after applying `subst` to
// a type, no further `apply(subst, ...)` makes a difference. To preserve
// idempotence as we add bindings, we always apply the current substitution
// to the new value FIRST (so it's fully resolved) and then walk all
// existing entries replacing the new var. This is the "compose" trick from
// standard HM, just inlined into extend().

import { ratAdd, ratMul, ratNeg, ratIsZero, RAT_ZERO } from './rat.js';
import { tDim, tFn, tList, tTuple, tStruct, dimExprMul, dimExprPow, dimExprSubstVar } from './types.js';

export function makeSubst() {
  return { tvars: new Map(), dimVars: new Map() };
}

// ── apply: walk a type, resolving all bound vars ──────────────────

export function applyType(t, subst) {
  switch (t.kind) {
    case 'TVar': {
      if (subst.tvars.has(t.id)) return applyType(subst.tvars.get(t.id), subst);
      return t;
    }
    case 'TDim':    return tDim(applyDimExpr(t.dim, subst));
    case 'TFn':     return tFn(t.params.map(p => applyType(p, subst)), applyType(t.result, subst));
    case 'TList':   return tList(applyType(t.elem, subst));
    case 'TTuple':  return tTuple(t.elems.map(e => applyType(e, subst)));
    case 'TStruct': {
      const f = {};
      for (const k in t.fields) f[k] = applyType(t.fields[k], subst);
      return tStruct(t.name, f);
    }
    default: return t;   // TBool, TString, TNever, TDimVar (bare — shouldn't normally appear)
  }
}

// Apply subst to every DimExpr in a Type, but only the dim half — used
// when extending dim-var bindings and we need to push the new mapping
// into already-stored TVar→Type entries.
export function applyDimVarSubstToType(t, dimVarId, repl) {
  switch (t.kind) {
    case 'TDim':    return tDim(dimExprSubstVar(t.dim, dimVarId, repl));
    case 'TFn':     return tFn(t.params.map(p => applyDimVarSubstToType(p, dimVarId, repl)), applyDimVarSubstToType(t.result, dimVarId, repl));
    case 'TList':   return tList(applyDimVarSubstToType(t.elem, dimVarId, repl));
    case 'TTuple':  return tTuple(t.elems.map(e => applyDimVarSubstToType(e, dimVarId, repl)));
    case 'TStruct': {
      const f = {};
      for (const k in t.fields) f[k] = applyDimVarSubstToType(t.fields[k], dimVarId, repl);
      return tStruct(t.name, f);
    }
    default: return t;
  }
}

// applyDimExpr: walk a DimExpr, resolving each var via the substitution.
// Bounded iteration — each pass strictly removes one resolvable var (or
// makes no change, signaling we're done).
export function applyDimExpr(d, subst) {
  let cur = d;
  while (true) {
    let resolved = false;
    let acc = Object.freeze({ base: Object.freeze({ ...cur.base }), vars: Object.freeze({}) });
    for (const k in cur.vars) {
      const id = Number(k);
      const exp = cur.vars[k];
      if (subst.dimVars.has(id)) {
        acc = dimExprMul(acc, dimExprPow(subst.dimVars.get(id), exp));
        resolved = true;
      } else {
        const v = { ...acc.vars };
        v[k] = v[k] ? ratAdd(v[k], exp) : exp;
        acc = Object.freeze({ base: acc.base, vars: Object.freeze(v) });
      }
    }
    if (!resolved) return acc;
    cur = acc;
  }
}

// ── extend with occurs check ──────────────────────────────────────

export class UnifyError extends Error {
  constructor(message, span) { super(message); this.name = 'UnifyError'; this.span = span || null; }
}

// Bind α := τ. τ must already be fully-resolved (caller's responsibility:
// apply current subst before calling). Throws UnifyError on occurs.
export function extendTVar(subst, id, type) {
  if (occursTVar(id, type)) {
    throw new UnifyError(`occurs check: 'a${id} appears in its own binding`);
  }
  const newTVars   = new Map();
  const newDimVars = new Map();
  for (const [k, v] of subst.tvars)   newTVars.set(k,   applyType(v, { tvars: new Map([[id, type]]), dimVars: new Map() }));
  for (const [k, v] of subst.dimVars) newDimVars.set(k, v);   // dim-var values don't contain TVars
  newTVars.set(id, type);
  return { tvars: newTVars, dimVars: newDimVars };
}

// Bind $id := dimExpr. dimExpr must already be fully-resolved.
export function extendDimVar(subst, id, dimExpr) {
  if (id in dimExpr.vars) {
    throw new UnifyError(`occurs check: $${id} appears in its own binding`);
  }
  const newDimVars = new Map();
  for (const [k, v] of subst.dimVars) newDimVars.set(k, dimExprSubstVar(v, id, dimExpr));
  newDimVars.set(id, dimExpr);
  const newTVars = new Map();
  for (const [k, v] of subst.tvars)   newTVars.set(k, applyDimVarSubstToType(v, id, dimExpr));
  return { tvars: newTVars, dimVars: newDimVars };
}

function occursTVar(id, t) {
  switch (t.kind) {
    case 'TVar':    return t.id === id;
    case 'TFn':     return t.params.some(p => occursTVar(id, p)) || occursTVar(id, t.result);
    case 'TList':   return occursTVar(id, t.elem);
    case 'TTuple':  return t.elems.some(e => occursTVar(id, e));
    case 'TStruct': for (const k in t.fields) if (occursTVar(id, t.fields[k])) return true; return false;
    default:        return false;
  }
}
