// Main unifier — `unify(t1, t2, subst) → subst'`.
//
// Cases:
//   - typeEq after applying current subst → subst unchanged
//   - TVar on either side → bind (occurs check)
//   - TDim ~ TDim → delegate to dim solver
//   - TFn ~ TFn (same arity) → unify each param + result
//   - TList ~ TList → unify elem
//   - TTuple ~ TTuple (same arity) → unify each
//   - TStruct ~ TStruct (same name) → unify each field
//   - TBool / TString / TNever ~ self → trivial
//   - anything else → throw UnifyError
//
// Throws UnifyError with the constraint's source span attached so
// phase-5 error reporting can point at the right line.

import { typeEq } from './types.js';
import { applyType, extendTVar, UnifyError } from './subst.js';
import { solveDimEq } from './dim-solve.js';
import { formatTypePretty } from './errors.js';

export function unify(t1, t2, subst, span) {
  const a = applyType(t1, subst);
  const b = applyType(t2, subst);
  if (typeEq(a, b)) return subst;

  if (a.kind === 'TVar') return extendTVar(subst, a.id, b);
  if (b.kind === 'TVar') return extendTVar(subst, b.id, a);

  if (a.kind === 'TDim' && b.kind === 'TDim') {
    return solveDimEq(a.dim, b.dim, subst, span);
  }

  if (a.kind === 'TFn' && b.kind === 'TFn') {
    if (a.params.length !== b.params.length) {
      throw new UnifyError(`function arity mismatch: expected ${a.params.length}, got ${b.params.length}`, span);
    }
    let s = subst;
    for (let i = 0; i < a.params.length; i++) s = unify(a.params[i], b.params[i], s, span);
    return unify(a.result, b.result, s, span);
  }

  if (a.kind === 'TList' && b.kind === 'TList') {
    return unify(a.elem, b.elem, subst, span);
  }

  if (a.kind === 'TTuple' && b.kind === 'TTuple') {
    if (a.elems.length !== b.elems.length) {
      throw new UnifyError(`tuple arity mismatch: expected ${a.elems.length}, got ${b.elems.length}`, span);
    }
    let s = subst;
    for (let i = 0; i < a.elems.length; i++) s = unify(a.elems[i], b.elems[i], s, span);
    return s;
  }

  if (a.kind === 'TStruct' && b.kind === 'TStruct') {
    if (a.name !== b.name) throw new UnifyError(`struct mismatch: ${a.name} vs ${b.name}`, span);
    let s = subst;
    for (const k in a.fields) {
      if (!(k in b.fields)) throw new UnifyError(`struct ${a.name}: field ${k} missing on other side`, span);
      s = unify(a.fields[k], b.fields[k], s, span);
    }
    return s;
  }

  throw new UnifyError(`cannot unify ${formatTypePretty(a)} with ${formatTypePretty(b)}`, span);
}
