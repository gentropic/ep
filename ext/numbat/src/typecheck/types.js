// Type representation for the typechecker.
//
// Tag-discriminated frozen objects, no classes — so structural equality
// works via deep-compare and JSON.stringify gives a usable debug print.
//
// Two var spaces:
//   TVar    — ordinary type variables (Bool/String/Fn/Struct/List polymorphism)
//   TDimVar — dim-level variables (participate in multiplicative dim arithmetic)
// Mixing them in one space makes the dim solver harder. Upstream splits the
// same way (Type::TVar vs DType::TypeVariable).

import { ratOf, ratIsZero, ratEq, ratFormat, ratAdd, ratSub, ratNeg, ratMul, RAT_ZERO } from './rat.js';

let _nextTVar    = 0;
let _nextTDimVar = 0;

export function freshTVar()    { return { kind: 'TVar',    id: _nextTVar++ }; }
export function freshTDimVar() { return { kind: 'TDimVar', id: _nextTDimVar++ }; }

// Test-only — reset id counters so test runs are reproducible.
export function resetTypeIds() { _nextTVar = 0; _nextTDimVar = 0; }

// ── DimExpr ───────────────────────────────────────────────────────
//
// A dim expression at typecheck time: a product of base-dim powers and
// dim-var powers. Stored as two sparse maps with rational exponents.
//
//   { base: { length: Rat, mass: Rat, ... },
//     vars: { 0: Rat, 1: Rat, ... } }       // keys are TDimVar ids
//
// Identity (dimensionless / scalar) is `{ base: {}, vars: {} }`.
// Concrete runtime dims (from dimensions.js) lift in via dimExprFromMap —
// all integer denominators, no vars.

function freezeDimExpr(base, vars) {
  return Object.freeze({ base: Object.freeze(base), vars: Object.freeze(vars) });
}

export function dimExprEmpty() { return freezeDimExpr({}, {}); }

export function dimExprFromMap(dimMap) {
  const base = {};
  for (const k in dimMap) {
    if (dimMap[k] !== 0) base[k] = ratOf(dimMap[k]);
  }
  return freezeDimExpr(base, {});
}

export function dimExprFromVar(tdvar) {
  return freezeDimExpr({}, { [tdvar.id]: ratOf(1) });
}

function ratMapEq(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const ra = a[k]; const rb = b[k];
    if (!ra) { if (!ratIsZero(rb)) return false; continue; }
    if (!rb) { if (!ratIsZero(ra)) return false; continue; }
    if (!ratEq(ra, rb)) return false;
  }
  return true;
}

export function dimExprEq(a, b) {
  return ratMapEq(a.base, b.base) && ratMapEq(a.vars, b.vars);
}

export function dimExprIsConcrete(d) { return Object.keys(d.vars).length === 0; }
export function dimExprIsScalar(d) {
  for (const k in d.base) if (!ratIsZero(d.base[k])) return false;
  for (const k in d.vars) if (!ratIsZero(d.vars[k])) return false;
  return true;
}

// ── DimExpr arithmetic (multiplicative) ───────────────────────────
//
// Shared by check.js (constraint generation), subst.js (substitution
// composition), and dim-solve.js (the dim equation solver). Lives here
// so the flat-scope build doesn't see duplicate helpers.

function cleanDimExprFor(base, vars) {
  const b = {};
  for (const k in base) if (!ratIsZero(base[k])) b[k] = base[k];
  const v = {};
  for (const k in vars) if (!ratIsZero(vars[k])) v[k] = vars[k];
  return freezeDimExpr(b, v);
}

export function dimExprMul(a, b) {
  const base = { ...a.base };
  for (const k in b.base) base[k] = base[k] ? ratAdd(base[k], b.base[k]) : b.base[k];
  const vars = { ...a.vars };
  for (const k in b.vars) vars[k] = vars[k] ? ratAdd(vars[k], b.vars[k]) : b.vars[k];
  return cleanDimExprFor(base, vars);
}

export function dimExprDiv(a, b) {
  const base = { ...a.base };
  for (const k in b.base) base[k] = base[k] ? ratSub(base[k], b.base[k]) : ratNeg(b.base[k]);
  const vars = { ...a.vars };
  for (const k in b.vars) vars[k] = vars[k] ? ratSub(vars[k], b.vars[k]) : ratNeg(b.vars[k]);
  return cleanDimExprFor(base, vars);
}

export function dimExprPow(d, r) {
  if (ratIsZero(r)) return dimExprEmpty();
  const base = {};
  for (const k in d.base) base[k] = ratMul(d.base[k], r);
  const vars = {};
  for (const k in d.vars) vars[k] = ratMul(d.vars[k], r);
  return cleanDimExprFor(base, vars);
}

// Inverse-substitute one dim-var inside a DimExpr (var `id` → `repl`).
// Used when extending the substitution with a new dim-var binding so
// previously-stored values get the new resolution.
export function dimExprSubstVar(d, id, repl) {
  if (!(id in d.vars)) return d;
  const exp = d.vars[id];
  const v = { ...d.vars }; delete v[id];
  const stripped = freezeDimExpr({ ...d.base }, v);
  return dimExprMul(stripped, dimExprPow(repl, exp));
}

export function dimExprFormat(d) {
  const parts = [];
  for (const k in d.base) {
    const r = d.base[k];
    if (ratIsZero(r)) continue;
    parts.push(r.n === 1 && r.d === 1 ? k : `${k}^${ratFormat(r)}`);
  }
  for (const k in d.vars) {
    const r = d.vars[k];
    if (ratIsZero(r)) continue;
    const name = `$${k}`;
    parts.push(r.n === 1 && r.d === 1 ? name : `${name}^${ratFormat(r)}`);
  }
  return parts.join('·') || '-';
}

// ── Type constructors ─────────────────────────────────────────────

export function tVar(id)                   { return Object.freeze({ kind: 'TVar', id }); }
export function tDimVar(id)                { return Object.freeze({ kind: 'TDimVar', id }); }
export function tDim(dimExpr)              { return Object.freeze({ kind: 'TDim', dim: dimExpr }); }
export function tBool()                    { return T_BOOL; }
export function tString()                  { return T_STRING; }
export function tNever()                   { return T_NEVER; }
export function tFn(params, result)        { return Object.freeze({ kind: 'TFn', params: Object.freeze([...params]), result }); }
export function tList(elem)                { return Object.freeze({ kind: 'TList', elem }); }
export function tStruct(name, fields)      { return Object.freeze({ kind: 'TStruct', name, fields: Object.freeze({ ...fields }) }); }
export function tTuple(elems)              { return Object.freeze({ kind: 'TTuple', elems: Object.freeze([...elems]) }); }

// A type scheme is ∀(tvars, dimVars). body — used for generic fn signatures.
//
//   fn id<D>(x: D) -> D
// becomes
//   tScheme([], [d0], tFn([tDim(dimExprFromVar(d0))], tDim(dimExprFromVar(d0))))
export function tScheme(tvars, dimVars, body) {
  return Object.freeze({ kind: 'TScheme', tvars: Object.freeze([...tvars]), dimVars: Object.freeze([...dimVars]), body });
}

const T_BOOL   = Object.freeze({ kind: 'TBool' });
const T_STRING = Object.freeze({ kind: 'TString' });
const T_NEVER  = Object.freeze({ kind: 'TNever' });

export const T_SCALAR = tDim(dimExprEmpty());

// ── Closed-type equality + formatting ─────────────────────────────
//
// Structural eq for types with NO free vars. Open types (containing TVar
// or TDimVar without substitution) are unifier territory — use unify().

export function typeEq(a, b) {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'TBool':
    case 'TString':
    case 'TNever':
      return true;
    case 'TVar':
    case 'TDimVar':
      return a.id === b.id;
    case 'TDim':
      return dimExprEq(a.dim, b.dim);
    case 'TFn':
      if (a.params.length !== b.params.length) return false;
      for (let i = 0; i < a.params.length; i++) if (!typeEq(a.params[i], b.params[i])) return false;
      return typeEq(a.result, b.result);
    case 'TList':
      return typeEq(a.elem, b.elem);
    case 'TTuple':
      if (a.elems.length !== b.elems.length) return false;
      for (let i = 0; i < a.elems.length; i++) if (!typeEq(a.elems[i], b.elems[i])) return false;
      return true;
    case 'TStruct': {
      if (a.name !== b.name) return false;
      const ak = Object.keys(a.fields).sort();
      const bk = Object.keys(b.fields).sort();
      if (ak.length !== bk.length) return false;
      for (let i = 0; i < ak.length; i++) {
        if (ak[i] !== bk[i]) return false;
        if (!typeEq(a.fields[ak[i]], b.fields[bk[i]])) return false;
      }
      return true;
    }
    case 'TScheme':
      if (a.tvars.length !== b.tvars.length) return false;
      if (a.dimVars.length !== b.dimVars.length) return false;
      return typeEq(a.body, b.body);
    default:
      throw new Error(`typeEq: unknown kind ${a.kind}`);
  }
}

export function formatType(t) {
  switch (t.kind) {
    case 'TBool':   return 'Bool';
    case 'TString': return 'String';
    case 'TNever':  return '!';
    case 'TVar':    return `'a${t.id}`;
    case 'TDimVar': return `$${t.id}`;
    case 'TDim':    return dimExprIsScalar(t.dim) ? 'Scalar' : dimExprFormat(t.dim);
    case 'TFn':     return `(${t.params.map(formatType).join(', ')}) -> ${formatType(t.result)}`;
    case 'TList':   return `List<${formatType(t.elem)}>`;
    case 'TTuple':  return `(${t.elems.map(formatType).join(', ')})`;
    case 'TStruct': return t.name;
    case 'TScheme': {
      const binders = [
        ...t.tvars.map(v => `'a${v.id ?? v}`),
        ...t.dimVars.map(v => `$${v.id ?? v}`),
      ].join(', ');
      return binders.length ? `∀(${binders}). ${formatType(t.body)}` : formatType(t.body);
    }
    default: return `<unknown ${t.kind}>`;
  }
}

// Walk a type and collect free TVar ids and free TDimVar ids. "Free" here
// means "appears anywhere" — TScheme binders are NOT subtracted; callers
// that need scheme-aware freevars handle it themselves.
export function freeVars(t, acc = { tvars: new Set(), dimVars: new Set() }) {
  switch (t.kind) {
    case 'TVar':    acc.tvars.add(t.id); break;
    case 'TDimVar': acc.dimVars.add(t.id); break;
    case 'TDim':    for (const k in t.dim.vars) acc.dimVars.add(Number(k)); break;
    case 'TFn':     for (const p of t.params) freeVars(p, acc); freeVars(t.result, acc); break;
    case 'TList':   freeVars(t.elem, acc); break;
    case 'TTuple':  for (const e of t.elems) freeVars(e, acc); break;
    case 'TStruct': for (const k in t.fields) freeVars(t.fields[k], acc); break;
    case 'TScheme': freeVars(t.body, acc); break;
    case 'TBool': case 'TString': case 'TNever': break;
  }
  return acc;
}
