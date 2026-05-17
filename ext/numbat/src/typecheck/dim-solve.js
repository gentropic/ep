// Dim-equation solver.
//
// Given a constraint `TDim(a) ~ TDim(b)`, find a substitution σ such that
// σ(a) = σ(b) as dim expressions. We work incrementally — each call
// extends the substitution by one variable binding (or by zero if the
// constraint is already satisfied) and returns the new substitution.
//
// Incremental form (rather than batched matrix reduction): every dim
// constraint is `a · b⁻¹ = 1`. After resolving with the current subst:
//
//   - If c = a·b⁻¹ has no dim-vars, its base part must be all-zero
//     (else it's a hard dim mismatch).
//   - If c has dim-vars, pick one ($k with coefficient e) and solve:
//       $k = (c without $k) raised to (-1/e)
//     Extend the subst with that binding.
//
// Rational exponents throughout — the solver handles `sqrt`-style ops
// correctly (`Length^(1/2) = D` → D := Length^(1/2)).

import { ratOf, ratDiv } from './rat.js';
import { applyDimExpr, extendDimVar, UnifyError } from './subst.js';
import { dimExprFormat, dimExprDiv, dimExprPow, dimExprIsScalar } from './types.js';

export function solveDimEq(a, b, subst, span) {
  const aR = applyDimExpr(a, subst);
  const bR = applyDimExpr(b, subst);
  const c  = dimExprDiv(aR, bR);

  // No vars to bind — the equation must already hold.
  if (Object.keys(c.vars).length === 0) {
    if (dimExprIsScalar(c)) return subst;
    throw new UnifyError(`dimension mismatch: ${dimExprFormat(aR)} != ${dimExprFormat(bR)}`, span);
  }

  // Pick a var to solve for. Heuristic: prefer the one whose coefficient
  // is ±1 (clean substitution); fall back to first.
  const varIds = Object.keys(c.vars).map(Number);
  let pickId = varIds[0];
  for (const id of varIds) {
    const r = c.vars[id];
    if (r.d === 1 && (r.n === 1 || r.n === -1)) { pickId = id; break; }
  }
  const coef = c.vars[pickId];

  // Build "c without pickId", negate, then raise to 1/coef → the solution.
  const restVars = { ...c.vars };
  delete restVars[pickId];
  const rest = Object.freeze({ base: Object.freeze({ ...c.base }), vars: Object.freeze(restVars) });
  // pickId^coef · rest = 1  →  pickId = rest^(-1/coef)
  const negInvCoef = ratDiv(ratOf(-1), coef);
  const solution   = dimExprPow(rest, negInvCoef);

  return extendDimVar(subst, pickId, solution);
}
