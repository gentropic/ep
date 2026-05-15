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
        // Generate all prefixed lookup names:
        //   long  prefix + canonical  (kilometre)
        //   long  prefix + long alias (kilometer, kilometres, kilometers)
        //   short prefix + short alias (km)
        // Upstream Numbat applies prefixes to all spellings (so US `decimeter`
        // and UK `decimetre` both resolve).
        const lookups = [prefixedFull];
        for (const alias of aliases)      lookups.push(longName + alias);
        for (const sa    of shortAliases) lookups.push(shortName + sa);
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

const CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

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
        case 'fn':        return parseFn(decorators);
        default:
          throw err(t, `unsupported keyword '${t.name}' at top level (v0.3 handles: use, dimension, unit, let, fn)`);
      }
    }
    throw err(t, `expected a declaration keyword (use / dimension / unit / let / fn)`);
  }

  function parseFn(decorators) {
    eat();  // 'fn'
    const nameTok = expectType('id', 'function name');
    // No generics (`<T: Dim>`) in v0.3 — that's v0.4.
    expectOp('(');
    const params = [];
    if (!atOp(')')) {
      params.push(parseFnParam());
      while (atOp(',')) { eat(); params.push(parseFnParam()); }
    }
    expectOp(')');
    // Optional return type. Uses parseAddExpr to avoid consuming the body's `->`
    // if any (return type can't itself contain `->` at top level).
    let returnType = null;
    if (atOp('->')) {
      eat();
      returnType = parseAddExpr();
    }
    expectOp('=');
    const body = parseExpr();
    // Optional `where` clauses: `fn foo(x) = z where y = x * x and z = y * y`.
    // Each clause is `name = expr`, joined by the keyword `and`. Clauses are
    // evaluated in source order; each can reference parameters and prior
    // clauses, and the body can reference all of them.
    let whereClauses = null;
    if (atKw('where')) {
      eat();
      whereClauses = [parseWhereClause()];
      while (atKw('and')) {
        eat();
        whereClauses.push(parseWhereClause());
      }
    }
    return { type: 'FnDecl', name: nameTok.name, params, returnType, body, whereClauses, decorators };
  }

  function parseWhereClause() {
    const nameTok = expectType('id', 'where-clause binding name');
    expectOp('=');
    const expr = parseExpr();
    return { name: nameTok.name, expr };
  }

  function parseFnParam() {
    const nameTok = expectType('id', 'parameter name');
    let typeExpr = null;
    if (atOp(':')) { eat(); typeExpr = parseAddExpr(); }
    return { name: nameTok.name, typeExpr };
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
    // Upstream allows alternate definitions joined by `=`:
    //   `dimension Energy = Momentum^2 / Mass = Mass × Velocity^2 = Force × Length`
    // Each alternate must evaluate to the same dim (loader checks this).
    const exprs = [];
    while (atOp('=')) {
      eat();
      exprs.push(parseExpr());
    }
    return { type: 'DimensionDecl', name: nameTok.name, exprs, decorators };
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

  function parseExpr() {
    if (atKw('if')) return parseIfExpr();
    return parsePipe();
  }

  // Pipe `|>`: `x |> f` → Call(f, [x]); `x |> f(args)` → Call(f, [x, ...args]).
  // Left-associative, looser than conversion (`pi/3 + pi |> cos` works).
  function parsePipe() {
    let l = parseConversion();
    while (atOp('|>')) {
      eat();
      const right = parsePrimary();
      if (right.type === 'Ident') {
        l = { type: 'Call', name: right.name, args: [l] };
      } else if (right.type === 'Call') {
        l = { type: 'Call', name: right.name, args: [l, ...right.args] };
      } else {
        throw err(peek(), '|> RHS must be a function name or call');
      }
    }
    return l;
  }

  function parseIfExpr() {
    eat();  // 'if'
    const cond = parseExpr();
    if (!atKw('then')) throw err(peek(), `expected 'then' in if-expression`);
    eat();
    const thenBranch = parseExpr();
    if (!atKw('else')) throw err(peek(), `expected 'else' in if-expression`);
    eat();
    const elseBranch = parseExpr();
    return { type: 'If', cond, then: thenBranch, else: elseBranch };
  }

  function parseConversion() {
    let l = parseCmp();
    while (atOp('->') || atKw('to')) {
      eat();
      const right = parseCmp();
      l = { type: 'Binary', op: '->', left: l, right };
    }
    return l;
  }

  function parseCmp() {
    let l = parseAddExpr();
    while (peek() && peek().type === 'op' && CMP_OPS.has(peek().op)) {
      const op = eat().op;
      l = { type: 'Binary', op, left: l, right: parseAddExpr() };
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
    if (t.type === 'kw' && (t.name === 'true' || t.name === 'false')) {
      eat();
      return { type: 'Bool', value: t.name === 'true' };
    }
    if (t.type === 'num') { eat(); return { type: 'Num', value: t.value, raw: t.raw }; }
    if (t.type === 'id')  {
      eat();
      // Function call: `name(args)` if `(` immediately follows.
      if (atOp('(')) {
        eat();
        const args = [];
        if (!atOp(')')) {
          args.push(parseExpr());
          while (atOp(',')) { eat(); args.push(parseExpr()); }
        }
        expectOp(')');
        return { type: 'Call', name: t.name, args, span: t.span };
      }
      return { type: 'Ident', name: t.name, span: t.span };
    }
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

function evalValueExpr(node, env) {
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

function loadModule(ast, env) {
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

function loadSource(text, sourceName, env) {
  const tokens = tokenize(text, sourceName);
  const ast = parse(tokens, sourceName);
  loadModule(ast, env);
}

// Build the env object used by the loader. Hosts that want to use the
// loader directly (without going through the Numbat class) call this.
function makeEnv({ dims, units, values, fns, resolveUse }) {
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

// ─── vendored.js ───────────────────────────────────────
// AUTO-GENERATED by ext/numbat/build.js — do not edit by hand.
// Source: ext/numbat/vendor/numbat/modules/*.nbt
// Regenerate by running `node ext/numbat/build.js`.

const VENDORED_MODULES = {
  "core::dimensions": "### Physical dimensions\r\n\r\ndimension Angle = 1  # SI: plane angle\r\ndimension SolidAngle = Angle^2\r\n\r\ndimension Length\r\ndimension Area = Length^2\r\ndimension Volume = Length^3\r\ndimension Wavenumber = 1 / Length\r\n\r\ndimension Time\r\ndimension Frequency = 1 / Time\r\ndimension Velocity = Length / Time\r\ndimension Acceleration = Length / Time^2\r\ndimension Jerk = Length / Time^3\r\ndimension FlowRate = Volume / Time\r\n\r\ndimension Mass\r\ndimension Momentum = Mass × Velocity\r\ndimension Force = Mass × Acceleration = Momentum / Time\r\ndimension Energy = Momentum^2 / Mass = Mass × Velocity^2 = Force × Length  # also: work, amount of heat\r\ndimension Power = Energy / Time = Force × Velocity\r\ndimension Pressure = Force / Area = Energy / Volume  # also: stress\r\ndimension Action = Energy × Time\r\ndimension MassDensity = Mass / Length^3\r\ndimension MomentOfInertia = Mass × Length^2 / Angle^2\r\ndimension AngularMomentum = MomentOfInertia × Angle / Time = Mass × Length^2 / Time / Angle\r\ndimension Torque = Length × Force / Angle  # also: moment of force\r\ndimension EnergyDensity = Energy / Volume\r\ndimension MassFlow = Mass / Time\r\n\r\ndimension Current\r\ndimension ElectricCharge = Current × Time\r\ndimension Voltage = Energy / ElectricCharge = Power / Current  # ISQ: electric tension, SI: electric potential difference\r\ndimension Capacitance = ElectricCharge / Voltage\r\ndimension ElectricResistance = Voltage / Current\r\ndimension Resistivity = ElectricResistance × Length\r\ndimension ElectricConductance = 1 / ElectricResistance\r\ndimension Conductivity = ElectricConductance / Length\r\ndimension MagneticFluxDensity = Force / (ElectricCharge × Velocity)\r\ndimension MagneticFlux = MagneticFluxDensity × Area = Voltage × Time\r\ndimension MagneticFieldStrength = Current / Length\r\ndimension Inductance = MagneticFlux / Current\r\ndimension ElectricChargeDensity = ElectricCharge / Volume\r\ndimension CurrentDensity = Current / Area\r\ndimension ElectricDipoleMoment = ElectricCharge × Length\r\ndimension ElectricQuadrupoleMoment = ElectricCharge × Length^2\r\ndimension MagneticDipoleMoment = Current × Area = Torque / MagneticFluxDensity\r\ndimension ElectricFieldStrength = Voltage / Length\r\ndimension ElectricDisplacementFieldStrength = ElectricCharge / Area\r\ndimension ElectricPermittivity = Time^4 × Current^2 / Mass / Length^3 × Angle = ElectricDisplacementFieldStrength / ElectricFieldStrength × Angle\r\ndimension MagneticPermeability = Length × Mass / Time^2 / Current^2 / Angle = MagneticFluxDensity / MagneticFieldStrength / Angle\r\ndimension Polarizability = ElectricDipoleMoment / ElectricFieldStrength = Current^2 × Time^4 / Mass\r\ndimension ElectricMobility = Velocity / ElectricFieldStrength\r\n\r\ndimension Temperature\r\ndimension Entropy = Energy / Temperature\r\ndimension HeatCapacity = Energy / Temperature\r\ndimension SpecificHeatCapacity = HeatCapacity / Mass\r\ndimension ThermalConductivity = Power / (Length × Temperature)\r\ndimension ThermalTransmittance = Power / (Length^2 × Temperature)\r\n\r\ndimension AmountOfSubstance\r\ndimension MolarMass = Mass / AmountOfSubstance\r\ndimension MolarVolume = Volume / AmountOfSubstance\r\ndimension CatalyticActivity = AmountOfSubstance / Time\r\ndimension Molarity = AmountOfSubstance / Volume\r\ndimension Molality = AmountOfSubstance / Mass\r\ndimension ChemicalPotential = Energy / AmountOfSubstance\r\ndimension MolarEnthalpyOfVaporization = Energy / AmountOfSubstance\r\ndimension MolarHeatCapacity = HeatCapacity / AmountOfSubstance\r\n\r\ndimension LuminousIntensity\r\ndimension LuminousFlux = LuminousIntensity × Angle^2\r\ndimension Illuminance = LuminousFlux / Area\r\ndimension Luminance = LuminousIntensity / Area\r\ndimension Irradiance = Power / Area\r\n\r\ndimension Activity = 1 / Time\r\ndimension AbsorbedDose = Energy / Mass\r\ndimension EquivalentDose = Energy / Mass  # also: dose equivalent\r\ndimension SpecificActivity = Activity / Mass\r\n\r\ndimension DynamicViscosity = Pressure × Time\r\ndimension KinematicViscosity = Length^2 / Time\r\n",
  "core::scalar": "dimension Scalar = 1\r\n",
  "math::constants": "use core::scalar\r\n\r\n### Mathematical\r\n\r\n@name(\"Pi\")\r\n@url(\"https://en.wikipedia.org/wiki/Pi\")\r\n@aliases(pi)\r\nlet π = 3.14159265358979323846264338327950288\r\n\r\n@name(\"Tau\")\r\n@url(\"https://en.wikipedia.org/wiki/Turn_(angle)#Tau_proposals\")\r\n@aliases(tau)\r\nlet τ = 2 π\r\n\r\n@name(\"Euler's number\")\r\n@url(\"https://en.wikipedia.org/wiki/E_(mathematical_constant)\")\r\nlet e = 2.71828182845904523536028747135266250\r\n\r\n@name(\"Golden ratio\")\r\n@url(\"https://en.wikipedia.org/wiki/Golden_ratio\")\r\n@aliases(golden_ratio)\r\nlet φ = 1.61803398874989484820458683436563811\r\n\r\n### Named numbers\r\n\r\n#### Large numbers\r\n\r\n@name(\"Hundred\")\r\n@url(\"https://en.wikipedia.org/wiki/100_(number)\")\r\nunit hundred = 100\r\n\r\n@name(\"Thousand\")\r\n@url(\"https://en.wikipedia.org/wiki/1000_(number)\")\r\nunit thousand = 1_000\r\n\r\n@name(\"Million\")\r\n@url(\"https://en.wikipedia.org/wiki/Million\")\r\nunit million = 1_000_000\r\n\r\n@name(\"Billion\")\r\n@url(\"https://en.wikipedia.org/wiki/Billion\")\r\nunit billion = 10^9\r\n\r\n@name(\"Trillion\")\r\n@url(\"https://en.wikipedia.org/wiki/Trillion\")\r\nunit trillion = 10^12\r\n\r\n@name(\"Quadrillion\")\r\n@url(\"https://en.wikipedia.org/wiki/Quadrillion\")\r\nunit quadrillion = 10^15\r\n\r\n@name(\"Quintillion\")\r\n@url(\"https://en.wikipedia.org/wiki/Quintillion\")\r\nunit quintillion = 10^18\r\n\r\n@name(\"Googol\")\r\n@url(\"https://en.wikipedia.org/wiki/Googol\")\r\nlet googol =  10^100\r\n\r\n### Unicode fractions\r\n\r\n@name(\"One half\")\r\n@url(\"https://en.wikipedia.org/wiki/One_half\")\r\n@aliases(half, semi)\r\nlet ½ = 1 / 2\r\n\r\nlet ⅓ = 1 / 3\r\nlet ⅔ = 2 / 3\r\n\r\n@aliases(quarter)\r\nlet ¼ = 1 / 4\r\n\r\nlet ¾ = 3 / 4\r\n\r\nlet ⅕ = 1 / 5\r\nlet ⅖ = 2 / 5\r\nlet ⅗ = 3 / 5\r\nlet ⅘ = 4 / 5\r\n\r\nlet ⅙ = 1 / 6\r\nlet ⅚ = 5 / 6\r\n\r\nlet ⅐ = 1 / 7\r\n\r\nlet ⅛ = 1 / 8\r\nlet ⅜ = 3 / 8\r\nlet ⅝ = 5 / 8\r\nlet ⅞ = 7 / 8\r\n\r\nlet ⅑ = 1 / 9\r\n\r\nlet ⅒ = 1 / 10\r\n\r\n#### Integers and colloquial names\r\n\r\n@name(\"One\")\r\n@url(\"https://en.wikipedia.org/wiki/1\")\r\nlet one = 1\r\n\r\n@name(\"Two\")\r\n@url(\"https://en.wikipedia.org/wiki/2\")\r\n@aliases(double)\r\nlet two = 2\r\n\r\n@name(\"Three\")\r\n@url(\"https://en.wikipedia.org/wiki/3\")\r\n@aliases(triple)\r\nlet three = 3\r\n\r\n@name(\"Four\")\r\n@url(\"https://en.wikipedia.org/wiki/4\")\r\n@aliases(quadruple)\r\nlet four = 4\r\n\r\n@name(\"Five\")\r\n@url(\"https://en.wikipedia.org/wiki/5\")\r\nlet five = 5\r\n\r\n@name(\"Six\")\r\n@url(\"https://en.wikipedia.org/wiki/6\")\r\nlet six = 6\r\n\r\n@name(\"Seven\")\r\n@url(\"https://en.wikipedia.org/wiki/7\")\r\nlet seven = 7\r\n\r\n@name(\"Eight\")\r\n@url(\"https://en.wikipedia.org/wiki/8\")\r\nlet eight = 8\r\n\r\n@name(\"Nine\")\r\n@url(\"https://en.wikipedia.org/wiki/9\")\r\nlet nine = 9\r\n\r\n@name(\"Ten\")\r\n@url(\"https://en.wikipedia.org/wiki/10\")\r\nlet ten = 10\r\n\r\n@name(\"Eleven\")\r\n@url(\"https://en.wikipedia.org/wiki/11\")\r\nlet eleven = 11\r\n\r\n@name(\"Twelve\")\r\n@url(\"https://en.wikipedia.org/wiki/12\")\r\nlet twelve = 12\r\n\r\n@name(\"Dozen\")\r\n@url(\"https://en.wikipedia.org/wiki/Dozen\")\r\nunit dozen = 12\r\n",
  "units::partsperx": "@name(\"Percent\")\r\n@url(\"https://en.wikipedia.org/wiki/Percentage\")\r\n@aliases(%: short, pct)\r\nunit percent = 1e-02\r\n\r\n@name(\"Permille\")\r\n@url(\"https://en.wikipedia.org/wiki/Per_mille\")\r\n@aliases(‰: short, permil, permill)\r\nunit permille = 1e-03\r\n\r\n@name(\"Parts per million\")\r\n@url(\"https://en.wikipedia.org/wiki/Parts-per_notation\")\r\n@aliases(ppm)\r\nunit partspermillion = 1e-06\r\n\r\n@name(\"Parts per billion\")\r\n@url(\"https://en.wikipedia.org/wiki/Parts-per_notation\")\r\n@aliases(ppb)\r\nunit partsperbillion = 1e-09\r\n\r\n@name(\"Parts per trillion\")\r\n@url(\"https://en.wikipedia.org/wiki/Parts-per_notation\")\r\n@aliases(ppt)\r\nunit partspertrillion = 1e-12\r\n\r\n@name(\"Parts per quadrillion\")\r\n@url(\"https://en.wikipedia.org/wiki/Parts-per_notation\")\r\n@aliases(ppq)\r\nunit partsperquadrillion = 1e-15\r\n",
  "units::si": "use core::dimensions\r\nuse math::constants\r\n\r\n### SI base units\r\n\r\n@name(\"Metre\")\r\n@url(\"https://en.wikipedia.org/wiki/Metre\")\r\n@metric_prefixes\r\n@aliases(metres, meter, meters, m: short)\r\nunit metre: Length\r\n\r\n@name(\"Second\")\r\n@url(\"https://en.wikipedia.org/wiki/Second\")\r\n@metric_prefixes\r\n@aliases(seconds, s: short, sec: none)\r\nunit second: Time\r\n\r\n@name(\"Gram\")\r\n@url(\"https://en.wikipedia.org/wiki/Gram\")\r\n@metric_prefixes\r\n@aliases(grams, gramme, grammes, g: short)\r\nunit gram: Mass\r\n\r\n@name(\"Ampere\")\r\n@url(\"https://en.wikipedia.org/wiki/Ampere\")\r\n@metric_prefixes\r\n@aliases(amperes, A: short)\r\nunit ampere: Current\r\n\r\n@name(\"Kelvin\")\r\n@url(\"https://en.wikipedia.org/wiki/Kelvin\")\r\n@metric_prefixes\r\n@aliases(kelvins, K: short)\r\nunit kelvin: Temperature\r\n\r\n@name(\"Mole\")\r\n@url(\"https://en.wikipedia.org/wiki/Mole_(unit)\")\r\n@metric_prefixes\r\n@aliases(moles, mol: short)\r\nunit mole: AmountOfSubstance\r\n\r\n@name(\"Candela\")\r\n@url(\"https://en.wikipedia.org/wiki/Candela\")\r\n@metric_prefixes\r\n@aliases(candelas, cd: short)\r\nunit candela: LuminousIntensity\r\n\r\n### SI derived units\r\n\r\n@name(\"Radian\")\r\n@url(\"https://en.wikipedia.org/wiki/Radian\")\r\n@metric_prefixes\r\n@aliases(radians, rad: short)\r\nunit radian: Angle = meter / meter\r\n\r\n@name(\"Steradian\")\r\n@url(\"https://en.wikipedia.org/wiki/Steradian\")\r\n@metric_prefixes\r\n@aliases(steradians, sr: short)\r\nunit steradian: SolidAngle = radian^2\r\n\r\n@name(\"Hertz\")\r\n@url(\"https://en.wikipedia.org/wiki/Hertz\")\r\n@metric_prefixes\r\n@aliases(Hz: short)\r\nunit hertz: Frequency = 1 / second\r\n\r\n@name(\"Newton\")\r\n@url(\"https://en.wikipedia.org/wiki/Newton_(unit)\")\r\n@metric_prefixes\r\n@aliases(newtons, N: short)\r\nunit newton: Force = kilogram meter / second^2\r\n\r\n@name(\"Pascal\")\r\n@url(\"https://en.wikipedia.org/wiki/Pascal_(unit)\")\r\n@metric_prefixes\r\n@aliases(pascals, Pa: short)\r\nunit pascal: Pressure = newton / meter^2\r\n\r\n@name(\"Joule\")\r\n@url(\"https://en.wikipedia.org/wiki/Joule\")\r\n@metric_prefixes\r\n@aliases(joules, J: short)\r\nunit joule: Energy = newton meter\r\n\r\n@name(\"Watt\")\r\n@url(\"https://en.wikipedia.org/wiki/Watt\")\r\n@metric_prefixes\r\n@aliases(watts, W: short)\r\nunit watt: Power = joule / second\r\n\r\n@name(\"Coulomb\")\r\n@url(\"https://en.wikipedia.org/wiki/Coulomb\")\r\n@metric_prefixes\r\n@aliases(coulombs, C: short)\r\nunit coulomb: ElectricCharge = ampere second\r\n\r\n@name(\"Volt\")\r\n@url(\"https://en.wikipedia.org/wiki/Volt\")\r\n@metric_prefixes\r\n@aliases(volts, V: short)\r\nunit volt: Voltage = kilogram meter^2 / (second^3 ampere)\r\n\r\n@name(\"Farad\")\r\n@url(\"https://en.wikipedia.org/wiki/Farad\")\r\n@metric_prefixes\r\n@aliases(farads, F: short)\r\nunit farad: Capacitance = coulomb / volt\r\n\r\n@name(\"Ohm\")\r\n@url(\"https://en.wikipedia.org/wiki/Ohm\")\r\n@metric_prefixes\r\n@aliases(ohms, Ω: short, Ω: short)\r\nunit ohm: ElectricResistance = volt / ampere\r\n\r\n@name(\"Siemens\")\r\n@url(\"https://en.wikipedia.org/wiki/Siemens_(unit)\")\r\n@metric_prefixes\r\n@aliases(S: short)\r\nunit siemens: ElectricConductance = 1 / ohm\r\n\r\n@name(\"Weber\")\r\n@url(\"https://en.wikipedia.org/wiki/Weber_(unit)\")\r\n@metric_prefixes\r\n@aliases(webers, Wb: short)\r\nunit weber: MagneticFlux = volt second\r\n\r\n@name(\"Tesla\")\r\n@url(\"https://en.wikipedia.org/wiki/Tesla_(unit)\")\r\n@metric_prefixes\r\n@aliases(teslas, T: short)\r\nunit tesla: MagneticFluxDensity = weber / meter^2\r\n\r\n@name(\"Henry\")\r\n@url(\"https://en.wikipedia.org/wiki/Henry_(unit)\")\r\n@metric_prefixes\r\n@aliases(henrys, henries, H: short)\r\nunit henry: Inductance = weber / ampere\r\n\r\n@name(\"Lumen\")\r\n@url(\"https://en.wikipedia.org/wiki/Lumen_(unit)\")\r\n@metric_prefixes\r\n@aliases(lumens, lm: short)\r\nunit lumen: LuminousFlux = candela steradian\r\n\r\n@name(\"Lux\")\r\n@url(\"https://en.wikipedia.org/wiki/Lux\")\r\n@metric_prefixes\r\n@aliases(lx: short)\r\nunit lux: Illuminance = lumen / meter^2\r\n\r\n@name(\"Nit\")\r\n@url(\"https://en.wikipedia.org/wiki/Candela_per_square_metre\")\r\n@metric_prefixes\r\n@aliases(nt: short)\r\nunit nit: Luminance = candela / meter^2\r\n\r\n@name(\"Becquerel\")\r\n@url(\"https://en.wikipedia.org/wiki/Becquerel\")\r\n@metric_prefixes\r\n@aliases(becquerels, Bq: short)\r\nunit becquerel: Activity = 1 / second\r\n\r\n@name(\"Gray\")\r\n@url(\"https://en.wikipedia.org/wiki/Gray_(unit)\")\r\n@metric_prefixes\r\n@aliases(grays, Gy: short)\r\nunit gray: AbsorbedDose = joule / kilogram\r\n\r\n@name(\"Sievert\")\r\n@url(\"https://en.wikipedia.org/wiki/Sievert\")\r\n@metric_prefixes\r\n@aliases(sieverts, Sv: short)\r\nunit sievert: EquivalentDose = joule / kilogram\r\n\r\n@name(\"Katal\")\r\n@url(\"https://en.wikipedia.org/wiki/Katal\")\r\n@metric_prefixes\r\n@aliases(katals, kat: short)\r\nunit katal: CatalyticActivity = mole / second\r\n\r\n### SI accepted units\r\n\r\n@name(\"Minute\")\r\n@url(\"https://en.wikipedia.org/wiki/Minute\")\r\n@aliases(minutes, min: short)\r\nunit minute: Time = 60 seconds\r\n\r\n@name(\"Hour\")\r\n@url(\"https://en.wikipedia.org/wiki/Hour\")\r\n@aliases(hours, hr, h: short)\r\nunit hour: Time = 60 minutes\r\n\r\n@name(\"Day\")\r\n@url(\"https://en.wikipedia.org/wiki/Day\")\r\n@aliases(days, day: short, d: short)\r\nunit day: Time = 24 hours\r\n\r\n@name(\"Astronomical unit\")\r\n@url(\"https://en.wikipedia.org/wiki/Astronomical_unit\")\r\n@aliases(astronomicalunits, au: short, AU: short)\r\nunit astronomicalunit: Length = 149_597_870_700 meter\r\n\r\n@name(\"Degree\")\r\n@url(\"https://en.wikipedia.org/wiki/Degree_(angle)\")\r\n@aliases(degrees, deg, °: short)\r\nunit degree: Angle = π / 180 × radian\r\n\r\n@name(\"Minute of arc\")\r\n@url(\"https://en.wikipedia.org/wiki/Minute_and_second_of_arc\")\r\n@aliases(arcminutes, arcmin, ′: short)\r\nunit arcminute: Angle = 1 / 60 × degree\r\n\r\n@name(\"Second of arc\")\r\n@url(\"https://en.wikipedia.org/wiki/Minute_and_second_of_arc\")\r\n@metric_prefixes\r\n@aliases(arcseconds, arcsec, ″: short)\r\nunit arcsecond: Angle = 1 / 60 × arcminute\r\n\r\n@name(\"Are\")\r\n@url(\"https://en.wikipedia.org/wiki/Are_(unit)\")\r\nunit are: Area = (10 m)^2\r\n\r\n@name(\"Hectare\")\r\n@url(\"https://en.wikipedia.org/wiki/Hectare\")\r\n@aliases(hectares, ha: short)\r\nunit hectare: Area = 100 are\r\n\r\n@name(\"Litre\")\r\n@url(\"https://en.wikipedia.org/wiki/Litre\")\r\n@metric_prefixes\r\n@aliases(litres, liter, liters, L: short, l: short)\r\nunit litre: Volume = decimeter^3\r\n\r\n@name(\"Tonne\")\r\n@url(\"https://en.wikipedia.org/wiki/Tonne\")\r\n@metric_prefixes\r\n@aliases(tonnes, ton: both, tons: both, metricton: none)\r\nunit tonne: Mass = 10^3 kilogram\r\n\r\n@name(\"Dalton\")\r\n@url(\"https://en.wikipedia.org/wiki/Dalton\")\r\n@aliases(daltons, Da: short)\r\nunit dalton: Mass = 1.660_539_066_60e-27 kilogram\r\n\r\n@name(\"Electron volt\")\r\n@url(\"https://en.wikipedia.org/wiki/Electronvolt\")\r\n@metric_prefixes\r\n@aliases(electronvolts, eV: short)\r\nunit electronvolt: Energy = 1.602_176_634e-19 joule\r\n",
};

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
  // opts:
  //   prelude: 'v0.1' (default) — hand-crafted JS prelude, ep-compatible
  //            'vendored'        — load upstream .nbt prelude (units::si + units::partsperx)
  //            'none'            — no prelude; caller registers/loads modules itself
  constructor(opts = {}) {
    this.registry = new UnitRegistry();
    this.dims     = new DimRegistry();
    this.values   = new Map();          // let bindings
    this.fns      = new Map();          // user-defined functions (fn decls)
    this.modules  = new Map();          // path → source text (registered .nbt)
    this.loaded   = new Set();          // paths already loaded (idempotent)

    const prelude = opts.prelude ?? 'v0.1';
    if (prelude === 'v0.1')          loadPrelude(this.registry);
    else if (prelude === 'vendored') this.loadVendoredPrelude();
    else if (prelude === 'none')     { /* caller takes over */ }
    else throw new Error(`unknown prelude option: ${prelude}`);
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
      fns: this.fns,
      resolveUse: (path) => this.use(path.join('::')),
    });
    loadSource(text, sourceName, env);
  }

  // Register every vendored .nbt module bundled at build time, then load
  // the SI and partsperx modules (which transitively pull in core::dimensions,
  // core::scalar, and math::constants). Provides a Numbat-compatible
  // standard-library subset without a hand-crafted JS prelude.
  loadVendoredPrelude() {
    for (const [path, source] of Object.entries(VENDORED_MODULES)) {
      this.registerModule(path, source);
    }
    this.use('units::si');
    this.use('units::partsperx');
  }
}
export { Numbat, Quantity, UnitRegistry, DimRegistry, dimEq, dimMul, dimDiv, dimPow, dimInv, dimEmpty, dimFormat, formatNumber, tokenize, parse, loadSource, loadModule, makeEnv, evalDimExpr, evalValueExpr, VENDORED_MODULES };
