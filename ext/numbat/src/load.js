// Loader for parsed Numbat-script modules.
//
// Walks the AST produced by parse.js, evaluates dimension/value expressions,
// applies decorators, and registers the results in a Numbat environment
// (DimRegistry + UnitRegistry + a Map of let-binding values).
//
// Two interpreters share the AST:
//   evalDimExpr(node, env)   → dim vector  (for `dimension X = expr` RHS)
//   evalValueExpr(node, env) → Quantity    (for `unit X = expr` and `let` RHS)
//
// The env object passed in carries:
//   dims:         DimRegistry
//   units:        UnitRegistry
//   values:       Map<string, Quantity>          (let bindings only)
//   lookupValue:  (name) => Quantity | null      (lets first, then units)
//   resolveUse:   (path: string[]) => void        (recursive module loading)
//
// v0.2 covers the declarative subset only — `fn`, `if`, structs, `->`
// in value expressions all error with a clear message.

import { Quantity } from './quantity.js';
import { dimEq, dimMul, dimDiv, dimPow, dimEmpty } from './dimensions.js';
import { tokenize } from './tokenize.js';
import { parse } from './parse.js';

// ── expression evaluators ────────────────────────────────────────

export function evalDimExpr(node, env) {
  if (node.type === 'Num') {
    if (node.value === 1) return {};
    throw new Error(`dimension expression: numbers other than 1 not allowed (got ${node.value})`);
  }
  if (node.type === 'Ident') {
    if (!env.dims.has(node.name)) throw new Error(`unknown dimension: ${node.name}`);
    return env.dims.resolve(node.name);
  }
  if (node.type === 'Paren') return evalDimExpr(node.expr, env);
  if (node.type === 'Binary') {
    if (node.op === '^') {
      const base = evalDimExpr(node.left, env);
      if (node.right.type !== 'Num') {
        throw new Error('dimension exponent must be a literal number');
      }
      return dimPow(base, node.right.value);
    }
    const l = evalDimExpr(node.left, env);
    const r = evalDimExpr(node.right, env);
    if (node.op === '*') return dimMul(l, r);
    if (node.op === '/') return dimDiv(l, r);
    throw new Error(`operator '${node.op}' not allowed in dimension expression`);
  }
  throw new Error(`unexpected node ${node.type} in dimension expression`);
}

// Built-in functions available without user-side `fn` definition.
// Upstream Numbat defines these in math::transcendental / math::trigonometry
// as `fn` bodies that call lower-level builtins; here we just expose the
// host's Math directly. Once we load enough upstream .nbt math modules,
// these become a fallback rather than the primary path.
const BUILTIN_FNS = {
  sqrt(q) {
    // sqrt of a dim: halve each exponent. Odd exponents → error.
    const r = {};
    for (const k in q.dim) {
      if (q.dim[k] % 2 !== 0) throw new Error(`sqrt: dimension ${k} has odd exponent`);
      r[k] = q.dim[k] / 2;
    }
    return new Quantity(Math.sqrt(q.value), r);
  },
  cbrt(q) {
    const r = {};
    for (const k in q.dim) {
      if (q.dim[k] % 3 !== 0) throw new Error(`cbrt: dimension ${k} has non-multiple-of-3 exponent`);
      r[k] = q.dim[k] / 3;
    }
    return new Quantity(Math.cbrt(q.value), r);
  },
  abs(q) { return new Quantity(Math.abs(q.value), q.dim); },
  sin(q) { mustBeDimensionless(q, 'sin'); return new Quantity(Math.sin(q.value), {}); },
  cos(q) { mustBeDimensionless(q, 'cos'); return new Quantity(Math.cos(q.value), {}); },
  tan(q) { mustBeDimensionless(q, 'tan'); return new Quantity(Math.tan(q.value), {}); },
  asin(q){ mustBeDimensionless(q, 'asin');return new Quantity(Math.asin(q.value), {}); },
  acos(q){ mustBeDimensionless(q, 'acos');return new Quantity(Math.acos(q.value), {}); },
  atan(q){ mustBeDimensionless(q, 'atan');return new Quantity(Math.atan(q.value), {}); },
  log(q) { mustBeDimensionless(q, 'log'); return new Quantity(Math.log10(q.value), {}); },
  log2(q){ mustBeDimensionless(q, 'log2');return new Quantity(Math.log2(q.value), {}); },
  ln(q)  { mustBeDimensionless(q, 'ln');  return new Quantity(Math.log(q.value), {}); },
  exp(q) { mustBeDimensionless(q, 'exp'); return new Quantity(Math.exp(q.value), {}); },
  sinh(q){ mustBeDimensionless(q, 'sinh');return new Quantity(Math.sinh(q.value), {}); },
  cosh(q){ mustBeDimensionless(q, 'cosh');return new Quantity(Math.cosh(q.value), {}); },
  tanh(q){ mustBeDimensionless(q, 'tanh');return new Quantity(Math.tanh(q.value), {}); },
  asinh(q){ mustBeDimensionless(q,'asinh');return new Quantity(Math.asinh(q.value),{}); },
  acosh(q){ mustBeDimensionless(q,'acosh');return new Quantity(Math.acosh(q.value),{}); },
  atanh(q){ mustBeDimensionless(q,'atanh');return new Quantity(Math.atanh(q.value),{}); },
  floor(q) { return new Quantity(Math.floor(q.value), q.dim); },
  ceil(q)  { return new Quantity(Math.ceil(q.value),  q.dim); },
  round(q) { return new Quantity(Math.round(q.value), q.dim); },
  factorial(q) {
    mustBeDimensionless(q, 'factorial');
    const n = q.value;
    if (n < 0 || !Number.isFinite(n) || Math.floor(n) !== n) {
      throw new Error(`factorial: requires non-negative integer, got ${n}`);
    }
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return new Quantity(r, {});
  },
};

function mustBeDimensionless(q, fnName) {
  if (!dimEmpty(q.dim)) throw new Error(`${fnName}: argument must be dimensionless`);
}

// Variadic built-in procedures. Differ from BUILTIN_FNS in that they accept
// an args array directly (so they can be 1/2/3-arg overloaded) and may return
// a "void" sentinel — we use Quantity(0, {}) since v0.3 doesn't have a
// dedicated Unit/Void type.
const BUILTIN_PROCS = {
  // assert(bool): error if false. Used by upstream test programs.
  assert(args) {
    if (args.length !== 1) throw new Error(`assert: expected 1 arg, got ${args.length}`);
    const b = args[0];
    if (typeof b !== 'boolean') throw new Error('assert: expected Bool argument');
    if (!b) throw new Error('assertion failed');
    return new Quantity(0, {});
  },
  // error(msg): throws an error with the given string message. Used by
  // upstream stdlib for guard clauses like
  //   `if x == 0 then error("divide by zero") else 1 / x`.
  error(args) {
    if (args.length !== 1) throw new Error(`error: expected 1 arg, got ${args.length}`);
    const msg = args[0];
    if (typeof msg !== 'string') throw new Error('error: argument must be a string');
    throw new Error(msg);
  },
  // print(value): would emit to a host-provided output stream. For v0.4 we
  // accept the call but no-op (returns 0). Hosts can override BUILTIN_PROCS.
  print(args) {
    return new Quantity(0, {});
  },

  // Datetime / locale stubs — return Quantities (seconds since Unix epoch
  // with dim {time:1}) so that arithmetic on them in upstream code works.
  // Real DateTime semantics (timezones, formatting, calendar arithmetic)
  // need their own type — that's later work. For now these are best-effort
  // stubs that make module loading succeed.
  get_local_timezone(args) { return 'UTC'; },
  now(args)                { return new Quantity(Date.now() / 1000, { time: 1 }); },
  format_datetime(args)    { return String(args[1] ?? ''); },
  tz(args)                 { return { __struct: 'TzFn', name: String(args[0] ?? '') }; },
  exchange_rate(args)      { return new Quantity(1, {}); },
  datetime(args) {
    // Parse ISO-ish input into seconds-since-epoch; falls back to 0 on bad input.
    const t = Date.parse(String(args[0] ?? ''));
    return new Quantity(Number.isFinite(t) ? t / 1000 : 0, { time: 1 });
  },

  // mod(a, b) — least nonnegative remainder. Upstream declares this as
  // `fn mod<T: Dim>(a: T, b: T) -> T` so it's an extern that dispatches here.
  mod(args) {
    if (args.length !== 2) throw new Error(`mod: expected 2 args, got ${args.length}`);
    const [a, b] = args;
    if (!(a instanceof Quantity) || !(b instanceof Quantity)) {
      throw new Error('mod: both args must be Quantities');
    }
    if (!dimEq(a.dim, b.dim)) {
      throw new Error(`mod: dim mismatch [${JSON.stringify(a.dim)}] vs [${JSON.stringify(b.dim)}]`);
    }
    // Euclidean remainder (always non-negative)
    const r = ((a.value % b.value) + b.value) % b.value;
    return new Quantity(r, a.dim);
  },

  // random() — host-provided pseudo-random in [0, 1). Returns a dimensionless
  // Quantity. For deterministic testing the host can override this.
  random(args) {
    if (args.length !== 0) throw new Error(`random: expected 0 args, got ${args.length}`);
    return new Quantity(Math.random(), {});
  },

  // ── list primitives (v0.5) ──────────────────────────────────
  // Upstream's core::lists declares these as `fn head<A>(xs: List<A>) -> A`
  // (extern); the loader routes extern body-less fns here.
  len(args) {
    if (args.length !== 1) throw new Error(`len: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (Array.isArray(xs)) return new Quantity(xs.length, {});
    if (typeof xs === 'string') return new Quantity(xs.length, {});
    throw new Error('len: expected List or String');
  },
  head(args) {
    if (args.length !== 1) throw new Error(`head: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('head: expected List');
    if (xs.length === 0) throw new Error('head: empty list');
    return xs[0];
  },
  tail(args) {
    if (args.length !== 1) throw new Error(`tail: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('tail: expected List');
    if (xs.length === 0) throw new Error('tail: empty list');
    return xs.slice(1);
  },
  cons(args) {
    if (args.length !== 2) throw new Error(`cons: expected 2 args, got ${args.length}`);
    const [x, xs] = args;
    if (!Array.isArray(xs)) throw new Error('cons: second arg must be a List');
    return [x, ...xs];
  },
  cons_end(args) {
    if (args.length !== 2) throw new Error(`cons_end: expected 2 args, got ${args.length}`);
    const [x, xs] = args;
    if (!Array.isArray(xs)) throw new Error('cons_end: second arg must be a List');
    return [...xs, x];
  },
  // assert_eq(a, b)        — strict equality (same dim, same value)
  // assert_eq(a, b, eps)   — approximate equality (|a - b| <= eps)
  // Works on Quantity-vs-Quantity (with dim check) or Bool-vs-Bool.
  assert_eq(args) {
    if (args.length < 2 || args.length > 3) {
      throw new Error(`assert_eq: expected 2 or 3 args, got ${args.length}`);
    }
    const [a, b, eps] = args;
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      if (typeof a !== typeof b) throw new Error('assert_eq: cannot compare Bool with Quantity');
      if (eps !== undefined) throw new Error('assert_eq: tolerance not meaningful for Bool');
      if (a !== b) throw new Error(`assert_eq failed: ${a} ≠ ${b}`);
      return new Quantity(0, {});
    }
    if (!dimEq(a.dim, b.dim)) {
      throw new Error(`assert_eq: dim mismatch [${JSON.stringify(a.dim)}] vs [${JSON.stringify(b.dim)}]`);
    }
    if (eps === undefined) {
      if (a.value !== b.value) {
        throw new Error(`assert_eq failed: ${a.value} ≠ ${b.value}`);
      }
    } else {
      if (!dimEq(a.dim, eps.dim)) {
        throw new Error(`assert_eq: tolerance must have same dim as compared values`);
      }
      if (Math.abs(a.value - b.value) > eps.value) {
        throw new Error(`assert_eq failed: |${a.value} - ${b.value}| = ${Math.abs(a.value - b.value)} > ${eps.value}`);
      }
    }
    return new Quantity(0, {});
  },
};

const EVAL_CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

export function evalValueExpr(node, env) {
  if (node.type === 'Num')  return new Quantity(node.value, {});
  if (node.type === 'Bool') return node.value;   // JS boolean
  if (node.type === 'Str')  return node.value;   // JS string
  if (node.type === 'If') {
    const cond = evalValueExpr(node.cond, env);
    if (typeof cond !== 'boolean') {
      throw new Error('if-condition must be a Bool, got a Quantity');
    }
    return evalValueExpr(cond ? node.then : node.else, env);
  }
  if (node.type === 'Ident') {
    const q = env.lookupValue(node.name);
    if (q === null || q === undefined) throw new Error(`unknown identifier: ${node.name}`);
    return q;
  }
  if (node.type === 'Paren') return evalValueExpr(node.expr, env);
  if (node.type === 'Call') {
    return evalCall(node, env);
  }
  if (node.type === 'List') {
    return node.items.map(item => evalValueExpr(item, env));
  }
  if (node.type === 'StructInit') {
    // v0.5 stores structs as plain JS objects with a __struct tag for the
    // type name. Field types from the declaration aren't enforced at runtime.
    const obj = { __struct: node.name };
    for (const f of node.fields) obj[f.name] = evalValueExpr(f.value, env);
    return obj;
  }
  if (node.type === 'Field') {
    const o = evalValueExpr(node.obj, env);
    if (o === null || typeof o !== 'object' || Array.isArray(o)) {
      throw new Error(`field access on non-struct value`);
    }
    if (!(node.name in o)) {
      throw new Error(`field '${node.name}' not in struct ${o.__struct ?? '(unknown)'}`);
    }
    return o[node.name];
  }
  if (node.type === 'Unary' && node.op === '!') {
    const v = evalValueExpr(node.expr, env);
    if (typeof v !== 'boolean') throw new Error('! requires a Bool operand');
    return !v;
  }
  if (node.type === 'Factorial') {
    // Postfix n! — always goes to the builtin, bypassing any user-defined
    // `factorial` (which itself often has body `n!` — recursing would
    // overflow the stack).
    const v = evalValueExpr(node.expr, env);
    if (!(v instanceof Quantity)) throw new Error('!: requires a Quantity');
    return BUILTIN_FNS.factorial(v);
  }
  if (node.type === 'Unary' && node.op === '-') {
    return evalValueExpr(node.expr, env).neg();
  }
  if (node.type === 'Binary') {
    // Logical operators on booleans (short-circuit).
    if (node.op === '&&') {
      const l = evalValueExpr(node.left, env);
      if (typeof l !== 'boolean') throw new Error('&& requires Bool operands');
      if (!l) return false;
      const r = evalValueExpr(node.right, env);
      if (typeof r !== 'boolean') throw new Error('&& requires Bool operands');
      return r;
    }
    if (node.op === '||') {
      const l = evalValueExpr(node.left, env);
      if (typeof l !== 'boolean') throw new Error('|| requires Bool operands');
      if (l) return true;
      const r = evalValueExpr(node.right, env);
      if (typeof r !== 'boolean') throw new Error('|| requires Bool operands');
      return r;
    }
    if (EVAL_CMP_OPS.has(node.op)) return evalCmp(node, env);
    if (node.op === '->') {
      const left = evalValueExpr(node.left, env);
      let target = node.right;
      while (target.type === 'Paren') target = target.expr;
      // Three meanings for `x -> name` depending on context:
      //   1. left is a Quantity AND name is a unit → set disp tag (conversion)
      //   2. name is a fn/builtin → function application `f(x)`
      //      (upstream uses this pattern: `datetime("…") -> julian_date`)
      //   3. otherwise → error
      if (target.type === 'Ident') {
        if (left instanceof Quantity && env.units.has(target.name)) {
          return left.convertTo(target.name, env.units);
        }
        if (env.fns?.has(target.name)) {
          return invokeUserFn(env.fns.get(target.name), target.name, [left], env);
        }
        if (BUILTIN_PROCS[target.name]) return BUILTIN_PROCS[target.name]([left]);
        if (BUILTIN_FNS[target.name])   return BUILTIN_FNS[target.name](left);
        throw new Error(`-> ${target.name}: unknown unit or function`);
      }
      // Compound case: evaluate the target as a Quantity, verify dim,
      // return left with no disp tag (compound display naming is v0.5+).
      const targetQ = evalValueExpr(target, env);
      if (!(left instanceof Quantity) || !(targetQ instanceof Quantity)) {
        throw new Error('-> compound target requires Quantity on both sides');
      }
      if (!dimEq(left.dim, targetQ.dim)) {
        throw new Error(`-> dim mismatch: [${JSON.stringify(left.dim)}] cannot convert to [${JSON.stringify(targetQ.dim)}]`);
      }
      return new Quantity(left.value, left.dim);
    }
    if (node.op === '^') {
      const base = evalValueExpr(node.left, env);
      const exp = evalValueExpr(node.right, env);
      if (!dimEmpty(exp.dim)) throw new Error('exponent must be dimensionless');
      return base.pow(exp.value);
    }
    const l = evalValueExpr(node.left, env);
    const r = evalValueExpr(node.right, env);
    if (node.op === '+') return l.add(r);
    if (node.op === '-') return l.sub(r);
    if (node.op === '*') return l.mul(r);
    if (node.op === '/') return l.div(r);
    throw new Error(`operator '${node.op}' not supported in value expression`);
  }
  throw new Error(`unexpected node ${node.type} in value expression`);
}

// Deep equality across Quantity / Bool / String / List values.
function valueEq(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valueEq(v, b[i]));
  }
  if (a instanceof Quantity && b instanceof Quantity) {
    return a.value === b.value && dimEq(a.dim, b.dim);
  }
  return a === b;
}

// Comparison: both operands must agree on shape. ==/!= work on every value
// type; ordering ops only on Quantities (with same dim).
function evalCmp(node, env) {
  const l = evalValueExpr(node.left, env);
  const r = evalValueExpr(node.right, env);
  // ==/!= are total: lists, strings, booleans, quantities all comparable to
  // their own kind. Cross-kind compares throw to surface obvious bugs.
  if (node.op === '==' || node.op === '!=') {
    if (Array.isArray(l) || Array.isArray(r)) {
      if (!Array.isArray(l) || !Array.isArray(r)) {
        throw new Error(`${node.op}: cannot compare List with non-List`);
      }
      const eq = valueEq(l, r);
      return node.op === '==' ? eq : !eq;
    }
    if (typeof l === 'boolean' || typeof r === 'boolean') {
      if (typeof l !== typeof r) {
        throw new Error(`${node.op}: cannot compare Bool with non-Bool`);
      }
      return node.op === '==' ? l === r : l !== r;
    }
    if (typeof l === 'string' || typeof r === 'string') {
      if (typeof l !== typeof r) {
        throw new Error(`${node.op}: cannot compare String with non-String`);
      }
      return node.op === '==' ? l === r : l !== r;
    }
    // Quantity-vs-Quantity
    if (!dimEq(l.dim, r.dim)) {
      throw new Error(`${node.op}: dim mismatch [${JSON.stringify(l.dim)}] vs [${JSON.stringify(r.dim)}]`);
    }
    return node.op === '==' ? l.value === r.value : l.value !== r.value;
  }
  // Ordering ops: Quantity only.
  if (typeof l === 'boolean' || typeof r === 'boolean') {
    throw new Error(`${node.op}: ordering not defined on booleans`);
  }
  if (Array.isArray(l) || Array.isArray(r) || typeof l === 'string' || typeof r === 'string') {
    throw new Error(`${node.op}: ordering only defined on Quantities`);
  }
  if (!dimEq(l.dim, r.dim)) {
    throw new Error(`${node.op}: dim mismatch [${JSON.stringify(l.dim)}] vs [${JSON.stringify(r.dim)}]`);
  }
  switch (node.op) {
    case '<':  return l.value <  r.value;
    case '<=': return l.value <= r.value;
    case '>':  return l.value >  r.value;
    case '>=': return l.value >= r.value;
  }
}

// ── generic-fn machinery (v0.4) ──────────────────────────────────
//
// Numbat's dimension generics treat dimensions as a free abelian group.
// `fn sqrt<T: Dim>(q: T^2) -> T = q^(1/2)` types as: "for any dimension T,
// taking a Quantity with dim T^2 produces a Quantity with dim T." At a call
// site, we *unify* the parameter's symbolic pattern with the concrete arg dim
// to solve for T.
//
// A "symbolic dim vector" is a plain object whose keys are either base-axis
// names (lowercase by convention — length, mass, time, ...) or generic
// parameter names (whatever the user declared — typically uppercase: T, U).
// The genericNames set tells us which keys to treat as variables.

// Evaluate a type expression with generics in scope. Returns a symbolic dim
// vector where generic-named keys carry their exponent.
function evalSymDim(node, env, genericNames) {
  if (node.type === 'Num') {
    if (node.value !== 1) throw new Error(`dimension expression: numbers other than 1 not allowed`);
    return {};
  }
  if (node.type === 'Ident') {
    if (genericNames.has(node.name)) {
      return { [node.name]: 1 };
    }
    if (!env.dims.has(node.name)) throw new Error(`unknown dimension: ${node.name}`);
    return env.dims.resolve(node.name);
  }
  if (node.type === 'Paren') return evalSymDim(node.expr, env, genericNames);
  if (node.type === 'Binary') {
    if (node.op === '^') {
      const base = evalSymDim(node.left, env, genericNames);
      if (node.right.type !== 'Num') throw new Error('dimension exponent must be a number literal');
      return dimPow(base, node.right.value);
    }
    const l = evalSymDim(node.left, env, genericNames);
    const r = evalSymDim(node.right, env, genericNames);
    if (node.op === '*') return dimMul(l, r);
    if (node.op === '/') return dimDiv(l, r);
    throw new Error(`operator '${node.op}' not allowed in type expression`);
  }
  throw new Error(`unexpected node ${node.type} in type expression`);
}

// Unify a symbolic pattern against a concrete dim, solving for generic vars.
// Returns substitutions { genericName: dimVec }. Throws on no-solution.
//
// v0.4 supports patterns with at most ONE generic variable. Multi-variable
// patterns (T * U where both are unknown) need linear-system solving over Z
// and are deferred to a later version.
function unifyOne(pattern, target, genericNames) {
  const concrete = {};
  const variable = {};
  for (const [k, e] of Object.entries(pattern)) {
    if (genericNames.has(k)) variable[k] = e;
    else                     concrete[k] = e;
  }
  // residual = target / concrete  ← what variables must produce
  const residual = dimDiv(target, concrete);
  const varNames = Object.keys(variable);

  if (varNames.length === 0) {
    if (Object.keys(residual).length > 0) {
      throw new Error(`unification failed: argument dim has extra axes ${JSON.stringify(residual)}`);
    }
    return {};
  }
  if (varNames.length === 1) {
    const T = varNames[0];
    const n = variable[T];
    const subT = {};
    for (const [k, e] of Object.entries(residual)) {
      if (e % n !== 0) {
        throw new Error(`unification failed: ${T}^${n} = ... — axis ${k} exponent ${e} not divisible by ${n}`);
      }
      subT[k] = e / n;
    }
    return { [T]: subT };
  }
  throw new Error(`unification: multi-variable patterns not supported (vars: ${varNames.join(', ')})`);
}

// Walk parameters, unify each annotated param's pattern with its concrete arg,
// merge inferences. Params whose type isn't a dim (List<A>, String, Bool)
// can't contribute, so we skip them rather than fail — the fn might still work
// if its body doesn't dim-sensitively reference the unsolved generic. Same
// for Bool/String/List arg values, which carry no dim info.
function solveGenerics(generics, params, argVals, env) {
  const genericNames = new Set(generics.map(g => g.name));
  const subs = {};
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (!p.typeExpr) continue;
    const arg = argVals[i];
    // Only Quantity args carry dim info usable for generic inference. Skip
    // booleans, strings, lists, structs.
    if (!(arg instanceof Quantity)) continue;
    let pattern;
    try { pattern = evalSymDim(p.typeExpr, env, genericNames); }
    catch { continue; }   // param type isn't a dimension — skip
    const newSubs = unifyOne(pattern, arg.dim, genericNames);
    for (const [T, sub] of Object.entries(newSubs)) {
      if (subs[T] && !dimEq(subs[T], sub)) {
        throw new Error(`generic ${T} inferred inconsistently: ${JSON.stringify(subs[T])} vs ${JSON.stringify(sub)}`);
      }
      subs[T] = sub;
    }
  }
  // Unresolved generics stay out of `subs`; the return-type check handles that
  // (it falls back to skipping when substitution doesn't resolve to a real dim).
  return subs;
}

// Substitute generic vars in a symbolic dim, producing a concrete dim.
function substituteVars(symVec, subs) {
  let result = {};
  for (const [k, exp] of Object.entries(symVec)) {
    if (subs[k]) {
      result = dimMul(result, dimPow(subs[k], exp));
    } else {
      result = dimMul(result, { [k]: exp });
    }
  }
  return result;
}

// Invoke a user-defined fn with already-evaluated argument values. Shared by
// evalCall (the AST path) and the `->` function-application form.
function invokeUserFn(userFn, name, argVals, env) {
  if (argVals.length !== userFn.params.length) {
    throw new Error(`${name}: expected ${userFn.params.length} args, got ${argVals.length}`);
  }
  if (userFn.body === null) {
    const proc = BUILTIN_PROCS[name];
    if (proc) return proc(argVals);
    const builtin = BUILTIN_FNS[name];
    if (builtin && argVals.length === 1) return builtin(argVals[0]);
    throw new Error(`extern fn ${name}: no built-in implementation provided by host`);
  }
  // Lexical scope: parameters layered on top of the outer scope's let-bindings.
  const fnValues = new Map(env.values);
  for (let i = 0; i < userFn.params.length; i++) {
    fnValues.set(userFn.params[i].name, argVals[i]);
  }
  const buildFnEnv = () => {
    const fnEnv = { ...env, values: fnValues };
    fnEnv.lookupValue = (n) => {
      if (fnValues.has(n)) return fnValues.get(n);
      if (env.fns.has(n)) {
        const f = env.fns.get(n);
        return (...a) => invokeUserFn(f, n, a, env);
      }
      if (BUILTIN_FNS[n])   return (q) => BUILTIN_FNS[n](q);
      if (BUILTIN_PROCS[n]) return (...a) => BUILTIN_PROCS[n](a);
      const u = env.units.resolve(n);
      if (u) return new Quantity(u.mul, u.dim);
      return null;
    };
    return fnEnv;
  };
  if (userFn.whereClauses) {
    for (const clause of userFn.whereClauses) {
      const v = evalValueExpr(clause.expr, buildFnEnv());
      fnValues.set(clause.name, v);
    }
  }
  let subs = null;
  if (userFn.generics && userFn.generics.length > 0) {
    subs = solveGenerics(userFn.generics, userFn.params, argVals, env);
  }
  const result = evalValueExpr(userFn.body, buildFnEnv());
  if (userFn.returnType && result instanceof Quantity) {
    let expected;
    try {
      if (subs) {
        const genericNames = new Set(userFn.generics.map(g => g.name));
        const symRet = evalSymDim(userFn.returnType, env, genericNames);
        expected = substituteVars(symRet, subs);
        if (Object.keys(expected).some(k => genericNames.has(k))) return result;
      } else {
        expected = evalDimExpr(userFn.returnType, env);
      }
    } catch {
      return result;
    }
    if (!dimEq(expected, result.dim)) {
      throw new Error(`${name}: return type mismatch (annotated [${JSON.stringify(expected)}] vs result [${JSON.stringify(result.dim)}])`);
    }
  }
  return result;
}

// Evaluate a function call. Dispatch order: user-defined fns by name → local
// scope (params holding fn values, for higher-order calls) → builtins.
function evalCall(node, env) {
  const userFn = env.fns?.get(node.name);
  if (userFn) {
    const argVals = node.args.map(a => evalValueExpr(a, env));
    return invokeUserFn(userFn, node.name, argVals, env);
  }
  // Higher-order: the callee may be a fn value bound to a local name
  // (e.g. `foldl(_add, ...)` where `_add` is a fn passed as the `f` param,
  // then called inside foldl's body as `f(acc, x)`).
  if (env.values.has(node.name)) {
    const v = env.values.get(node.name);
    if (typeof v === 'function') {
      const argVals = node.args.map(a => evalValueExpr(a, env));
      return v(...argVals);
    }
  }
  const argVals = node.args.map(a => evalValueExpr(a, env));
  const proc = BUILTIN_PROCS[node.name];
  if (proc) return proc(argVals);
  const builtin = BUILTIN_FNS[node.name];
  if (builtin) {
    if (argVals.length !== 1) {
      throw new Error(`${node.name}: built-in takes 1 argument, got ${argVals.length}`);
    }
    return builtin(argVals[0]);
  }
  throw new Error(`unknown function: ${node.name}`);
}

// ── decorator extraction ─────────────────────────────────────────

function decoratorInfo(decorators) {
  const info = {
    aliases: [],          // long-form alternate names
    shortAliases: [],     // short-form (prefix-eligible) alternates
    metricPrefixes: false,
    displayName: null,    // from @name(...)
    url: null,            // from @url(...) — stored but unused at runtime
  };
  for (const d of decorators) {
    switch (d.name) {
      case 'aliases':
        for (const arg of d.args) {
          if (arg.type !== 'NameArg') continue;
          // Upstream modifiers:
          //   short:  prefixable short form (e.g. `m: short`)
          //   long:   long-form alternate name; not prefixed
          //   none:   no auto-pluralization; treat as long-form for our purposes
          //   both:   serves as BOTH long alias AND short (prefixable) form
          //   (none): default = long
          if (arg.modifier === 'short') {
            info.shortAliases.push(arg.name);
          } else if (arg.modifier === 'both' || arg.modifier === 'any') {
            info.aliases.push(arg.name);
            info.shortAliases.push(arg.name);
          } else {
            info.aliases.push(arg.name);
          }
        }
        break;
      case 'metric_prefixes':
        info.metricPrefixes = true;
        break;
      case 'name': {
        const a = d.args[0];
        if (a?.type === 'StrArg') info.displayName = a.value;
        break;
      }
      case 'url': {
        const a = d.args[0];
        if (a?.type === 'StrArg') info.url = a.value;
        break;
      }
      // Other decorators (@description, @example, @elide, ...) silently ignored
      // — they're metadata that doesn't affect registration.
    }
  }
  return info;
}

// ── module loader ────────────────────────────────────────────────

export function loadModule(ast, env) {
  for (const decl of ast.decls) {
    try {
      switch (decl.type) {
        case 'UseStmt':       env.resolveUse(decl.path); break;
        case 'DimensionDecl': loadDimensionDecl(decl, env); break;
        case 'UnitDecl':      loadUnitDecl(decl, env); break;
        case 'LetDecl':       loadLetDecl(decl, env); break;
        case 'FnDecl':        loadFnDecl(decl, env); break;
        case 'StructDecl':    loadStructDecl(decl, env); break;
        default:
          throw new Error(`unsupported declaration: ${decl.type}`);
      }
    } catch (e) {
      const where = `${ast.source ?? '<module>'}: ${decl.name ?? decl.type}`;
      throw new Error(`${where}: ${e.message}`);
    }
  }
}

function loadStructDecl(decl, env) {
  env.structs.set(decl.name, {
    name: decl.name,
    generics: decl.generics,
    fields: decl.fields.map(f => ({ name: f.name, type: f.type })),
  });
}

function loadFnDecl(decl, env) {
  if (!env.fns) env.fns = new Map();
  // Store the AST + parameter info for later invocation. No type-check yet —
  // dimension annotations on params and return type are verified at call time.
  env.fns.set(decl.name, {
    generics: decl.generics ?? [],
    params: decl.params,
    body: decl.body,
    returnType: decl.returnType,
    whereClauses: decl.whereClauses,
  });
}

function loadDimensionDecl(decl, env) {
  if (decl.exprs.length === 0) {
    env.dims.defineBase(decl.name);
    return;
  }
  const dim = evalDimExpr(decl.exprs[0], env);
  // Alternate definitions must produce the same dim (upstream's redundant-
  // equation notation for documentation).
  for (let i = 1; i < decl.exprs.length; i++) {
    const alt = evalDimExpr(decl.exprs[i], env);
    if (!dimEq(dim, alt)) {
      throw new Error(`dimension ${decl.name}: alternate definition #${i + 1} disagrees with primary`);
    }
  }
  env.dims.defineDerived(decl.name, dim);
}

function loadUnitDecl(decl, env) {
  const meta = decoratorInfo(decl.decorators);
  let dim, mul;

  if (decl.expr === null) {
    if (decl.dim === null) {
      throw new Error(`base unit '${decl.name}' requires a dimension annotation`);
    }
    dim = evalDimExpr(decl.dim, env);
    mul = 1;
  } else {
    const q = evalValueExpr(decl.expr, env);
    mul = q.value;
    if (decl.dim !== null) {
      const expected = evalDimExpr(decl.dim, env);
      if (!dimEq(expected, q.dim)) {
        throw new Error(`dimension mismatch: annotated [${JSON.stringify(expected)}] vs value [${JSON.stringify(q.dim)}]`);
      }
      dim = expected;
    } else {
      dim = q.dim;
    }
  }

  env.units.define(decl.name, {
    dim,
    mul,
    aliases: meta.aliases,
    shortAliases: meta.shortAliases,
    displayName: meta.shortAliases[0] ?? decl.name,
    prefixSet: meta.metricPrefixes ? 'metric' : null,
  });
}

function loadLetDecl(decl, env) {
  const q = evalValueExpr(decl.expr, env);
  // Dim check only when both annotation parses as a known dim AND the value
  // is a Quantity. Non-Quantity values (List/Bool/String/fn) skip — proper
  // typecheck for those is future work.
  if (decl.dim !== null && q instanceof Quantity) {
    let expected;
    try { expected = evalDimExpr(decl.dim, env); }
    catch { expected = null; }  // annotation isn't a dim — skip check
    if (expected !== null && !dimEq(expected, q.dim)) {
      throw new Error(`let '${decl.name}': annotated dimension does not match value expression`);
    }
  }
  env.values.set(decl.name, q);
  // Apply @aliases — extra names binding to the same value. Upstream uses this
  // for things like `let speed_of_light @aliases(c)`, `@aliases(µ0, μ0, mu0)`.
  const meta = decoratorInfo(decl.decorators);
  for (const alias of meta.aliases) {
    if (!env.values.has(alias)) env.values.set(alias, q);
  }
  for (const sa of meta.shortAliases) {
    if (!env.values.has(sa)) env.values.set(sa, q);
  }
}

// ── convenience: tokenize + parse + load in one call ─────────────

export function loadSource(text, sourceName, env) {
  const tokens = tokenize(text, sourceName);
  const ast = parse(tokens, sourceName);
  loadModule(ast, env);
}

// Build the env object used by the loader. Hosts that want to use the
// loader directly (without going through the Numbat class) call this.
export function makeEnv({ dims, units, values, fns, structs, resolveUse }) {
  const env = {
    dims,
    units,
    values,
    fns:     fns     ?? new Map(),
    structs: structs ?? new Map(),
    resolveUse: resolveUse ?? (() => {}),
  };
  // Identifier lookup with first-class fn support. Order: let bindings > user
  // fns (wrapped as JS callables for higher-order use) > builtins > units.
  env.lookupValue = (name) => {
    if (values.has(name)) return values.get(name);
    if (env.fns.has(name)) {
      const userFn = env.fns.get(name);
      return (...args) => invokeUserFn(userFn, name, args, env);
    }
    if (BUILTIN_FNS[name])   return (q) => BUILTIN_FNS[name](q);
    if (BUILTIN_PROCS[name]) return (...args) => BUILTIN_PROCS[name](args);
    const u = units.resolve(name);
    if (u) return new Quantity(u.mul, u.dim);
    return null;
  };
  return env;
}
