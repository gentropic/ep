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

export function formatDim(dimExpr) {
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
