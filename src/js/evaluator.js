// Pure evaluator: classify lines, parse dimension annotations, evaluate a body
//
// v0.2 — decorator form. Inputs and outputs are now expressed as numbat-style
// decorators (`@input`, `@output[(unit)]`, `@options(a, b, c)`) on the line
// ABOVE the binding they modify, rather than via the old `@params { … }` /
// `@outputs { … }` block syntax. This matches numbat's grammar (decorators
// adorn the next declaration) so programs round-trip through pure numbat
// cleanly. See SPEC.md → "Numbat compatibility status" for the rationale.
// of ep-script statements into rows/params/outputs/scope.
//
// Expression evaluation is delegated to numbat-js: each binding/expression is
// wrapped as `let __ep__ = <expr>`, tokenized + parsed by numbat-js, and the
// expression AST is evaluated via evalValueExpr against a shared env. This
// gives ep the full Numbat surface (sin/cos/sqrt/factorial/etc.) and the full
// vendored unit/dim system "for free."
//
// What remains ep-specific:
//   - classify(): recognizes @<decorator>, # / -- comments
//   - parseAnno() + DIMENSION_OF: type-annotation syntax for parameters
//   - evaluate() loop: line-level error resilience (one bad row doesn't stop
//     siblings), reactive scope build-up across the body
//
// The Numbat host instance is created lazily and reused across evaluate()
// calls. Values are per-evaluation (fresh Map every time) so chip edits
// don't accumulate stale bindings in the host.

import { dEq, dMul, dDiv, fmtDim } from './units.js';
import { Numbat, Quantity, tokenize, parse, evalValueExpr, makeEnv, loadModule, VENDORED_MODULES, setQuantityFormatter, formatParts } from '../../ext/numbat/dist/numbat.js';

// ── Numbat host (shared across all evaluate() calls) ──────────────
// Uses the v0.1 prelude: ep's existing ore-body-shaped unit table. The
// prelude registers units only, not value bindings, so we seed common math
// constants ep historically supported. Switching to {prelude: 'vendored'}
// would pull math::constants and the full upstream SI set for free, but it
// also widens the identifier name space — defer until ep's demo is validated
// against that.

let _host = null;
function host() {
  if (_host) return _host;
  _host = new Numbat({ prelude: 'v0.1' });

  // Seed math constants. These were hardcoded in ep's old parser; replicate
  // here so existing programs keep working after the numbat-js migration.
  _host.values.set('pi',  new Quantity(Math.PI,     {}));
  _host.values.set('π',   new Quantity(Math.PI,     {}));
  _host.values.set('tau', new Quantity(Math.PI * 2, {}));
  _host.values.set('τ',   new Quantity(Math.PI * 2, {}));
  _host.values.set('e',   new Quantity(Math.E,      {}));
  _host.values.set('NaN', new Quantity(NaN,         {}));
  _host.values.set('nan', new Quantity(NaN,         {}));
  _host.values.set('inf', new Quantity(Infinity,    {}));
  _host.values.set('infinity', new Quantity(Infinity, {}));

  // Seed the standard dimensions so user-side `dimension X = ...` decls
  // resolve `Length`, `Mass`, etc. The v0.1 prelude registers units only.
  //
  // defineDerived for every entry — the dim shapes are already correct in
  // DIMENSION_OF. defineBase would allocate a fresh axis from `name`,
  // which is wrong for dimensionless dims (Scalar, Angle) where empty {}
  // is the actual desired shape, not "needs a new axis".
  for (const [name, dim] of Object.entries(DIMENSION_OF)) {
    _host.dims.defineDerived(name, dim);
  }

  // Register the 62 vendored .nbt modules so `use units::stoney` etc.
  // resolve. Modules are registered but NOT auto-loaded — the user
  // pays for what they reference.
  if (typeof VENDORED_MODULES === 'object') {
    for (const [path, source] of Object.entries(VENDORED_MODULES)) {
      _host.registerModule(path, source);
    }
  }

  // String interpolation needs a unit-formatter to render `"{v}"` as
  // "60 mph" rather than "26.8224 [?]". formatParts is module-scoped to
  // load.js by default; the load.js exposes setQuantityFormatter so
  // hosts can plug their own. We hand it the host's registry.
  if (typeof setQuantityFormatter === 'function' && typeof formatParts === 'function') {
    setQuantityFormatter(q => formatParts(q, _host.registry));
  }

  // ep prelude fn library — gcu/units parity for the most common
  // domain helpers. Loaded via numbat-script source so they're real
  // numbat functions (composable, type-checked, dimensionally-aware).
  // Add cautiously: any name here becomes a reserved identifier
  // visible to autocompletion and unshadowable from user programs.
  _host.loadSource(`
    # Cylindrical sample volume — diameter, length → volume.
    fn cylinder_volume(diameter, length) = pi / 4 * diameter^2 * length

    # Drill-core sample mass — diameter, length, density → mass.
    # Common pattern: sample_mass(NQ_core, 5 m, 2.7 g/cm3).
    fn sample_mass(diameter, length, density) =
      cylinder_volume(diameter, length) * density
  `, '<ep-prelude>');

  return _host;
}

// ── line classification ───────────────────────────────────────────

// Token-based statement parser.
//
// Replaces the old per-line regex classifier + paren-depth stitcher with a
// proper scan that uses numbat's tokenizer for boundary detection. The
// tokenizer already handles strings, comments, decorators, keywords, and
// operators with span info — we just walk tokens and find where one
// statement ends and the next begins.
//
// A statement spans some range of body lines. It may carry zero or more
// decorators (`@input`, `@output(unit)`, `@options(a, b, c)`, …) whose
// args themselves may span multiple lines. The statement boundaries are:
//   - depth-0 token transition where the next token's line > prev token's
//     line AND the next token starts a new statement (decorator keyword
//     or a bare-binding pattern)
//   - end of input
//
// Returns Statement[]:
//   { decorators: [{name, args}], bodyText: string, startLine, bindingLine, endLine }
//
// bodyText is the source of the binding/expression itself (without the
// decorator lines). startLine is the first line of the WHOLE statement
// (first decorator), bindingLine is where the binding/expr actually
// starts. All are 1-indexed to match doc lines.
export function parseEpBody(source) {
  const tokens = tokenize(source, '<body>');
  const statements = [];
  let i = 0;
  while (i < tokens.length) {
    // Collect leading decorators for this statement.
    const decorators = [];
    let startLine = tokens[i].span.line;
    while (i < tokens.length && tokens[i].type === 'dec') {
      const dec = readDecorator(tokens, i);
      decorators.push(dec.value);
      i = dec.next;
    }
    if (i >= tokens.length) {
      // Trailing decorators with no statement to attach to — drop silently.
      break;
    }
    // Statement body starts here. Find where it ends.
    const bindingStart = i;
    const bindingLine = tokens[i].span.line;
    let depth = 0;
    let end = i;
    let stopBeforeSemicolon = false;
    while (end < tokens.length) {
      const tok = tokens[end];
      if (tok.type === 'op') {
        if (tok.op === '(' || tok.op === '[' || tok.op === '{') depth++;
        else if (tok.op === ')' || tok.op === ']' || tok.op === '}') depth--;
      }
      // Semicolon at depth 0 — hard statement terminator. The semicolon
      // itself isn't part of the statement; we leave `end` pointing at
      // the last real token and skip the `;` afterwards.
      const next = tokens[end + 1];
      if (depth <= 0 && next && next.type === 'op' && next.op === ';') {
        stopBeforeSemicolon = true;
        break;
      }
      // Look at the next token: if we're at depth 0 and the next token
      // is on a later line AND starts a new statement, stop here.
      // EXCEPT when the current statement's last token is "awaiting" an
      // operand (a binary operator, `=`, `if`/`then`/`else`/`where`/`and`
      // keyword, etc.). That tells us the previous expression isn't
      // syntactically complete yet, so the next line — whatever it looks
      // like — must be its continuation. Catches the multi-line
      // `fn bump(x) =\n  if x >= 0\n    then 1\n    else 0` shape.
      if (depth <= 0 && next && next.span.line > tok.span.line
          && startsStatement(tokens, end + 1)
          && !awaitingOperand(tok)) {
        break;
      }
      end++;
    }
    // Slice the source for the binding text.
    const startOff = tokens[bindingStart].span.offset;
    const endOff = (end < tokens.length ? tokens[end].span.end : source.length);
    const bodyText = source.slice(startOff, endOff);
    const endLine = end < tokens.length ? tokens[end].span.line : tokens[tokens.length - 1].span.line;
    statements.push({
      decorators,
      bodyText,
      startLine,
      bindingLine,
      endLine,
    });
    // Skip past a terminating `;` if we stopped on one, otherwise just
    // advance past the last consumed token.
    i = end + 1;
    if (stopBeforeSemicolon && i < tokens.length && tokens[i].type === 'op' && tokens[i].op === ';') {
      i++;
    }
  }
  return statements;
}

// Decorator: `@<name>` optionally followed by `(<arg>, ...)`. Args are
// identifiers or strings. Multi-line args are fine — paren balance
// drives end detection. Returns { value: {name, args}, next: tokenIdx }.
function readDecorator(tokens, i) {
  const dec = tokens[i];
  const name = dec.name;
  let next = i + 1;
  const args = [];
  if (next < tokens.length && tokens[next].type === 'op' && tokens[next].op === '(') {
    next++;
    while (next < tokens.length) {
      const t = tokens[next];
      if (t.type === 'op' && t.op === ')') { next++; break; }
      if (t.type === 'op' && t.op === ',') { next++; continue; }
      // Arg: identifier, keyword (e.g. `let` mis-used as a name), or string
      if (t.type === 'id' || t.type === 'kw') {
        args.push(t.name);
        next++;
        // Tolerate `name: modifier` numbat syntax — swallow modifier silently
        if (next < tokens.length && tokens[next].type === 'op' && tokens[next].op === ':') {
          next++;
          if (next < tokens.length && tokens[next].type === 'id') next++;
        }
        continue;
      }
      if (t.type === 'str') {
        args.push(t.value);
        next++;
        continue;
      }
      // Unrecognized token inside decorator args — bail out gracefully.
      next++;
    }
  }
  return { value: { name, args }, next };
}

// Does the token at index i start a new statement? Called only at depth-0
// line breaks. `where` and `and` explicitly DON'T start statements — they
// continue the preceding fn declaration's where-clause chain. Everything
// else on a fresh line at top level is a new statement: a new keyword
// declaration, a new binding, or a naked expression. The previous regime
// (only id-followed-by-= counted as a binding-start) wrongly merged
// `f(x)` on a new line into the previous statement.
function startsStatement(tokens, i) {
  const t = tokens[i];
  if (!t) return false;
  // Continuation keywords — a line starting with one of these is always
  // a continuation of the previous statement, never a fresh one.
  // (`if` is NOT here: at top level it begins a new expression
  // statement. The multi-line if-in-fn-body case continues via the `=`
  // awaiting-operand path, not via `if` itself.)
  if (t.type === 'kw' && ['where','and','then','else'].includes(t.name)) return false;
  return true;
}

// Does this token leave the expression hanging — i.e., does the parser
// need MORE input after it to form a complete expression? Used to keep
// a multi-line construct (`fn f(x) =\n  if ...\n    then ...\n    else ...`)
// from being split at the wrong line break.
function awaitingOperand(tok) {
  if (!tok) return false;
  if (tok.type === 'op') {
    const ops = ['=','+','-','*','/','^','%','<','>','<=','>=','==','!=',
                 '&&','||','|>','->','→','×','÷','−',',','(','[','{',':',';'];
    return ops.includes(tok.op);
  }
  if (tok.type === 'kw') {
    return ['if','then','else','where','and','to','per'].includes(tok.name);
  }
  return false;
}

export function classify(src) {
  const t = src.trim();
  if (t === '') return {kind: 'empty'};
  if (t.startsWith('--') || t.startsWith('#')) return {kind: 'comment'};

  // Decorator line: `@<name>` or `@<name>(<arg>, …)`. Numbat-style grammar;
  // adorns the next non-trivial declaration in evaluate(). ep recognizes
  // three decorator names with semantic meaning — @input, @output, @options
  // — but classify() captures any well-formed decorator and lets evaluate()
  // decide what to do with it (other names are accepted and ignored, which
  // is also how numbat treats unknown decorators).
  const dec = t.match(/^@([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(\s*([^)]*?)\s*\))?\s*$/);
  if (dec) {
    const name = dec[1];
    const argsRaw = dec[2] || '';
    const args = argsRaw.trim()
      ? argsRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    return { kind: 'decorator', name, args };
  }

  // Numbat statement decls — single-line, routed through numbat-js's loader.
  if (/^fn\s+/.test(t)) {
    const m = t.match(/^fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
    return {kind: 'fn-decl', name: m ? m[1] : null, src: t};
  }
  if (/^dimension\s+/.test(t)) {
    const m = t.match(/^dimension\s+([A-Z][a-zA-Z0-9_]*)/);
    return {kind: 'dim-decl', name: m ? m[1] : null, src: t};
  }
  if (/^unit\s+/.test(t)) {
    const m = t.match(/^unit\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
    return {kind: 'unit-decl', name: m ? m[1] : null, src: t};
  }
  if (/^struct\s+/.test(t)) {
    const m = t.match(/^struct\s+([A-Z][a-zA-Z0-9_]*)/);
    return {kind: 'struct-decl', name: m ? m[1] : null, src: t};
  }
  if (/^use\s+/.test(t)) {
    return {kind: 'use-decl', src: t};
  }

  // Binding: `[let] name [: Type] = expr [trailing-comment]`. The optional
  // `let` keyword is stripped so chips render the same way whether or not
  // the user uses it. A trailing `# options: a, b, c` (or `-- options: ...`)
  // is captured and surfaced on the binding as `.options` so render.js can
  // render the chip as a <select> with that fixed set.
  const body = /^let\s+/.test(t) ? t.slice(4).trim() : t;
  // [\s\S]+ instead of .+ so the expr captures newlines — necessary for
  // multi-line calls stitched together by buildLogicalLines().
  const bm = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*([A-Z][a-zA-Z0-9_]*(?:\s*[/*]\s*[A-Z][a-zA-Z0-9_]*(?:\s*\^\s*-?\d+)?)*))?\s*=\s*([\s\S]+)$/);
  if (bm) {
    let expr = bm[3];
    const options = extractOptionsAnnotation(expr);
    if (options) expr = stripTrailingComment(expr);
    return {kind: 'binding', name: bm[1], anno: bm[2] || null, expr, options};
  }

  return {kind: 'expr', expr: t};
}

// `# options: a, b, c` or `-- options: a, b, c` (with optional whitespace
// before the marker). Case-insensitive on the keyword. Returns the array
// of trimmed option strings, or null if no annotation present.
function extractOptionsAnnotation(text) {
  const m = text.match(/(?:#|--)\s*options\s*:\s*(.+?)\s*$/i);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

function stripTrailingComment(text) {
  // Walk the string respecting "..." so we don't mistake `#` inside a
  // literal for a comment marker. Mirrors bracketDepth's string-aware
  // tokenization. Returns the source with the trailing comment removed
  // (whitespace before the marker also trimmed).
  let inString = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (inString) {
      if (c === '\\' && k + 1 < text.length) { k++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '#' || (c === '-' && text[k + 1] === '-')) {
      return text.slice(0, k).replace(/\s+$/, '');
    }
  }
  return text;
}

// Snapshot of names available for completion. Snapshot, not live binding —
// callers (render.js's CM6 autocomplete source, the unit picker) call this
// fresh each open. Hits the registry directly; the prelude is already loaded.
//   - units: every name that resolves (canonical + aliases + prefixed)
//   - functions: numbat-side fn names (sin/cos/sqrt/etc. from the prelude)
//   - dimensions: from ep's DIMENSION_OF table (for type annotations)
//   - keywords: ep-script keywords used by the parser
export function getCompletionData() {
  const h = host();
  const units = h.registry._units
    ? [...h.registry._units.keys()].sort()
    : [];
  const functions = h.fns
    ? [...h.fns.keys()].sort()
    : [];
  const dimensions = Object.keys(DIMENSION_OF).sort();
  const keywords = [
    'let', 'fn', 'if', 'then', 'else', 'where', 'dimension', 'unit',
    'struct', 'use', 'to', 'per', 'and', 'or', 'not', 'true', 'false',
  ];
  const decorators = ['@input', '@output', '@options'];
  return { units, functions, dimensions, keywords, decorators };
}

// Unit-picker categorization. Returns array of {category, units:[{name, displayName, dim}]}.
// Buckets units by matching their dim against entries in DIMENSION_OF; units
// whose dim doesn't match any named dimension go into "Other".
export function getUnitsByCategory() {
  const h = host();
  // Include inputOnly units — the unit-picker is an explicit user choice,
  // unlike auto-scale where inputOnly is the right filter.
  const entries = (h.registry._entries || []);
  // Build a reverse lookup of dim signature → category name.
  const dimToCategory = new Map();
  for (const [name, dim] of Object.entries(DIMENSION_OF)) {
    if (name === 'Scalar') continue;
    dimToCategory.set(dimKey(dim), name);
  }
  // Group entries by category. For each unique entry, pick the shortest
  // resolvable name as the "primary" so the picker doesn't show every
  // prefixed variant.
  const byCategory = new Map();
  for (const entry of entries) {
    const cat = dimToCategory.get(dimKey(entry.dim)) || 'Other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push({
      name: entry.displayName,
      displayName: entry.displayName,
      fullName: entry.fullName,
    });
  }
  // Stable category order: well-known dimensions first, then Other.
  const wellKnown = Object.keys(DIMENSION_OF).filter(n => n !== 'Scalar');
  const order = [...wellKnown.filter(c => byCategory.has(c)), 'Other'];
  return order
    .filter(c => byCategory.has(c))
    .map(c => ({ category: c, units: byCategory.get(c) }));
}

function dimKey(dim) {
  return Object.keys(dim).sort().map(k => `${k}:${dim[k]}`).join(',');
}

// Resolve every registered unit whose dim matches `targetDim`. Used by the
// click-the-gutter unit picker to offer a per-line display-unit override.
// Includes inputOnly units (imperial / customary) — they're excluded from
// auto-scale but the picker is an explicit user choice and Canadian /
// US-imperial datasets are real, so ft³ / lb / mi need to be reachable.
export function getCompatibleUnits(targetDim) {
  const h = host();
  const seen = new Set();
  const out = [];
  for (const e of (h.registry._entries || [])) {
    if (!dEq(e.dim, targetDim)) continue;
    if (seen.has(e.displayName)) continue;
    seen.add(e.displayName);
    out.push({ name: e.displayName, fullName: e.fullName, mul: e.mul, inputOnly: !!e.inputOnly });
  }
  out.sort((a, b) => a.mul - b.mul);
  return out;
}

// ── dimension-annotation parsing (unchanged) ──────────────────────
// ep keeps its own dimension table for annotations to avoid coupling the
// annotation syntax to numbat-js's DimRegistry state.

export const DIMENSION_OF = {
  Scalar:    {},
  Length:    {length: 1},
  Mass:      {mass: 1},
  Time:      {time: 1},
  // Angle is dimensionless to match numbat's convention (`dimension Angle = 1`
  // in `core::dimensions`). Radians are pure ratios — keeping Angle as a
  // separate axis would type-mismatch any vendored module that uses them.
  Angle:     {},
  Area:      {length: 2},
  Volume:    {length: 3},
  Density:   {mass: 1, length: -3},
  Velocity:  {length: 1, time: -1},
  Acceleration: {length: 1, time: -2},
  Force:     {mass: 1, length: 1, time: -2},
};

export function parseAnno(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      toks.push({t: 'id', v: s.slice(i, j)}); i = j; continue;
    }
    if ('*/^'.includes(c)) { toks.push({t: 'op', v: c}); i++; continue; }
    if (/[-0-9]/.test(c)) {
      let j = i; if (c === '-') j++;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      toks.push({t: 'num', v: parseInt(s.slice(i, j))}); i = j; continue;
    }
    throw new Error(`bad dim: ${c}`);
  }
  let p = 0;
  const peek = () => toks[p];
  function termD() {
    const t = peek();
    if (!t || t.t !== 'id') throw new Error('expected dimension name');
    let base;
    if (t.v in DIMENSION_OF) base = DIMENSION_OF[t.v];
    else {
      // Fall back to the host's dim registry — this picks up any
      // user-defined dims (`dimension Foo = …`, or the auto-base-dim
      // created by `unit thing`).
      try { base = host().dims.resolve(t.v); }
      catch { base = null; }
      if (!base) throw new Error(`unknown dimension: ${t.v}`);
    }
    p++;
    let d = {...base};
    if (peek() && peek().t === 'op' && peek().v === '^') {
      p++;
      const n = peek();
      if (!n || n.t !== 'num') throw new Error('expected integer after ^');
      p++;
      const r = {}; for (const k in d) r[k] = d[k] * n.v; d = r;
    }
    return d;
  }
  let l = termD();
  while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
    const op = peek().v; p++;
    const r = termD();
    l = op === '*' ? dMul(l, r) : dDiv(l, r);
  }
  return l;
}

// ── numbat-js bridge ──────────────────────────────────────────────
// Parse a single ep-script expression and evaluate it against a numbat env.
// We wrap as `let __ep__ = expr` because numbat-js's parser only accepts top-
// level declarations; we then pluck out the expression AST and run it
// directly so the temporary binding is never written to the env.

function evalExprText(text, env) {
  const tokens = tokenize(`let __ep__ = ${text}`, '<line>');
  const ast = parse(tokens, '<line>');
  if (ast.decls.length !== 1 || ast.decls[0].type !== 'LetDecl') {
    throw new Error('expected an expression');
  }
  return evalValueExpr(ast.decls[0].expr, env);
}

// Run a single-line numbat-script statement (fn / dimension / unit / use)
// against the env. Side-effects only — no value to display.
function loadStatement(text, env) {
  const tokens = tokenize(text, '<line>');
  const ast = parse(tokens, '<line>');
  loadModule(ast, env);
}

// Resolve a unit string to {mul, dim, displayName}. Tries direct registry
// lookup first (fast path for "m", "kg", "m^3", "ozt", etc.); falls back to
// parsing the text as a Numbat expression so compound forms like "ft^3",
// "kg/m^2", "lb*ft/s^2" work too.
//
// Throws "unknown unit: <text>" if neither path resolves.
export function resolveUnitExpression(unitText) {
  const h = host();
  const direct = h.registry.resolve(unitText);
  if (direct) {
    return { mul: direct.mul, dim: direct.dim, displayName: direct.displayName };
  }
  let q;
  try { q = evalExprText(unitText, freshEnv()); }
  catch { throw new Error(`unknown unit: ${unitText}`); }
  if (!q || typeof q.value !== 'number' || !q.dim) {
    throw new Error(`unknown unit: ${unitText}`);
  }
  // Prettify `^2`/`^3` to `²`/`³` for display only; conversion math is exact.
  const displayName = unitText
    .replace(/\^2(?![0-9])/g, '²')
    .replace(/\^3(?![0-9])/g, '³');
  return { mul: q.value, dim: q.dim, displayName };
}

// Build a fresh env sharing the host's units/dims/fns/structs. Values are
// seeded from the host (so math constants like pi/tau/e are visible) but
// stored in a per-evaluation Map so this program's bindings don't pollute
// the host or leak between programs.
function freshEnv() {
  const h = host();
  return makeEnv({
    dims:    h.dims,
    units:   h.registry,
    values:  new Map(h.values),
    fns:     h.fns,
    structs: h.structs,
    resolveUse: (path) => h.use(path.join('::')),
  });
}

// ── main evaluator ────────────────────────────────────────────────
// Returns {rows, params, outputs, scope, blockComplete, blocks}.
// Row shape: {kind, name, result, error, outputs, inParams}.

export function evaluate(body) {
  const source = body.map(r => r.src).join('\n');
  let statements;
  try {
    statements = parseEpBody(source);
  } catch (e) {
    // Tokenizer error — surface on row 0 and bail. (Rare; the tokenizer
    // is permissive, but malformed strings or stray `@` could trip it.)
    const rows = body.map(() => ({kind: null, name: null, result: null, error: null, outputs: null, inParams: false}));
    if (rows.length) { rows[0].error = e.message; rows[0].kind = 'expr'; }
    return { rows, params: [], outputs: [], scope: {}, blockComplete: false, blocks: [] };
  }

  const env = freshEnv();
  const params = [];
  const outputs = [];
  const rows = body.map(() => ({kind: null, name: null, result: null, error: null, outputs: null, inParams: false}));

  for (const stmt of statements) {
    const isInput   = stmt.decorators.some(d => d.name === 'input');
    const outDec    = stmt.decorators.find(d => d.name === 'output');
    const optDec    = stmt.decorators.find(d => d.name === 'options');
    const isOutput  = !!outDec;
    const outputUnit = isOutput && outDec.args.length ? outDec.args[0] : null;
    const decoratorOptions = optDec ? optDec.args : null;
    const wantsChip = isInput || !!decoratorOptions;

    const ownerIdx = stmt.bindingLine - 1;
    const c = classify(stmt.bodyText);
    const row = rows[ownerIdx] || {kind: null, name: null, result: null, error: null, outputs: null, inParams: false};
    row.kind = c.kind;
    row.name = c.name || null;
    row.inParams = wantsChip;

    if (c.kind === 'binding') {
      const name = c.name;
      const finalOptions = decoratorOptions || c.options || null;

      // Tag-style binding: when options are present and the value is a
      // bare label (not a numbat-resolvable expression), skip evaluation
      // entirely — the chip drives selection.
      if (wantsChip && finalOptions && finalOptions.length) {
        params.push({
          name, valueSrc: c.expr, anno: c.anno || null, options: finalOptions,
          bodyIdx: ownerIdx, result: null, error: null,
        });
        if (isOutput) { outputs.push({ name, unit: outputUnit }); row.outputs = [name]; }
        continue;
      }

      let q = null, err = null;
      try {
        q = evalExprText(c.expr, env);
        if (c.anno) {
          const expected = parseAnno(c.anno);
          if (!dEq(expected, q.dim)) {
            throw new Error(`annotated ${c.anno} but got [${fmtDim(q.dim)}]`);
          }
        }
        env.values.set(name, q);
        env.values.set('_',   q);
        env.values.set('ans', q);
      } catch (e) { q = null; err = e.message; }
      row.result = q;
      row.error  = err;
      if (wantsChip) {
        params.push({
          name, valueSrc: c.expr, anno: c.anno || null, options: finalOptions,
          bodyIdx: ownerIdx, result: q, error: err,
        });
      }
      if (isOutput) { outputs.push({ name, unit: outputUnit }); row.outputs = [name]; }
      continue;
    }

    // Mid-edit recovery: an @input binding whose RHS isn't parseable yet.
    if (wantsChip) {
      const recovery = stmt.bodyText.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*([^=]+?))?\s*=\s*([\s\S]*)$/);
      if (recovery) {
        const recName = recovery[1];
        const recAnno = recovery[2] ? recovery[2].trim() : null;
        const recExpr = (recovery[3] || '').trim();
        const err = recExpr ? `couldn't parse: ${recExpr}` : 'empty expression';
        params.push({
          name: recName, valueSrc: recExpr, anno: recAnno, options: decoratorOptions || null,
          bodyIdx: ownerIdx, result: null, error: err,
        });
        row.kind  = 'binding';
        row.name  = recName;
        row.error = err;
        continue;
      }
    }

    if (c.kind === 'fn-decl' || c.kind === 'dim-decl' || c.kind === 'unit-decl' || c.kind === 'struct-decl') {
      // For unit/dimension/struct decls, prepend any leading non-ep
      // decorators (`@aliases(...)`, `@metric_prefixes`, etc.) back to
      // the source text so numbat's loader sees them. Our parseEpBody
      // strips decorators above the statement; this re-attaches the
      // numbat-recognized ones the loader needs.
      const passthrough = stmt.decorators
        .filter(d => d.name !== 'input' && d.name !== 'output' && d.name !== 'options')
        .map(d => '@' + d.name + (d.args.length ? '(' + d.args.join(', ') + ')' : ''))
        .join('\n');
      const src = passthrough ? passthrough + '\n' + c.src : c.src;
      try { loadStatement(src, env); }
      catch (e) { row.error = e.message; }
      continue;
    }
    if (c.kind === 'use-decl') {
      try { loadStatement(c.src, env); }
      catch (e) { row.error = e.message; }
      continue;
    }

    if (c.kind === 'expr') {
      try {
        const q = evalExprText(c.expr, env);
        row.result = q;
        // `_` and `ans` resolve to the most recent expression / binding
        // result. Re-bind on every successful eval so the next
        // statement sees the right value.
        env.values.set('_',   q);
        env.values.set('ans', q);
      } catch (e) { row.error = e.message; }
      continue;
    }
  }

  // Convert the values Map to a plain object — render.js does `state._scope[name]`.
  // Exclude host-seeded names (pi/tau/e/…) so the returned scope reflects
  // only this program's bindings.
  const scope = {};
  const seeded = host().values;
  for (const [k, v] of env.values) {
    if (!seeded.has(k)) scope[k] = v;
  }

  return {rows, params, outputs, scope, blockComplete: false, blocks: []};
}
