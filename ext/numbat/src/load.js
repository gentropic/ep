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
  floor(q) { return new Quantity(Math.floor(q.value), q.dim); },
  ceil(q)  { return new Quantity(Math.ceil(q.value),  q.dim); },
  round(q) { return new Quantity(Math.round(q.value), q.dim); },
};

function mustBeDimensionless(q, fnName) {
  if (!dimEmpty(q.dim)) throw new Error(`${fnName}: argument must be dimensionless`);
}

const EVAL_CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

export function evalValueExpr(node, env) {
  if (node.type === 'Num')  return new Quantity(node.value, {});
  if (node.type === 'Bool') return node.value;   // JS boolean
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
  if (node.type === 'Unary' && node.op === '-') {
    return evalValueExpr(node.expr, env).neg();
  }
  if (node.type === 'Binary') {
    if (EVAL_CMP_OPS.has(node.op)) return evalCmp(node, env);
    if (node.op === '->') {
      const left = evalValueExpr(node.left, env);
      // Single-identifier target (with optional parens). Compound targets like
      // `q -> m/s` need a compound display mechanism — v0.4+.
      let target = node.right;
      while (target.type === 'Paren') target = target.expr;
      if (target.type === 'Ident') {
        return left.convertTo(target.name, env.units);
      }
      throw new Error('-> target must be a single unit name (compound targets coming in v0.4+)');
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

// Comparison: both operands must be Quantities with the same dim. `==`/`!=`
// also accept booleans (so `is_empty(xs) == true` works once lists land).
function evalCmp(node, env) {
  const l = evalValueExpr(node.left, env);
  const r = evalValueExpr(node.right, env);
  if (typeof l === 'boolean' || typeof r === 'boolean') {
    if (node.op !== '==' && node.op !== '!=') {
      throw new Error(`${node.op}: ordering not defined on booleans`);
    }
    if (typeof l !== typeof r) {
      throw new Error(`${node.op}: cannot compare Bool with Quantity`);
    }
    return node.op === '==' ? l === r : l !== r;
  }
  if (!dimEq(l.dim, r.dim)) {
    throw new Error(`${node.op}: dim mismatch [${JSON.stringify(l.dim)}] vs [${JSON.stringify(r.dim)}]`);
  }
  switch (node.op) {
    case '==': return l.value === r.value;
    case '!=': return l.value !== r.value;
    case '<':  return l.value <  r.value;
    case '<=': return l.value <= r.value;
    case '>':  return l.value >  r.value;
    case '>=': return l.value >= r.value;
  }
}

// Evaluate a function call. User-defined fns take precedence over builtins so
// users can shadow them if they really want to.
function evalCall(node, env) {
  const userFn = env.fns?.get(node.name);
  if (userFn) {
    if (node.args.length !== userFn.params.length) {
      throw new Error(`${node.name}: expected ${userFn.params.length} args, got ${node.args.length}`);
    }
    const argVals = node.args.map(a => evalValueExpr(a, env));
    // Lexical scope: parameters layered on top of the outer scope's let-bindings.
    const fnValues = new Map(env.values);
    for (let i = 0; i < userFn.params.length; i++) {
      fnValues.set(userFn.params[i].name, argVals[i]);
    }
    // Helper: rebuild env with the current fnValues snapshot.
    const buildFnEnv = () => ({
      ...env,
      values: fnValues,
      lookupValue: (name) => {
        if (fnValues.has(name)) return fnValues.get(name);
        const u = env.units.resolve(name);
        if (u) return new Quantity(u.mul, u.dim);
        return null;
      },
    });
    // Evaluate where clauses in declaration order; each clause sees the params
    // and earlier clauses.
    if (userFn.whereClauses) {
      for (const clause of userFn.whereClauses) {
        const v = evalValueExpr(clause.expr, buildFnEnv());
        fnValues.set(clause.name, v);
      }
    }
    const fnEnv = buildFnEnv();
    // Optional return-type check
    const result = evalValueExpr(userFn.body, fnEnv);
    if (userFn.returnType) {
      const expected = evalDimExpr(userFn.returnType, env);
      if (!dimEq(expected, result.dim)) {
        throw new Error(`${node.name}: return type mismatch (annotated [${JSON.stringify(expected)}] vs result [${JSON.stringify(result.dim)}])`);
      }
    }
    return result;
  }
  const builtin = BUILTIN_FNS[node.name];
  if (builtin) {
    if (node.args.length !== 1) {
      throw new Error(`${node.name}: built-in takes 1 argument, got ${node.args.length}`);
    }
    return builtin(evalValueExpr(node.args[0], env));
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
          if (arg.modifier === 'short') info.shortAliases.push(arg.name);
          else                          info.aliases.push(arg.name);
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
        default:
          throw new Error(`unsupported declaration: ${decl.type}`);
      }
    } catch (e) {
      const where = `${ast.source ?? '<module>'}: ${decl.name ?? decl.type}`;
      throw new Error(`${where}: ${e.message}`);
    }
  }
}

function loadFnDecl(decl, env) {
  if (!env.fns) env.fns = new Map();
  // Store the AST + parameter info for later invocation. No type-check yet —
  // dimension annotations on params and return type are verified at call time.
  env.fns.set(decl.name, {
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
  if (decl.dim !== null) {
    const expected = evalDimExpr(decl.dim, env);
    if (!dimEq(expected, q.dim)) {
      throw new Error(`let '${decl.name}': annotated dimension does not match value expression`);
    }
  }
  env.values.set(decl.name, q);
}

// ── convenience: tokenize + parse + load in one call ─────────────

export function loadSource(text, sourceName, env) {
  const tokens = tokenize(text, sourceName);
  const ast = parse(tokens, sourceName);
  loadModule(ast, env);
}

// Build the env object used by the loader. Hosts that want to use the
// loader directly (without going through the Numbat class) call this.
export function makeEnv({ dims, units, values, fns, resolveUse }) {
  return {
    dims,
    units,
    values,
    fns: fns ?? new Map(),
    lookupValue: (name) => {
      if (values.has(name)) return values.get(name);
      const u = units.resolve(name);
      if (u) return new Quantity(u.mul, u.dim);
      return null;
    },
    resolveUse: resolveUse ?? (() => {}),
  };
}
