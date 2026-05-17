// Constraint-generating walker (phase 2 of the typechecker).
//
// `inferExpr(node, env, ctx)` walks an expression AST, returns the inferred
// Type, and side-effects constraints into `ctx.cs`. `checkModule(ast, env)`
// runs the same over a Module's decls, mutating the env to bind names
// (let-decls, fn-decls, dim-decls, unit-decls, struct-decls).
//
// No solving here — the constraint set is handed off to the unifier
// (phase 3). At this stage TVars and TDimVars in the returned types are
// just placeholders awaiting substitution.

import { ratOf, ratAdd, ratSub, ratMul, ratDiv, ratNeg, ratIsZero } from './rat.js';
import { freshTVar, freshTDimVar, tDim, tBool, tString, tFn, tList, tStruct, tTuple, tScheme, T_SCALAR, dimExprEmpty, dimExprFromMap, dimExprFromVar, dimExprMul, dimExprDiv, dimExprPow, formatType } from './types.js';
import { typeEnvExtend, typeEnvBindValue, typeEnvBindFn, typeEnvBindDim, typeEnvBindStruct, typeEnvLookupValue, typeEnvLookupFn, typeEnvLookupDim, typeEnvLookupStruct } from './env.js';
import { cEqual, cIsDType, cHasField, cAdd, makeConstraintSet } from './constraints.js';
import { generalize, instantiate } from './scheme.js';
import { applyType, makeSubst } from './subst.js';

// ── Entry point ───────────────────────────────────────────────────

export function checkModule(ast, env) {
  const ctx = { cs: makeConstraintSet(), errors: [], generics: new Map() };
  for (const decl of ast.decls) {
    try { checkDecl(decl, env, ctx); }
    catch (e) { ctx.errors.push({ message: e.message, span: e.span || null }); }
  }
  return { constraints: ctx.cs, errors: ctx.errors, env };
}

// ── Const evaluator for ^ exponents ───────────────────────────────
//
// Returns a Rat if the expression is a compile-time numeric constant,
// or null otherwise. Supports literal numbers, unary -, and the four
// arithmetic binops between constants. Mirrors the subset of upstream's
// const_evaluation.rs that real Numbat programs actually use.

function tryFoldConst(node) {
  if (!node) return null;
  switch (node.type) {
    case 'Num':    return ratOf(node.value);   // JS numbers truncate to int — fine for typical exponents
    case 'Paren':  return tryFoldConst(node.expr);
    case 'Unary': {
      const r = tryFoldConst(node.expr);
      if (!r) return null;
      return node.op === '-' ? ratNeg(r) : null;
    }
    case 'Binary': {
      const l = tryFoldConst(node.left);
      const r = tryFoldConst(node.right);
      if (!l || !r) return null;
      switch (node.op) {
        case '+': return ratAdd(l, r);
        case '-': return ratSub(l, r);
        case '*': return ratMul(l, r);
        case '/': return r.n === 0 ? null : ratDiv(l, r);
        default: return null;
      }
    }
    default: return null;
  }
}

// ── Type annotation evaluator ─────────────────────────────────────
//
// Walks an annotation AST (same shape as a regular expression, since
// parseTypeExpr just calls parseAddExpr) and returns a Type. In-scope
// generic params resolve to TDimVars via ctx.generics.

function evalTypeAnno(node, env, ctx) {
  if (!node) return T_SCALAR;
  switch (node.type) {
    case 'Paren':   return evalTypeAnno(node.expr, env, ctx);
    case 'TypeApp': return evalTypeApp(node, env, ctx);
    case 'Ident': {
      const name = node.name;
      if (ctx.generics.has(name)) return tDim(dimExprFromVar(ctx.generics.get(name)));
      if (name === 'Scalar')   return T_SCALAR;
      if (name === 'Bool')     return tBool();
      if (name === 'String')   return tString();
      const dim = typeEnvLookupDim(env, name);
      if (dim) return tDim(dimExprFromMap(dim));
      const struct = typeEnvLookupStruct(env, name);
      if (struct) return instantiate(struct);   // generic struct in type position
      throw withSpan(new Error(`unknown type: ${name}`), node.span);
    }
    case 'Num': {
      // Bare 1 in a type position means Scalar — used in `1 / Time`.
      if (node.value === 1) return T_SCALAR;
      throw withSpan(new Error(`numeric literal '${node.value}' in type position (only '1' allowed)`), node.span);
    }
    case 'Binary': {
      const l = evalTypeAnno(node.left, env, ctx);
      if (node.op === '^') {
        const exp = tryFoldConst(node.right);
        if (!exp) throw withSpan(new Error('exponent in type position must be a constant'), node.span);
        if (l.kind !== 'TDim') throw withSpan(new Error(`'^' base must be a dimension type, got ${formatType(l)}`), node.span);
        return tDim(dimExprPow(l.dim, exp));
      }
      const r = evalTypeAnno(node.right, env, ctx);
      if (l.kind !== 'TDim' || r.kind !== 'TDim') {
        throw withSpan(new Error(`type-level '${node.op}' needs dimension operands`), node.span);
      }
      switch (node.op) {
        case '*': return tDim(dimExprMul(l.dim, r.dim));
        case '/': return tDim(dimExprDiv(l.dim, r.dim));
        default:  throw withSpan(new Error(`unsupported operator in type position: ${node.op}`), node.span);
      }
    }
    case 'Unary': {
      if (node.op === '-') {
        const r = tryFoldConst(node);
        if (r) {
          // Negative numbers as exponents are handled in ^ — bare unary
          // minus in a type position doesn't make sense otherwise.
          throw withSpan(new Error('unary minus has no meaning in a type expression'), node.span);
        }
      }
      throw withSpan(new Error(`unsupported unary in type position: ${node.op}`), node.span);
    }
    default:
      throw withSpan(new Error(`unsupported node in type annotation: ${node.type}`), node.span);
  }
}

function withSpan(err, span) { err.span = span || null; return err; }

// TypeApp: `List<D>`, `Box<Length>`, `Pair<Length, Mass>`. Looks up the
// head as a struct/list constructor and substitutes the explicit args
// for the constructor's bound dim-vars. Note: we DON'T call instantiate
// here — the explicit args provide the renaming directly.
function evalTypeApp(node, env, ctx) {
  if (node.base.type !== 'Ident') {
    throw withSpan(new Error('type application head must be a name'), node.span);
  }
  const name = node.base.name;

  if (name === 'List') {
    if (node.args.length !== 1) throw withSpan(new Error(`List takes 1 type arg, got ${node.args.length}`), node.span);
    return tList(evalTypeAnno(node.args[0], env, ctx));
  }

  const scheme = typeEnvLookupStruct(env, name);
  if (scheme && scheme.kind === 'TScheme') {
    if (node.args.length !== scheme.dimVars.length) {
      throw withSpan(new Error(`${name} expects ${scheme.dimVars.length} type args, got ${node.args.length}`), node.span);
    }
    const sub = makeSubst();
    for (let i = 0; i < scheme.dimVars.length; i++) {
      const argT = evalTypeAnno(node.args[i], env, ctx);
      if (argT.kind !== 'TDim') {
        throw withSpan(new Error(`${name} type arg ${i} must be a dimension type, got ${formatType(argT)}`), node.span);
      }
      sub.dimVars.set(scheme.dimVars[i].id, argT.dim);
    }
    return applyType(scheme.body, sub);
  }

  throw withSpan(new Error(`unknown type constructor: ${name}`), node.span);
}

// ── Decl-level checks ─────────────────────────────────────────────

function checkDecl(decl, env, ctx) {
  switch (decl.type) {
    case 'LetDecl':       return checkLetDecl(decl, env, ctx);
    case 'FnDecl':        return checkFnDecl(decl, env, ctx);
    case 'DimensionDecl': return checkDimensionDecl(decl, env, ctx);
    case 'UnitDecl':      return checkUnitDecl(decl, env, ctx);
    case 'StructDecl':    return checkStructDecl(decl, env, ctx);
    case 'UseStmt':       return;  // module-resolution is loader's job; nothing to typecheck
    default:
      // Top-level expression statements (allowed in upstream) — infer + drop.
      if (isExprNode(decl)) { inferExpr(decl, env, ctx); return; }
      throw withSpan(new Error(`unsupported top-level decl: ${decl.type}`), decl.span);
  }
}

function isExprNode(n) {
  switch (n.type) {
    case 'Num': case 'Bool': case 'Str': case 'Ident': case 'Paren':
    case 'Unary': case 'Binary': case 'Call': case 'If': case 'List':
    case 'Field': case 'StructInit': case 'Factorial':
      return true;
    default: return false;
  }
}

function checkLetDecl(decl, env, ctx) {
  const inferred = inferExpr(decl.expr, env, ctx);
  if (decl.dim) {
    const anno = evalTypeAnno(decl.dim, env, ctx);
    cAdd(ctx.cs, cEqual(anno, inferred, decl.expr.span));
    typeEnvBindValue(env, decl.name, anno);   // annotation wins as the declared type
  } else {
    typeEnvBindValue(env, decl.name, inferred);
  }
}

function checkFnDecl(decl, env, ctx) {
  // Generic params bind in a fresh ctx — each call site gets fresh tvars
  // via instantiate() in phase 4. For the body-check we use the generic
  // params directly so the dim-vars line up with the signature.
  const savedGenerics = ctx.generics;
  ctx.generics = new Map(savedGenerics);
  const dimVarsForGenerics = [];
  for (const g of decl.generics || []) {
    if (g.kind !== 'Dim') {
      ctx.generics = savedGenerics;
      throw withSpan(new Error(`generic kind '${g.kind}' not yet supported (only 'Dim')`), decl.span);
    }
    const tdv = freshTDimVar();
    ctx.generics.set(g.name, tdv);
    dimVarsForGenerics.push(tdv);
  }

  // Param types from annotations (or fresh TVar if missing).
  const paramTypes = [];
  for (const p of decl.params) {
    paramTypes.push(p.typeExpr ? evalTypeAnno(p.typeExpr, env, ctx) : freshTVar());
  }
  const returnType = decl.returnType ? evalTypeAnno(decl.returnType, env, ctx) : freshTVar();

  // If body is null, this is an extern decl — nothing to check internally.
  if (decl.body !== null) {
    const bodyEnv = typeEnvExtend(env);
    for (let i = 0; i < decl.params.length; i++) {
      typeEnvBindValue(bodyEnv, decl.params[i].name, paramTypes[i]);
    }
    // where-clauses: evaluate in order, bind each. Each clause can refer
    // to params + prior clauses + the fn body.
    if (decl.whereClauses) {
      for (const w of decl.whereClauses) {
        const t = inferExpr(w.expr, bodyEnv, ctx);
        typeEnvBindValue(bodyEnv, w.name, t);
      }
    }
    const bodyType = inferExpr(decl.body, bodyEnv, ctx);
    cAdd(ctx.cs, cEqual(returnType, bodyType, decl.body.span));
  }

  ctx.generics = savedGenerics;

  // Generalize: the dim-vars introduced for this fn's generics become its
  // scheme binders. Tvars list stays empty — Numbat fn generics are all
  // Dim-kinded; if we ever add non-Dim generics, they'd populate the
  // first slot.
  const fnType = tFn(paramTypes, returnType);
  typeEnvBindFn(env, decl.name, generalize(fnType, [], dimVarsForGenerics));
}

function checkDimensionDecl(decl, env, ctx) {
  // `dimension Foo` → base axis named 'foo' (lowercased to match runtime).
  // `dimension Foo = Length * Mass` → derived dim.
  if (!decl.exprs || decl.exprs.length === 0) {
    typeEnvBindDim(env, decl.name, { [decl.name.toLowerCase()]: 1 });
    return;
  }
  // Each entry is an alternative definition (upstream allows several for
  // consistency-check) — we just take the first.
  const e = decl.exprs[0];
  const t = evalTypeAnno(e, env, ctx);
  if (t.kind !== 'TDim') throw withSpan(new Error(`dimension RHS must be a dim expression`), decl.span);
  // Reduce to integer DimMap (annotation should resolve to a concrete
  // integer-exponent dim).
  const dm = dimExprToMap(t.dim, decl.span);
  typeEnvBindDim(env, decl.name, dm);
}

function dimExprToMap(d, span) {
  if (Object.keys(d.vars).length) {
    throw withSpan(new Error(`dimension definition must not contain type variables`), span);
  }
  const out = {};
  for (const k in d.base) {
    const r = d.base[k];
    if (r.d !== 1) throw withSpan(new Error(`dimension exponent must be an integer, got ${r.n}/${r.d}`), span);
    out[k] = r.n;
  }
  return out;
}

function checkUnitDecl(decl, env, ctx) {
  // For typecheck purposes a unit's dim is what matters. Two forms:
  //   `unit name: DimExpr` — dim from annotation
  //   `unit name = ValueExpr` — dim from inferring the value
  let dim;
  if (decl.dim) {
    const t = evalTypeAnno(decl.dim, env, ctx);
    if (t.kind !== 'TDim') throw withSpan(new Error(`unit annotation must be a dim type`), decl.span);
    dim = dimExprToMap(t.dim, decl.span);
  } else if (decl.expr) {
    const t = inferExpr(decl.expr, env, ctx);
    if (t.kind !== 'TDim') throw withSpan(new Error(`unit value must be a dim quantity`), decl.span);
    dim = dimExprToMap(t.dim, decl.span);
  } else {
    // `unit name` with no body — a base unit, dim auto-generated.
    dim = { [decl.name]: 1 };
  }
  typeEnvBindValue(env, decl.name, tDim(dimExprFromMap(dim)));
}

function checkStructDecl(decl, env, ctx) {
  // Generic struct: fresh TDimVars for each generic param, exposed in
  // ctx.generics for field-type annotation resolution. Mirrors fn-decl's
  // handling.
  const savedGenerics = ctx.generics;
  ctx.generics = new Map(savedGenerics);
  const dimVarsForGenerics = [];
  for (const g of decl.generics || []) {
    if (g.kind !== 'Dim') {
      ctx.generics = savedGenerics;
      throw withSpan(new Error(`generic kind '${g.kind}' not yet supported (only 'Dim')`), decl.span);
    }
    const tdv = freshTDimVar();
    ctx.generics.set(g.name, tdv);
    dimVarsForGenerics.push(tdv);
  }
  const fields = {};
  for (const f of decl.fields) {
    fields[f.name] = evalTypeAnno(f.type, env, ctx);
  }
  ctx.generics = savedGenerics;
  // Always store as a scheme so lookups are uniform (empty binders for
  // non-generic structs).
  typeEnvBindStruct(env, decl.name, generalize(tStruct(decl.name, fields), [], dimVarsForGenerics));
}

// ── Expression-level inference ────────────────────────────────────

export function inferExpr(node, env, ctx) {
  switch (node.type) {
    case 'Num':       return T_SCALAR;
    case 'Bool':      return tBool();
    case 'Str':       return tString();
    case 'Paren':     return inferExpr(node.expr, env, ctx);
    case 'Ident':     return inferIdent(node, env, ctx);
    case 'Unary':     return inferUnary(node, env, ctx);
    case 'Binary':    return inferBinary(node, env, ctx);
    case 'Call':      return inferCall(node, env, ctx);
    case 'If':        return inferIf(node, env, ctx);
    case 'List':      return inferList(node, env, ctx);
    case 'Field':     return inferField(node, env, ctx);
    case 'StructInit':return inferStructInit(node, env, ctx);
    case 'Factorial': return inferFactorial(node, env, ctx);
    default:
      throw withSpan(new Error(`inferExpr: unsupported node type ${node.type}`), node.span);
  }
}

function inferIdent(node, env, ctx) {
  const v = typeEnvLookupValue(env, node.name);
  if (v) return v;
  const fn = typeEnvLookupFn(env, node.name);
  if (fn) return instantiate(fn);   // higher-order use
  throw withSpan(new Error(`unknown identifier: ${node.name}`), node.span);
}

function inferUnary(node, env, ctx) {
  const inner = inferExpr(node.expr, env, ctx);
  switch (node.op) {
    case '-': {
      cAdd(ctx.cs, cIsDType(inner, node.span));
      return inner;
    }
    case '!': {
      cAdd(ctx.cs, cEqual(inner, tBool(), node.span));
      return tBool();
    }
    default:
      throw withSpan(new Error(`unsupported unary operator: ${node.op}`), node.span);
  }
}

function inferBinary(node, env, ctx) {
  const op = node.op;

  if (op === '&&' || op === '||') {
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, tBool(), node.left.span));
    cAdd(ctx.cs, cEqual(r, tBool(), node.right.span));
    return tBool();
  }

  if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, r, node.span));
    return tBool();
  }

  if (op === '+' || op === '-') {
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cIsDType(l, node.left.span));
    cAdd(ctx.cs, cEqual(l, r, node.span));
    return l;
  }

  if (op === '*' || op === '/') {
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cIsDType(l, node.left.span));
    cAdd(ctx.cs, cIsDType(r, node.right.span));
    if (l.kind === 'TDim' && r.kind === 'TDim') {
      return tDim(op === '*' ? dimExprMul(l.dim, r.dim) : dimExprDiv(l.dim, r.dim));
    }
    // At least one side is a TVar that needs to resolve to a TDim. Phase 3
    // solver handles this; for now we return a fresh dim-var-flavoured TDim
    // so the rest of inference proceeds.
    const tdv = freshTDimVar();
    return tDim(dimExprFromVar(tdv));
  }

  if (op === '^') {
    const l = inferExpr(node.left, env, ctx);
    const exp = tryFoldConst(node.right);
    if (exp) {
      if (l.kind === 'TDim') return tDim(dimExprPow(l.dim, exp));
      // Unresolved base — emit a constraint that it must be a dim, return
      // a fresh dim-var TDim so the surrounding pass can keep walking.
      cAdd(ctx.cs, cIsDType(l, node.left.span));
      const tdv = freshTDimVar();
      return tDim(dimExprFromVar(tdv));
    }
    // Non-const exponent — both base and exp must be Scalar (the only
    // case dimensionally well-defined without static eval).
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, T_SCALAR, node.left.span));
    cAdd(ctx.cs, cEqual(r, T_SCALAR, node.right.span));
    return T_SCALAR;
  }

  if (op === '->') {
    // Conversion: left and right are both dim expressions of the same
    // dim. Result type = left (the value side).
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, r, node.span));
    return l;
  }

  throw withSpan(new Error(`unsupported binary operator: ${op}`), node.span);
}

function inferCall(node, env, ctx) {
  const scheme = typeEnvLookupFn(env, node.name);
  if (!scheme) {
    // Could still be a higher-order call via a value (the AST shape
    // disambiguates Ident-call from value-call upstream, but our parser
    // routes both through Call). Fall back to value lookup.
    const v = typeEnvLookupValue(env, node.name);
    if (v && v.kind === 'TFn') return inferDirectFnCall(v, node, env, ctx);
    throw withSpan(new Error(`unknown function: ${node.name}`), node.span);
  }
  return inferDirectFnCall(instantiate(scheme), node, env, ctx);
}

function inferDirectFnCall(fnT, node, env, ctx) {
  if (fnT.kind !== 'TFn') throw withSpan(new Error(`call target is not a function: ${formatType(fnT)}`), node.span);
  if (fnT.params.length !== node.args.length) {
    throw withSpan(new Error(`${node.name}: expected ${fnT.params.length} args, got ${node.args.length}`), node.span);
  }
  for (let i = 0; i < node.args.length; i++) {
    const argT = inferExpr(node.args[i], env, ctx);
    cAdd(ctx.cs, cEqual(fnT.params[i], argT, node.args[i].span));
  }
  return fnT.result;
}

function inferIf(node, env, ctx) {
  const c = inferExpr(node.cond, env, ctx);
  cAdd(ctx.cs, cEqual(c, tBool(), node.cond.span));
  const t = inferExpr(node.then,  env, ctx);
  const e = inferExpr(node.else,  env, ctx);
  cAdd(ctx.cs, cEqual(t, e, node.span));
  return t;
}

function inferList(node, env, ctx) {
  if (node.items.length === 0) return tList(freshTVar());
  const first = inferExpr(node.items[0], env, ctx);
  for (let i = 1; i < node.items.length; i++) {
    const ti = inferExpr(node.items[i], env, ctx);
    cAdd(ctx.cs, cEqual(first, ti, node.items[i].span));
  }
  return tList(first);
}

function inferField(node, env, ctx) {
  const objT = inferExpr(node.obj, env, ctx);
  if (objT.kind === 'TStruct') {
    if (!(node.name in objT.fields)) {
      throw withSpan(new Error(`struct ${objT.name} has no field '${node.name}'`), node.span);
    }
    return objT.fields[node.name];
  }
  // Polymorphic case: emit HasField, return a fresh tvar that the solver
  // will tie to the actual field type.
  const ft = freshTVar();
  cAdd(ctx.cs, cHasField(objT, node.name, ft, node.span));
  return ft;
}

function inferStructInit(node, env, ctx) {
  const scheme = typeEnvLookupStruct(env, node.name);
  if (!scheme) throw withSpan(new Error(`unknown struct: ${node.name}`), node.span);
  // Instantiate at each use — fresh dim-vars per construction site so
  // separate `Pair { ... }` exprs don't accidentally share generics.
  const s = instantiate(scheme);
  const seen = new Set();
  for (const f of node.fields) {
    if (!(f.name in s.fields)) throw withSpan(new Error(`struct ${node.name} has no field '${f.name}'`), node.span);
    seen.add(f.name);
    const fT = inferExpr(f.value, env, ctx);
    cAdd(ctx.cs, cEqual(s.fields[f.name], fT, f.value.span));
  }
  for (const k in s.fields) {
    if (!seen.has(k)) throw withSpan(new Error(`struct ${node.name} missing field '${k}'`), node.span);
  }
  return s;
}

function inferFactorial(node, env, ctx) {
  const t = inferExpr(node.expr, env, ctx);
  cAdd(ctx.cs, cEqual(t, T_SCALAR, node.expr.span));
  return T_SCALAR;
}
