// Polymorphism — TScheme construction (generalize) and use (instantiate).
//
// A TScheme is `∀(tvars, dimVars). body` — the body is a Type that may
// reference the bound vars. instantiate() makes fresh vars at each use
// site so two calls to the same generic fn don't accidentally share
// dim-var ids. generalize() packages a body + explicit binder list into
// a scheme — used by check.js when finalizing a fn-decl or struct-decl.
//
// `generalize` takes explicit binders here (rather than computing free
// vars and subtracting the env's free set) because Numbat requires
// explicit generic params on fn-decls — there's no inferred polymorphism
// for un-annotated fns the way ML/Haskell have.

import { tScheme, freshTVar, freshTDimVar, dimExprFromVar } from './types.js';
import { applyType, makeSubst } from './subst.js';

// Wrap (body, tvars, dimVars) into a scheme. Body is taken as-is — the
// caller is responsible for applying any pending substitution first.
export function generalize(body, tvars, dimVars) {
  return tScheme(tvars, dimVars, body);
}

// Replace scheme's bound vars with fresh ones, return the renamed body.
// Non-scheme inputs pass through (useful where env.fns is consulted but
// the entry might not be a scheme yet during partial construction).
export function instantiate(scheme) {
  if (scheme.kind !== 'TScheme') return scheme;
  // Prefer scheme.binders for ordered walks; fall back to tvars+dimVars
  // for legacy callers that construct schemes by hand (older tests).
  const binders = scheme.binders ?? [
    ...scheme.dimVars.map(v => ({ kind: 'D', var: v })),
    ...scheme.tvars.map(v   => ({ kind: 'T', var: v })),
  ];
  if (binders.length === 0) return scheme.body;

  const sub = makeSubst();
  for (const b of binders) {
    if (b.kind === 'T') sub.tvars.set(b.var.id, freshTVar());
    else                sub.dimVars.set(b.var.id, dimExprFromVar(freshTDimVar()));
  }
  return applyType(scheme.body, sub);
}
