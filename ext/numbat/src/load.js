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

export function evalValueExpr(node, env) {
  if (node.type === 'Num') return new Quantity(node.value, {});
  if (node.type === 'Ident') {
    const q = env.lookupValue(node.name);
    if (!q) throw new Error(`unknown identifier: ${node.name}`);
    return q;
  }
  if (node.type === 'Paren') return evalValueExpr(node.expr, env);
  if (node.type === 'Unary' && node.op === '-') {
    return evalValueExpr(node.expr, env).neg();
  }
  if (node.type === 'Binary') {
    if (node.op === '->') {
      throw new Error('-> conversion in value expressions not supported in v0.2');
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
        default:
          throw new Error(`unsupported declaration: ${decl.type}`);
      }
    } catch (e) {
      const where = `${ast.source ?? '<module>'}: ${decl.name ?? decl.type}`;
      throw new Error(`${where}: ${e.message}`);
    }
  }
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
export function makeEnv({ dims, units, values, resolveUse }) {
  return {
    dims,
    units,
    values,
    lookupValue: (name) => {
      if (values.has(name)) return values.get(name);
      const u = units.resolve(name);
      if (u) return new Quantity(u.mul, u.dim);
      return null;
    },
    resolveUse: resolveUse ?? (() => {}),
  };
}
