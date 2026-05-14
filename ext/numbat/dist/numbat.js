// numbat-js v0.1 — built artifact, do not edit by hand.
// Source: ext/numbat/src/. Rebuild with `node ext/numbat/build.js`.

// ─── dimensions.js ─────────────────────────────────────
// Dimension primitives.
//
// A dimension is a sparse object {baseAxis: integerExponent}. Dimensions form
// a free abelian group under multiplication (componentwise add); identity is
// {} (scalar / dimensionless); inverse is negation.
//
// Base axis keys are lowercase strings: 'length', 'mass', 'time', 'angle',
// 'current', 'temperature', 'substance', 'luminous'. v0.2+ lets users define
// custom base dimensions; v0.1 uses these conventionally.

const dimEq = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] || 0) !== (b[k] || 0)) return false;
  return true;
};

const dimMul = (a, b) => {
  const r = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k] || 0) + (b[k] || 0);
    if (n) r[k] = n;
  }
  return r;
};

const dimDiv = (a, b) => {
  const r = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k] || 0) - (b[k] || 0);
    if (n) r[k] = n;
  }
  return r;
};

const dimPow = (d, n) => {
  const r = {};
  for (const k in d) {
    const e = d[k] * n;
    if (e) r[k] = e;
  }
  return r;
};

const dimInv = (d) => dimPow(d, -1);

const dimEmpty = (d) => Object.keys(d).length === 0;

const dimFormat = (d) => {
  const parts = Object.entries(d).map(([k, v]) => v === 1 ? k : `${k}^${v}`);
  return parts.join('·') || '-';
};

// DimRegistry: maps Numbat-style dimension names (Length, Velocity) to dim
// vectors. Base dimensions get a fresh lowercase axis key derived from their
// name; derived dimensions store a computed vector built from arithmetic on
// existing dimensions.
//
// Used by the .nbt loader (see load.js); the runtime Quantity/UnitRegistry
// only cares about the dim vectors themselves.
class DimRegistry {
  constructor() {
    this._dims = new Map();
  }

  // Declare a base dimension. Allocates a new axis named after the dimension
  // (lowercased). E.g. `defineBase('Length')` → registers Length as {length: 1}.
  defineBase(name) {
    if (this._dims.has(name)) throw new Error(`dimension already defined: ${name}`);
    const axis = name.toLowerCase();
    this._dims.set(name, { [axis]: 1 });
  }

  // Declare a derived dimension with an already-computed dim vector.
  defineDerived(name, dim) {
    if (this._dims.has(name)) throw new Error(`dimension already defined: ${name}`);
    this._dims.set(name, dim);
  }

  resolve(name) {
    return this._dims.get(name) ?? null;
  }

  has(name) {
    return this._dims.has(name);
  }

  list() {
    return [...this._dims.entries()].map(([name, dim]) => ({ name, dim }));
  }
}

// ─── quantity.js ───────────────────────────────────────
// Quantity: a value in canonical units plus a dimension vector plus an
// optional display-unit tag (set by `->` / convertTo, preserved through unary
// operations but lost in further arithmetic — matches Numbat semantics).
//
// Numbat is purely functional: every arithmetic method returns a new Quantity.

class Quantity {
  constructor(value, dim, disp = null) {
    this.value = value;
    this.dim = dim;
    this.disp = disp;
  }

  // Deprecated short aliases retained for ep's pre-numbat-js code. New code
  // should use .value / .dim directly. To be removed once ep finishes migrating
  // (no fixed deadline — these are zero-cost getters).
  get v() { return this.value; }
  get d() { return this.dim; }

  add(other) {
    if (!dimEq(this.dim, other.dim)) {
      throw new Error(`can't add [${dimFormat(this.dim)}] + [${dimFormat(other.dim)}]`);
    }
    return new Quantity(this.value + other.value, this.dim);
  }

  sub(other) {
    if (!dimEq(this.dim, other.dim)) {
      throw new Error(`can't subtract [${dimFormat(this.dim)}] − [${dimFormat(other.dim)}]`);
    }
    return new Quantity(this.value - other.value, this.dim);
  }

  mul(other) {
    return new Quantity(this.value * other.value, dimMul(this.dim, other.dim));
  }

  div(other) {
    return new Quantity(this.value / other.value, dimDiv(this.dim, other.dim));
  }

  // pow accepts either a number or a dimensionless Quantity
  pow(exponent) {
    const expValue = exponent instanceof Quantity ? exponent.value : exponent;
    if (exponent instanceof Quantity && !dimEmpty(exponent.dim)) {
      throw new Error('exponent must be dimensionless');
    }
    return new Quantity(Math.pow(this.value, expValue), dimPow(this.dim, expValue));
  }

  neg() {
    return new Quantity(-this.value, this.dim, this.disp);
  }

  // Conversion needs a registry to look up the target unit. Canonical value
  // is unchanged; the display-unit tag is set so the formatter honors it
  // instead of auto-scaling.
  convertTo(unitName, registry) {
    const u = registry.resolve(unitName);
    if (!u) throw new Error(`unknown unit: ${unitName}`);
    if (!dimEq(this.dim, u.dim)) {
      throw new Error(`can't convert [${dimFormat(this.dim)}] to ${unitName} [${dimFormat(u.dim)}]`);
    }
    return new Quantity(this.value, this.dim, unitName);
  }
}

// ─── units.js ──────────────────────────────────────────
// UnitRegistry: declarative unit definitions with optional metric-prefix
// auto-generation. All units stored at canonical-unit scale (multiplier from
// the unit to its canonical base — e.g., kilometer.mul = 1000 when meter is
// canonical for Length).

// Metric prefixes for v0.1. The full upstream set comes in via .nbt loading
// in v0.2+. 'micro' has both 'µ' and 'u' as common short forms.
const METRIC_PREFIXES = [
  ['tera',  'T',  1e12],
  ['giga',  'G',  1e9],
  ['mega',  'M',  1e6],
  ['kilo',  'k',  1e3],
  ['hecto', 'h',  1e2],
  ['deca',  'da', 1e1],
  // base — handled by the unprefixed registration
  ['deci',  'd',  1e-1],
  ['centi', 'c',  1e-2],
  ['milli', 'm',  1e-3],
  ['micro', 'µ',  1e-6],
  ['micro', 'u',  1e-6],
  ['nano',  'n',  1e-9],
  ['pico',  'p',  1e-12],
];

class UnitRegistry {
  constructor() {
    this._units = new Map();    // lookup name -> {mul, dim, displayName, fullName}
    this._entries = [];         // ordered, for iteration (auto-scale)
  }

  // Define a unit.
  //   canonicalName:      long name ('metre')
  //   opts.dim:           dimension vector (required)
  //   opts.mul:           canonical multiplier (default 1 = base canonical)
  //   opts.displayName:   pretty form for auto-scale display
  //                       (default: first shortAlias if any, else canonicalName)
  //   opts.aliases:       LONG-form alternate names ['meter', 'meters']. NOT prefixed.
  //   opts.shortAliases:  SHORT-form alternate names ['m']. Each combines with
  //                       the metric prefix's short form (kilo + m = km).
  //   opts.prefixSet:     'metric' | null
  //
  // Upstream Numbat's `@aliases(metres, meter, meters, m: short)` splits
  // into aliases=[metres, meter, meters] and shortAliases=[m]. v0.1 callers
  // that passed `aliases: ['m']` should migrate to `shortAliases: ['m']`.
  define(canonicalName, opts) {
    const dim = opts.dim;
    const mul = opts.mul ?? 1;
    const aliases      = opts.aliases ?? [];
    const shortAliases = opts.shortAliases ?? [];
    const displayName  = opts.displayName ?? shortAliases[0] ?? canonicalName;
    const prefixSet    = opts.prefixSet ?? null;

    this._addEntry({mul, dim, displayName, fullName: canonicalName},
                   [canonicalName, ...aliases, ...shortAliases]);

    if (prefixSet === 'metric') {
      for (const [longName, shortName, factor] of METRIC_PREFIXES) {
        const prefixedDisplay = shortName + displayName;
        const prefixedFull = longName + canonicalName;
        const entry = {
          mul: mul * factor,
          dim,
          displayName: prefixedDisplay,
          fullName: prefixedFull,
        };
        const lookups = [prefixedFull];
        for (const sa of shortAliases) lookups.push(shortName + sa);
        this._addEntry(entry, lookups);
      }
    }
  }

  _addEntry(entry, lookupNames) {
    // First-come-first-served. Conflicts silently ignored in v0.1.
    let added = false;
    for (const name of lookupNames) {
      if (!this._units.has(name)) {
        this._units.set(name, entry);
        added = true;
      }
    }
    if (added) this._entries.push(entry);
  }

  resolve(name) {
    return this._units.get(name) ?? null;
  }

  has(name) {
    return this._units.has(name);
  }

  // List all unit entries, optionally filtered by exact dimension match.
  // Used by the formatter to find candidate units for auto-scaling.
  list(filterDim = null) {
    if (!filterDim) return this._entries.slice();
    return this._entries.filter(e => dimEq(filterDim, e.dim));
  }
}

// ─── format.js ─────────────────────────────────────────
// Format a Quantity to a human-readable string. Honors the disp tag set by
// convertTo; otherwise auto-scales to the largest unit that lands in
// [1, 1000) (with relaxed fallbacks for extreme magnitudes).

function format(q, registry) {
  const { num, unit } = formatParts(q, registry);
  return unit ? `${num} ${unit}` : num;
}

function formatParts(q, registry) {
  if (dimEmpty(q.dim)) return { num: formatNumber(q.value), unit: null };

  // Explicit display unit (from -> conversion) wins over auto-scale.
  if (q.disp) {
    const u = registry.resolve(q.disp);
    if (u && dimEq(u.dim, q.dim)) {
      return { num: formatNumber(q.value / u.mul), unit: u.displayName };
    }
  }

  const cands = registry.list(q.dim);
  if (!cands.length) return { num: formatNumber(q.value), unit: `[${dimFormat(q.dim)}]` };

  cands.sort((a, b) => b.mul - a.mul);
  let best = null;
  // Prefer the largest unit whose scaled value lands in [1, 1000).
  for (const c of cands) {
    const s = q.value / c.mul;
    if (Math.abs(s) >= 1 && Math.abs(s) < 1000) { best = { entry: c, scaled: s }; break; }
  }
  // Relaxed: keep within a permissive window so 80,000 m³ stays in m³, not km³.
  if (!best) {
    for (const c of cands) {
      const s = q.value / c.mul;
      if (Math.abs(s) >= 0.01 && Math.abs(s) < 1e6) { best = { entry: c, scaled: s }; break; }
    }
  }
  // Last resort: closest to magnitude 1 on log scale.
  if (!best) {
    cands.sort((a, b) => {
      const la = Math.abs(Math.log10(Math.abs(q.value / a.mul) || 1e-30));
      const lb = Math.abs(Math.log10(Math.abs(q.value / b.mul) || 1e-30));
      return la - lb;
    });
    best = { entry: cands[0], scaled: q.value / cands[0].mul };
  }
  return { num: formatNumber(best.scaled), unit: best.entry.displayName };
}

function formatNumber(n) {
  if (!isFinite(n)) return String(n);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 1e-4 || abs >= 1e9) return n.toExponential(3).replace('e+', 'e');
  const s = parseFloat(n.toPrecision(5)).toString();
  if (Math.abs(parseFloat(s)) >= 1000) {
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }
  return s;
}

// ─── tokenize.js ───────────────────────────────────────
// Tokenizer for Numbat-script.
//
// Emits a flat array of tokens with span info (line/col/offset) for error
// reporting. Keywords are split out from identifiers. Comments (`#` to EOL)
// are skipped. Unicode letters and a handful of symbol identifiers (`%`,
// `‰`, etc.) are accepted in identifier positions so upstream module aliases
// like `@aliases(%: short)` and Greek-letter constants tokenize cleanly.
//
// Numbers support digit separators (`1_800`) and scientific notation
// (`1.5e-3`). Number-and-unit adjacency (e.g. `5 m`) is NOT collapsed here —
// the parser treats adjacency as implicit multiplication.

const KEYWORDS = new Set([
  'dimension', 'unit', 'let', 'fn', 'use',
  'if', 'then', 'else', 'where', 'and', 'or', 'not',
  'struct', 'mod', 'to',
  'true', 'false',
]);

// Multi-character operators, sorted longest-first so the tokenizer prefers
// the longer match (`::` before `:`, `->` before `-`).
const MULTI_OPS = ['->', '::', '|>', '!=', '<=', '>=', '==', '&&', '||', '**'];

// Single-character operators / punctuation.
const SINGLE_OPS = '+-*/^=(){}[],:.<>!';

const UNICODE_OP_ALIAS = {
  '→': '->',
  '×': '*',
  '÷': '/',
  '−': '-',
  '·': '*',
  '²': '^2',   // handled specially below — emits OP^ then NUM 2
  '³': '^3',
  'π': null,   // identifier, not operator
};

// Identifier-start: ASCII letter, underscore, `%`, or any non-ASCII codepoint.
// This makes Greek letters and symbol-style aliases (`%`, `‰`, `°`) tokenizable
// without lookup tables. The parser/loader decides which are valid in context.
const isIdentStart = (c) =>
  (c >= 'a' && c <= 'z') ||
  (c >= 'A' && c <= 'Z') ||
  c === '_' ||
  c === '%' ||
  c.charCodeAt(0) >= 0x80;

const isIdentCont = (c) =>
  // ² and ³ are unicode exponent shorthands handled by the special-case branch
  // below; they must NOT extend an identifier (so `m²` tokenizes as `m`, `^`,
  // `2` rather than as a single weird identifier `m²`).
  c !== '²' && c !== '³' &&
  (isIdentStart(c) || (c >= '0' && c <= '9'));

function tokenize(source, sourceName = '<input>') {
  const toks = [];
  let i = 0, line = 1, col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i + k] === '\n') { line++; col = 1; }
      else col++;
    }
    i += n;
  };

  const here = () => ({ line, col, offset: i, source: sourceName });

  const emit = (type, fields, start) => {
    toks.push({ type, ...fields, span: { ...start, end: i } });
  };

  while (i < source.length) {
    const start = here();
    const c = source[i];

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { advance(); continue; }

    // Comments: # to end of line. Numbat uses `###` for section headers but
    // those are still just comments.
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }

    // Decorator: @identifier
    if (c === '@') {
      advance();
      const nameStart = i;
      while (i < source.length && isIdentCont(source[i])) advance();
      const name = source.slice(nameStart, i);
      if (!name) throw new Error(`${sourceName}:${start.line}:${start.col}: expected identifier after '@'`);
      emit('dec', { name }, start);
      continue;
    }

    // String literal
    if (c === '"') {
      advance();
      let value = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          value += esc === 'n' ? '\n'
                : esc === 't' ? '\t'
                : esc === 'r' ? '\r'
                : esc;
          advance(2);
        } else {
          value += source[i];
          advance();
        }
      }
      if (i >= source.length) throw new Error(`${sourceName}:${start.line}:${start.col}: unterminated string`);
      advance();  // consume closing quote
      emit('str', { value }, start);
      continue;
    }

    // Number literal
    if ((c >= '0' && c <= '9') || (c === '.' && source[i + 1] >= '0' && source[i + 1] <= '9')) {
      const numStart = i;
      let dot = false, eExp = false;
      while (i < source.length) {
        const ch = source[i];
        if (ch >= '0' && ch <= '9') advance();
        else if (ch === '_' && source[i + 1] >= '0' && source[i + 1] <= '9') advance();
        else if (ch === '.' && !dot && !eExp) { dot = true; advance(); }
        else if ((ch === 'e' || ch === 'E') && !eExp) {
          eExp = true; advance();
          if (source[i] === '+' || source[i] === '-') advance();
        } else break;
      }
      const raw = source.slice(numStart, i);
      const value = parseFloat(raw.replace(/_/g, ''));
      emit('num', { value, raw }, start);
      continue;
    }

    // Unicode exponents: ² → "^2", ³ → "^3"
    if (c === '²' || c === '³') {
      advance();
      emit('op', { op: '^' }, start);
      const numStart = here();
      emit('num', { value: c === '²' ? 2 : 3, raw: c }, numStart);
      continue;
    }

    // Multi-character operators
    let matched = false;
    for (const op of MULTI_OPS) {
      if (source.startsWith(op, i)) {
        advance(op.length);
        emit('op', { op }, start);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Unicode operator aliases (single-char)
    if (UNICODE_OP_ALIAS[c] && UNICODE_OP_ALIAS[c] !== null) {
      const op = UNICODE_OP_ALIAS[c];
      advance();
      emit('op', { op }, start);
      continue;
    }

    // Identifier or keyword (must come AFTER unicode-op-alias check so π isn't
    // an op alias, but it IS an identifier — UNICODE_OP_ALIAS['π'] is null so
    // we fall through here).
    if (isIdentStart(c)) {
      const idStart = i;
      while (i < source.length && isIdentCont(source[i])) advance();
      const name = source.slice(idStart, i);
      emit(KEYWORDS.has(name) ? 'kw' : 'id', { name }, start);
      continue;
    }

    // Single-character operators
    if (SINGLE_OPS.includes(c)) {
      advance();
      emit('op', { op: c }, start);
      continue;
    }

    throw new Error(`${sourceName}:${start.line}:${start.col}: unexpected character ${JSON.stringify(c)}`);
  }

  return toks;
}

// ─── parse.js ──────────────────────────────────────────
// Parser for Numbat-script.
//
// Consumes the token stream from tokenize.js and produces an AST. v0.2 covers
// the *declarative* subset that upstream .nbt files use:
//
//   - `use path::path`
//   - `dimension Name` / `dimension Name = expr`
//   - `unit name[: DimExpr] [= ValueExpr]`
//   - `let name[: DimExpr] = ValueExpr`
//   - leading decorators on each declaration (@name, @url, @aliases,
//     @metric_prefixes, @description, @example, ...)
//
// Expression grammar (lowest to highest precedence):
//   conversion: addExpr ('->' addExpr)*               # `to` is a synonym
//   addExpr:    mulExpr (('+' | '-') mulExpr)*
//   mulExpr:    implMul (('*' | '/') implMul)*
//   implMul:    power (power)*                        # implicit multiplication
//   power:      unary ('^' power)?                    # right-associative
//   unary:      '-' unary | primary
//   primary:    NUM | IDENT | '(' expr ')'
//
// AST nodes:
//   { type: 'Module', decls: [...] }
//   { type: 'UseStmt', path: ['core', 'dimensions'], decorators: [...] }
//   { type: 'DimensionDecl', name, expr|null, decorators }
//   { type: 'UnitDecl', name, dim|null, expr|null, decorators }
//   { type: 'LetDecl', name, dim|null, expr, decorators }
//   { type: 'Decorator', name, args: [...] }
//   { type: 'StrArg', value }
//   { type: 'NameArg', name, modifier|null }
//   { type: 'Num', value, raw }
//   { type: 'Ident', name }
//   { type: 'Binary', op, left, right }
//   { type: 'Unary', op, expr }
//   { type: 'Paren', expr }
//
// Statements other than the listed four (e.g., `fn`, `struct`, expression
// statements at top level) are rejected with a clear error in v0.2 — they
// arrive in v0.3+.

function parse(tokens, sourceName = '<input>') {
  let p = 0;

  const peek = (offset = 0) => tokens[p + offset];
  const eat  = () => tokens[p++];
  const atOp = (op)   => peek() && peek().type === 'op' && peek().op === op;
  const atKw = (name) => peek() && peek().type === 'kw' && peek().name === name;
  const atType = (type) => peek() && peek().type === type;

  const err = (tok, msg) => {
    const span = tok?.span;
    const loc = span ? `${span.source ?? sourceName}:${span.line}:${span.col}` : `${sourceName}:?:?`;
    return new Error(`${loc}: ${msg}`);
  };
  const expectOp = (op) => {
    if (!atOp(op)) throw err(peek(), `expected '${op}'`);
    return eat();
  };
  const expectType = (type, what = type) => {
    if (!atType(type)) {
      const t = peek();
      const got = t ? `${t.type}${t.name ? ` '${t.name}'` : t.op ? ` '${t.op}'` : ''}` : 'end of input';
      throw err(t, `expected ${what}, got ${got}`);
    }
    return eat();
  };

  // ── declarations ────────────────────────────────────────────────

  const decls = [];
  while (p < tokens.length) {
    decls.push(parseDecl());
  }
  return { type: 'Module', decls, source: sourceName };

  function parseDecl() {
    const decorators = [];
    while (atType('dec')) decorators.push(parseDecorator());

    const t = peek();
    if (!t) throw err(null, 'unexpected end of input after decorators');
    if (t.type === 'kw') {
      switch (t.name) {
        case 'use':       return parseUse(decorators);
        case 'dimension': return parseDimension(decorators);
        case 'unit':      return parseUnit(decorators);
        case 'let':       return parseLet(decorators);
        default:
          throw err(t, `unsupported keyword '${t.name}' at top level (v0.2 handles: use, dimension, unit, let)`);
      }
    }
    throw err(t, `expected a declaration keyword (use / dimension / unit / let)`);
  }

  function parseDecorator() {
    const dec = eat();  // type 'dec'
    const args = [];
    if (atOp('(')) {
      eat();
      if (!atOp(')')) {
        args.push(parseDecoratorArg());
        while (atOp(',')) { eat(); args.push(parseDecoratorArg()); }
      }
      expectOp(')');
    }
    return { type: 'Decorator', name: dec.name, args, span: dec.span };
  }

  function parseDecoratorArg() {
    const t = peek();
    if (!t) throw err(null, 'unexpected end of input in decorator arg');
    if (t.type === 'str') {
      eat();
      return { type: 'StrArg', value: t.value };
    }
    if (t.type === 'id' || t.type === 'kw') {
      // Allow keywords as decorator-arg names too — they're string-ish here.
      eat();
      let modifier = null;
      if (atOp(':')) {
        eat();
        const m = expectType('id', "modifier (short/long/none)");
        modifier = m.name;
      }
      return { type: 'NameArg', name: t.name, modifier };
    }
    throw err(t, `expected string or identifier in decorator arg, got ${t.type}`);
  }

  function parseUse(decorators) {
    eat();  // 'use'
    const parts = [expectType('id', 'module path segment').name];
    while (atOp('::')) {
      eat();
      parts.push(expectType('id', 'module path segment').name);
    }
    return { type: 'UseStmt', path: parts, decorators };
  }

  function parseDimension(decorators) {
    eat();  // 'dimension'
    const nameTok = expectType('id', 'dimension name');
    let expr = null;
    if (atOp('=')) { eat(); expr = parseExpr(); }
    return { type: 'DimensionDecl', name: nameTok.name, expr, decorators };
  }

  function parseUnit(decorators) {
    eat();  // 'unit'
    const nameTok = expectType('id', 'unit name');
    let dim = null, expr = null;
    if (atOp(':')) { eat(); dim = parseExpr(); }
    if (atOp('=')) { eat(); expr = parseExpr(); }
    return { type: 'UnitDecl', name: nameTok.name, dim, expr, decorators };
  }

  function parseLet(decorators) {
    eat();  // 'let'
    const nameTok = expectType('id', 'binding name');
    let dim = null;
    if (atOp(':')) { eat(); dim = parseExpr(); }
    expectOp('=');
    const expr = parseExpr();
    return { type: 'LetDecl', name: nameTok.name, dim, expr, decorators };
  }

  // ── expressions ─────────────────────────────────────────────────

  function parseExpr() { return parseConversion(); }

  function parseConversion() {
    let l = parseAddExpr();
    while (atOp('->') || atKw('to')) {
      eat();
      const right = parseAddExpr();
      l = { type: 'Binary', op: '->', left: l, right };
    }
    return l;
  }

  function parseAddExpr() {
    let l = parseMulExpr();
    while (atOp('+') || atOp('-')) {
      const op = eat().op;
      l = { type: 'Binary', op, left: l, right: parseMulExpr() };
    }
    return l;
  }

  function parseMulExpr() {
    let l = parseImplMul();
    while (atOp('*') || atOp('/')) {
      const op = eat().op;
      l = { type: 'Binary', op, left: l, right: parseImplMul() };
    }
    return l;
  }

  function parseImplMul() {
    let l = parsePower();
    while (isExprStart(peek())) {
      l = { type: 'Binary', op: '*', left: l, right: parsePower() };
    }
    return l;
  }

  function parsePower() {
    const base = parseUnary();
    if (atOp('^') || atOp('**')) {
      eat();
      const exp = parsePower();  // right-associative
      return { type: 'Binary', op: '^', left: base, right: exp };
    }
    return base;
  }

  function parseUnary() {
    if (atOp('-')) {
      eat();
      return { type: 'Unary', op: '-', expr: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw err(null, 'unexpected end of input in expression');
    if (t.type === 'num') { eat(); return { type: 'Num', value: t.value, raw: t.raw }; }
    if (t.type === 'id')  { eat(); return { type: 'Ident', name: t.name, span: t.span }; }
    if (t.type === 'op' && t.op === '(') {
      eat();
      const inner = parseExpr();
      expectOp(')');
      return { type: 'Paren', expr: inner };
    }
    throw err(t, `unexpected token in expression: ${t.type}${t.op ? ` '${t.op}'` : ''}${t.name ? ` '${t.name}'` : ''}`);
  }

  function isExprStart(t) {
    if (!t) return false;
    if (t.type === 'num' || t.type === 'id') return true;
    if (t.type === 'op' && t.op === '(') return true;
    return false;
  }
}

// ─── load.js ───────────────────────────────────────────
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

// ── expression evaluators ────────────────────────────────────────

function evalDimExpr(node, env) {
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

function evalValueExpr(node, env) {
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

function loadModule(ast, env) {
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
  if (decl.expr === null) {
    env.dims.defineBase(decl.name);
  } else {
    const dim = evalDimExpr(decl.expr, env);
    env.dims.defineDerived(decl.name, dim);
  }
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
        throw new Error(`dimension mismatch: annotated does not match value expression`);
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

function loadSource(text, sourceName, env) {
  const tokens = tokenize(text, sourceName);
  const ast = parse(tokens, sourceName);
  loadModule(ast, env);
}

// Build the env object used by the loader. Hosts that want to use the
// loader directly (without going through the Numbat class) call this.
function makeEnv({ dims, units, values, resolveUse }) {
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

// ─── prelude.js ────────────────────────────────────────
// Hand-crafted v0.1 prelude. Covers what ep currently uses (geological lane:
// SI base + key derived + density + ppm/ppb/g/t). Replaced in v0.2 by .nbt
// module loading from upstream Numbat's vendored modules.

function loadPrelude(registry) {
  // Mass scales used in mining/commodity contexts. Registered BEFORE 'gram'
  // so the auto-scaler prefers `t` / `kt` / `Mt` over the equivalent
  // metric-prefixed gram variants (megagram, gigagram, teragram) on ties.
  // No prefixSet — these are explicit standalone scales.
  registry.define('tonne',      { dim: {mass: 1}, mul: 1e6,    shortAliases: ['t']   });
  registry.define('kilotonne',  { dim: {mass: 1}, mul: 1e9,    shortAliases: ['kt']  });
  registry.define('megatonne',  { dim: {mass: 1}, mul: 1e12,   shortAliases: ['Mt']  });
  registry.define('ounce',      { dim: {mass: 1}, mul: 28.3495,shortAliases: ['oz']  });
  registry.define('troy_ounce', { dim: {mass: 1}, mul: 31.1035,shortAliases: ['ozt'] });

  // SI base canonicals (with metric prefixes auto-generated from shortAliases).
  // Mass: gram is canonical (ep convention); SI base is kilogram but gram
  // is more convenient at calculator scale. v0.2 follows upstream's choice.
  registry.define('gram',   { dim: {mass: 1},   shortAliases: ['g'],   prefixSet: 'metric' });
  registry.define('meter',  { dim: {length: 1}, shortAliases: ['m'],   prefixSet: 'metric' });
  registry.define('second', { dim: {time: 1},   shortAliases: ['s'],   prefixSet: 'metric' });
  registry.define('radian', { dim: {angle: 1},  shortAliases: ['rad'] });

  // Area — explicit squared units (parser-level `m^2` syntax in v0.3+).
  registry.define('m2',  { dim: {length: 2}, displayName: 'm²',  aliases: ['m^2'] });
  registry.define('cm2', { dim: {length: 2}, mul: 1e-4, displayName: 'cm²' });
  registry.define('mm2', { dim: {length: 2}, mul: 1e-6, displayName: 'mm²' });
  registry.define('km2', { dim: {length: 2}, mul: 1e6,  displayName: 'km²' });
  registry.define('ha',  { dim: {length: 2}, mul: 1e4,  displayName: 'ha' });

  // Volume — explicit cubed units.
  registry.define('m3',    { dim: {length: 3}, displayName: 'm³',  aliases: ['m^3'] });
  registry.define('cm3',   { dim: {length: 3}, mul: 1e-6, displayName: 'cm³' });
  registry.define('km3',   { dim: {length: 3}, mul: 1e9,  displayName: 'km³' });
  registry.define('liter', { dim: {length: 3}, mul: 1e-3, displayName: 'L', shortAliases: ['L'] });

  // Density.
  registry.define('g/cm3', { dim: {mass: 1, length: -3}, mul: 1e6, displayName: 'g/cm³' });
  registry.define('kg/m3', { dim: {mass: 1, length: -3}, mul: 1e3, displayName: 'kg/m³' });
  registry.define('t/m3',  { dim: {mass: 1, length: -3}, mul: 1e6, displayName: 't/m³' });

  // Parts-per-X (mass fraction; treated as dimensionless, matching upstream).
  registry.define('ppm', { dim: {}, mul: 1e-6, shortAliases: ['ppm'] });
  registry.define('ppb', { dim: {}, mul: 1e-9, shortAliases: ['ppb'] });
  registry.define('pct', { dim: {}, mul: 1e-2, displayName: '%', aliases: ['percent'] });
  registry.define('g/t', { dim: {}, mul: 1e-6, shortAliases: ['g/t'] });

  // Angles.
  registry.define('degree', { dim: {angle: 1}, mul: Math.PI / 180, shortAliases: ['deg'] });
}

// ─── api.js ────────────────────────────────────────────
// Public API: the Numbat class is the host's entry point. Wraps a unit
// registry preloaded with the v0.1 prelude and offers convenience methods
// closed over it.

class Numbat {
  constructor() {
    this.registry = new UnitRegistry();
    this.dims     = new DimRegistry();
    this.values   = new Map();          // let bindings
    this.modules  = new Map();          // path → source text (registered .nbt)
    this.loaded   = new Set();          // paths already loaded (idempotent)
    loadPrelude(this.registry);
  }

  // Construct a Quantity from a value + unit name. With no unit, returns a
  // dimensionless Quantity at canonical value.
  q(value, unitName) {
    if (!unitName) return new Quantity(value, {});
    const u = this.registry.resolve(unitName);
    if (!u) throw new Error(`unknown unit: ${unitName}`);
    return new Quantity(value * u.mul, u.dim);
  }

  hasUnit(name) {
    return this.registry.has(name);
  }

  // Look up a unit. Returns {mul, dim, displayName, fullName} or null.
  resolve(name) {
    return this.registry.resolve(name);
  }

  convertTo(q, unitName) {
    return q.convertTo(unitName, this.registry);
  }

  format(q) {
    return format(q, this.registry);
  }

  formatParts(q) {
    return formatParts(q, this.registry);
  }

  // ── .nbt module loading (v0.2) ───────────────────────────────

  // Register a module's source text under its upstream path
  // (e.g. 'core::dimensions'). No parsing happens until use() is called.
  registerModule(path, source) {
    this.modules.set(path, source);
  }

  // Load a registered module by path. Idempotent (loading the same path
  // twice is a no-op). Recursive: `use` statements inside the module
  // trigger nested loads.
  use(path) {
    if (this.loaded.has(path)) return;
    this.loaded.add(path);
    const source = this.modules.get(path);
    if (source === undefined) throw new Error(`module not registered: ${path}`);
    this.loadSource(source, path);
  }

  // Tokenize, parse, and load a Numbat-script source. Doesn't add to the
  // module map; useful for ad-hoc input.
  loadSource(text, sourceName = '<inline>') {
    const env = makeEnv({
      dims: this.dims,
      units: this.registry,
      values: this.values,
      resolveUse: (path) => this.use(path.join('::')),
    });
    loadSource(text, sourceName, env);
  }
}
export { Numbat, Quantity, UnitRegistry, DimRegistry, dimEq, dimMul, dimDiv, dimPow, dimInv, dimEmpty, dimFormat, formatNumber, tokenize, parse, loadSource, loadModule, makeEnv, evalDimExpr, evalValueExpr };
