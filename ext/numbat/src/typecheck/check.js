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
import { didYouMeanSuffix } from './errors.js';

// Collect candidate names from an env (values + fns + dims + structs)
// and any in-scope generic params. Used by did-you-mean suggestions.
function envCandidates(env, ctx) {
  const out = new Set();
  for (let e = env; e; e = e.parent) {
    for (const k of e.values.keys())  out.add(k);
    for (const k of e.fns.keys())     out.add(k);
    for (const k of e.dims.keys())    out.add(k);
    for (const k of e.structs.keys()) out.add(k);
  }
  if (ctx?.generics) for (const k of ctx.generics.keys()) out.add(k);
  return [...out];
}

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

// Detects expressions that are statically zero — used by the polymorphic-
// zero rule for + and -. Recognizes the literal `0`, parenthesized
// zeros, unary `-0`, zero multiplied by anything (0 propagates through
// `*`), and zero divided by anything (0/x = 0 when x ≠ 0).
function isStaticZero(node) {
  if (!node) return false;
  switch (node.type) {
    case 'Num':       return node.value === 0;
    case 'Paren':     return isStaticZero(node.expr);
    case 'Unary':     return node.op === '-' && isStaticZero(node.expr);
    case 'Binary':
      if (node.op === '*') return isStaticZero(node.left) || isStaticZero(node.right);
      if (node.op === '/') return isStaticZero(node.left);
      if (node.op === '+' || node.op === '-')
        return isStaticZero(node.left) && isStaticZero(node.right);
      return false;
    default: return false;
  }
}

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
        case '^': {
          // Integer exponent only — fractional powers on rationals
          // (e.g. (1/2)^(1/3)) need real-number exponentiation we don't
          // want to muddle exact arithmetic with.
          if (r.d !== 1) return null;
          let acc = ratOf(1);
          const e = Math.abs(r.n);
          for (let i = 0; i < e; i++) acc = ratMul(acc, l);
          return r.n < 0 ? ratDiv(ratOf(1), acc) : acc;
        }
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
    case 'Paren':       return evalTypeAnno(node.expr, env, ctx);
    case 'TypeApp':     return evalTypeApp(node, env, ctx);
    case 'FnTypeAnno': {
      // `Fn[(A, B) -> C]` annotation: build a TFn directly.
      const params = node.params.map(p => evalTypeAnno(p, env, ctx));
      const result = evalTypeAnno(node.result, env, ctx);
      return tFn(params, result);
    }
    case 'Ident': {
      const name = node.name;
      if (ctx.generics.has(name)) {
        const entry = ctx.generics.get(name);
        // Dim-kinded generics (explicit `<T: Dim>`) wrap directly as
        // TDim. Type-kinded generics (default `<T>`) return the bare
        // TVar; promotion to TDim happens lazily in dim-arithmetic
        // positions below via Equal constraints.
        return entry.kind === 'D' ? tDim(dimExprFromVar(entry.var)) : entry.var;
      }
      if (name === 'Scalar')   return T_SCALAR;
      if (name === 'Bool')     return tBool();
      if (name === 'String')   return tString();
      const dim = typeEnvLookupDim(env, name);
      if (dim) return tDim(dimExprFromMap(dim));
      const struct = typeEnvLookupStruct(env, name);
      if (struct) {
        // Generic struct referenced without `<...>` is an error — matches
        // upstream's strict arity check. Non-generic structs (binders=[])
        // pass through.
        const binders = struct.kind === 'TScheme' ? (struct.binders ?? []) : [];
        if (binders.length > 0) {
          throw withSpan(new Error(`${name} expects ${binders.length} type args, got 0`), node.span);
        }
        return instantiate(struct);
      }
      throw withSpan(new Error(`unknown type: ${name}${didYouMeanSuffix(name, envCandidates(env, ctx))}`), node.span);
    }
    case 'Num': {
      // Bare 1 in a type position means Scalar — used in `1 / Time`.
      if (node.value === 1) return T_SCALAR;
      throw withSpan(new Error(`numeric literal '${node.value}' in type position (only '1' allowed)`), node.span);
    }
    case 'Binary': {
      const l = evalTypeAnno(node.left, env, ctx);
      // Helper: turn a Type-kinded TVar operand into a TDim by allocating
      // a fresh dim-var and emitting a constraint that ties them. Returns
      // the operand's dim expression to use in arithmetic.
      const asDim = (t, side) => {
        if (t.kind === 'TDim') return t.dim;
        if (t.kind === 'TVar') {
          const dv = freshTDimVar();
          const dvDim = dimExprFromVar(dv);
          cAdd(ctx.cs, cEqual(t, tDim(dvDim), spanOf(side)));
          return dvDim;
        }
        throw withSpan(new Error(`type-level '${node.op}' needs dimension operand, got ${formatType(t)}`), node.span);
      };
      if (node.op === '^') {
        const exp = tryFoldConst(node.right);
        if (!exp) throw withSpan(new Error('exponent in type position must be a constant'), node.span);
        const lDim = asDim(l, node.left);
        return tDim(dimExprPow(lDim, exp));
      }
      const r = evalTypeAnno(node.right, env, ctx);
      const lDim = asDim(l, node.left);
      const rDim = asDim(r, node.right);
      switch (node.op) {
        case '*': return tDim(dimExprMul(lDim, rDim));
        case '/': return tDim(dimExprDiv(lDim, rDim));
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

// Best-effort span lookup. The parser attaches `.span` to Ident, Call,
// StructInit, List, and a few decl-level nodes — but not to Binary,
// Unary, If, or Paren. For those, fall back to the leftmost
// span-carrying child so error messages still point at *some* spot in
// the source.
function spanOf(node) {
  if (!node) return null;
  if (node.span) return node.span;
  switch (node.type) {
    case 'Binary':    return spanOf(node.left) || spanOf(node.right);
    case 'Unary':     return spanOf(node.expr);
    case 'Paren':     return spanOf(node.expr);
    case 'Factorial': return spanOf(node.expr);
    case 'If':        return spanOf(node.cond) || spanOf(node.then) || spanOf(node.else);
    case 'Field':     return spanOf(node.obj);
    case 'TypeApp':   return spanOf(node.base);
    default:          return null;
  }
}

// Public for the integration layer, which uses it to lift already-
// loaded user fn/struct declarations from the runtime env.
export { evalTypeAnno };

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
    const arity = scheme.binders.length;
    if (node.args.length !== arity) {
      throw withSpan(new Error(`${name} expects ${arity} type args, got ${node.args.length}`), node.span);
    }
    const sub = makeSubst();
    for (let i = 0; i < arity; i++) {
      const b = scheme.binders[i];
      const argT = evalTypeAnno(node.args[i], env, ctx);
      if (b.kind === 'T') {
        // Type-kinded binder: accept any type.
        sub.tvars.set(b.var.id, argT);
      } else {
        // Dim-kinded binder: require TDim and substitute its dim expr.
        if (argT.kind !== 'TDim') {
          throw withSpan(new Error(`${name} type arg ${i} must be a dimension type, got ${formatType(argT)}`), node.span);
        }
        sub.dimVars.set(b.var.id, argT.dim);
      }
    }
    return applyType(scheme.body, sub);
  }

  throw withSpan(new Error(`unknown type constructor: ${name}`), node.span);
}

// ── Decl-level checks ─────────────────────────────────────────────

export function checkDecl(decl, env, ctx) {
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
    case 'Field': case 'StructInit': case 'Factorial': case 'Where':
      return true;
    default: return false;
  }
}

function checkLetDecl(decl, env, ctx) {
  const inferred = inferExpr(decl.expr, env, ctx);
  if (decl.dim) {
    const anno = evalTypeAnno(decl.dim, env, ctx);
    cAdd(ctx.cs, cEqual(anno, inferred, spanOf(decl.expr)));
    typeEnvBindValue(env, decl.name, anno);   // annotation wins as the declared type
  } else {
    typeEnvBindValue(env, decl.name, inferred);
  }
}

function checkFnDecl(decl, env, ctx) {
  // Extern fn (no body) must have an annotated return type. Without it
  // the type would be polymorphic in a vacuous way and the runtime
  // dispatcher couldn't validate calls. Matches upstream.
  if (decl.body === null && decl.returnType === null) {
    throw withSpan(new Error(`extern fn '${decl.name}' needs a return type annotation`), decl.span);
  }
  // Name-clash: fn names mustn't collide with let-bound values, dim
  // names, or struct names. Multiple fn overloads with the same name
  // are also rejected (we don't have overload resolution).
  assertNameAvailable(decl.name, env, ctx, decl.span, 'fn');
  // Generic params bind in a fresh ctx — each call site gets fresh tvars
  // via instantiate() in phase 4. For the body-check we use the generic
  // params directly so the dim-vars line up with the signature.
  const savedGenerics = ctx.generics;
  ctx.generics = new Map(savedGenerics);
  // Track binders in declaration order (matters for application-site
  // positional args). Each entry is {kind: 'T'|'D', var, name}.
  const declBinders = [];
  for (const g of decl.generics || []) {
    if (g.kind === 'Dim') {
      const tdv = freshTDimVar();
      ctx.generics.set(g.name, { kind: 'D', var: tdv });
      declBinders.push({ kind: 'D', var: tdv, name: g.name });
    } else {
      // Default ('Type') or any other annotation: unrestricted TVar.
      // Promotion to TDim happens lazily via Equal constraints when the
      // generic is used in a dim-arithmetic position.
      const tv = freshTVar();
      ctx.generics.set(g.name, { kind: 'T', var: tv });
      declBinders.push({ kind: 'T', var: tv, name: g.name });
    }
  }

  // Param types from annotations (or fresh TVar if missing).
  const paramTypes = [];
  for (const p of decl.params) {
    paramTypes.push(p.typeExpr ? evalTypeAnno(p.typeExpr, env, ctx) : freshTVar());
  }
  const returnType = decl.returnType ? evalTypeAnno(decl.returnType, env, ctx) : freshTVar();

  // Bind the fn's own scheme into env BEFORE body inference so recursive
  // references resolve. The scheme will be replaced with the final
  // version below — using the same scheme object means the recursive
  // call site instantiates with fresh dim-vars per call.
  const fnTypeForRecursion = tFn(paramTypes, returnType);
  const tvarsForGenerics   = declBinders.filter(b => b.kind === 'T').map(b => b.var);
  const dimVarsForGenerics = declBinders.filter(b => b.kind === 'D').map(b => b.var);
  const binderOrder = declBinders.map(b => b.kind);
  const recursionScheme = tScheme(tvarsForGenerics, dimVarsForGenerics, fnTypeForRecursion, { binderOrder });
  typeEnvBindFn(env, decl.name, recursionScheme);

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
    cAdd(ctx.cs, cEqual(returnType, bodyType, spanOf(decl.body)));
  }

  ctx.generics = savedGenerics;
  // Final scheme is the one bound above for recursion. finalizeDecl in
  // integration.js applies the per-decl solver's subst and re-derives
  // binders from the resolved body's free vars.
  typeEnvBindFn(env, decl.name, recursionScheme);
}

// Cross-namespace name clash check. Each name lives in at most one of:
// { dims, values (let/unit), fns, structs }. Multiple decls of the same
// name within the SAME namespace are allowed only when `allowReplace`
// is true (used for fn redeclaration during recursive pre-binding).
function assertNameAvailable(name, env, ctx, span, kind) {
  // Forbid cross-namespace clashes. Recursive fn pre-binding doesn't
  // route through this check — it goes directly to typeEnvBindFn — so
  // we can reject fn redeclaration unconditionally here.
  if (kind !== 'dim'    && typeEnvLookupDim(env, name))    throw withSpan(new Error(`name '${name}' already used as a dimension`), span);
  if (kind !== 'struct' && typeEnvLookupStruct(env, name)) throw withSpan(new Error(`name '${name}' already used as a struct`), span);
  if (kind !== 'fn'     && typeEnvLookupFn(env, name))     throw withSpan(new Error(`name '${name}' already used as a function`), span);
  // Within fn namespace: redeclaration is also an error.
  if (kind === 'fn' && env.fns.has(name)) {
    throw withSpan(new Error(`fn '${name}' is already defined`), span);
  }
  // Don't enforce a clash against env.values (let/unit) — Numbat
  // intentionally allows shadowing via `let` in many cases.
}

function checkDimensionDecl(decl, env, ctx) {
  assertNameAvailable(decl.name, env, ctx, decl.span, 'dim');
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
  // Three forms:
  //   `unit name: DimExpr` — dim from annotation
  //   `unit name = ValueExpr` — dim from inferring the value
  //   `unit name: DimExpr = ValueExpr` — annotated AND defined; cross-check.
  let annoT = null, exprT = null;
  if (decl.dim) {
    annoT = evalTypeAnno(decl.dim, env, ctx);
    if (annoT.kind !== 'TDim') throw withSpan(new Error(`unit annotation must be a dim type`), decl.span);
  }
  if (decl.expr) {
    exprT = inferExpr(decl.expr, env, ctx);
    if (exprT.kind !== 'TDim') throw withSpan(new Error(`unit value must be a dim quantity`), decl.span);
  }
  if (annoT && exprT) {
    // Cross-check: annotated dim must match expression's dim. Surfaces
    // `unit my_c: C = a` (A != C).
    cAdd(ctx.cs, cEqual(annoT, exprT, spanOf(decl.expr)));
  }
  const t = annoT ?? exprT;
  if (t) {
    typeEnvBindValue(env, decl.name, t);
  } else {
    // `unit name` with no body — base unit, dim auto-generated.
    typeEnvBindValue(env, decl.name, tDim(dimExprFromMap({ [decl.name]: 1 })));
  }
}

function checkStructDecl(decl, env, ctx) {
  assertNameAvailable(decl.name, env, ctx, decl.span, 'struct');
  // Generic struct generics: each binder is T-kinded (unrestricted)
  // by default, D-kinded with explicit `: Dim`. Mirrors fn-decl.
  const savedGenerics = ctx.generics;
  ctx.generics = new Map(savedGenerics);
  const declBinders = [];
  for (const g of decl.generics || []) {
    if (g.kind === 'Dim') {
      const tdv = freshTDimVar();
      ctx.generics.set(g.name, { kind: 'D', var: tdv });
      declBinders.push({ kind: 'D', var: tdv, name: g.name });
    } else {
      const tv = freshTVar();
      ctx.generics.set(g.name, { kind: 'T', var: tv });
      declBinders.push({ kind: 'T', var: tv, name: g.name });
    }
  }
  const fields = {};
  for (const f of decl.fields) {
    fields[f.name] = evalTypeAnno(f.type, env, ctx);
  }
  ctx.generics = savedGenerics;
  const tvars   = declBinders.filter(b => b.kind === 'T').map(b => b.var);
  const dimVars = declBinders.filter(b => b.kind === 'D').map(b => b.var);
  const binderOrder = declBinders.map(b => b.kind);
  typeEnvBindStruct(env, decl.name, tScheme(tvars, dimVars, tStruct(decl.name, fields), { binderOrder }));
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
    case 'Lambda':    return inferLambda(node, env, ctx);
    // Filter `where` (ep dataset extension): the result has the same
    // type as the source (filtering preserves element type). The
    // predicate is left unchecked — for a Dataset source it references
    // columns whose schema is runtime-only, so any inference there is
    // noise the runtime-success policy would drop anyway.
    case 'Where':     return inferExpr(node.source, env, ctx);
    default:
      throw withSpan(new Error(`inferExpr: unsupported node type ${node.type}`), node.span);
  }
}

function inferIdent(node, env, ctx) {
  const v = typeEnvLookupValue(env, node.name);
  if (v) return v;
  const fn = typeEnvLookupFn(env, node.name);
  if (fn) return instantiate(fn);   // higher-order use
  throw withSpan(new Error(`unknown identifier: ${node.name}${didYouMeanSuffix(node.name, envCandidates(env, ctx))}`), node.span);
}

function inferUnary(node, env, ctx) {
  const inner = inferExpr(node.expr, env, ctx);
  switch (node.op) {
    case '-': {
      cAdd(ctx.cs, cIsDType(inner, spanOf(node)));
      return inner;
    }
    case '!': {
      cAdd(ctx.cs, cEqual(inner, tBool(), spanOf(node)));
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
    cAdd(ctx.cs, cEqual(l, tBool(), spanOf(node.left)));
    cAdd(ctx.cs, cEqual(r, tBool(), spanOf(node.right)));
    return tBool();
  }

  if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, r, spanOf(node)));
    return tBool();
  }

  if (op === '+' || op === '-') {
    // Polymorphic zero: `0` (and `0 * x`, `-0`, etc.) is the additive
    // identity for any dim. `1 a + 0` typechecks as A; `1 a + 0 * b`
    // also typechecks as A because `0 * b` is statically zero. Mirrors
    // upstream Numbat's behavior.
    const leftZero  = isStaticZero(node.left);
    const rightZero = isStaticZero(node.right);
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    if (leftZero && !rightZero) {
      cAdd(ctx.cs, cIsDType(r, spanOf(node.right)));
      return r;
    }
    if (rightZero && !leftZero) {
      cAdd(ctx.cs, cIsDType(l, spanOf(node.left)));
      return l;
    }
    cAdd(ctx.cs, cIsDType(l, spanOf(node.left)));
    cAdd(ctx.cs, cEqual(l, r, spanOf(node), `'${op}'`));
    return l;
  }

  if (op === '*' || op === '/') {
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cIsDType(l, spanOf(node.left)));
    cAdd(ctx.cs, cIsDType(r, spanOf(node.right)));
    // Pull a dim-expr out of each operand. When the operand is already a
    // TDim, use its dim directly. When it's a TVar (will be promoted to
    // TDim by the IsDType handler), allocate a fresh dim-var and emit an
    // Equal constraint that ties the TVar to TDim<$thatDimVar> so the
    // result expression stays connected to the operand's dim.
    const lDim = l.kind === 'TDim' ? l.dim : dimExprFromVar(freshTDimVar());
    const rDim = r.kind === 'TDim' ? r.dim : dimExprFromVar(freshTDimVar());
    if (l.kind !== 'TDim') cAdd(ctx.cs, cEqual(l, tDim(lDim), spanOf(node.left)));
    if (r.kind !== 'TDim') cAdd(ctx.cs, cEqual(r, tDim(rDim), spanOf(node.right)));
    return tDim(op === '*' ? dimExprMul(lDim, rDim) : dimExprDiv(lDim, rDim));
  }

  if (op === '^') {
    const l = inferExpr(node.left, env, ctx);
    const exp = tryFoldConst(node.right);
    if (exp) {
      if (l.kind === 'TDim') return tDim(dimExprPow(l.dim, exp));
      // Unresolved base: emit IsDType + allocate a dim-var, tie l to
      // TDim<$dv>, and return TDim<$dv ^ exp> so the surrounding pass
      // sees the right dim shape downstream.
      cAdd(ctx.cs, cIsDType(l, spanOf(node.left)));
      const dv = freshTDimVar();
      const dvDim = dimExprFromVar(dv);
      cAdd(ctx.cs, cEqual(l, tDim(dvDim), spanOf(node.left)));
      return tDim(dimExprPow(dvDim, exp));
    }
    // Non-const exponent — both base and exp must be Scalar (the only
    // case dimensionally well-defined without static eval).
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, T_SCALAR, spanOf(node.left)));
    cAdd(ctx.cs, cEqual(r, T_SCALAR, spanOf(node.right)));
    return T_SCALAR;
  }

  if (op === '->') {
    // Conversion: left and right are both dim expressions of the same
    // dim. Result type = left (the value side).
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, r, spanOf(node), `conversion '->'`));
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
    throw withSpan(new Error(`unknown function: ${node.name}${didYouMeanSuffix(node.name, envCandidates(env, ctx))}`), node.span);
  }
  return inferDirectFnCall(instantiate(scheme), node, env, ctx);
}

function inferDirectFnCall(fnT, node, env, ctx) {
  if (fnT.kind !== 'TFn') throw withSpan(new Error(`call target is not a function: ${formatType(fnT)}`), node.span);
  // Variadic support: optional trailing params can be omitted. The
  // accepted arg count range is [params.length - optional, params.length].
  const optional = fnT.optional ?? 0;
  const minArity = fnT.params.length - optional;
  const maxArity = fnT.params.length;
  if (node.args.length < minArity || node.args.length > maxArity) {
    const arityRange = minArity === maxArity ? `${minArity}` : `${minArity}..${maxArity}`;
    throw withSpan(new Error(`${node.name}: expected ${arityRange} args, got ${node.args.length}`), node.span);
  }
  for (let i = 0; i < node.args.length; i++) {
    const argT = inferExpr(node.args[i], env, ctx);
    cAdd(ctx.cs, cEqual(fnT.params[i], argT, spanOf(node.args[i]), `argument ${i + 1} of call to '${node.name}'`));
  }
  return fnT.result;
}

function inferIf(node, env, ctx) {
  const c = inferExpr(node.cond, env, ctx);
  cAdd(ctx.cs, cEqual(c, tBool(), spanOf(node.cond), `if condition`));
  const t = inferExpr(node.then,  env, ctx);
  const e = inferExpr(node.else,  env, ctx);
  cAdd(ctx.cs, cEqual(t, e, spanOf(node), `if branches`));
  return t;
}

function inferList(node, env, ctx) {
  if (node.items.length === 0) return tList(freshTVar());
  const first = inferExpr(node.items[0], env, ctx);
  for (let i = 1; i < node.items.length; i++) {
    const ti = inferExpr(node.items[i], env, ctx);
    cAdd(ctx.cs, cEqual(first, ti, spanOf(node.items[i])));
  }
  return tList(first);
}

// Arrow-function lambda inference. Each param gets a fresh type var
// (or its annotated type, if given), then the body is inferred in an
// env extended with those bindings. Returns TFn(paramTypes, bodyType).
// Monomorphic — captured fn values aren't let-generalized (the caller
// supplies arg types at the call site, and HM unification handles the
// rest). Matches what fnDecl does for top-level fns, minus the
// recursion-scheme bit (lambdas can't reference themselves by name).
function inferLambda(node, env, ctx) {
  const paramTypes = node.params.map(p => {
    if (p.type) {
      // Annotated lambda param. Type annotations in expression position
      // are parsed but rare; reuse the same evaluator the let-anno path
      // uses if it's available, otherwise fall back to a fresh TVar.
      try { return evalTypeAnno(p.type, env, ctx); }
      catch { return freshTVar(); }
    }
    return freshTVar();
  });
  const bodyEnv = typeEnvExtend(env);
  for (let i = 0; i < node.params.length; i++) {
    typeEnvBindValue(bodyEnv, node.params[i].name, paramTypes[i]);
  }
  const bodyType = inferExpr(node.body, bodyEnv, ctx);
  return tFn(paramTypes, bodyType);
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
  cAdd(ctx.cs, cHasField(objT, node.name, ft, spanOf(node)));
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
    cAdd(ctx.cs, cEqual(s.fields[f.name], fT, spanOf(f.value)));
  }
  for (const k in s.fields) {
    if (!seen.has(k)) throw withSpan(new Error(`struct ${node.name} missing field '${k}'`), node.span);
  }
  return s;
}

function inferFactorial(node, env, ctx) {
  const t = inferExpr(node.expr, env, ctx);
  cAdd(ctx.cs, cEqual(t, T_SCALAR, spanOf(node.expr)));
  return T_SCALAR;
}
