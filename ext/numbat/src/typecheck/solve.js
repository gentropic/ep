// Top-level constraint solver — walks the constraint set from check.js,
// applies unification, and returns (subst, errors). Handles Equal
// directly via unify; defers IsDType and HasField until the relevant
// type is concrete enough to discharge.
//
// IsDType and HasField are simple shape predicates — we keep deferring
// them across passes as long as progress is being made elsewhere. If a
// pass produces no changes and constraints remain, they're unresolvable
// and we surface as errors.

import { applyType, makeSubst, UnifyError, extendTVar } from './subst.js';
import { unify } from './unify.js';
import { tDim, freshTDimVar, dimExprFromVar } from './types.js';
import { formatTypePretty } from './errors.js';

export function solve(constraintSet, opts) {
  const dimAliases = opts?.dimAliases ?? null;
  let subst = makeSubst();
  const errors = [];
  let deferred = constraintSet.items.slice();
  let prevLen = -1;
  let prevSubstSize = -1;

  while (deferred.length > 0) {
    const curSubstSize = subst.tvars.size + subst.dimVars.size;
    // Termination: if no constraints were discharged AND no new subst
    // entries this round, we're stuck.
    if (deferred.length === prevLen && curSubstSize === prevSubstSize) break;
    prevLen = deferred.length;
    prevSubstSize = curSubstSize;

    const next = [];
    for (const c of deferred) {
      try {
        if (c.kind === 'Equal') {
          subst = unify(c.t1, c.t2, subst, c.span, c.context, dimAliases);
        } else if (c.kind === 'IsDType') {
          const r = applyType(c.t, subst);
          if (r.kind === 'TDim') continue;            // satisfied
          if (r.kind === 'TVar') {
            // Promote: this TVar must be a dimension type. Bind it to a
            // fresh TDim wrapping a fresh dim-var. Subsequent uses of the
            // TVar resolve to that TDim; the dim-var stays free until
            // either further constraints pin it or the post-pass
            // generalizes it.
            subst = extendTVar(subst, r.id, tDim(dimExprFromVar(freshTDimVar())));
            continue;
          }
          throw new UnifyError(`expected dimension type, got ${formatTypePretty(r)}`, c.span);
        } else if (c.kind === 'HasField') {
          const r = applyType(c.t, subst);
          if (r.kind === 'TStruct') {
            if (!(c.name in r.fields)) {
              throw new UnifyError(`struct ${r.name}: no field '${c.name}'`, c.span);
            }
            subst = unify(c.fieldType, r.fields[c.name], subst, c.span, c.context, dimAliases);
          } else if (r.kind === 'TVar') {
            next.push(c);
          } else {
            throw new UnifyError(`field access on non-struct: ${formatTypePretty(r)}`, c.span);
          }
        }
      } catch (e) {
        if (e instanceof UnifyError) errors.push({ message: e.message, span: e.span });
        else throw e;
      }
    }
    deferred = next;
  }

  // Any constraints still deferred are genuinely unresolvable.
  for (const c of deferred) {
    errors.push({ message: `unresolvable constraint: ${c.kind}`, span: c.span });
  }

  return { subst, errors };
}
