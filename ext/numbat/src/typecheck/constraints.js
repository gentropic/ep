// Constraint set for the typechecker.
//
// Constraints accumulate during the inference walk (check.js) and are
// discharged by the solver (dim-solve.js + unify.js). Spans flow through
// so phase-5 error reporting can point at the right source location.
//
// Four constraint kinds, matching upstream's:
//   Equal(t1, t2)      — classical unification: t1 ≡ t2
//   IsDType(t)         — t must be a dimension type
//   HasField(t, n, ft) — t must be a struct with field n having type ft
//   (EqualScalar omitted: it's just Equal(t, T_SCALAR))

export function cEqual(t1, t2, span, context)        { return Object.freeze({ kind: 'Equal',    t1, t2, span: span || null, context: context || null }); }
export function cIsDType(t, span, context)           { return Object.freeze({ kind: 'IsDType',  t,      span: span || null, context: context || null }); }
export function cHasField(t, name, ft, span, context){ return Object.freeze({ kind: 'HasField', t, name, fieldType: ft, span: span || null, context: context || null }); }

export function makeConstraintSet() { return { items: [] }; }
export function cAdd(cs, c)         { cs.items.push(c); return cs; }
export function cAll(cs, list)      { for (const c of list) cs.items.push(c); return cs; }
