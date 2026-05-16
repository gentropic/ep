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
export function formatEpBody(source, opts = {}) {
  const width = opts.width || TARGET_WIDTH;
  let statements;
  try {
    statements = parseEpBody(source);
  } catch {
    // Tokenizer failed — return source unchanged rather than risk
    // destroying the user's program with a half-formatted result.
    return source;
  }

  // Numbat's tokenizer drops comments, so the parser never sees them. Scan
  // the source separately and attach each comment to a statement (or to
  // the document's leading/trailing region) so the formatter can re-emit.
  attachComments(source, statements);

  const out = [];
  // Leading whole-line comments (before the first statement).
  if (statements.length && statements[0]._leadingComments) {
    for (const c of statements[0]._leadingComments) out.push(c);
  } else if (!statements.length) {
    // Document with only comments / blanks — emit comments unchanged.
    const onlyComments = extractAllWholeLineComments(source);
    if (onlyComments.length) {
      for (const c of onlyComments) out.push(c);
      return out.join('\n') + '\n';
    }
  }

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    // Emit decorators, one per line, in original order.
    for (const dec of stmt.decorators) {
      out.push(formatDecorator(dec, width));
    }
    // Emit the binding/expression body, possibly broken across lines.
    const bodyLines = formatStatementBody(stmt.bodyText, width, stmt._trailingComment);
    for (const l of bodyLines) out.push(l);
    // Comments that sat BETWEEN this statement and the next (or after the
    // last one) get emitted before the blank-line separator so they stay
    // visually grouped with the statement they follow.
    if (stmt._intervalComments) {
      for (const c of stmt._intervalComments) out.push(c);
    }
    // One blank line between top-level statements.
    if (i < statements.length - 1) out.push('');
  }

  // Trim leading / trailing blank lines and ensure the document ends with
  // a single trailing newline (POSIX convention).
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

// Walk the source line by line and attach comments to statements.
//
// Rules:
//   - Whole-line comments BEFORE the first statement (and any blank lines
//     mixed in) → statements[0]._leadingComments
//   - Whole-line comments AFTER a statement's last line, before the next
//     statement's first line → previous statement's _intervalComments
//   - Whole-line comments AFTER the last statement → last statement's
//     _intervalComments (so they end up at the bottom of the document)
//   - Trailing comment on a statement's binding line (e.g., `x = 5 # …`)
//     → that statement's _trailingComment
//
// Comments INSIDE a multi-line statement (e.g., between two args of a
// multi-line call) are dropped. Rare enough to ignore for v0; can be
// addressed later by tracking them per-statement and re-emitting in the
// multi-line break path.
function attachComments(source, statements) {
  const lines = source.split('\n');
  if (!statements.length) return;
  let cursor = 0;                       // 1-indexed source line we're at
  for (let s = 0; s < statements.length; s++) {
    const stmt = statements[s];
    stmt._leadingComments = [];
    stmt._intervalComments = [];
    stmt._trailingComment = '';
    // Lines from `cursor` (exclusive of previous statement) up to but not
    // including stmt.startLine — these are the leading interval.
    const intervalBefore = collectCommentsInRange(lines, cursor + 1, stmt.startLine - 1);
    if (s === 0) {
      stmt._leadingComments = intervalBefore;
    } else {
      statements[s - 1]._intervalComments.push(...intervalBefore);
    }
    // Trailing comment on the binding line itself.
    const bindingLineText = lines[stmt.bindingLine - 1] || '';
    const trailing = extractTrailingComment(bindingLineText);
    if (trailing) stmt._trailingComment = trailing;
    cursor = stmt.endLine;
  }
  // Anything after the last statement → its _intervalComments.
  const last = statements[statements.length - 1];
  const afterLast = collectCommentsInRange(lines, last.endLine + 1, lines.length);
  if (afterLast.length) last._intervalComments.push(...afterLast);
}

// Return whole-line comments (preserving their original text including
// any leading indentation) within the inclusive 1-indexed line range.
// Skips blank lines. If multiple comments appear back-to-back, returns
// them as separate entries (formatter emits each on its own line).
function collectCommentsInRange(lines, fromLine, toLine) {
  const out = [];
  for (let i = fromLine; i <= toLine; i++) {
    const raw = lines[i - 1];
    if (raw === undefined) continue;
    const t = raw.trim();
    if (t === '') continue;
    if (t.startsWith('#') || t.startsWith('--')) {
      out.push(raw.replace(/\s+$/, ''));
    }
  }
  return out;
}

function extractAllWholeLineComments(source) {
  return collectCommentsInRange(source.split('\n'), 1, source.split('\n').length);
}

// Strip a trailing `# …` or `-- …` comment from a single-line body and
// return just the comment portion (or '' if there isn't one). String-
// aware: `#` inside `"..."` doesn't count.
function extractTrailingComment(text) {
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
      // Only treat as trailing if there's actual code before it.
      const before = text.slice(0, k).trim();
      if (!before) return '';
      return text.slice(k).replace(/\s+$/, '');
    }
  }
  return '';
}

// Format `@name` or `@name(arg, arg, ...)`. Args are emitted single-line if
// they fit; otherwise broken into one-per-line form. Recursive nesting in
// decorator args isn't supported (numbat's decorator grammar only allows
// flat id/string args), so this stays simple.
function formatDecorator(dec, width) {
  const head = '@' + dec.name;
  if (!dec.args || dec.args.length === 0) return head;
  const singleLine = head + '(' + dec.args.join(', ') + ')';
  if (singleLine.length <= width) return singleLine;
  return head + '(\n' + dec.args.map(a => '  ' + a + ',').join('\n') + '\n)';
}

// Format a binding / expression body. Returns string[] (one per physical
// line). The body is whatever came after the decorators — typically
// `name [: anno] = expr` or `fn ...` or a naked expression. `trailing`
// (already pre-extracted by attachComments) is the `# …` text that
// originally sat at the end of the binding line; we re-append it.
function formatStatementBody(bodyText, width, trailing) {
  // Drop any trailing comment that's still inside bodyText so the
  // single-line / break logic doesn't include it in the width math.
  const stripped = stripTrailingCommentText(bodyText);

  const bindingMatch = stripped.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*([^=]+?))?\s*=\s*([\s\S]+)$/);
  if (bindingMatch) {
    const name = bindingMatch[2];
    const anno = bindingMatch[3] ? bindingMatch[3].trim() : null;
    const rhs  = bindingMatch[4].trim();
    const prefix = anno ? `${name} : ${anno} = ` : `${name} = `;
    const singleLine = prefix + normalizeExprSpacing(rhs);
    const trailingSuffix = trailing ? '  ' + trailing : '';
    if (singleLine.length + trailingSuffix.length <= width) {
      return [singleLine + trailingSuffix];
    }
    const broken = breakCallExpression(rhs, width, prefix.length)
                || breakArithmeticExpression(rhs);
    if (broken) {
      const lines = (prefix + broken).split('\n');
      if (trailing) lines[0] += trailingSuffix;
      return lines;
    }
    return [singleLine + trailingSuffix];
  }

  // Non-binding (fn decl, dim decl, expr, etc.) — leave the user's
  // whitespace inside the expression alone but normalize trailing.
  const lines = stripped.split('\n').map(l => l.replace(/\s+$/, ''));
  if (trailing && lines.length) lines[lines.length - 1] += '  ' + trailing;
  return lines;
}

// Remove a trailing `# …` / `-- …` comment from text (string-aware).
// Returns the text without the comment; doesn't return the comment.
function stripTrailingCommentText(text) {
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
      // Only strip if there's code before it — otherwise the whole line is
      // a comment and we leave it alone.
      const before = text.slice(0, k).trim();
      if (!before) return text;
      return text.slice(0, k).replace(/\s+$/, '');
    }
  }
  return text;
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

// Wrap a long arithmetic RHS in parens and break at the LOWEST-precedence
// binary operator(s) at top level. Precedence-aware so the visual
// grouping reflects evaluation order — e.g.
//
//   total = base + adjust * factor / divisor + extra
//
// breaks at the two `+` (precedence 1) and keeps the `*` / `/` chain
// (precedence 2) inline on its line. Returns null if there are no
// breakable top-level binary ops (e.g., a single function call we
// already handled, or a bare identifier).
//
// Pure additive `-` and unary `-` are distinguished by lookback: a `-`
// after another op (or at position 0) is unary and not a break point.
function breakArithmeticExpression(rhs) {
  let tokens;
  try { tokens = tokenize(rhs, '<fmt>'); }
  catch { return null; }
  if (tokens.length < 3) return null;

  const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const ops = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'op') continue;
    if (t.op === '(' || t.op === '[') { depth++; continue; }
    if (t.op === ')' || t.op === ']') { depth--; continue; }
    if (depth !== 0) continue;
    if (!(t.op in PREC)) continue;
    // Unary +/- check: must have a non-op prev token (or a closing paren).
    if (t.op === '+' || t.op === '-') {
      const prev = tokens[i - 1];
      const prevIsOperand = prev && (prev.type !== 'op' || prev.op === ')' || prev.op === ']');
      if (!prevIsOperand) continue;
    }
    ops.push({ index: i, op: t.op, prec: PREC[t.op] });
  }
  if (!ops.length) return null;
  const minPrec = Math.min(...ops.map(o => o.prec));
  const breaks = ops.filter(o => o.prec === minPrec);
  if (breaks.length < 1) return null;

  // Build segments split at the chosen break positions. Operator floats
  // to the start of the next line (Prettier convention) — easier to scan
  // the operator column at a glance.
  const segs = [];
  let segStart = 0;
  for (const b of breaks) {
    const segTokens = tokens.slice(segStart, b.index);
    if (segTokens.length) {
      segs.push({ text: sliceTokens(rhs, segTokens), opBefore: null });
    }
    segStart = b.index + 1;
    // The op itself becomes a leading symbol on the next segment.
    // We capture it once we know the segment text.
    if (segs.length) segs[segs.length - 1]._opAfter = b.op;
  }
  if (segStart < tokens.length) {
    segs.push({ text: sliceTokens(rhs, tokens.slice(segStart)), opBefore: null });
  }
  if (segs.length < 2) return null;

  // Reflow: the operator lives at the START of the line it joins.
  const indent = '  ';
  const lines = [];
  for (let i = 0; i < segs.length; i++) {
    if (i === 0) {
      lines.push(indent + segs[0].text.trim());
    } else {
      const opFromPrev = segs[i - 1]._opAfter;
      lines.push(indent + opFromPrev + ' ' + segs[i].text.trim());
    }
  }
  return '(\n' + lines.join('\n') + '\n)';
}

function sliceTokens(source, toks) {
  if (!toks.length) return '';
  return source.slice(toks[0].span.offset, toks[toks.length - 1].span.end);
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
