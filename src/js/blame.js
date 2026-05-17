// Bidirectional blame walker for @output dim mismatches.
//
// When `@output(unit)` on a binding doesn't match the value's actual
// dim, this walker tries to identify the offending sub-term — typically
// one misplaced Ident (e.g. `thickness` bound to a Time value when the
// chain expected Length).
//
// Algorithm: collect every Ident leaf in the expression with its sign
// in the multiplicative chain (+1 for `a` in `a * …`, −1 for `b` in
// `… / b`). Then for each leaf compute the dim it WOULD need to have
// for the whole chain to produce the expected dim — leaving every other
// leaf unchanged. The leaf whose "required dim" has the lowest
// complexity (fewest base-axis contributions) is the most likely
// culprit.
//
// For `volume = length * width * thickness` with `thickness = 8 ms`
// and `@output(m^3)`:
//   ratio = expected / actual = length^3 / (length^2·time) = length·time⁻¹
//   length's required = length × ratio = length²·time⁻¹  (complexity 3)
//   width's  required = length × ratio = length²·time⁻¹  (complexity 3)
//   thickness's required = time × ratio = length        (complexity 1) ← BLAME
//
// Handles only multiplicative chains (`* / ^ unary-minus paren`).
// Bails on `+ - == … fn-call …` shapes: returns null and the caller
// falls back to its local-mismatch message.

import { dimMul, dimDiv, dimPow, dimEq, dimEmpty } from '../../ext/numbat/dist/numbat.js';

function lookupDim(name, env) {
  const v = env.values?.get?.(name);
  if (v && typeof v === 'object' && v.dim) return v.dim;
  const u = env.units?.resolve?.(name);
  if (u) return u.dim;
  return null;
}

// Walk multiplicative subexpressions, collecting every reachable Ident
// leaf with its (signed integer) exponent in the chain. +1 for `a` in
// `a * …`, −1 for `b` in `… / b`, +2 for `a^2`, −2 for `… / a^2`, etc.
// Returns `null` if the AST contains a shape we can't reason about
// (function call, list, field access, conditional, addition/subtraction,
// non-const exponent, comparison, etc.).
function collectMulChainLeaves(node, exponent, out) {
  if (!node) return false;
  switch (node.type) {
    case 'Paren': return collectMulChainLeaves(node.expr, exponent, out);

    case 'Unary':
      // Unary `-` doesn't change dim; walk through.
      if (node.op === '-') return collectMulChainLeaves(node.expr, exponent, out);
      return false;

    case 'Ident': {
      out.push({ node, exponent });
      return true;
    }

    case 'Num': {
      // Numeric literals are Scalar — identity contribution. Skip.
      return true;
    }

    case 'Binary': {
      if (node.op === '*') {
        return collectMulChainLeaves(node.left,  exponent, out)
            && collectMulChainLeaves(node.right, exponent, out);
      }
      if (node.op === '/') {
        return collectMulChainLeaves(node.left,  exponent,      out)
            && collectMulChainLeaves(node.right, -exponent,     out);
      }
      if (node.op === '^') {
        // a^n with const integer exp — multiply the exponent through.
        if (node.right.type !== 'Num' || !Number.isInteger(node.right.value)) return false;
        const exp = node.right.value;
        if (exp === 0) return true;
        return collectMulChainLeaves(node.left, exponent * exp, out);
      }
      if (node.op === '->') {
        // Conversion: dim preserved. Walk the value side; ignore the
        // right (it's a unit reference).
        return collectMulChainLeaves(node.left, exponent, out);
      }
      return false;   // +, -, comparisons, logical ops → bail
    }

    default:
      return false;   // Call / Field / List / StructInit / If / Factorial
  }
}

// Combined dim of all leaves, each raised to its (signed integer)
// exponent. Returns null if any leaf's dim isn't resolvable.
function dimFromLeaves(leaves, env) {
  let d = {};
  for (const { node, exponent } of leaves) {
    const ld = lookupDim(node.name, env);
    if (!ld) return null;
    d = dimMul(d, dimPow(ld, exponent));
  }
  return d;
}

function complexity(dim) {
  let n = 0;
  for (const k in dim) n += Math.abs(dim[k]);
  return n;
}

// Heuristic: among the leaves whose "required dim" (the dim they'd need
// to have for the chain to match `expected`) differs from their actual
// dim, pick the one whose required dim has the lowest complexity.
// Returns `{name, span, actual, expected}` or null.
export function traceBlame(node, expected, env) {
  const leaves = [];
  if (!collectMulChainLeaves(node, 1, leaves)) return null;
  if (leaves.length === 0) return null;

  const actualTotal = dimFromLeaves(leaves, env);
  if (!actualTotal) return null;
  if (dimEq(actualTotal, expected)) return null;   // nothing to blame

  // ratio = expected / actualTotal. For a leaf with exponent k, the
  // total contains leaf.actual^k. To make total = expected we'd need
  // leaf.required^k = leaf.actual^k × ratio, i.e.
  // leaf.required = leaf.actual × ratio^(1/k). When ratio's exponents
  // aren't cleanly divisible by k, that leaf can't be the sole culprit.
  const ratio = dimDiv(expected, actualTotal);
  if (dimEmpty(ratio)) return null;

  let best = null;
  for (const { node: leafNode, exponent } of leaves) {
    if (exponent === 0) continue;
    const actual = lookupDim(leafNode.name, env);
    if (!actual) continue;
    // ratio^(1/exponent) requires each base-axis exponent to be
    // divisible by `exponent`. Otherwise the leaf can't have a
    // clean dim that fixes the chain.
    const adjust = {};
    let cleanRoot = true;
    for (const k in ratio) {
      const e = ratio[k] / exponent;
      if (!Number.isInteger(e)) { cleanRoot = false; break; }
      if (e) adjust[k] = e;
    }
    if (!cleanRoot) continue;
    const required = dimMul(actual, adjust);
    if (dimEq(actual, required)) continue;
    const c = complexity(required);
    if (!best || c < best.complexity) {
      best = { name: leafNode.name, span: leafNode.span ?? null,
               actual, expected: required, complexity: c };
    }
  }
  if (!best) return null;
  return { name: best.name, span: best.span, actual: best.actual, expected: best.expected };
}
