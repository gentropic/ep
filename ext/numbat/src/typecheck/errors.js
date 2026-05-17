// Error formatting for typecheck diagnostics.
//
// Takes the (message, span) records that solve() produces and turns them
// into multi-line strings with source snippets and caret pointers —
// Rust-/upstream-Numbat-style. Span-less errors degrade gracefully to
// just the message text.
//
// Dim formatting upgraded over `formatType`'s debug form: capitalized
// base names (Length, not length), Unicode superscripts where they make
// sense, fractional exponents shown as "^(1/2)" rather than "^0.5".

import { ratFormat, ratIsZero } from './rat.js';

// ── Dim formatting ────────────────────────────────────────────────

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Unicode superscripts for common integer exponents. Fall back to ASCII
// `^N` for anything we can't render cleanly (rationals, large numbers).
const SUP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
};

function unicodeExp(n) {
  const s = String(n);
  let out = '';
  for (const ch of s) {
    if (!(ch in SUP)) return null;   // bail to ASCII form
    out += SUP[ch];
  }
  return out;
}

// Format an integer or rational exponent for display.
function formatExp(rat) {
  if (rat.d === 1) {
    if (rat.n === 1) return '';
    const u = unicodeExp(rat.n);
    return u !== null ? u : `^${rat.n}`;
  }
  return `^(${ratFormat(rat)})`;
}

export function formatDim(dimExpr, dimAliases = null) {
  // When an alias map is provided and the canonical form matches a
  // registered dim name, surface the user-facing name instead of the
  // raw base-axis form. So `density : Density = 5 kg` errors as
  // "expected Density" rather than "expected Mass·Length⁻³".
  if (dimAliases) {
    const alias = lookupDimAlias(dimExpr, dimAliases);
    if (alias) return alias;
  }
  const parts = [];
  for (const k in dimExpr.base) {
    const r = dimExpr.base[k];
    if (ratIsZero(r)) continue;
    parts.push(capitalize(k) + formatExp(r));
  }
  for (const k in dimExpr.vars) {
    const r = dimExpr.vars[k];
    if (ratIsZero(r)) continue;
    parts.push('$' + k + formatExp(r));
  }
  return parts.join('·') || 'Scalar';
}

// Canonical-string for a DimExpr — stable key for reverse lookup.
// Only base dims (no dim-vars) participate; aliases are only meaningful
// for fully-resolved concrete dims.
function dimExprCanonical(dimExpr) {
  if (Object.keys(dimExpr.vars).length > 0) return null;
  const entries = Object.entries(dimExpr.base)
    .filter(([, r]) => !ratIsZero(r))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return entries.map(([k, r]) => `${k}^${r.n}/${r.d}`).join('·');
}

function lookupDimAlias(dimExpr, aliases) {
  const key = dimExprCanonical(dimExpr);
  if (key === null) return null;
  return aliases.get(key) ?? null;
}

// Build a {canonical-string → name} map from an env's dims registry.
// Walks the env chain so inherited dims show up. When two dim names
// share a canonical form, last-seen wins (deterministic given map
// iteration order).
export function buildDimAliases(env) {
  const m = new Map();
  for (let e = env; e; e = e.parent) {
    for (const [name, dimMap] of e.dims) {
      // dimMap is the runtime shape {axis: integerExponent}. Lift to a
      // DimExpr-equivalent and canonicalize.
      const fake = { base: {}, vars: {} };
      for (const k in dimMap) fake.base[k] = { n: dimMap[k], d: 1 };
      const key = dimExprCanonical(fake);
      if (key !== null && key !== '' && !m.has(key)) m.set(key, name);
    }
  }
  return m;
}

export function formatTypePretty(t) {
  switch (t.kind) {
    case 'TBool':   return 'Bool';
    case 'TString': return 'String';
    case 'TNever':  return '!';
    case 'TVar':    return `'a${t.id}`;
    case 'TDimVar': return `$${t.id}`;
    case 'TDim':    return formatDim(t.dim);
    case 'TFn':     return `(${t.params.map(formatTypePretty).join(', ')}) -> ${formatTypePretty(t.result)}`;
    case 'TList':   return `List<${formatTypePretty(t.elem)}>`;
    case 'TTuple':  return `(${t.elems.map(formatTypePretty).join(', ')})`;
    case 'TStruct': return t.name;
    case 'TScheme': {
      const bs = [
        ...t.tvars.map(v => `'a${v.id}`),
        ...t.dimVars.map(v => `$${v.id}`),
      ].join(', ');
      return bs.length ? `∀(${bs}). ${formatTypePretty(t.body)}` : formatTypePretty(t.body);
    }
    default: return `<unknown ${t.kind}>`;
  }
}

// ── Source-snippet error formatting ───────────────────────────────

// Single-line snippet pointer:
//
//   <source>:LINE:COL: MESSAGE
//      L | … source line …
//        |   ^^^^^^ (column carets, sized to span)
//
// Multi-line spans (rare in our error set) collapse to caret-at-start.

export function formatError(err, source, sourceName) {
  const msg = err.message || '(no message)';
  const span = err.span;
  if (!span || !source) {
    const loc = sourceName ? `${sourceName}: ` : '';
    return `${loc}error: ${msg}`;
  }
  const where = `${span.source || sourceName || '<input>'}:${span.line}:${span.col}`;
  const lines = source.split('\n');
  const lineText = lines[span.line - 1] ?? '';
  const linePrefix = `   ${span.line} | `;
  const margin    = '     | ';
  // Caret width: end - offset → spanned chars. Cap at line length so we
  // don't run carets past end of line (multi-line spans degrade here).
  const startCol = Math.max(1, span.col);
  const width = Math.max(1, Math.min(
    (span.end ?? (span.offset + 1)) - span.offset,
    lineText.length - (startCol - 1),
  ));
  const carets = ' '.repeat(startCol - 1) + '^'.repeat(width);
  return [
    `${where}: error: ${msg}`,
    linePrefix + lineText,
    margin    + carets,
  ].join('\n');
}

// Render a list of errors as a single block, blank-line separated.
export function formatErrors(errors, source, sourceName) {
  return errors.map(e => formatError(e, source, sourceName)).join('\n\n');
}

// ── did-you-mean suggestion engine ────────────────────────────────
//
// Levenshtein-based: rank known names by edit distance to the typo,
// return up to N close matches (distance ≤ threshold). Used by check.js
// when surfacing "unknown identifier" / "unknown type" / "unknown
// function" errors.

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Two-row DP: rolling-array.
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insert
        prev[j] + 1,            // delete
        prev[j - 1] + cost,     // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

// Return up to `max` candidate names from `candidates`, sorted by edit
// distance to `target`. Edit-distance threshold scales with target
// length — short names need to match tighter (a 3-char identifier with
// a 2-edit allowance produces too much noise).
export function didYouMean(target, candidates, max = 3, threshold = null) {
  if (!target || !candidates?.length) return [];
  const cap = threshold ?? (target.length <= 2 ? 0 : target.length <= 4 ? 1 : 2);
  const scored = [];
  for (const c of candidates) {
    const d = levenshtein(target.toLowerCase(), c.toLowerCase());
    // Include exact-match-only-different-case as a hint (user wrote
    // 'length' when the binding is 'Length' — surface the right case).
    if (d <= cap && (d > 0 || c !== target)) scored.push({ name: c, d });
  }
  scored.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  return scored.slice(0, max).map(s => s.name);
}

// Format a did-you-mean suffix to append to a "unknown X" message.
// Returns an empty string when no good candidates exist.
export function didYouMeanSuffix(target, candidates) {
  const matches = didYouMean(target, candidates);
  if (matches.length === 0) return '';
  if (matches.length === 1) return ` (did you mean '${matches[0]}'?)`;
  return ` (did you mean ${matches.map(m => `'${m}'`).join(' or ')}?)`;
}
