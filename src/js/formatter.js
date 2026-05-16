// ep-script formatter. Three layers:
//
//   v0 — whitespace normalization: trim trailing spaces, collapse blank-line
//        runs to one, normalize indentation of continuation lines.
//   v1 — opinionated layout: decorators stack flush above their binding (no
//        blank lines between them); one blank line between top-level
//        statements; the document never starts or ends with a blank line.
//   v2 — line-width-aware: function calls (and @options arg lists) that
//        would exceed the target width get broken into one-argument-per-line
//        form. Long arithmetic / string literals are left alone.
//
// The formatter is text-in / text-out. evaluate() and CM6 are not involved
// — callers just dispatch the new text into the editor, which triggers the
// normal evaluate + render pipeline.

import { parseEpBody } from './evaluator.js';
import { tokenize } from '../../ext/numbat/dist/numbat.js';

// 40 chars matches the usable width on the narrowest mobile viewport
// after the floating result gutter steals its share of the editor. Wider
// viewports get under-utilized space — preferred to a width that breaks
// readability on phones. Single value (not responsive) so the same source
// file looks consistent regardless of where it was last formatted.
const TARGET_WIDTH = 40;

// Public entry. Returns formatted source text. Idempotent: format(format(s)) === format(s).
// Pure function — no state / DOM access, importable from Node tests.
export function formatEpBody(source) {
  let statements;
  try {
    statements = parseEpBody(source);
  } catch {
    // Tokenizer failed — return source unchanged rather than risk
    // destroying the user's program with a half-formatted result.
    return source;
  }

  const out = [];
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    // Emit decorators, one per line, in original order.
    for (const dec of stmt.decorators) {
      out.push(formatDecorator(dec));
    }
    // Emit the binding/expression body, possibly broken across lines.
    const bodyLines = formatStatementBody(stmt.bodyText, TARGET_WIDTH);
    for (const l of bodyLines) out.push(l);
    // One blank line between top-level statements.
    if (i < statements.length - 1) out.push('');
  }

  // Trim leading / trailing blank lines and ensure the document ends with
  // a single trailing newline (POSIX convention).
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

// Format `@name` or `@name(arg, arg, ...)`. Args are emitted single-line if
// they fit; otherwise broken into one-per-line form. Recursive nesting in
// decorator args isn't supported (numbat's decorator grammar only allows
// flat id/string args), so this stays simple.
function formatDecorator(dec) {
  const head = '@' + dec.name;
  if (!dec.args || dec.args.length === 0) return head;
  const singleLine = head + '(' + dec.args.join(', ') + ')';
  if (singleLine.length <= TARGET_WIDTH) return singleLine;
  return head + '(\n' + dec.args.map(a => '  ' + a + ',').join('\n') + '\n)';
}

// Format a binding / expression body. Returns string[] (one per physical
// line). The body is whatever came after the decorators — typically
// `name [: anno] = expr` or `fn ...` or a naked expression.
function formatStatementBody(bodyText, width) {
  const trimmed = bodyText.replace(/\s+$/, '');
  // Strip a trailing comment so we can normalize spacing on the value half;
  // re-append at the end. (Trailing comments on bindings are rare now that
  // @options(…) is a real decorator, but we preserve any the user wrote.)
  const { code, trailing } = splitTrailingComment(trimmed);

  // For bindings, try `name [: anno] = expr` on one line. If too long
  // AND the RHS is a function call, break the call's args.
  const bindingMatch = code.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*([^=]+?))?\s*=\s*([\s\S]+)$/);
  if (bindingMatch) {
    const name = bindingMatch[2];
    const anno = bindingMatch[3] ? bindingMatch[3].trim() : null;
    const rhs  = bindingMatch[4].trim();
    const prefix = anno ? `${name} : ${anno} = ` : `${name} = `;
    const singleLine = prefix + normalizeExprSpacing(rhs);
    if (singleLine.length + (trailing ? trailing.length + 2 : 0) <= width) {
      return [singleLine + (trailing ? '  ' + trailing : '')];
    }
    // Too wide. If the RHS is a function call, break args.
    const broken = breakCallExpression(rhs, width, prefix.length);
    if (broken) {
      const lines = (prefix + broken).split('\n');
      if (trailing) lines[0] += '  ' + trailing;
      return lines;
    }
    // Can't break — emit single-line and accept the overflow.
    return [singleLine + (trailing ? '  ' + trailing : '')];
  }

  // Non-binding (fn decl, dim decl, expr, etc.) — leave the user's
  // whitespace inside the expression alone but normalize trailing.
  return code.split('\n').map(l => l.replace(/\s+$/, ''));
}

// Strip a trailing `# …` or `-- …` comment from a single-line body.
// String-aware so `# inside "..."` isn't mistaken for a marker.
function splitTrailingComment(text) {
  let inStr = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (c === '\\' && k + 1 < text.length) { k++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '#' || (c === '-' && text[k + 1] === '-')) {
      return { code: text.slice(0, k).replace(/\s+$/, ''), trailing: text.slice(k) };
    }
  }
  return { code: text, trailing: '' };
}

// Whitespace normalization for an expression that fits on one line:
// single space around binary operators, single space after commas, no
// extra whitespace. Uses the tokenizer so we don't get confused by
// strings or numeric formatting.
// Collapse a possibly-multi-line expression to a single line. We don't
// aggressively re-space operator-by-operator — users have strong
// preferences about how compound units read (`g/cm3` snug vs `g / cm3`
// spaced) and the formatter shouldn't override them. So we only:
//   - Replace newlines (and surrounding whitespace) with a single space.
//   - Remove space right after `(` / `[` and right before `)` / `]`.
//   - Collapse multi-space runs to one.
//   - Strip trailing commas before a close bracket — legal but ugly.
function normalizeExprSpacing(expr) {
  let out = expr;
  out = out.replace(/\s*\n\s*/g, ' ');                // newlines → spaces
  out = out.replace(/,\s*([)\]])/g, '$1');            // strip trailing commas
  out = out.replace(/([(\[])\s+/g, '$1');             // no space after opener
  out = out.replace(/\s+([)\]])/g, '$1');             // no space before closer
  out = out.replace(/[ \t]{2,}/g, ' ');               // collapse multi-space
  return out.trim();
}

// Reconstruct the literal text of a token from the source. Numbat
// tokens have span: { offset, end }.
function tokenText(t, source) {
  if (t.span && typeof t.span.offset === 'number' && typeof t.span.end === 'number') {
    return source.slice(t.span.offset, t.span.end);
  }
  // Defensive fallback — should never hit for numbat tokens.
  if (t.type === 'id' || t.type === 'kw' || t.type === 'dec') return t.name;
  if (t.type === 'num') return t.raw ?? String(t.value);
  if (t.type === 'str') return JSON.stringify(t.value);
  if (t.type === 'op')  return t.op;
  return '';
}

// If `rhs` is a function call whose args don't fit, emit broken form:
//
//   funcname(
//     arg1,
//     arg2,
//     …
//   )
//
// Returns null if rhs isn't a function call shape we can break.
function breakCallExpression(rhs, width, indentCols) {
  let tokens;
  try { tokens = tokenize(rhs, '<fmt>'); }
  catch { return null; }
  if (tokens.length < 3) return null;
  // First token: identifier (the callee). Second token: `(`. Last token: `)`.
  const first = tokens[0];
  const second = tokens[1];
  if (first.type !== 'id' && first.type !== 'kw') return null;
  if (second.type !== 'op' || second.op !== '(') return null;
  const last = tokens[tokens.length - 1];
  if (last.type !== 'op' || last.op !== ')') return null;
  // Walk inner tokens and split at top-level commas.
  const args = [];
  let depth = 0;
  let cur = [];
  for (let i = 2; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (t.type === 'op') {
      if (t.op === '(' || t.op === '[') depth++;
      else if (t.op === ')' || t.op === ']') depth--;
      if (depth === 0 && t.op === ',') {
        args.push(cur);
        cur = [];
        continue;
      }
    }
    cur.push(t);
  }
  if (cur.length) args.push(cur);
  if (!args.length) return null;
  // Render each arg by slicing the original source between its first and
  // last token. This preserves the user's intra-arg spacing (e.g.,
  // `2.7 g/cm3` stays `2.7 g/cm3`, not `2.7 g / cm3`).
  const indent = ' '.repeat(2);
  const renderedArgs = args.map(toks => {
    const startOff = toks[0].span.offset;
    const endOff   = toks[toks.length - 1].span.end;
    return rhs.slice(startOff, endOff).replace(/\s+/g, ' ').trim();
  });
  return first.name + '(\n' + renderedArgs.map(a => indent + a + ',').join('\n') + '\n)';
}
