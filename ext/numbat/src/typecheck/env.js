// Typed environment for the typechecker.
//
// Parallel to load.js's value env. Walks a parent chain on lookup; new
// scopes are child envs that shadow the parent. Immutable from the
// caller's view — operations return new envs rather than mutating.
//
// Four slots, mirroring the runtime env shape so the two stay in sync:
//   values   — identifier → Type    (let-bindings, fn params in scope)
//   fns      — fn-name    → TScheme (always a scheme; monomorphic fns
//                                    are just schemes with no binders)
//   dims     — dim-name   → DimMap  (`Length` → {length:1}, etc.)
//   structs  — name       → TStruct

export function makeTypeEnv() {
  return {
    parent:  null,
    values:  new Map(),
    fns:     new Map(),
    dims:    new Map(),
    structs: new Map(),
  };
}

export function typeEnvExtend(parent) {
  return {
    parent,
    values:  new Map(),
    fns:     new Map(),
    dims:    new Map(),
    structs: new Map(),
  };
}

function lookupIn(env, slot, name) {
  let e = env;
  while (e) {
    const v = e[slot].get(name);
    if (v !== undefined) return v;
    e = e.parent;
  }
  return undefined;
}

export function typeEnvLookupValue(env, name)  { return lookupIn(env, 'values',  name); }
export function typeEnvLookupFn(env, name)     { return lookupIn(env, 'fns',     name); }
export function typeEnvLookupDim(env, name)    { return lookupIn(env, 'dims',    name); }
export function typeEnvLookupStruct(env, name) { return lookupIn(env, 'structs', name); }

export function typeEnvBindValue(env, name, type)    { env.values.set(name,  type);   return env; }
export function typeEnvBindFn(env, name, scheme)     { env.fns.set(name,     scheme); return env; }
export function typeEnvBindDim(env, name, dim)       { env.dims.set(name,    dim);    return env; }
export function typeEnvBindStruct(env, name, struct) { env.structs.set(name, struct); return env; }

// Collect free TVar/TDimVar ids that appear in any binding in this env
// (and its parents). Used by generalize() to know which vars are
// "captured" by the outer scope and therefore must NOT be generalized at
// the current fn boundary. Implementation comes in scheme.js; this is the
// hook so callers don't need to know the env shape.
export function envFreeVars(env, collect) {
  let e = env;
  while (e) {
    for (const t of e.values.values()) collect(t);
    for (const s of e.fns.values())    collect(s);
    e = e.parent;
  }
}
