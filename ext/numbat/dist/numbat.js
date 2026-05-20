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
function dimensionsEqual(a, b) {
  return dimEq(a, b);
}

class DimRegistry {
  constructor() {
    this._dims = new Map();
  }

  // Declare a base dimension. Allocates a new axis named after the dimension
  // (lowercased). E.g. `defineBase('Length')` → registers Length as {length: 1}.
  // Idempotent: re-defining with the same shape is a no-op (so a vendored
  // module's `dimension Length` doesn't conflict with the host's pre-seed).
  defineBase(name) {
    const axis = name.toLowerCase();
    const desired = { [axis]: 1 };
    if (this._dims.has(name)) {
      if (dimensionsEqual(this._dims.get(name), desired)) return;
      throw new Error(`dimension already defined with different shape: ${name}`);
    }
    this._dims.set(name, desired);
  }

  // Declare a derived dimension with an already-computed dim vector.
  // Same idempotency rule as defineBase.
  defineDerived(name, dim) {
    if (this._dims.has(name)) {
      if (dimensionsEqual(this._dims.get(name), dim)) return;
      throw new Error(`dimension already defined with different shape: ${name}`);
    }
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

// Full SI prefix set (per BIPM 2022). Both 'µ' (micro sign U+00B5) and 'u'
// register for micro; both 'μ' (greek mu U+03BC) is added below.
const METRIC_PREFIXES = [
  ['quetta', 'Q',  1e30],
  ['ronna',  'R',  1e27],
  ['yotta',  'Y',  1e24],
  ['zetta',  'Z',  1e21],
  ['exa',    'E',  1e18],
  ['peta',   'P',  1e15],
  ['tera',   'T',  1e12],
  ['giga',   'G',  1e9],
  ['mega',   'M',  1e6],
  ['kilo',   'k',  1e3],
  ['hecto',  'h',  1e2],
  ['deca',   'da', 1e1],
  // base — handled by the unprefixed registration
  ['deci',   'd',  1e-1],
  ['centi',  'c',  1e-2],
  ['milli',  'm',  1e-3],
  ['micro',  'µ',  1e-6],   // U+00B5 micro sign
  ['micro',  'μ',  1e-6],   // U+03BC greek mu
  ['micro',  'u',  1e-6],
  ['nano',   'n',  1e-9],
  ['pico',   'p',  1e-12],
  ['femto',  'f',  1e-15],
  ['atto',   'a',  1e-18],
  ['zepto',  'z',  1e-21],
  ['yocto',  'y',  1e-24],
  ['ronto',  'r',  1e-27],
  ['quecto', 'q',  1e-30],
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
  //   opts.inputOnly:     true → resolves for input, but excluded from the
  //                       formatter's auto-scale candidate pool. Use for
  //                       units the user can type but shouldn't be picked
  //                       as a default display unit (e.g., imperial units
  //                       in a metric-defaulting prelude).
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
    const inputOnly    = opts.inputOnly === true;

    const entry = {mul, dim, displayName, fullName: canonicalName};
    if (inputOnly) entry.inputOnly = true;
    this._addEntry(entry, [canonicalName, ...aliases, ...shortAliases]);

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

  // List unit entries available to the formatter's auto-scaler. Entries
  // flagged `inputOnly` are resolvable via resolve() but excluded here.
  list(filterDim = null) {
    const base = this._entries.filter(e => !e.inputOnly);
    if (!filterDim) return base;
    return base.filter(e => dimEq(filterDim, e.dim));
  }
}

// ─── format.js ─────────────────────────────────────────
// Format a Quantity to a human-readable string. Honors the disp tag set by
// convertTo; otherwise auto-scales to the largest unit that lands in
// [1, 1000) (with relaxed fallbacks for extreme magnitudes).

function format(q, registry, opts) {
  const { num, unit } = formatParts(q, registry, opts);
  return unit ? `${num} ${unit}` : num;
}

function formatParts(q, registry, opts = {}) {
  const sig = opts.sig ?? 5;
  if (dimEmpty(q.dim)) return { num: formatNumber(q.value, sig), unit: null };

  // Explicit display unit (from -> conversion) wins over auto-scale.
  if (q.disp) {
    const u = registry.resolve(q.disp);
    if (u && dimEq(u.dim, q.dim)) {
      return { num: formatNumber(q.value / u.mul, sig), unit: u.displayName };
    }
  }

  const cands = registry.list(q.dim);
  if (!cands.length) return { num: formatNumber(q.value, sig), unit: `[${dimFormat(q.dim)}]` };

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
  return { num: formatNumber(best.scaled, sig), unit: best.entry.displayName };
}

function formatNumber(n, sig = 5) {
  if (!isFinite(n)) return String(n);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  // Exponential digits track sig - 2 so 5 sig → "1.234e5" (legacy default).
  const expDigits = Math.max(0, sig - 2);
  if (abs < 1e-4 || abs >= 1e9) return n.toExponential(expDigits).replace('e+', 'e');
  const s = parseFloat(n.toPrecision(sig)).toString();
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
  'struct', 'to', 'per',
  'true', 'false',
  // Notably NOT a keyword: `mod` — upstream uses it as a regular fn name in
  // core::functions, so we keep it as an identifier. Numbat itself has no
  // infix `mod` operator (it's invoked as `mod(a, b)`).
]);

// Multi-character operators, sorted longest-first so the tokenizer prefers
// the longer match (`::` before `:`, `->` before `-`).
const MULTI_OPS = ['->', '=>', '::', '|>', '!=', '<=', '>=', '==', '&&', '||', '**'];

// Single-character operators / punctuation.
const SINGLE_OPS = '+-*/^=(){}[],:.<>!;';

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

// Identifier-start: ASCII letter, underscore, `%`, `$`, or any non-ASCII
// codepoint. This makes Greek letters, currency symbols, and symbol-style
// aliases (`%`, `‰`, `°`, `$`) tokenizable without lookup tables. The
// parser/loader decides which are valid in context.
const isIdentStart = (c) =>
  (c >= 'a' && c <= 'z') ||
  (c >= 'A' && c <= 'Z') ||
  c === '_' ||
  c === '%' ||
  c === '$' ||
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

    // Number literal — decimal (incl. underscore separators, scientific),
    // hexadecimal (0x), octal (0o), or binary (0b).
    if ((c >= '0' && c <= '9') || (c === '.' && source[i + 1] >= '0' && source[i + 1] <= '9')) {
      const numStart = i;
      // Radix-prefixed integers: `0x`, `0o`, `0b` (case-insensitive prefix).
      if (c === '0' && i + 1 < source.length) {
        const radixCh = source[i + 1];
        let radix = 0, allowed = null;
        if (radixCh === 'x' || radixCh === 'X') { radix = 16; allowed = /[0-9a-fA-F_]/; }
        else if (radixCh === 'o' || radixCh === 'O') { radix = 8;  allowed = /[0-7_]/;       }
        else if (radixCh === 'b' || radixCh === 'B') { radix = 2;  allowed = /[01_]/;        }
        if (radix) {
          advance(2);
          while (i < source.length && allowed.test(source[i])) advance();
          const raw = source.slice(numStart, i);
          const digits = raw.slice(2).replace(/_/g, '');
          if (!digits) throw new Error(`${sourceName}:${start.line}:${start.col}: empty radix literal`);
          emit('num', { value: parseInt(digits, radix), raw }, start);
          continue;
        }
      }
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

  // Span-combining helpers — attach a span to compound nodes that
  // covers the leftmost-child's start through the rightmost-child's
  // end. Lets error formatters caret the full source range of an
  // expression instead of just one operand.
  const spanOfN = (n) => n?.span ?? null;
  const combineSpans = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return { source: a.source, line: a.line, col: a.col, offset: a.offset, end: b.end ?? b.offset };
  };
  const mkBin = (op, left, right) => ({
    type: 'Binary', op, left, right,
    span: combineSpans(spanOfN(left), spanOfN(right)),
  });
  const mkUnary = (op, expr, headSpan) => ({
    type: 'Unary', op, expr,
    span: combineSpans(headSpan, spanOfN(expr)),
  });
  const mkParen = (expr, openSpan, closeSpan) => ({
    type: 'Paren', expr,
    span: combineSpans(openSpan, closeSpan ?? spanOfN(expr)),
  });
  const mkIf = (cond, thenB, elseB, headSpan) => ({
    type: 'If', cond, then: thenB, else: elseB,
    span: combineSpans(headSpan, spanOfN(elseB)),
  });
  const mkFactorial = (expr, bangSpan) => ({
    type: 'Factorial', expr,
    span: combineSpans(spanOfN(expr), bangSpan),
  });
  const mkField = (obj, name, nameSpan) => ({
    type: 'Field', obj, name,
    span: combineSpans(spanOfN(obj), nameSpan),
  });

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
        case 'struct':    return parseStruct(decorators);
        default:
          throw err(t, `unsupported keyword '${t.name}' at top level (v0.5 handles: use, dimension, unit, let, fn, struct)`);
      }
    }
    throw err(t, `expected a declaration keyword (use / dimension / unit / let / fn / struct)`);
  }

  function parseStruct(decorators) {
    eat();  // 'struct'
    const nameTok = expectType('id', 'struct name');
    const generics = [];
    if (atOp('<')) {
      eat();
      while (!atOp('>')) {
        generics.push(parseGenericParam());
        if (atOp(',')) eat();
        else break;
      }
      if (!atOp('>')) throw err(peek(), `expected '>' to close struct generics`);
      eat();
    }
    expectOp('{');
    const fields = [];
    while (!atOp('}')) {
      const fname = expectType('id', 'field name');
      expectOp(':');
      const ftype = parseTypeExpr();
      fields.push({ name: fname.name, type: ftype });
      if (atOp(',')) eat();
    }
    expectOp('}');
    return { type: 'StructDecl', name: nameTok.name, generics, fields, decorators };
  }

  function parseFn(decorators) {
    eat();  // 'fn'
    const nameTok = expectType('id', 'function name');
    // Optional generic parameters: `<T: Dim, U: Dim>`. v0.4 supports the `Dim`
    // kind; other kinds are parsed and stored but raise an error if used.
    const generics = [];
    if (atOp('<')) {
      eat();
      while (!atOp('>')) {
        generics.push(parseGenericParam());
        if (atOp(',')) eat();
        else break;
      }
      if (!atOp('>')) throw err(peek(), `expected '>' to close generic parameters`);
      eat();
    }
    expectOp('(');
    const params = [];
    while (!atOp(')')) {
      params.push(parseFnParam());
      if (atOp(',')) eat();
      else break;
    }
    expectOp(')');
    // Optional return type. Uses parseTypeExpr (parseAddExpr + optional
    // generic-type-args `<...>`) — the latter handles upstream signatures
    // like `fn args() -> List<String>` whose generic args we ignore in v0.4.
    let returnType = null;
    if (atOp('->')) {
      eat();
      returnType = parseTypeExpr();
    }
    // The body is optional: a fn declared `fn abs<T: Dim>(x: T) -> T` (no `=`)
    // is an *extern* declaration — its implementation lives in the host (our
    // BUILTIN_FNS). Upstream uses this for math/list primitives.
    let body = null;
    if (atOp('=')) {
      eat();
      body = parseExpr();
    }
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
    return { type: 'FnDecl', name: nameTok.name, generics, params, returnType, body, whereClauses, decorators };
  }

  function parseGenericParam() {
    const nameTok = expectType('id', 'generic parameter name');
    // Default kind is 'Type' (unrestricted) — matches upstream Numbat.
    // `<T: Dim>` is the explicit Dim-restricted form. The typechecker
    // promotes Type-kinded generics to Dim lazily via constraints when
    // they appear in dim-arithmetic positions.
    let kind = 'Type';
    if (atOp(':')) {
      eat();
      const kindTok = expectType('id', "generic kind (e.g. 'Dim')");
      kind = kindTok.name;
    }
    return { name: nameTok.name, kind };
  }

  function parseWhereClause() {
    const nameTok = expectType('id', 'where-clause binding name');
    // Optional type annotation: `where unit_val: D = ...`. We parse and store
    // it for future type checking; v0.5 doesn't enforce it at runtime.
    let typeAnno = null;
    if (atOp(':')) { eat(); typeAnno = parseTypeExpr(); }
    expectOp('=');
    const expr = parseExpr();
    return { name: nameTok.name, typeAnno, expr };
  }

  function parseFnParam() {
    const nameTok = expectType('id', 'parameter name');
    let typeExpr = null;
    if (atOp(':')) { eat(); typeExpr = parseTypeExpr(); }
    return { name: nameTok.name, typeExpr };
  }

  // Type expression: parseAddExpr followed by optional generic-type-args
  // `<...>` (captured as TypeApp) or function-type args `[(A) -> B]`
  // (captured as FnTypeAnno when the head is `Fn`). The angle-bracket
  // form is used for generic structs and List<D>; the bracket form is
  // used for first-class function types.
  function parseTypeExpr() {
    let t = parseAddExpr();
    while (atOp('<') || atOp('[')) {
      const open = peek().op;
      if (open === '<') {
        eat();
        const args = [];
        if (!atOp('>')) {
          args.push(parseTypeExpr());
          while (atOp(',')) { eat(); args.push(parseTypeExpr()); }
        }
        if (!atOp('>')) throw err(peek(), `expected '>' to close type-arg bracket`);
        eat();
        t = { type: 'TypeApp', base: t, args, span: t.span };
      } else {
        // `Fn[(A, B) -> C]` — parse the params + result properly.
        // Only recognized when the head is the identifier 'Fn'. For
        // anything else, fall back to the legacy "scan and discard"
        // behavior so non-Fn `[...]` annotations don't break parses.
        if (t.type === 'Ident' && t.name === 'Fn') {
          eat();   // consume '['
          expectOp('(');
          const params = [];
          if (!atOp(')')) {
            params.push(parseTypeExpr());
            while (atOp(',')) { eat(); params.push(parseTypeExpr()); }
          }
          expectOp(')');
          if (!atOp('->')) throw err(peek(), `expected '->' in Fn[...] type`);
          eat();
          const result = parseTypeExpr();
          if (!atOp(']')) throw err(peek(), `expected ']' to close Fn[...] type`);
          eat();
          t = { type: 'FnTypeAnno', params, result, span: t.span };
        } else {
          // Unknown `[...]` annotation — scan and discard.
          eat();
          let depth = 1;
          while (depth > 0 && peek()) {
            if (atOp('['))      { depth++; eat(); }
            else if (atOp(']')) { depth--; eat(); if (depth === 0) break; }
            else                { eat(); }
          }
          if (depth !== 0) throw err(peek(), `expected ']' to close type-arg bracket`);
        }
      }
    }
    return t;
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
    if (atOp(':')) { eat(); dim = parseTypeExpr(); }
    if (atOp('=')) { eat(); expr = parseExpr(); }
    return { type: 'UnitDecl', name: nameTok.name, dim, expr, decorators };
  }

  function parseLet(decorators) {
    eat();  // 'let'
    const nameTok = expectType('id', 'binding name');
    // Type annotation may be a dimension or a non-dim type like
    // `Fn[(DateTime) -> DateTime]`. parseTypeExpr handles both.
    let dim = null;
    if (atOp(':')) { eat(); dim = parseTypeExpr(); }
    expectOp('=');
    const expr = parseExpr();
    return { type: 'LetDecl', name: nameTok.name, dim, expr, decorators };
  }

  // ── expressions ─────────────────────────────────────────────────

  function parseExpr() {
    if (atKw('if')) return parseIfExpr();
    // Arrow-function lambda — single-param `x => body` form. The
    // multi-param `(x, y) => body` form is detected in parsePrimary
    // when it sees `(` (since `(x, y)` isn't a valid paren-expression
    // and would otherwise parse-fail). ep-flavored extension; upstream
    // Numbat doesn't currently have anonymous-fn syntax.
    if (peek() && peek().type === 'id' && peek(1) && peek(1).type === 'op' && peek(1).op === '=>') {
      const paramTok = eat();
      eat();  // '=>'
      const body = parseExpr();
      return { type: 'Lambda', params: [{ name: paramTok.name }], body, span: paramTok.span };
    }
    return parsePipe();
  }

  // Lookahead helper: from a `(` position, scan forward tracking paren
  // depth to find the matching `)`; return true iff `=>` follows it.
  // Used to disambiguate `(x, y) => body` (lambda) from `(x)` (paren-expr).
  function isParenLambdaAhead() {
    let depth = 0;
    let i = p;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === 'op' && t.op === '(') depth++;
      else if (t.type === 'op' && t.op === ')') {
        depth--;
        if (depth === 0) {
          const next = tokens[i + 1];
          return !!(next && next.type === 'op' && next.op === '=>');
        }
      }
      i++;
    }
    return false;
  }

  // Parse a multi-param lambda: positioned at the opening `(`.
  // Form: `(name [: TypeAnno], name [: TypeAnno], ...) => body`
  function parseParenLambda() {
    const openTok = eat();   // '('
    const params = [];
    while (!atOp(')')) {
      const nameTok = peek();
      if (!nameTok || nameTok.type !== 'id') {
        throw err(nameTok, 'expected lambda parameter name');
      }
      eat();
      const param = { name: nameTok.name };
      if (atOp(':')) {
        eat();
        param.type = parseTypeAnno();
      }
      params.push(param);
      if (atOp(',')) eat();
      else break;
    }
    expectOp(')');
    expectOp('=>');
    const body = parseExpr();
    return { type: 'Lambda', params, body, span: openTok.span };
  }

  // Pipe `|>`: `x |> f` → Call(f, [x]); `x |> f(args)` → Call(f, [x, ...args]).
  // Left-associative, looser than conversion (`pi/3 + pi |> cos` works).
  function parsePipe() {
    let l = parseOr();
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
    return mkIf(cond, thenBranch, elseBranch, spanOfN(cond));
  }

  // Precedence (lowest → highest, all left-associative except ^):
  //   if-then-else                          (top of parseExpr)
  //   pipe `|>`
  //   logical or `||`
  //   logical and `&&`
  //   comparison ==/!=/</<=/>/>=
  //   conversion `->` / `to`
  //   + / -
  //   * / /
  //   implicit multiplication
  //   power ^ (right-associative)
  //   unary -
  //   primary
  function parseOr() {
    let l = parseAnd();
    while (atOp('||')) {
      eat();
      l = mkBin('||', l, parseAnd());
    }
    return l;
  }

  function parseAnd() {
    let l = parseCmp();
    while (atOp('&&')) {
      eat();
      l = mkBin('&&', l, parseCmp());
    }
    return l;
  }

  function parseCmp() {
    let l = parseConversion();
    while (peek() && peek().type === 'op' && CMP_OPS.has(peek().op)) {
      const op = eat().op;
      l = mkBin(op, l, parseConversion());
    }
    return l;
  }

  function parseConversion() {
    let l = parseAddExpr();
    while (atOp('->') || atKw('to')) {
      eat();
      const right = parseAddExpr();
      l = mkBin('->', l, right);
    }
    return l;
  }

  function parseAddExpr() {
    let l = parseMulExpr();
    while (atOp('+') || atOp('-')) {
      const op = eat().op;
      l = mkBin(op, l, parseMulExpr());
    }
    return l;
  }

  function parseMulExpr() {
    let l = parseImplMul();
    while (true) {
      let op;
      if (atOp('*') || atOp('/')) op = eat().op;
      else if (atKw('per'))       { eat(); op = '/'; }   // `meter per second`
      else break;
      l = mkBin(op, l, parseImplMul());
    }
    return l;
  }

  function parseImplMul() {
    let l = parsePower();
    while (isExprStart(peek())) {
      l = mkBin('*', l, parsePower());
    }
    return l;
  }

  function parsePower() {
    let base = parseUnary();
    // Postfix forms: field access `.name` and factorial `!`. Loop so chains
    // like `a.b.c!` work. `!` is its own AST node — NOT a Call to factorial —
    // so user-defined `fn factorial(n) = n!` doesn't recurse infinitely.
    while (atOp('.') || atOp('!')) {
      if (atOp('.')) {
        eat();
        const fnameTok = expectType('id', 'field name');
        base = mkField(base, fnameTok.name, fnameTok.span);
      } else {
        const bangTok = eat();
        base = mkFactorial(base, bangTok.span);
      }
    }
    if (atOp('^') || atOp('**')) {
      eat();
      const exp = parsePower();  // right-associative
      return mkBin('^', base, exp);
    }
    return base;
  }

  function parseUnary() {
    if (atOp('-')) {
      const tok = eat();
      return mkUnary('-', parseUnary(), tok.span);
    }
    // Prefix `!` is boolean NOT. (Postfix `!` factorial is handled in
    // parsePower, after the operand is consumed.)
    if (atOp('!')) {
      const tok = eat();
      return mkUnary('!', parseUnary(), tok.span);
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
    if (t.type === 'str') { eat(); return { type: 'Str', value: t.value }; }
    if (t.type === 'num') { eat(); return { type: 'Num', value: t.value, raw: t.raw }; }
    if (t.type === 'id')  {
      eat();
      // Function call: `name(args)` if `(` immediately follows.
      if (atOp('(')) {
        eat();
        const args = [];
        while (!atOp(')')) {
          args.push(parseExpr());
          if (atOp(',')) eat();
          else break;
        }
        expectOp(')');
        return { type: 'Call', name: t.name, args, span: t.span };
      }
      // Struct construction: `Name { field: value, ... }`.
      if (atOp('{')) {
        eat();
        const fields = [];
        while (!atOp('}')) {
          const fname = expectType('id', 'field name');
          expectOp(':');
          const fval = parseExpr();
          fields.push({ name: fname.name, value: fval });
          if (atOp(',')) eat();
          else break;
        }
        expectOp('}');
        return { type: 'StructInit', name: t.name, fields, span: t.span };
      }
      return { type: 'Ident', name: t.name, span: t.span };
    }
    if (t.type === 'op' && t.op === '(') {
      // Multi-param lambda: `(x, y) => body`. Detect via lookahead so
      // we don't try to parse `(x, y)` as a paren-expr first (the
      // comma would fail the regular expression grammar). Single-
      // param lambdas without parens land in parseExpr instead.
      if (isParenLambdaAhead()) {
        return parseParenLambda();
      }
      const openTok  = eat();
      const inner    = parseExpr();
      const closeTok = expectOp(')');
      return mkParen(inner, openTok.span, closeTok.span);
    }
    // List literal: `[a, b, c]`, or `[]` for empty. Trailing commas allowed.
    if (t.type === 'op' && t.op === '[') {
      eat();
      const items = [];
      while (!atOp(']')) {
        items.push(parseExpr());
        if (atOp(',')) eat();
        else break;
      }
      if (!atOp(']')) throw err(peek(), `expected ']' to close list literal`);
      eat();
      return { type: 'List', items, span: t.span };
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

// ─── typecheck/rat.js ──────────────────────────────────
// Rational arithmetic for typechecker exponents.
//
// Why rationals: the typechecker needs to express dim exponents like 1/2
// (for sqrt) and 1/3 (for cbrt) during inference, even though the runtime
// stays integer-only. A program like `sqrt(area)` typechecks as
// `(Length^2)^(1/2) = Length^1` — the 1/2 has to be representable
// somewhere or the typechecker can't close the loop.
//
// Shape: { n, d } where d > 0 and gcd(|n|, d) === 1. Always normalized at
// construction. JS numbers (not BigInt) — exponents stay small in practice
// (max we've seen in any prelude is 6) and the perf cost of BigInt isn't
// worth it for the typecheck domain.

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { const t = b; b = a % b; a = t; }
  return a;
}

function normalize(n, d) {
  if (d === 0) throw new Error('rational: zero denominator');
  if (d < 0) { n = -n; d = -d; }
  if (n === 0) return { n: 0, d: 1 };
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

function ratOf(n, d = 1) { return Object.freeze(normalize(n, d)); }

const RAT_ZERO = ratOf(0);
const RAT_ONE  = ratOf(1);

function ratIsZero(r) { return r.n === 0; }
function ratIsInt(r)  { return r.d === 1; }
function ratIsOne(r)  { return r.n === 1 && r.d === 1; }

function ratEq(a, b)  { return a.n === b.n && a.d === b.d; }

function ratAdd(a, b) { return ratOf(a.n * b.d + b.n * a.d, a.d * b.d); }
function ratSub(a, b) { return ratOf(a.n * b.d - b.n * a.d, a.d * b.d); }
function ratMul(a, b) { return ratOf(a.n * b.n, a.d * b.d); }
function ratDiv(a, b) {
  if (b.n === 0) throw new Error('rational: division by zero');
  return ratOf(a.n * b.d, a.d * b.n);
}
function ratNeg(a)    { return ratOf(-a.n, a.d); }

function ratFormat(r) {
  if (r.d === 1) return String(r.n);
  return `${r.n}/${r.d}`;
}

// ─── typecheck/types.js ────────────────────────────────
// Type representation for the typechecker.
//
// Tag-discriminated frozen objects, no classes — so structural equality
// works via deep-compare and JSON.stringify gives a usable debug print.
//
// Two var spaces:
//   TVar    — ordinary type variables (Bool/String/Fn/Struct/List polymorphism)
//   TDimVar — dim-level variables (participate in multiplicative dim arithmetic)
// Mixing them in one space makes the dim solver harder. Upstream splits the
// same way (Type::TVar vs DType::TypeVariable).

let _nextTVar    = 0;
let _nextTDimVar = 0;

function freshTVar()    { return { kind: 'TVar',    id: _nextTVar++ }; }
function freshTDimVar() { return { kind: 'TDimVar', id: _nextTDimVar++ }; }

// Test-only — reset id counters so test runs are reproducible.
function resetTypeIds() { _nextTVar = 0; _nextTDimVar = 0; }

// ── DimExpr ───────────────────────────────────────────────────────
//
// A dim expression at typecheck time: a product of base-dim powers and
// dim-var powers. Stored as two sparse maps with rational exponents.
//
//   { base: { length: Rat, mass: Rat, ... },
//     vars: { 0: Rat, 1: Rat, ... } }       // keys are TDimVar ids
//
// Identity (dimensionless / scalar) is `{ base: {}, vars: {} }`.
// Concrete runtime dims (from dimensions.js) lift in via dimExprFromMap —
// all integer denominators, no vars.

function freezeDimExpr(base, vars) {
  return Object.freeze({ base: Object.freeze(base), vars: Object.freeze(vars) });
}

function dimExprEmpty() { return freezeDimExpr({}, {}); }

function dimExprFromMap(dimMap) {
  const base = {};
  for (const k in dimMap) {
    if (dimMap[k] !== 0) base[k] = ratOf(dimMap[k]);
  }
  return freezeDimExpr(base, {});
}

function dimExprFromVar(tdvar) {
  return freezeDimExpr({}, { [tdvar.id]: ratOf(1) });
}

function ratMapEq(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const ra = a[k]; const rb = b[k];
    if (!ra) { if (!ratIsZero(rb)) return false; continue; }
    if (!rb) { if (!ratIsZero(ra)) return false; continue; }
    if (!ratEq(ra, rb)) return false;
  }
  return true;
}

function dimExprEq(a, b) {
  return ratMapEq(a.base, b.base) && ratMapEq(a.vars, b.vars);
}

function dimExprIsConcrete(d) { return Object.keys(d.vars).length === 0; }
function dimExprIsScalar(d) {
  for (const k in d.base) if (!ratIsZero(d.base[k])) return false;
  for (const k in d.vars) if (!ratIsZero(d.vars[k])) return false;
  return true;
}

// ── DimExpr arithmetic (multiplicative) ───────────────────────────
//
// Shared by check.js (constraint generation), subst.js (substitution
// composition), and dim-solve.js (the dim equation solver). Lives here
// so the flat-scope build doesn't see duplicate helpers.

function cleanDimExprFor(base, vars) {
  const b = {};
  for (const k in base) if (!ratIsZero(base[k])) b[k] = base[k];
  const v = {};
  for (const k in vars) if (!ratIsZero(vars[k])) v[k] = vars[k];
  return freezeDimExpr(b, v);
}

function dimExprMul(a, b) {
  const base = { ...a.base };
  for (const k in b.base) base[k] = base[k] ? ratAdd(base[k], b.base[k]) : b.base[k];
  const vars = { ...a.vars };
  for (const k in b.vars) vars[k] = vars[k] ? ratAdd(vars[k], b.vars[k]) : b.vars[k];
  return cleanDimExprFor(base, vars);
}

function dimExprDiv(a, b) {
  const base = { ...a.base };
  for (const k in b.base) base[k] = base[k] ? ratSub(base[k], b.base[k]) : ratNeg(b.base[k]);
  const vars = { ...a.vars };
  for (const k in b.vars) vars[k] = vars[k] ? ratSub(vars[k], b.vars[k]) : ratNeg(b.vars[k]);
  return cleanDimExprFor(base, vars);
}

function dimExprPow(d, r) {
  if (ratIsZero(r)) return dimExprEmpty();
  const base = {};
  for (const k in d.base) base[k] = ratMul(d.base[k], r);
  const vars = {};
  for (const k in d.vars) vars[k] = ratMul(d.vars[k], r);
  return cleanDimExprFor(base, vars);
}

// Inverse-substitute one dim-var inside a DimExpr (var `id` → `repl`).
// Used when extending the substitution with a new dim-var binding so
// previously-stored values get the new resolution.
function dimExprSubstVar(d, id, repl) {
  if (!(id in d.vars)) return d;
  const exp = d.vars[id];
  const v = { ...d.vars }; delete v[id];
  const stripped = freezeDimExpr({ ...d.base }, v);
  return dimExprMul(stripped, dimExprPow(repl, exp));
}

function dimExprFormat(d) {
  const parts = [];
  for (const k in d.base) {
    const r = d.base[k];
    if (ratIsZero(r)) continue;
    parts.push(r.n === 1 && r.d === 1 ? k : `${k}^${ratFormat(r)}`);
  }
  for (const k in d.vars) {
    const r = d.vars[k];
    if (ratIsZero(r)) continue;
    const name = `$${k}`;
    parts.push(r.n === 1 && r.d === 1 ? name : `${name}^${ratFormat(r)}`);
  }
  return parts.join('·') || '-';
}

// ── Type constructors ─────────────────────────────────────────────

function tVar(id)                   { return Object.freeze({ kind: 'TVar', id }); }
function tDimVar(id)                { return Object.freeze({ kind: 'TDimVar', id }); }
function tDim(dimExpr)              { return Object.freeze({ kind: 'TDim', dim: dimExpr }); }
function tBool()                    { return T_BOOL; }
function tString()                  { return T_STRING; }
function tNever()                   { return T_NEVER; }
// tFn(params, result, opts?). opts.optional = N marks the LAST N params
// as optional — call sites can omit them. Used by variadic procs like
// assert_eq (mandatory `a, b`; optional `tolerance`).
function tFn(params, result, opts) {
  const optional = opts?.optional ?? 0;
  return Object.freeze({
    kind: 'TFn',
    params: Object.freeze([...params]),
    result,
    optional,
  });
}
function tList(elem)                { return Object.freeze({ kind: 'TList', elem }); }
function tStruct(name, fields)      { return Object.freeze({ kind: 'TStruct', name, fields: Object.freeze({ ...fields }) }); }
function tTuple(elems)              { return Object.freeze({ kind: 'TTuple', elems: Object.freeze([...elems]) }); }

// A type scheme is ∀(tvars, dimVars). body — used for generic fn signatures.
//
//   fn id<D: Dim>(x: D) -> D
// becomes
//   tScheme([], [d0], tFn([tDim(dimExprFromVar(d0))], tDim(dimExprFromVar(d0))))
//
// `binderOrder` (optional) lists kinds in declaration order: ['T','D'].
// Used by evalTypeApp to bind positional type args correctly when binders
// mix tvars and dimVars. Defaults to "all dimVars first, then all tvars".
function tScheme(tvars, dimVars, body, opts) {
  const order = opts?.binderOrder ?? [
    ...dimVars.map(() => 'D'),
    ...tvars.map(() => 'T'),
  ];
  let ti = 0, di = 0;
  const binders = order.map(k => k === 'T'
    ? { kind: 'T', var: tvars[ti++] }
    : { kind: 'D', var: dimVars[di++] });
  return Object.freeze({
    kind: 'TScheme',
    tvars:   Object.freeze([...tvars]),
    dimVars: Object.freeze([...dimVars]),
    binders: Object.freeze(binders.map(Object.freeze)),
    body,
  });
}

const T_BOOL   = Object.freeze({ kind: 'TBool' });
const T_STRING = Object.freeze({ kind: 'TString' });
const T_NEVER  = Object.freeze({ kind: 'TNever' });

const T_SCALAR = tDim(dimExprEmpty());

// ── Closed-type equality + formatting ─────────────────────────────
//
// Structural eq for types with NO free vars. Open types (containing TVar
// or TDimVar without substitution) are unifier territory — use unify().

function typeEq(a, b) {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'TBool':
    case 'TString':
    case 'TNever':
      return true;
    case 'TVar':
    case 'TDimVar':
      return a.id === b.id;
    case 'TDim':
      return dimExprEq(a.dim, b.dim);
    case 'TFn':
      if (a.params.length !== b.params.length) return false;
      for (let i = 0; i < a.params.length; i++) if (!typeEq(a.params[i], b.params[i])) return false;
      return typeEq(a.result, b.result);
    case 'TList':
      return typeEq(a.elem, b.elem);
    case 'TTuple':
      if (a.elems.length !== b.elems.length) return false;
      for (let i = 0; i < a.elems.length; i++) if (!typeEq(a.elems[i], b.elems[i])) return false;
      return true;
    case 'TStruct': {
      if (a.name !== b.name) return false;
      const ak = Object.keys(a.fields).sort();
      const bk = Object.keys(b.fields).sort();
      if (ak.length !== bk.length) return false;
      for (let i = 0; i < ak.length; i++) {
        if (ak[i] !== bk[i]) return false;
        if (!typeEq(a.fields[ak[i]], b.fields[bk[i]])) return false;
      }
      return true;
    }
    case 'TScheme':
      if (a.tvars.length !== b.tvars.length) return false;
      if (a.dimVars.length !== b.dimVars.length) return false;
      return typeEq(a.body, b.body);
    default:
      throw new Error(`typeEq: unknown kind ${a.kind}`);
  }
}

function formatType(t) {
  switch (t.kind) {
    case 'TBool':   return 'Bool';
    case 'TString': return 'String';
    case 'TNever':  return '!';
    case 'TVar':    return `'a${t.id}`;
    case 'TDimVar': return `$${t.id}`;
    case 'TDim':    return dimExprIsScalar(t.dim) ? 'Scalar' : dimExprFormat(t.dim);
    case 'TFn':     return `(${t.params.map(formatType).join(', ')}) -> ${formatType(t.result)}`;
    case 'TList':   return `List<${formatType(t.elem)}>`;
    case 'TTuple':  return `(${t.elems.map(formatType).join(', ')})`;
    case 'TStruct': return t.name;
    case 'TScheme': {
      const binders = [
        ...t.tvars.map(v => `'a${v.id ?? v}`),
        ...t.dimVars.map(v => `$${v.id ?? v}`),
      ].join(', ');
      return binders.length ? `∀(${binders}). ${formatType(t.body)}` : formatType(t.body);
    }
    default: return `<unknown ${t.kind}>`;
  }
}

// Walk a type and collect free TVar ids and free TDimVar ids. "Free" here
// means "appears anywhere" — TScheme binders are NOT subtracted; callers
// that need scheme-aware freevars handle it themselves.
function freeVars(t, acc = { tvars: new Set(), dimVars: new Set() }) {
  switch (t.kind) {
    case 'TVar':    acc.tvars.add(t.id); break;
    case 'TDimVar': acc.dimVars.add(t.id); break;
    case 'TDim':    for (const k in t.dim.vars) acc.dimVars.add(Number(k)); break;
    case 'TFn':     for (const p of t.params) freeVars(p, acc); freeVars(t.result, acc); break;
    case 'TList':   freeVars(t.elem, acc); break;
    case 'TTuple':  for (const e of t.elems) freeVars(e, acc); break;
    case 'TStruct': for (const k in t.fields) freeVars(t.fields[k], acc); break;
    case 'TScheme': freeVars(t.body, acc); break;
    case 'TBool': case 'TString': case 'TNever': break;
  }
  return acc;
}

// ─── typecheck/env.js ──────────────────────────────────
// Typed environment for the typechecker.
//
// Parallel to load.js's value env. Walks a parent chain on lookup; new
// scopes are child envs that shadow the parent. Immutable from the
// caller's view — operations return new envs rather than mutating.
//
// Four slots, mirroring the runtime env shape so the two stay in sync:
//   values   — identifier → Type    (let-bindings, fn params in scope)
//   fns      — fn-name    → TScheme (always a scheme; monomorphic fns
//                                    are just schemes with no binders)
//   dims     — dim-name   → DimMap  (`Length` → {length:1}, etc.)
//   structs  — name       → TStruct

function makeTypeEnv() {
  return {
    parent:  null,
    values:  new Map(),
    fns:     new Map(),
    dims:    new Map(),
    structs: new Map(),
  };
}

function typeEnvExtend(parent) {
  return {
    parent,
    values:  new Map(),
    fns:     new Map(),
    dims:    new Map(),
    structs: new Map(),
  };
}

function lookupIn(env, slot, name) {
  let e = env;
  while (e) {
    const v = e[slot].get(name);
    if (v !== undefined) return v;
    e = e.parent;
  }
  return undefined;
}

function typeEnvLookupValue(env, name)  { return lookupIn(env, 'values',  name); }
function typeEnvLookupFn(env, name)     { return lookupIn(env, 'fns',     name); }
function typeEnvLookupDim(env, name)    { return lookupIn(env, 'dims',    name); }
function typeEnvLookupStruct(env, name) { return lookupIn(env, 'structs', name); }

function typeEnvBindValue(env, name, type)    { env.values.set(name,  type);   return env; }
function typeEnvBindFn(env, name, scheme)     { env.fns.set(name,     scheme); return env; }
function typeEnvBindDim(env, name, dim)       { env.dims.set(name,    dim);    return env; }
function typeEnvBindStruct(env, name, struct) { env.structs.set(name, struct); return env; }

// Collect free TVar/TDimVar ids that appear in any binding in this env
// (and its parents). Used by generalize() to know which vars are
// "captured" by the outer scope and therefore must NOT be generalized at
// the current fn boundary. Implementation comes in scheme.js; this is the
// hook so callers don't need to know the env shape.
function envFreeVars(env, collect) {
  let e = env;
  while (e) {
    for (const t of e.values.values()) collect(t);
    for (const s of e.fns.values())    collect(s);
    e = e.parent;
  }
}

// ─── typecheck/constraints.js ──────────────────────────
// Constraint set for the typechecker.
//
// Constraints accumulate during the inference walk (check.js) and are
// discharged by the solver (dim-solve.js + unify.js). Spans flow through
// so phase-5 error reporting can point at the right source location.
//
// Four constraint kinds, matching upstream's:
//   Equal(t1, t2)      — classical unification: t1 ≡ t2
//   IsDType(t)         — t must be a dimension type
//   HasField(t, n, ft) — t must be a struct with field n having type ft
//   (EqualScalar omitted: it's just Equal(t, T_SCALAR))

function cEqual(t1, t2, span, context)        { return Object.freeze({ kind: 'Equal',    t1, t2, span: span || null, context: context || null }); }
function cIsDType(t, span, context)           { return Object.freeze({ kind: 'IsDType',  t,      span: span || null, context: context || null }); }
function cHasField(t, name, ft, span, context){ return Object.freeze({ kind: 'HasField', t, name, fieldType: ft, span: span || null, context: context || null }); }

function makeConstraintSet() { return { items: [] }; }
function cAdd(cs, c)         { cs.items.push(c); return cs; }
function cAll(cs, list)      { for (const c of list) cs.items.push(c); return cs; }

// ─── typecheck/check.js ────────────────────────────────
// Constraint-generating walker (phase 2 of the typechecker).
//
// `inferExpr(node, env, ctx)` walks an expression AST, returns the inferred
// Type, and side-effects constraints into `ctx.cs`. `checkModule(ast, env)`
// runs the same over a Module's decls, mutating the env to bind names
// (let-decls, fn-decls, dim-decls, unit-decls, struct-decls).
//
// No solving here — the constraint set is handed off to the unifier
// (phase 3). At this stage TVars and TDimVars in the returned types are
// just placeholders awaiting substitution.

// Collect candidate names from an env (values + fns + dims + structs)
// and any in-scope generic params. Used by did-you-mean suggestions.
function envCandidates(env, ctx) {
  const out = new Set();
  for (let e = env; e; e = e.parent) {
    for (const k of e.values.keys())  out.add(k);
    for (const k of e.fns.keys())     out.add(k);
    for (const k of e.dims.keys())    out.add(k);
    for (const k of e.structs.keys()) out.add(k);
  }
  if (ctx?.generics) for (const k of ctx.generics.keys()) out.add(k);
  return [...out];
}

// ── Entry point ───────────────────────────────────────────────────

function checkModule(ast, env) {
  const ctx = { cs: makeConstraintSet(), errors: [], generics: new Map() };
  for (const decl of ast.decls) {
    try { checkDecl(decl, env, ctx); }
    catch (e) { ctx.errors.push({ message: e.message, span: e.span || null }); }
  }
  return { constraints: ctx.cs, errors: ctx.errors, env };
}

// ── Const evaluator for ^ exponents ───────────────────────────────
//
// Returns a Rat if the expression is a compile-time numeric constant,
// or null otherwise. Supports literal numbers, unary -, and the four
// arithmetic binops between constants. Mirrors the subset of upstream's
// const_evaluation.rs that real Numbat programs actually use.

// Detects expressions that are statically zero — used by the polymorphic-
// zero rule for + and -. Recognizes the literal `0`, parenthesized
// zeros, unary `-0`, zero multiplied by anything (0 propagates through
// `*`), and zero divided by anything (0/x = 0 when x ≠ 0).
function isStaticZero(node) {
  if (!node) return false;
  switch (node.type) {
    case 'Num':       return node.value === 0;
    case 'Paren':     return isStaticZero(node.expr);
    case 'Unary':     return node.op === '-' && isStaticZero(node.expr);
    case 'Binary':
      if (node.op === '*') return isStaticZero(node.left) || isStaticZero(node.right);
      if (node.op === '/') return isStaticZero(node.left);
      if (node.op === '+' || node.op === '-')
        return isStaticZero(node.left) && isStaticZero(node.right);
      return false;
    default: return false;
  }
}

function tryFoldConst(node) {
  if (!node) return null;
  switch (node.type) {
    case 'Num':    return ratOf(node.value);   // JS numbers truncate to int — fine for typical exponents
    case 'Paren':  return tryFoldConst(node.expr);
    case 'Unary': {
      const r = tryFoldConst(node.expr);
      if (!r) return null;
      return node.op === '-' ? ratNeg(r) : null;
    }
    case 'Binary': {
      const l = tryFoldConst(node.left);
      const r = tryFoldConst(node.right);
      if (!l || !r) return null;
      switch (node.op) {
        case '+': return ratAdd(l, r);
        case '-': return ratSub(l, r);
        case '*': return ratMul(l, r);
        case '/': return r.n === 0 ? null : ratDiv(l, r);
        case '^': {
          // Integer exponent only — fractional powers on rationals
          // (e.g. (1/2)^(1/3)) need real-number exponentiation we don't
          // want to muddle exact arithmetic with.
          if (r.d !== 1) return null;
          let acc = ratOf(1);
          const e = Math.abs(r.n);
          for (let i = 0; i < e; i++) acc = ratMul(acc, l);
          return r.n < 0 ? ratDiv(ratOf(1), acc) : acc;
        }
        default: return null;
      }
    }
    default: return null;
  }
}

// ── Type annotation evaluator ─────────────────────────────────────
//
// Walks an annotation AST (same shape as a regular expression, since
// parseTypeExpr just calls parseAddExpr) and returns a Type. In-scope
// generic params resolve to TDimVars via ctx.generics.

function evalTypeAnno(node, env, ctx) {
  if (!node) return T_SCALAR;
  switch (node.type) {
    case 'Paren':       return evalTypeAnno(node.expr, env, ctx);
    case 'TypeApp':     return evalTypeApp(node, env, ctx);
    case 'FnTypeAnno': {
      // `Fn[(A, B) -> C]` annotation: build a TFn directly.
      const params = node.params.map(p => evalTypeAnno(p, env, ctx));
      const result = evalTypeAnno(node.result, env, ctx);
      return tFn(params, result);
    }
    case 'Ident': {
      const name = node.name;
      if (ctx.generics.has(name)) {
        const entry = ctx.generics.get(name);
        // Dim-kinded generics (explicit `<T: Dim>`) wrap directly as
        // TDim. Type-kinded generics (default `<T>`) return the bare
        // TVar; promotion to TDim happens lazily in dim-arithmetic
        // positions below via Equal constraints.
        return entry.kind === 'D' ? tDim(dimExprFromVar(entry.var)) : entry.var;
      }
      if (name === 'Scalar')   return T_SCALAR;
      if (name === 'Bool')     return tBool();
      if (name === 'String')   return tString();
      const dim = typeEnvLookupDim(env, name);
      if (dim) return tDim(dimExprFromMap(dim));
      const struct = typeEnvLookupStruct(env, name);
      if (struct) {
        // Generic struct referenced without `<...>` is an error — matches
        // upstream's strict arity check. Non-generic structs (binders=[])
        // pass through.
        const binders = struct.kind === 'TScheme' ? (struct.binders ?? []) : [];
        if (binders.length > 0) {
          throw withSpan(new Error(`${name} expects ${binders.length} type args, got 0`), node.span);
        }
        return instantiate(struct);
      }
      throw withSpan(new Error(`unknown type: ${name}${didYouMeanSuffix(name, envCandidates(env, ctx))}`), node.span);
    }
    case 'Num': {
      // Bare 1 in a type position means Scalar — used in `1 / Time`.
      if (node.value === 1) return T_SCALAR;
      throw withSpan(new Error(`numeric literal '${node.value}' in type position (only '1' allowed)`), node.span);
    }
    case 'Binary': {
      const l = evalTypeAnno(node.left, env, ctx);
      // Helper: turn a Type-kinded TVar operand into a TDim by allocating
      // a fresh dim-var and emitting a constraint that ties them. Returns
      // the operand's dim expression to use in arithmetic.
      const asDim = (t, side) => {
        if (t.kind === 'TDim') return t.dim;
        if (t.kind === 'TVar') {
          const dv = freshTDimVar();
          const dvDim = dimExprFromVar(dv);
          cAdd(ctx.cs, cEqual(t, tDim(dvDim), spanOf(side)));
          return dvDim;
        }
        throw withSpan(new Error(`type-level '${node.op}' needs dimension operand, got ${formatType(t)}`), node.span);
      };
      if (node.op === '^') {
        const exp = tryFoldConst(node.right);
        if (!exp) throw withSpan(new Error('exponent in type position must be a constant'), node.span);
        const lDim = asDim(l, node.left);
        return tDim(dimExprPow(lDim, exp));
      }
      const r = evalTypeAnno(node.right, env, ctx);
      const lDim = asDim(l, node.left);
      const rDim = asDim(r, node.right);
      switch (node.op) {
        case '*': return tDim(dimExprMul(lDim, rDim));
        case '/': return tDim(dimExprDiv(lDim, rDim));
        default:  throw withSpan(new Error(`unsupported operator in type position: ${node.op}`), node.span);
      }
    }
    case 'Unary': {
      if (node.op === '-') {
        const r = tryFoldConst(node);
        if (r) {
          // Negative numbers as exponents are handled in ^ — bare unary
          // minus in a type position doesn't make sense otherwise.
          throw withSpan(new Error('unary minus has no meaning in a type expression'), node.span);
        }
      }
      throw withSpan(new Error(`unsupported unary in type position: ${node.op}`), node.span);
    }
    default:
      throw withSpan(new Error(`unsupported node in type annotation: ${node.type}`), node.span);
  }
}

function withSpan(err, span) { err.span = span || null; return err; }

// Best-effort span lookup. The parser attaches `.span` to Ident, Call,
// StructInit, List, and a few decl-level nodes — but not to Binary,
// Unary, If, or Paren. For those, fall back to the leftmost
// span-carrying child so error messages still point at *some* spot in
// the source.
function spanOf(node) {
  if (!node) return null;
  if (node.span) return node.span;
  switch (node.type) {
    case 'Binary':    return spanOf(node.left) || spanOf(node.right);
    case 'Unary':     return spanOf(node.expr);
    case 'Paren':     return spanOf(node.expr);
    case 'Factorial': return spanOf(node.expr);
    case 'If':        return spanOf(node.cond) || spanOf(node.then) || spanOf(node.else);
    case 'Field':     return spanOf(node.obj);
    case 'TypeApp':   return spanOf(node.base);
    default:          return null;
  }
}

// Public for the integration layer, which uses it to lift already-
// loaded user fn/struct declarations from the runtime env.
// TypeApp: `List<D>`, `Box<Length>`, `Pair<Length, Mass>`. Looks up the
// head as a struct/list constructor and substitutes the explicit args
// for the constructor's bound dim-vars. Note: we DON'T call instantiate
// here — the explicit args provide the renaming directly.
function evalTypeApp(node, env, ctx) {
  if (node.base.type !== 'Ident') {
    throw withSpan(new Error('type application head must be a name'), node.span);
  }
  const name = node.base.name;

  if (name === 'List') {
    if (node.args.length !== 1) throw withSpan(new Error(`List takes 1 type arg, got ${node.args.length}`), node.span);
    return tList(evalTypeAnno(node.args[0], env, ctx));
  }

  const scheme = typeEnvLookupStruct(env, name);
  if (scheme && scheme.kind === 'TScheme') {
    const arity = scheme.binders.length;
    if (node.args.length !== arity) {
      throw withSpan(new Error(`${name} expects ${arity} type args, got ${node.args.length}`), node.span);
    }
    const sub = makeSubst();
    for (let i = 0; i < arity; i++) {
      const b = scheme.binders[i];
      const argT = evalTypeAnno(node.args[i], env, ctx);
      if (b.kind === 'T') {
        // Type-kinded binder: accept any type.
        sub.tvars.set(b.var.id, argT);
      } else {
        // Dim-kinded binder: require TDim and substitute its dim expr.
        if (argT.kind !== 'TDim') {
          throw withSpan(new Error(`${name} type arg ${i} must be a dimension type, got ${formatType(argT)}`), node.span);
        }
        sub.dimVars.set(b.var.id, argT.dim);
      }
    }
    return applyType(scheme.body, sub);
  }

  throw withSpan(new Error(`unknown type constructor: ${name}`), node.span);
}

// ── Decl-level checks ─────────────────────────────────────────────

function checkDecl(decl, env, ctx) {
  switch (decl.type) {
    case 'LetDecl':       return checkLetDecl(decl, env, ctx);
    case 'FnDecl':        return checkFnDecl(decl, env, ctx);
    case 'DimensionDecl': return checkDimensionDecl(decl, env, ctx);
    case 'UnitDecl':      return checkUnitDecl(decl, env, ctx);
    case 'StructDecl':    return checkStructDecl(decl, env, ctx);
    case 'UseStmt':       return;  // module-resolution is loader's job; nothing to typecheck
    default:
      // Top-level expression statements (allowed in upstream) — infer + drop.
      if (isExprNode(decl)) { inferExpr(decl, env, ctx); return; }
      throw withSpan(new Error(`unsupported top-level decl: ${decl.type}`), decl.span);
  }
}

function isExprNode(n) {
  switch (n.type) {
    case 'Num': case 'Bool': case 'Str': case 'Ident': case 'Paren':
    case 'Unary': case 'Binary': case 'Call': case 'If': case 'List':
    case 'Field': case 'StructInit': case 'Factorial':
      return true;
    default: return false;
  }
}

function checkLetDecl(decl, env, ctx) {
  const inferred = inferExpr(decl.expr, env, ctx);
  if (decl.dim) {
    const anno = evalTypeAnno(decl.dim, env, ctx);
    cAdd(ctx.cs, cEqual(anno, inferred, spanOf(decl.expr)));
    typeEnvBindValue(env, decl.name, anno);   // annotation wins as the declared type
  } else {
    typeEnvBindValue(env, decl.name, inferred);
  }
}

function checkFnDecl(decl, env, ctx) {
  // Extern fn (no body) must have an annotated return type. Without it
  // the type would be polymorphic in a vacuous way and the runtime
  // dispatcher couldn't validate calls. Matches upstream.
  if (decl.body === null && decl.returnType === null) {
    throw withSpan(new Error(`extern fn '${decl.name}' needs a return type annotation`), decl.span);
  }
  // Name-clash: fn names mustn't collide with let-bound values, dim
  // names, or struct names. Multiple fn overloads with the same name
  // are also rejected (we don't have overload resolution).
  assertNameAvailable(decl.name, env, ctx, decl.span, 'fn');
  // Generic params bind in a fresh ctx — each call site gets fresh tvars
  // via instantiate() in phase 4. For the body-check we use the generic
  // params directly so the dim-vars line up with the signature.
  const savedGenerics = ctx.generics;
  ctx.generics = new Map(savedGenerics);
  // Track binders in declaration order (matters for application-site
  // positional args). Each entry is {kind: 'T'|'D', var, name}.
  const declBinders = [];
  for (const g of decl.generics || []) {
    if (g.kind === 'Dim') {
      const tdv = freshTDimVar();
      ctx.generics.set(g.name, { kind: 'D', var: tdv });
      declBinders.push({ kind: 'D', var: tdv, name: g.name });
    } else {
      // Default ('Type') or any other annotation: unrestricted TVar.
      // Promotion to TDim happens lazily via Equal constraints when the
      // generic is used in a dim-arithmetic position.
      const tv = freshTVar();
      ctx.generics.set(g.name, { kind: 'T', var: tv });
      declBinders.push({ kind: 'T', var: tv, name: g.name });
    }
  }

  // Param types from annotations (or fresh TVar if missing).
  const paramTypes = [];
  for (const p of decl.params) {
    paramTypes.push(p.typeExpr ? evalTypeAnno(p.typeExpr, env, ctx) : freshTVar());
  }
  const returnType = decl.returnType ? evalTypeAnno(decl.returnType, env, ctx) : freshTVar();

  // Bind the fn's own scheme into env BEFORE body inference so recursive
  // references resolve. The scheme will be replaced with the final
  // version below — using the same scheme object means the recursive
  // call site instantiates with fresh dim-vars per call.
  const fnTypeForRecursion = tFn(paramTypes, returnType);
  const tvarsForGenerics   = declBinders.filter(b => b.kind === 'T').map(b => b.var);
  const dimVarsForGenerics = declBinders.filter(b => b.kind === 'D').map(b => b.var);
  const binderOrder = declBinders.map(b => b.kind);
  const recursionScheme = tScheme(tvarsForGenerics, dimVarsForGenerics, fnTypeForRecursion, { binderOrder });
  typeEnvBindFn(env, decl.name, recursionScheme);

  // If body is null, this is an extern decl — nothing to check internally.
  if (decl.body !== null) {
    const bodyEnv = typeEnvExtend(env);
    for (let i = 0; i < decl.params.length; i++) {
      typeEnvBindValue(bodyEnv, decl.params[i].name, paramTypes[i]);
    }
    // where-clauses: evaluate in order, bind each. Each clause can refer
    // to params + prior clauses + the fn body.
    if (decl.whereClauses) {
      for (const w of decl.whereClauses) {
        const t = inferExpr(w.expr, bodyEnv, ctx);
        typeEnvBindValue(bodyEnv, w.name, t);
      }
    }
    const bodyType = inferExpr(decl.body, bodyEnv, ctx);
    cAdd(ctx.cs, cEqual(returnType, bodyType, spanOf(decl.body)));
  }

  ctx.generics = savedGenerics;
  // Final scheme is the one bound above for recursion. finalizeDecl in
  // integration.js applies the per-decl solver's subst and re-derives
  // binders from the resolved body's free vars.
  typeEnvBindFn(env, decl.name, recursionScheme);
}

// Cross-namespace name clash check. Each name lives in at most one of:
// { dims, values (let/unit), fns, structs }. Multiple decls of the same
// name within the SAME namespace are allowed only when `allowReplace`
// is true (used for fn redeclaration during recursive pre-binding).
function assertNameAvailable(name, env, ctx, span, kind) {
  // Forbid cross-namespace clashes. Recursive fn pre-binding doesn't
  // route through this check — it goes directly to typeEnvBindFn — so
  // we can reject fn redeclaration unconditionally here.
  if (kind !== 'dim'    && typeEnvLookupDim(env, name))    throw withSpan(new Error(`name '${name}' already used as a dimension`), span);
  if (kind !== 'struct' && typeEnvLookupStruct(env, name)) throw withSpan(new Error(`name '${name}' already used as a struct`), span);
  if (kind !== 'fn'     && typeEnvLookupFn(env, name))     throw withSpan(new Error(`name '${name}' already used as a function`), span);
  // Within fn namespace: redeclaration is also an error.
  if (kind === 'fn' && env.fns.has(name)) {
    throw withSpan(new Error(`fn '${name}' is already defined`), span);
  }
  // Don't enforce a clash against env.values (let/unit) — Numbat
  // intentionally allows shadowing via `let` in many cases.
}

function checkDimensionDecl(decl, env, ctx) {
  assertNameAvailable(decl.name, env, ctx, decl.span, 'dim');
  // `dimension Foo` → base axis named 'foo' (lowercased to match runtime).
  // `dimension Foo = Length * Mass` → derived dim.
  if (!decl.exprs || decl.exprs.length === 0) {
    typeEnvBindDim(env, decl.name, { [decl.name.toLowerCase()]: 1 });
    return;
  }
  // Each entry is an alternative definition (upstream allows several for
  // consistency-check) — we just take the first.
  const e = decl.exprs[0];
  const t = evalTypeAnno(e, env, ctx);
  if (t.kind !== 'TDim') throw withSpan(new Error(`dimension RHS must be a dim expression`), decl.span);
  // Reduce to integer DimMap (annotation should resolve to a concrete
  // integer-exponent dim).
  const dm = dimExprToMap(t.dim, decl.span);
  typeEnvBindDim(env, decl.name, dm);
}

function dimExprToMap(d, span) {
  if (Object.keys(d.vars).length) {
    throw withSpan(new Error(`dimension definition must not contain type variables`), span);
  }
  const out = {};
  for (const k in d.base) {
    const r = d.base[k];
    if (r.d !== 1) throw withSpan(new Error(`dimension exponent must be an integer, got ${r.n}/${r.d}`), span);
    out[k] = r.n;
  }
  return out;
}

function checkUnitDecl(decl, env, ctx) {
  // Three forms:
  //   `unit name: DimExpr` — dim from annotation
  //   `unit name = ValueExpr` — dim from inferring the value
  //   `unit name: DimExpr = ValueExpr` — annotated AND defined; cross-check.
  let annoT = null, exprT = null;
  if (decl.dim) {
    annoT = evalTypeAnno(decl.dim, env, ctx);
    if (annoT.kind !== 'TDim') throw withSpan(new Error(`unit annotation must be a dim type`), decl.span);
  }
  if (decl.expr) {
    exprT = inferExpr(decl.expr, env, ctx);
    if (exprT.kind !== 'TDim') throw withSpan(new Error(`unit value must be a dim quantity`), decl.span);
  }
  if (annoT && exprT) {
    // Cross-check: annotated dim must match expression's dim. Surfaces
    // `unit my_c: C = a` (A != C).
    cAdd(ctx.cs, cEqual(annoT, exprT, spanOf(decl.expr)));
  }
  const t = annoT ?? exprT;
  if (t) {
    typeEnvBindValue(env, decl.name, t);
  } else {
    // `unit name` with no body — base unit, dim auto-generated.
    typeEnvBindValue(env, decl.name, tDim(dimExprFromMap({ [decl.name]: 1 })));
  }
}

function checkStructDecl(decl, env, ctx) {
  assertNameAvailable(decl.name, env, ctx, decl.span, 'struct');
  // Generic struct generics: each binder is T-kinded (unrestricted)
  // by default, D-kinded with explicit `: Dim`. Mirrors fn-decl.
  const savedGenerics = ctx.generics;
  ctx.generics = new Map(savedGenerics);
  const declBinders = [];
  for (const g of decl.generics || []) {
    if (g.kind === 'Dim') {
      const tdv = freshTDimVar();
      ctx.generics.set(g.name, { kind: 'D', var: tdv });
      declBinders.push({ kind: 'D', var: tdv, name: g.name });
    } else {
      const tv = freshTVar();
      ctx.generics.set(g.name, { kind: 'T', var: tv });
      declBinders.push({ kind: 'T', var: tv, name: g.name });
    }
  }
  const fields = {};
  for (const f of decl.fields) {
    fields[f.name] = evalTypeAnno(f.type, env, ctx);
  }
  ctx.generics = savedGenerics;
  const tvars   = declBinders.filter(b => b.kind === 'T').map(b => b.var);
  const dimVars = declBinders.filter(b => b.kind === 'D').map(b => b.var);
  const binderOrder = declBinders.map(b => b.kind);
  typeEnvBindStruct(env, decl.name, tScheme(tvars, dimVars, tStruct(decl.name, fields), { binderOrder }));
}

// ── Expression-level inference ────────────────────────────────────

function inferExpr(node, env, ctx) {
  switch (node.type) {
    case 'Num':       return T_SCALAR;
    case 'Bool':      return tBool();
    case 'Str':       return tString();
    case 'Paren':     return inferExpr(node.expr, env, ctx);
    case 'Ident':     return inferIdent(node, env, ctx);
    case 'Unary':     return inferUnary(node, env, ctx);
    case 'Binary':    return inferBinary(node, env, ctx);
    case 'Call':      return inferCall(node, env, ctx);
    case 'If':        return inferIf(node, env, ctx);
    case 'List':      return inferList(node, env, ctx);
    case 'Field':     return inferField(node, env, ctx);
    case 'StructInit':return inferStructInit(node, env, ctx);
    case 'Factorial': return inferFactorial(node, env, ctx);
    case 'Lambda':    return inferLambda(node, env, ctx);
    default:
      throw withSpan(new Error(`inferExpr: unsupported node type ${node.type}`), node.span);
  }
}

function inferIdent(node, env, ctx) {
  const v = typeEnvLookupValue(env, node.name);
  if (v) return v;
  const fn = typeEnvLookupFn(env, node.name);
  if (fn) return instantiate(fn);   // higher-order use
  throw withSpan(new Error(`unknown identifier: ${node.name}${didYouMeanSuffix(node.name, envCandidates(env, ctx))}`), node.span);
}

function inferUnary(node, env, ctx) {
  const inner = inferExpr(node.expr, env, ctx);
  switch (node.op) {
    case '-': {
      cAdd(ctx.cs, cIsDType(inner, spanOf(node)));
      return inner;
    }
    case '!': {
      cAdd(ctx.cs, cEqual(inner, tBool(), spanOf(node)));
      return tBool();
    }
    default:
      throw withSpan(new Error(`unsupported unary operator: ${node.op}`), node.span);
  }
}

function inferBinary(node, env, ctx) {
  const op = node.op;

  if (op === '&&' || op === '||') {
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, tBool(), spanOf(node.left)));
    cAdd(ctx.cs, cEqual(r, tBool(), spanOf(node.right)));
    return tBool();
  }

  if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, r, spanOf(node)));
    return tBool();
  }

  if (op === '+' || op === '-') {
    // Polymorphic zero: `0` (and `0 * x`, `-0`, etc.) is the additive
    // identity for any dim. `1 a + 0` typechecks as A; `1 a + 0 * b`
    // also typechecks as A because `0 * b` is statically zero. Mirrors
    // upstream Numbat's behavior.
    const leftZero  = isStaticZero(node.left);
    const rightZero = isStaticZero(node.right);
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    if (leftZero && !rightZero) {
      cAdd(ctx.cs, cIsDType(r, spanOf(node.right)));
      return r;
    }
    if (rightZero && !leftZero) {
      cAdd(ctx.cs, cIsDType(l, spanOf(node.left)));
      return l;
    }
    cAdd(ctx.cs, cIsDType(l, spanOf(node.left)));
    cAdd(ctx.cs, cEqual(l, r, spanOf(node), `'${op}'`));
    return l;
  }

  if (op === '*' || op === '/') {
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cIsDType(l, spanOf(node.left)));
    cAdd(ctx.cs, cIsDType(r, spanOf(node.right)));
    // Pull a dim-expr out of each operand. When the operand is already a
    // TDim, use its dim directly. When it's a TVar (will be promoted to
    // TDim by the IsDType handler), allocate a fresh dim-var and emit an
    // Equal constraint that ties the TVar to TDim<$thatDimVar> so the
    // result expression stays connected to the operand's dim.
    const lDim = l.kind === 'TDim' ? l.dim : dimExprFromVar(freshTDimVar());
    const rDim = r.kind === 'TDim' ? r.dim : dimExprFromVar(freshTDimVar());
    if (l.kind !== 'TDim') cAdd(ctx.cs, cEqual(l, tDim(lDim), spanOf(node.left)));
    if (r.kind !== 'TDim') cAdd(ctx.cs, cEqual(r, tDim(rDim), spanOf(node.right)));
    return tDim(op === '*' ? dimExprMul(lDim, rDim) : dimExprDiv(lDim, rDim));
  }

  if (op === '^') {
    const l = inferExpr(node.left, env, ctx);
    const exp = tryFoldConst(node.right);
    if (exp) {
      if (l.kind === 'TDim') return tDim(dimExprPow(l.dim, exp));
      // Unresolved base: emit IsDType + allocate a dim-var, tie l to
      // TDim<$dv>, and return TDim<$dv ^ exp> so the surrounding pass
      // sees the right dim shape downstream.
      cAdd(ctx.cs, cIsDType(l, spanOf(node.left)));
      const dv = freshTDimVar();
      const dvDim = dimExprFromVar(dv);
      cAdd(ctx.cs, cEqual(l, tDim(dvDim), spanOf(node.left)));
      return tDim(dimExprPow(dvDim, exp));
    }
    // Non-const exponent — both base and exp must be Scalar (the only
    // case dimensionally well-defined without static eval).
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, T_SCALAR, spanOf(node.left)));
    cAdd(ctx.cs, cEqual(r, T_SCALAR, spanOf(node.right)));
    return T_SCALAR;
  }

  if (op === '->') {
    // Conversion: left and right are both dim expressions of the same
    // dim. Result type = left (the value side).
    const l = inferExpr(node.left,  env, ctx);
    const r = inferExpr(node.right, env, ctx);
    cAdd(ctx.cs, cEqual(l, r, spanOf(node), `conversion '->'`));
    return l;
  }

  throw withSpan(new Error(`unsupported binary operator: ${op}`), node.span);
}

function inferCall(node, env, ctx) {
  const scheme = typeEnvLookupFn(env, node.name);
  if (!scheme) {
    // Could still be a higher-order call via a value (the AST shape
    // disambiguates Ident-call from value-call upstream, but our parser
    // routes both through Call). Fall back to value lookup.
    const v = typeEnvLookupValue(env, node.name);
    if (v && v.kind === 'TFn') return inferDirectFnCall(v, node, env, ctx);
    throw withSpan(new Error(`unknown function: ${node.name}${didYouMeanSuffix(node.name, envCandidates(env, ctx))}`), node.span);
  }
  return inferDirectFnCall(instantiate(scheme), node, env, ctx);
}

function inferDirectFnCall(fnT, node, env, ctx) {
  if (fnT.kind !== 'TFn') throw withSpan(new Error(`call target is not a function: ${formatType(fnT)}`), node.span);
  // Variadic support: optional trailing params can be omitted. The
  // accepted arg count range is [params.length - optional, params.length].
  const optional = fnT.optional ?? 0;
  const minArity = fnT.params.length - optional;
  const maxArity = fnT.params.length;
  if (node.args.length < minArity || node.args.length > maxArity) {
    const arityRange = minArity === maxArity ? `${minArity}` : `${minArity}..${maxArity}`;
    throw withSpan(new Error(`${node.name}: expected ${arityRange} args, got ${node.args.length}`), node.span);
  }
  for (let i = 0; i < node.args.length; i++) {
    const argT = inferExpr(node.args[i], env, ctx);
    cAdd(ctx.cs, cEqual(fnT.params[i], argT, spanOf(node.args[i]), `argument ${i + 1} of call to '${node.name}'`));
  }
  return fnT.result;
}

function inferIf(node, env, ctx) {
  const c = inferExpr(node.cond, env, ctx);
  cAdd(ctx.cs, cEqual(c, tBool(), spanOf(node.cond), `if condition`));
  const t = inferExpr(node.then,  env, ctx);
  const e = inferExpr(node.else,  env, ctx);
  cAdd(ctx.cs, cEqual(t, e, spanOf(node), `if branches`));
  return t;
}

function inferList(node, env, ctx) {
  if (node.items.length === 0) return tList(freshTVar());
  const first = inferExpr(node.items[0], env, ctx);
  for (let i = 1; i < node.items.length; i++) {
    const ti = inferExpr(node.items[i], env, ctx);
    cAdd(ctx.cs, cEqual(first, ti, spanOf(node.items[i])));
  }
  return tList(first);
}

// Arrow-function lambda inference. Each param gets a fresh type var
// (or its annotated type, if given), then the body is inferred in an
// env extended with those bindings. Returns TFn(paramTypes, bodyType).
// Monomorphic — captured fn values aren't let-generalized (the caller
// supplies arg types at the call site, and HM unification handles the
// rest). Matches what fnDecl does for top-level fns, minus the
// recursion-scheme bit (lambdas can't reference themselves by name).
function inferLambda(node, env, ctx) {
  const paramTypes = node.params.map(p => {
    if (p.type) {
      // Annotated lambda param. Type annotations in expression position
      // are parsed but rare; reuse the same evaluator the let-anno path
      // uses if it's available, otherwise fall back to a fresh TVar.
      try { return evalTypeAnno(p.type, env, ctx); }
      catch { return freshTVar(); }
    }
    return freshTVar();
  });
  const bodyEnv = typeEnvExtend(env);
  for (let i = 0; i < node.params.length; i++) {
    typeEnvBindValue(bodyEnv, node.params[i].name, paramTypes[i]);
  }
  const bodyType = inferExpr(node.body, bodyEnv, ctx);
  return tFn(paramTypes, bodyType);
}

function inferField(node, env, ctx) {
  const objT = inferExpr(node.obj, env, ctx);
  if (objT.kind === 'TStruct') {
    if (!(node.name in objT.fields)) {
      throw withSpan(new Error(`struct ${objT.name} has no field '${node.name}'`), node.span);
    }
    return objT.fields[node.name];
  }
  // Polymorphic case: emit HasField, return a fresh tvar that the solver
  // will tie to the actual field type.
  const ft = freshTVar();
  cAdd(ctx.cs, cHasField(objT, node.name, ft, spanOf(node)));
  return ft;
}

function inferStructInit(node, env, ctx) {
  const scheme = typeEnvLookupStruct(env, node.name);
  if (!scheme) throw withSpan(new Error(`unknown struct: ${node.name}`), node.span);
  // Instantiate at each use — fresh dim-vars per construction site so
  // separate `Pair { ... }` exprs don't accidentally share generics.
  const s = instantiate(scheme);
  const seen = new Set();
  for (const f of node.fields) {
    if (!(f.name in s.fields)) throw withSpan(new Error(`struct ${node.name} has no field '${f.name}'`), node.span);
    seen.add(f.name);
    const fT = inferExpr(f.value, env, ctx);
    cAdd(ctx.cs, cEqual(s.fields[f.name], fT, spanOf(f.value)));
  }
  for (const k in s.fields) {
    if (!seen.has(k)) throw withSpan(new Error(`struct ${node.name} missing field '${k}'`), node.span);
  }
  return s;
}

function inferFactorial(node, env, ctx) {
  const t = inferExpr(node.expr, env, ctx);
  cAdd(ctx.cs, cEqual(t, T_SCALAR, spanOf(node.expr)));
  return T_SCALAR;
}

// ─── typecheck/subst.js ────────────────────────────────
// Substitutions and type-application for the typechecker.
//
// A substitution has two parts (mirrors the two var spaces from types.js):
//
//   { tvars:   Map<TVarId,    Type>,
//     dimVars: Map<TDimVarId, DimExpr> }
//
// The invariant we maintain is **idempotence**: after applying `subst` to
// a type, no further `apply(subst, ...)` makes a difference. To preserve
// idempotence as we add bindings, we always apply the current substitution
// to the new value FIRST (so it's fully resolved) and then walk all
// existing entries replacing the new var. This is the "compose" trick from
// standard HM, just inlined into extend().

function makeSubst() {
  return { tvars: new Map(), dimVars: new Map() };
}

// ── apply: walk a type, resolving all bound vars ──────────────────

function applyType(t, subst) {
  switch (t.kind) {
    case 'TVar': {
      if (subst.tvars.has(t.id)) return applyType(subst.tvars.get(t.id), subst);
      return t;
    }
    case 'TDim':    return tDim(applyDimExpr(t.dim, subst));
    case 'TFn':     return tFn(t.params.map(p => applyType(p, subst)), applyType(t.result, subst), { optional: t.optional ?? 0 });
    case 'TList':   return tList(applyType(t.elem, subst));
    case 'TTuple':  return tTuple(t.elems.map(e => applyType(e, subst)));
    case 'TStruct': {
      const f = {};
      for (const k in t.fields) f[k] = applyType(t.fields[k], subst);
      return tStruct(t.name, f);
    }
    default: return t;   // TBool, TString, TNever, TDimVar (bare — shouldn't normally appear)
  }
}

// Apply subst to every DimExpr in a Type, but only the dim half — used
// when extending dim-var bindings and we need to push the new mapping
// into already-stored TVar→Type entries.
function applyDimVarSubstToType(t, dimVarId, repl) {
  switch (t.kind) {
    case 'TDim':    return tDim(dimExprSubstVar(t.dim, dimVarId, repl));
    case 'TFn':     return tFn(t.params.map(p => applyDimVarSubstToType(p, dimVarId, repl)), applyDimVarSubstToType(t.result, dimVarId, repl), { optional: t.optional ?? 0 });
    case 'TList':   return tList(applyDimVarSubstToType(t.elem, dimVarId, repl));
    case 'TTuple':  return tTuple(t.elems.map(e => applyDimVarSubstToType(e, dimVarId, repl)));
    case 'TStruct': {
      const f = {};
      for (const k in t.fields) f[k] = applyDimVarSubstToType(t.fields[k], dimVarId, repl);
      return tStruct(t.name, f);
    }
    default: return t;
  }
}

// applyDimExpr: walk a DimExpr, resolving each var via the substitution.
// Bounded iteration — each pass strictly removes one resolvable var (or
// makes no change, signaling we're done).
function applyDimExpr(d, subst) {
  let cur = d;
  while (true) {
    let resolved = false;
    let acc = Object.freeze({ base: Object.freeze({ ...cur.base }), vars: Object.freeze({}) });
    for (const k in cur.vars) {
      const id = Number(k);
      const exp = cur.vars[k];
      if (subst.dimVars.has(id)) {
        acc = dimExprMul(acc, dimExprPow(subst.dimVars.get(id), exp));
        resolved = true;
      } else {
        const v = { ...acc.vars };
        v[k] = v[k] ? ratAdd(v[k], exp) : exp;
        acc = Object.freeze({ base: acc.base, vars: Object.freeze(v) });
      }
    }
    if (!resolved) return acc;
    cur = acc;
  }
}

// ── extend with occurs check ──────────────────────────────────────

class UnifyError extends Error {
  constructor(message, span) { super(message); this.name = 'UnifyError'; this.span = span || null; }
}

// Bind α := τ. τ must already be fully-resolved (caller's responsibility:
// apply current subst before calling). Throws UnifyError on occurs.
function extendTVar(subst, id, type) {
  if (occursTVar(id, type)) {
    throw new UnifyError(`occurs check: 'a${id} appears in its own binding`);
  }
  const newTVars   = new Map();
  const newDimVars = new Map();
  for (const [k, v] of subst.tvars)   newTVars.set(k,   applyType(v, { tvars: new Map([[id, type]]), dimVars: new Map() }));
  for (const [k, v] of subst.dimVars) newDimVars.set(k, v);   // dim-var values don't contain TVars
  newTVars.set(id, type);
  return { tvars: newTVars, dimVars: newDimVars };
}

// Bind $id := dimExpr. dimExpr must already be fully-resolved.
function extendDimVar(subst, id, dimExpr) {
  if (id in dimExpr.vars) {
    throw new UnifyError(`occurs check: $${id} appears in its own binding`);
  }
  const newDimVars = new Map();
  for (const [k, v] of subst.dimVars) newDimVars.set(k, dimExprSubstVar(v, id, dimExpr));
  newDimVars.set(id, dimExpr);
  const newTVars = new Map();
  for (const [k, v] of subst.tvars)   newTVars.set(k, applyDimVarSubstToType(v, id, dimExpr));
  return { tvars: newTVars, dimVars: newDimVars };
}

function occursTVar(id, t) {
  switch (t.kind) {
    case 'TVar':    return t.id === id;
    case 'TFn':     return t.params.some(p => occursTVar(id, p)) || occursTVar(id, t.result);
    case 'TList':   return occursTVar(id, t.elem);
    case 'TTuple':  return t.elems.some(e => occursTVar(id, e));
    case 'TStruct': for (const k in t.fields) if (occursTVar(id, t.fields[k])) return true; return false;
    default:        return false;
  }
}

// ─── typecheck/errors.js ───────────────────────────────
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

function formatDim(dimExpr, dimAliases = null) {
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
function buildDimAliases(env) {
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

function formatTypePretty(t) {
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

function formatError(err, source, sourceName) {
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
function formatErrors(errors, source, sourceName) {
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
function didYouMean(target, candidates, max = 3, threshold = null) {
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
function didYouMeanSuffix(target, candidates) {
  const matches = didYouMean(target, candidates);
  if (matches.length === 0) return '';
  if (matches.length === 1) return ` (did you mean '${matches[0]}'?)`;
  return ` (did you mean ${matches.map(m => `'${m}'`).join(' or ')}?)`;
}

// ─── typecheck/dim-solve.js ────────────────────────────
// Dim-equation solver.
//
// Given a constraint `TDim(a) ~ TDim(b)`, find a substitution σ such that
// σ(a) = σ(b) as dim expressions. We work incrementally — each call
// extends the substitution by one variable binding (or by zero if the
// constraint is already satisfied) and returns the new substitution.
//
// Incremental form (rather than batched matrix reduction): every dim
// constraint is `a · b⁻¹ = 1`. After resolving with the current subst:
//
//   - If c = a·b⁻¹ has no dim-vars, its base part must be all-zero
//     (else it's a hard dim mismatch).
//   - If c has dim-vars, pick one ($k with coefficient e) and solve:
//       $k = (c without $k) raised to (-1/e)
//     Extend the subst with that binding.
//
// Rational exponents throughout — the solver handles `sqrt`-style ops
// correctly (`Length^(1/2) = D` → D := Length^(1/2)).

function solveDimEq(a, b, subst, span, context, dimAliases) {
  const aR = applyDimExpr(a, subst);
  const bR = applyDimExpr(b, subst);
  const c  = dimExprDiv(aR, bR);

  // No vars to bind — the equation must already hold.
  if (Object.keys(c.vars).length === 0) {
    if (dimExprIsScalar(c)) return subst;
    const where = context ? ` in ${context}` : '';
    throw new UnifyError(`dimension mismatch${where}: expected ${formatDim(aR, dimAliases)}, got ${formatDim(bR, dimAliases)}`, span);
  }

  // Pick a var to solve for. Heuristic: prefer the one whose coefficient
  // is ±1 (clean substitution); fall back to first.
  const varIds = Object.keys(c.vars).map(Number);
  let pickId = varIds[0];
  for (const id of varIds) {
    const r = c.vars[id];
    if (r.d === 1 && (r.n === 1 || r.n === -1)) { pickId = id; break; }
  }
  const coef = c.vars[pickId];

  // Build "c without pickId", negate, then raise to 1/coef → the solution.
  const restVars = { ...c.vars };
  delete restVars[pickId];
  const rest = Object.freeze({ base: Object.freeze({ ...c.base }), vars: Object.freeze(restVars) });
  // pickId^coef · rest = 1  →  pickId = rest^(-1/coef)
  const negInvCoef = ratDiv(ratOf(-1), coef);
  const solution   = dimExprPow(rest, negInvCoef);

  return extendDimVar(subst, pickId, solution);
}

// ─── typecheck/unify.js ────────────────────────────────
// Main unifier — `unify(t1, t2, subst) → subst'`.
//
// Cases:
//   - typeEq after applying current subst → subst unchanged
//   - TVar on either side → bind (occurs check)
//   - TDim ~ TDim → delegate to dim solver
//   - TFn ~ TFn (same arity) → unify each param + result
//   - TList ~ TList → unify elem
//   - TTuple ~ TTuple (same arity) → unify each
//   - TStruct ~ TStruct (same name) → unify each field
//   - TBool / TString / TNever ~ self → trivial
//   - anything else → throw UnifyError
//
// Throws UnifyError with the constraint's source span attached so
// phase-5 error reporting can point at the right line.

function unify(t1, t2, subst, span, context, dimAliases) {
  const a = applyType(t1, subst);
  const b = applyType(t2, subst);
  if (typeEq(a, b)) return subst;

  if (a.kind === 'TVar') return extendTVar(subst, a.id, b);
  if (b.kind === 'TVar') return extendTVar(subst, b.id, a);

  if (a.kind === 'TDim' && b.kind === 'TDim') {
    return solveDimEq(a.dim, b.dim, subst, span, context, dimAliases);
  }

  const where = context ? ` in ${context}` : '';

  if (a.kind === 'TFn' && b.kind === 'TFn') {
    if (a.params.length !== b.params.length) {
      throw new UnifyError(`function arity mismatch${where}: expected ${a.params.length}, got ${b.params.length}`, span);
    }
    let s = subst;
    for (let i = 0; i < a.params.length; i++) s = unify(a.params[i], b.params[i], s, span, context, dimAliases);
    return unify(a.result, b.result, s, span, context, dimAliases);
  }

  if (a.kind === 'TList' && b.kind === 'TList') {
    return unify(a.elem, b.elem, subst, span, context, dimAliases);
  }

  if (a.kind === 'TTuple' && b.kind === 'TTuple') {
    if (a.elems.length !== b.elems.length) {
      throw new UnifyError(`tuple arity mismatch${where}: expected ${a.elems.length}, got ${b.elems.length}`, span);
    }
    let s = subst;
    for (let i = 0; i < a.elems.length; i++) s = unify(a.elems[i], b.elems[i], s, span, context, dimAliases);
    return s;
  }

  if (a.kind === 'TStruct' && b.kind === 'TStruct') {
    if (a.name !== b.name) throw new UnifyError(`struct mismatch${where}: ${a.name} vs ${b.name}`, span);
    let s = subst;
    for (const k in a.fields) {
      if (!(k in b.fields)) throw new UnifyError(`struct ${a.name}: field ${k} missing on other side`, span);
      s = unify(a.fields[k], b.fields[k], s, span, context, dimAliases);
    }
    return s;
  }

  throw new UnifyError(`cannot unify ${formatTypePretty(a)} with ${formatTypePretty(b)}${where}`, span);
}

// ─── typecheck/scheme.js ───────────────────────────────
// Polymorphism — TScheme construction (generalize) and use (instantiate).
//
// A TScheme is `∀(tvars, dimVars). body` — the body is a Type that may
// reference the bound vars. instantiate() makes fresh vars at each use
// site so two calls to the same generic fn don't accidentally share
// dim-var ids. generalize() packages a body + explicit binder list into
// a scheme — used by check.js when finalizing a fn-decl or struct-decl.
//
// `generalize` takes explicit binders here (rather than computing free
// vars and subtracting the env's free set) because Numbat requires
// explicit generic params on fn-decls — there's no inferred polymorphism
// for un-annotated fns the way ML/Haskell have.

// Wrap (body, tvars, dimVars) into a scheme. Body is taken as-is — the
// caller is responsible for applying any pending substitution first.
function generalize(body, tvars, dimVars) {
  return tScheme(tvars, dimVars, body);
}

// Replace scheme's bound vars with fresh ones, return the renamed body.
// Non-scheme inputs pass through (useful where env.fns is consulted but
// the entry might not be a scheme yet during partial construction).
function instantiate(scheme) {
  if (scheme.kind !== 'TScheme') return scheme;
  // Prefer scheme.binders for ordered walks; fall back to tvars+dimVars
  // for legacy callers that construct schemes by hand (older tests).
  const binders = scheme.binders ?? [
    ...scheme.dimVars.map(v => ({ kind: 'D', var: v })),
    ...scheme.tvars.map(v   => ({ kind: 'T', var: v })),
  ];
  if (binders.length === 0) return scheme.body;

  const sub = makeSubst();
  for (const b of binders) {
    if (b.kind === 'T') sub.tvars.set(b.var.id, freshTVar());
    else                sub.dimVars.set(b.var.id, dimExprFromVar(freshTDimVar()));
  }
  return applyType(scheme.body, sub);
}

// ─── typecheck/solve.js ────────────────────────────────
// Top-level constraint solver — walks the constraint set from check.js,
// applies unification, and returns (subst, errors). Handles Equal
// directly via unify; defers IsDType and HasField until the relevant
// type is concrete enough to discharge.
//
// IsDType and HasField are simple shape predicates — we keep deferring
// them across passes as long as progress is being made elsewhere. If a
// pass produces no changes and constraints remain, they're unresolvable
// and we surface as errors.

function solve(constraintSet, opts) {
  const dimAliases = opts?.dimAliases ?? null;
  let subst = makeSubst();
  const errors = [];
  let deferred = constraintSet.items.slice();
  let prevLen = -1;
  let prevSubstSize = -1;

  while (deferred.length > 0) {
    const curSubstSize = subst.tvars.size + subst.dimVars.size;
    // Termination: if no constraints were discharged AND no new subst
    // entries this round, we're stuck.
    if (deferred.length === prevLen && curSubstSize === prevSubstSize) break;
    prevLen = deferred.length;
    prevSubstSize = curSubstSize;

    const next = [];
    for (const c of deferred) {
      try {
        if (c.kind === 'Equal') {
          subst = unify(c.t1, c.t2, subst, c.span, c.context, dimAliases);
        } else if (c.kind === 'IsDType') {
          const r = applyType(c.t, subst);
          if (r.kind === 'TDim') continue;            // satisfied
          if (r.kind === 'TVar') {
            // Promote: this TVar must be a dimension type. Bind it to a
            // fresh TDim wrapping a fresh dim-var. Subsequent uses of the
            // TVar resolve to that TDim; the dim-var stays free until
            // either further constraints pin it or the post-pass
            // generalizes it.
            subst = extendTVar(subst, r.id, tDim(dimExprFromVar(freshTDimVar())));
            continue;
          }
          throw new UnifyError(`expected dimension type, got ${formatTypePretty(r)}`, c.span);
        } else if (c.kind === 'HasField') {
          const r = applyType(c.t, subst);
          if (r.kind === 'TStruct') {
            if (!(c.name in r.fields)) {
              throw new UnifyError(`struct ${r.name}: no field '${c.name}'`, c.span);
            }
            subst = unify(c.fieldType, r.fields[c.name], subst, c.span, c.context, dimAliases);
          } else if (r.kind === 'TVar') {
            next.push(c);
          } else {
            throw new UnifyError(`field access on non-struct: ${formatTypePretty(r)}`, c.span);
          }
        }
      } catch (e) {
        if (e instanceof UnifyError) errors.push({ message: e.message, span: e.span });
        else throw e;
      }
    }
    deferred = next;
  }

  // Any constraints still deferred are genuinely unresolvable.
  for (const c of deferred) {
    errors.push({ message: `unresolvable constraint: ${c.kind}`, span: c.span });
  }

  return { subst, errors };
}

// ─── typecheck/integration.js ──────────────────────────
// Glue between the typechecker and the runtime (load.js).
//
// `buildTypeEnv(runtimeEnv)` walks a freshly-constructed runtime env
// (dims registry, units registry, value table) and produces a parallel
// typed env. Hand-rolled schemes for the BUILTIN_FNS handle math
// primitives that aren't defined via vendored .nbt sources.
//
// `typecheckModule(ast, runtimeEnv)` runs the full pipeline (check →
// solve) and returns `{ subst, errors, env: typeEnv }`. Calling it
// before loadModule(ast, runtimeEnv) lets the runtime skip dim checks
// the typechecker already proved — and surfaces dim mismatches at
// parse/check time instead of at first-execution-of-the-bad-branch.
// ── Hand-rolled schemes for BUILTIN_FNS ───────────────────────────
//
// These mirror the upstream-Numbat-style declarations:
//   sqrt: <D>(D^2) -> D
//   abs:  <D>(D)   -> D
//   sin:  (Scalar) -> Scalar
// (Angle is represented as Scalar in our runtime, so sin accepts Scalar.)
//
// We build each scheme fresh so the dim-var ids stay unique. The
// generalize() call packages them as proper ∀-bound schemes.

function schemeUnaryPreserveDim() {
  const d = freshTDimVar();
  const td = tDim(dimExprFromVar(d));
  return generalize(tFn([td], td), [], [d]);
}

function schemeUnaryScalarToScalar() {
  return generalize(tFn([T_SCALAR], T_SCALAR), [], []);
}

function schemeRoot(n) {
  // sqrt: <D>(D^n) -> D
  const d = freshTDimVar();
  const dimExp = dimExprPow(dimExprFromVar(d), ratOf(n));
  return generalize(tFn([tDim(dimExp)], tDim(dimExprFromVar(d))), [], [d]);
}

// Schemes for the most-used BUILTIN_PROCS. The runtime procs are
// variadic in some cases (assert_eq is 2-or-3 args); we register a
// fixed-arity scheme here that matches the canonical form. Variadic
// proc typing is tracked as a follow-up.
function schemeAssertEq() {
  // <T>(T, T, T?) -> Scalar — third arg is optional tolerance.
  const t = freshTVar();
  return generalize(tFn([t, t, t], T_SCALAR, { optional: 1 }), [t], []);
}
function schemeAssertBool() {
  return generalize(tFn([tBool()], T_SCALAR), [], []);
}
function schemePolyUnary() {
  // <T>(T) -> Scalar — for print, println
  const t = freshTVar();
  return generalize(tFn([t], T_SCALAR), [t], []);
}
function schemeErrorString() {
  // error<T>(String) -> T — diverging, so return is fully polymorphic
  const t = freshTVar();
  return generalize(tFn([tString()], t), [t], []);
}

// Arithmetic-on-dim procs (mod, max, min) — return type matches the
// shared dim of all args. Variadic for max/min isn't worth tracking
// in our 2-arg-min scheme: we represent them as 2-arg with no optional
// slot here, and users calling with more args get a spurious error.
// Tracked alongside #103 if it becomes important.
function schemeBinaryPreserveDim() {
  // <D: Dim>(D, D) -> D
  const d = freshTDimVar();
  const td = tDim(dimExprFromVar(d));
  return generalize(tFn([td, td], td), [], [d]);
}
function schemeTypeOf() {
  // <T>(T) -> String — runtime returns a textual description of the type
  const t = freshTVar();
  return generalize(tFn([t], tString()), [t], []);
}
function schemeStrFn1() { return generalize(tFn([tString()], tString()), [], []); }
function schemeStrEq()  { return generalize(tFn([tString(), tString()], tBool()), [], []); }
function schemeStrLen() { return generalize(tFn([tString()], T_SCALAR), [], []); }
function schemeStrAppend() { return generalize(tFn([tString(), tString()], tString()), [], []); }
function schemeStrSlice() {
  // str_slice(start: Scalar, end: Scalar, s: String) -> String
  return generalize(tFn([T_SCALAR, T_SCALAR, tString()], tString()), [], []);
}
function schemeChr() { return generalize(tFn([T_SCALAR], tString()), [], []); }
function schemeOrd() { return generalize(tFn([tString()], T_SCALAR), [], []); }
function schemeRandom() { return generalize(tFn([], T_SCALAR), [], []); }

// List ops (subset of core::lists). Registered here so user programs
// can call them without `use core::lists` lifting through the runtime.
function schemeHead() {
  // <T>(List<T>) -> T
  const t = freshTVar();
  return generalize(tFn([tList(t)], t), [t], []);
}
function schemeTail() {
  // <T>(List<T>) -> List<T>
  const t = freshTVar();
  return generalize(tFn([tList(t)], tList(t)), [t], []);
}
function schemeCons() {
  // <T>(T, List<T>) -> List<T>
  const t = freshTVar();
  return generalize(tFn([t, tList(t)], tList(t)), [t], []);
}
function schemeLen() {
  // <T>(List<T>) -> Scalar
  const t = freshTVar();
  return generalize(tFn([tList(t)], T_SCALAR), [t], []);
}

const BUILTIN_PROC_SCHEMES = {
  // Assertions + I/O
  assert:     schemeAssertBool,
  assert_eq:  schemeAssertEq,
  print:      schemePolyUnary,
  println:    schemePolyUnary,
  error:      schemeErrorString,
  // List ops
  head:       schemeHead,
  tail:       schemeTail,
  cons:       schemeCons,
  cons_end:   schemeCons,
  len:        schemeLen,
  // Arithmetic
  mod:        schemeBinaryPreserveDim,
  max:        schemeBinaryPreserveDim,
  min:        schemeBinaryPreserveDim,
  random:     schemeRandom,
  // Reflection
  type:       schemeTypeOf,
  // String ops
  str_length: schemeStrLen,
  str_eq:     schemeStrEq,
  str_slice:  schemeStrSlice,
  str_append: schemeStrAppend,
  chr:        schemeChr,
  ord:        schemeOrd,
  lowercase:  schemeStrFn1,
  uppercase:  schemeStrFn1,
  // Plot output procs. Each emits to the host's _plotSink and returns
  // the void sentinel (Scalar). plot/scatter take two lists; bar/hist
  // take one. Type vars are unrestricted dims so calling with e.g.
  // List<Length> + List<Mass> typechecks cleanly — the host doesn't
  // care about the axes' physical dims.
  plot:       schemePlot2,
  scatter:    schemePlot2,
  bar_chart:  schemePlot1,  // NOT `bar` — conflicts with the `bar` pressure unit
  hist:       schemePlot1,
  // Iterative list ops — schemes mirror the script-level signatures in
  // core::lists. ep deletes the recursive user-fn defs after loading
  // the module so these native versions win dispatch; the schemes here
  // keep typecheck happy.
  range:      schemeRange,
  map:        schemeMap,
  map2:       schemeMap2,
  filter:     schemeFilter,
  foldl:      schemeFoldl,
  concat:     schemeConcat,
  take:       schemeListSlice,
  drop:       schemeListSlice,
  reverse:    schemeReverse,
  element_at: schemeElementAt,
  any:        schemeMaskReduceBool,
  all:        schemeMaskReduceBool,
  count:      schemeMaskReduceScalar,
  dataset:    schemeDataset,
  load_csv:   schemeLoadCsv,
  maximum:    schemeListReduceDim,
  minimum:    schemeListReduceDim,
  median:     schemeListReduceDim,
  random_list: schemeRandomList,
  zeros:    schemeZerosOnes,
  ones:     schemeZerosOnes,
  linspace: schemeLinspace,
  arange:   schemeArange,
};

function schemeMaskReduceBool() {
  // (List<Bool>) -> Bool — any / all
  return generalize(tFn([tList(tBool())], tBool()), [], []);
}
function schemeMaskReduceScalar() {
  // (List<Bool>) -> Scalar — count
  return generalize(tFn([tList(tBool())], T_SCALAR), [], []);
}
function schemeDataset() {
  // <A>(List<A>) -> List<A> — loose. A Dataset is conceptually a list
  // of rows; the runtime columnarizes it. Column access on the result
  // isn't statically verified (the schema is runtime-only) — the
  // "drop tc errors when runtime succeeds" policy covers it.
  const a = freshTVar();
  return generalize(tFn([tList(a)], tList(a)), [a], []);
}
function schemeLoadCsv() {
  // <A>(String) -> List<A> — loose. The Dataset's columns/schema are
  // runtime-only (the file is read at eval), so the result is typed as
  // an opaque list of rows; column access falls to the runtime.
  const a = freshTVar();
  return generalize(tFn([tString()], tList(a)), [a], []);
}
function schemeListReduceDim() {
  // <D>(List<D>) -> D — maximum / minimum / median. Native shadows of
  // the recursive math::statistics defs; the scheme keeps the
  // typechecker happy after evaluator.js deletes the .nbt versions.
  const a = freshTVar();
  return generalize(tFn([tList(a)], a), [a], []);
}

function schemeRandomList() {
  // (Scalar) -> List<Scalar>  — n random samples in [0, 1)
  return generalize(tFn([T_SCALAR], tList(T_SCALAR)), [], []);
}
function schemeZerosOnes() {
  // (Scalar) -> List<Scalar>  — same shape for both
  return generalize(tFn([T_SCALAR], tList(T_SCALAR)), [], []);
}
function schemeLinspace() {
  // <D: Dim>(D, D, Scalar) -> List<D>  — preserves unit-bearing dim
  const d = freshTVar();
  return generalize(tFn([d, d, T_SCALAR], tList(d)), [d], []);
}
function schemeArange() {
  // <D: Dim>(D, D, D?) -> List<D>  — third arg (step) optional, same dim
  const d = freshTVar();
  return generalize(tFn([d, d, d], tList(d), { optional: 1 }), [d], []);
}

function schemeRange() {
  // (Scalar, Scalar) -> List<Scalar>
  return generalize(tFn([T_SCALAR, T_SCALAR], tList(T_SCALAR)), [], []);
}
function schemeMap() {
  // <A, B>(Fn[(A) -> B], List<A>) -> List<B>
  const a = freshTVar();
  const b = freshTVar();
  return generalize(tFn([tFn([a], b), tList(a)], tList(b)), [a, b], []);
}
function schemeMap2() {
  // <A, B, C>(Fn[(A, B) -> C], A, List<B>) -> List<C>  — simpler shape
  // than upstream allows (upstream accepts `other: A | List<A>`), but
  // covers the common case. Scheme is the strict shape; permissive
  // runtime handles the list-of-other variant too.
  const a = freshTVar();
  const b = freshTVar();
  const c = freshTVar();
  return generalize(tFn([tFn([a, b], c), a, tList(b)], tList(c)), [a, b, c], []);
}
function schemeFilter() {
  // <A, F>(F, List<A>) -> List<A>
  //
  // First arg is intentionally unconstrained. The runtime accepts EITHER
  // a predicate function `(A) -> Bool` OR a Bool mask `List<Bool>` of the
  // same length as xs. Encoding "function OR list" as a single HM scheme
  // isn't expressible — relaxing F to a TVar lets both forms typecheck
  // cleanly and pushes shape-checking to the runtime, where the error
  // message ("mask length 2 doesn't match list length 3") is also more
  // useful than the typechecker's "cannot unify (...) -> Bool with
  // List<Bool>". Net tradeoff: lose typecheck rejection of nonsense like
  // filter(5, xs); keep both useful forms.
  const a = freshTVar();
  const f = freshTVar();
  return generalize(tFn([f, tList(a)], tList(a)), [a, f], []);
}
function schemeFoldl() {
  // <A, B>(Fn[(A, B) -> A], A, List<B>) -> A
  const a = freshTVar();
  const b = freshTVar();
  return generalize(tFn([tFn([a, b], a), a, tList(b)], a), [a, b], []);
}
function schemeConcat() {
  // <A>(List<A>, List<A>) -> List<A>
  const a = freshTVar();
  return generalize(tFn([tList(a), tList(a)], tList(a)), [a], []);
}
function schemeListSlice() {
  // <A>(Scalar, List<A>) -> List<A>  — for take / drop
  const a = freshTVar();
  return generalize(tFn([T_SCALAR, tList(a)], tList(a)), [a], []);
}
function schemeReverse() {
  // <A>(List<A>) -> List<A>
  const a = freshTVar();
  return generalize(tFn([tList(a)], tList(a)), [a], []);
}
function schemeElementAt() {
  // <A>(Scalar, List<A>) -> A
  const a = freshTVar();
  return generalize(tFn([T_SCALAR, tList(a)], a), [a], []);
}

function schemePlot2() {
  // <X, Y>(List<X>, List<Y>, String?, String?, String?) -> Scalar
  // — plot/scatter. Trailing strings (xlabel, ylabel, title) are
  // all optional; runtime proc handles any of 2..5 args.
  const x = freshTVar();
  const y = freshTVar();
  return generalize(
    tFn([tList(x), tList(y), tString(), tString(), tString()], T_SCALAR, { optional: 3 }),
    [x, y], []
  );
}
function schemePlot1() {
  // <V>(List<V>, String?, String?, String?) -> Scalar  — bar_chart/hist.
  // Trailing strings: xlabel/ylabel/title in that order.
  const v = freshTVar();
  return generalize(
    tFn([tList(v), tString(), tString(), tString()], T_SCALAR, { optional: 3 }),
    [v], []
  );
}

const BUILTIN_FN_SCHEMES = {
  // Dim-preserving
  abs:   schemeUnaryPreserveDim,
  floor: schemeUnaryPreserveDim,
  ceil:  schemeUnaryPreserveDim,
  round: schemeUnaryPreserveDim,

  // Root extractors (handle even/cube exponents)
  sqrt:  () => schemeRoot(2),
  cbrt:  () => schemeRoot(3),

  // Trig + log + exp: dimensionless in and out
  sin:   schemeUnaryScalarToScalar,
  cos:   schemeUnaryScalarToScalar,
  tan:   schemeUnaryScalarToScalar,
  asin:  schemeUnaryScalarToScalar,
  acos:  schemeUnaryScalarToScalar,
  atan:  schemeUnaryScalarToScalar,
  log:   schemeUnaryScalarToScalar,
  log10: schemeUnaryScalarToScalar,
  log2:  schemeUnaryScalarToScalar,
  ln:    schemeUnaryScalarToScalar,
  exp:   schemeUnaryScalarToScalar,
  sinh:  schemeUnaryScalarToScalar,
  cosh:  schemeUnaryScalarToScalar,
  tanh:  schemeUnaryScalarToScalar,
  asinh: schemeUnaryScalarToScalar,
  acosh: schemeUnaryScalarToScalar,
  atanh: schemeUnaryScalarToScalar,

  // Factorial: scalar in, scalar out (Factorial node has its own infer
  // rule but `n!` invocations route through Call('factorial', [n]) too).
  factorial: schemeUnaryScalarToScalar,
};

// ── Building the typed env ────────────────────────────────────────

function buildTypeEnv(runtimeEnv) {
  const tcEnv = makeTypeEnv();

  // Accepts either the makeEnv-shaped object (env.units is the unit
  // registry) OR a Numbat host instance directly (host.registry is the
  // unit registry). Normalize.
  const unitRegistry = runtimeEnv.units || runtimeEnv.registry || null;

  // Dims: copy the public name → DimMap mapping.
  if (runtimeEnv.dims?.list) {
    for (const { name, dim } of runtimeEnv.dims.list()) {
      typeEnvBindDim(tcEnv, name, dim);
    }
  }

  // Units: every unit lookup-name becomes a typed value `TDim(unit.dim)`.
  // We iterate the private map directly — it's the only exhaustive source
  // (the public list() filters out inputOnly entries, which we DO want
  // for typechecking).
  if (unitRegistry?._units) {
    for (const [name, entry] of unitRegistry._units) {
      if (!tcEnv.values.has(name)) {
        typeEnvBindValue(tcEnv, name, tDim(dimExprFromMap(entry.dim)));
      }
    }
  }

  // Constants and let-bindings already in the runtime values table.
  if (runtimeEnv.values) {
    for (const [name, val] of runtimeEnv.values) {
      if (tcEnv.values.has(name)) continue;
      if (val && typeof val === 'object' && 'dim' in val && 'value' in val) {
        // Quantity-shaped — register as a TDim.
        typeEnvBindValue(tcEnv, name, tDim(dimExprFromMap(val.dim)));
      }
      // Skip fn-typed values; they're handled below via env.fns.
    }
  }

  // Lift user structs — those declared via earlier loadModule passes
  // are stored in runtimeEnv.structs as { name, generics, fields }.
  // Convert each into a TScheme(TStruct) so type annotations referencing
  // these structs resolve.
  if (runtimeEnv.structs) {
    for (const [name, rec] of runtimeEnv.structs) {
      if (!tcEnv.structs.has(name)) {
        typeEnvBindStruct(tcEnv, name, structRecordToScheme(rec, tcEnv));
      }
    }
  }

  // Lift user fns. Runtime stores { generics, params, body, returnType, ... }.
  // We build a TScheme directly without re-running body inference —
  // hosts that want body validation should re-run checkModule.
  if (runtimeEnv.fns) {
    for (const [name, rec] of runtimeEnv.fns) {
      if (!tcEnv.fns.has(name)) {
        typeEnvBindFn(tcEnv, name, fnRecordToScheme(rec, tcEnv));
      }
    }
  }

  // BUILTINs: math primitives get hand-rolled schemes so user code can
  // call sqrt/sin/etc. and typecheck cleanly. Last so user-declared fns
  // and structs take priority (a user's `fn sin` overrides the BUILTIN).
  for (const [name, mkScheme] of Object.entries(BUILTIN_FN_SCHEMES)) {
    if (!tcEnv.fns.has(name)) typeEnvBindFn(tcEnv, name, mkScheme());
  }
  // BUILTIN_PROCS too — same priority order, last so user decls win.
  for (const [name, mkScheme] of Object.entries(BUILTIN_PROC_SCHEMES)) {
    if (!tcEnv.fns.has(name)) typeEnvBindFn(tcEnv, name, mkScheme());
  }

  return tcEnv;
}

// ── Lifting helpers ───────────────────────────────────────────────

// Verify that each declared generic param still has an independent free
// var after solving. Returns an error record if two binders collapsed
// onto the same var, or null if all binders remain independent (or were
// resolved to concrete types — that's allowed; just means the user's
// `<A, B>` annotation was redundant).
function checkBindersStillIndependent(binders, subst, decl) {
  const seenTVarIds = new Map();    // id → binder name
  const seenDimVarIds = new Map();
  for (const b of binders) {
    const probe = b.kind === 'T'
      ? applyType({ kind: 'TVar', id: b.var.id }, subst)
      : applyType({ kind: 'TDim', dim: { base: {}, vars: { [b.var.id]: { n: 1, d: 1 } } } }, subst);
    // Concrete result (no free vars): binder was constrained to a
    // specific type. That's fine — the scheme just won't include it.
    const fv = freeVars(probe);
    const ids = [...fv.tvars, ...fv.dimVars];
    if (ids.length === 0) continue;
    if (ids.length > 1) continue;   // multi-var resolution; OK
    // Single-var resolution: must not collide with another binder.
    for (const id of fv.tvars) {
      if (seenTVarIds.has(id)) {
        return {
          message: `type parameters '${seenTVarIds.get(id)}' and '${b.name}' were unified — the signature claimed independence that the body doesn't deliver`,
          span: decl.span,
        };
      }
      seenTVarIds.set(id, b.name);
    }
    for (const id of fv.dimVars) {
      if (seenDimVarIds.has(id)) {
        return {
          message: `type parameters '${seenDimVarIds.get(id)}' and '${b.name}' were unified — the signature claimed independence that the body doesn't deliver`,
          span: decl.span,
        };
      }
      seenDimVarIds.set(id, b.name);
    }
  }
  return null;
}

function liftGenerics(declGenerics) {
  // Returns { generics: Map<name, {kind,var}>, binders: [{kind,var,name}] }.
  // Used by fn and struct record lifters in declaration order.
  const generics = new Map();
  const binders  = [];
  for (const g of declGenerics || []) {
    if (g.kind === 'Dim') {
      const tdv = freshTDimVar();
      generics.set(g.name, { kind: 'D', var: tdv });
      binders.push({ kind: 'D', var: tdv, name: g.name });
    } else {
      // 'Type' (default) or anything else → unrestricted TVar.
      const tv = freshTVar();
      generics.set(g.name, { kind: 'T', var: tv });
      binders.push({ kind: 'T', var: tv, name: g.name });
    }
  }
  return { generics, binders };
}

function fnRecordToScheme(rec, tcEnv) {
  const { generics, binders } = liftGenerics(rec.generics);
  const ctx = { cs: makeConstraintSet(), generics };
  const paramTypes = (rec.params || []).map(p =>
    p.typeExpr ? evalTypeAnno(p.typeExpr, tcEnv, ctx) : freshTVar(),
  );
  const returnType = rec.returnType
    ? evalTypeAnno(rec.returnType, tcEnv, ctx)
    : freshTVar();
  const tvars   = binders.filter(b => b.kind === 'T').map(b => b.var);
  const dimVars = binders.filter(b => b.kind === 'D').map(b => b.var);
  const order   = binders.map(b => b.kind);
  return tScheme(tvars, dimVars, tFn(paramTypes, returnType), { binderOrder: order });
}

function structRecordToScheme(rec, tcEnv) {
  const { generics, binders } = liftGenerics(rec.generics);
  const ctx = { cs: makeConstraintSet(), generics };
  const fields = {};
  for (const f of rec.fields || []) {
    fields[f.name] = evalTypeAnno(f.type, tcEnv, ctx);
  }
  const tvars   = binders.filter(b => b.kind === 'T').map(b => b.var);
  const dimVars = binders.filter(b => b.kind === 'D').map(b => b.var);
  const order   = binders.map(b => b.kind);
  return tScheme(tvars, dimVars, tStruct(rec.name, fields), { binderOrder: order });
}

// Typecheck a single parsed statement against a persistent typed env.
// Errors are returned (not thrown). The typed env is updated in place
// — subsequent calls see this decl's bindings. Used by ep's evaluator
// to interleave typecheck with per-statement runtime eval.
function typecheckStatement(ast, tcEnv) {
  const errors = [];
  const dimAliases = buildDimAliases(tcEnv);
  for (const decl of ast.decls) {
    const ctx = { cs: makeConstraintSet(), errors: [], generics: new Map() };
    try {
      checkDecl(decl, tcEnv, ctx);
    } catch (e) {
      errors.push({ message: e.message, span: e.span || null });
      continue;
    }
    if (ctx.errors.length) {
      errors.push(...ctx.errors);
      continue;
    }
    const { subst, errors: solveErrs } = solve(ctx.cs, { dimAliases });
    errors.push(...solveErrs);
    if (solveErrs.length) continue;
    finalizeDecl(decl, tcEnv, subst, errors);
  }
  return errors;
}

// One-shot: parse + check + solve + generalize, return diagnostics.
// Hosts that want to opt into typechecking call this before loadModule.
//
// Solves PER-DECL so each later decl sees earlier fns as fully-
// generalized schemes (proper HM let-generalization). Without this,
// `fn f(x) = x` would infer (α) -> α with α unbound — and the first
// call site would pin α to a concrete type, breaking polymorphic use.
function typecheckModule(ast, runtimeEnv) {
  const env = buildTypeEnv(runtimeEnv);
  const dimAliases = buildDimAliases(env);
  const errors = [];
  const allSubst = makeSubst();
  for (const decl of ast.decls) {
    const ctx = { cs: makeConstraintSet(), errors: [], generics: new Map() };
    try {
      checkDecl(decl, env, ctx);
    } catch (e) {
      errors.push({ message: e.message, span: e.span || null });
      continue;
    }
    if (ctx.errors.length) {
      errors.push(...ctx.errors);
      continue;
    }
    const { subst, errors: solveErrs } = solve(ctx.cs, { dimAliases });
    errors.push(...solveErrs);
    if (solveErrs.length) continue;
    // Merge into the running subst — useful for hosts that want to
    // inspect resolved types after the whole module.
    for (const [k, v] of subst.tvars)   allSubst.tvars.set(k, v);
    for (const [k, v] of subst.dimVars) allSubst.dimVars.set(k, v);
    finalizeDecl(decl, env, subst, errors);
  }
  return { env, subst: allSubst, errors };
}

// After per-decl solve, apply the substitution to anything this decl
// added to the env and generalize fn schemes.
function finalizeDecl(decl, env, subst, errors) {
  if (decl.type === 'FnDecl') {
    const scheme = env.fns.get(decl.name);
    if (!scheme || scheme.kind !== 'TScheme') return;
    const resolvedBody = applyType(scheme.body, subst);

    // Free-var consistency check: if the user wrote `fn f<A, B>(...)`,
    // each original binder should resolve to a distinct free variable
    // in the body (either still a TVar or a TDim<single dim-var>).
    // If two original binders end up sharing the same resolved var,
    // the signature claimed independence the body didn't deliver —
    // upstream rejects, so we do too. See #101.
    const originals = scheme.binders ?? [];
    const consistencyErr = checkBindersStillIndependent(originals, subst, decl);
    if (consistencyErr) {
      errors.push(consistencyErr);
      // Still install a scheme so subsequent decls can reference the fn.
    }

    // Re-derive binders purely from free vars in the resolved body —
    // this is the textbook HM "generalize" step. Original binders that
    // got constrained to concrete types drop out (their vars no longer
    // appear free). Original binders that stayed free are preserved.
    // Type-kinded generics that got promoted to TDim<$d> via dim-
    // arithmetic constraints get their $d in the body as a free dim-var,
    // so the scheme correctly reflects the inferred Dim restriction.
    const fv = freeVars(resolvedBody);
    const newT = [...fv.tvars].map(id => tVar(id));
    const newD = [...fv.dimVars].map(id => tDimVar(id));
    env.fns.set(decl.name, tScheme(newT, newD, resolvedBody));
  } else if (decl.type === 'LetDecl' || decl.type === 'UnitDecl') {
    const t = env.values.get(decl.name);
    if (t) env.values.set(decl.name, applyType(t, subst));
  } else if (decl.type === 'StructDecl') {
    const s = env.structs.get(decl.name);
    if (s && s.kind === 'TScheme') {
      // Same re-derivation for structs: free vars in the resolved body
      // are the binders. Preserves binder ORDER via binderOrder so
      // application sites (Wrapper<A>) bind positionally.
      const resolvedBody = applyType(s.body, subst);
      // We need to preserve the declaration order of the original
      // binders that survived (haven't been resolved to something
      // concrete). Walk s.binders, keep those whose var is still free
      // in resolved body.
      const fv = freeVars(resolvedBody);
      const survivingBinders = s.binders.filter(b =>
        b.kind === 'T' ? fv.tvars.has(b.var.id) : fv.dimVars.has(b.var.id),
      );
      const survT = survivingBinders.filter(b => b.kind === 'T').map(b => b.var);
      const survD = survivingBinders.filter(b => b.kind === 'D').map(b => b.var);
      const order = survivingBinders.map(b => b.kind);
      env.structs.set(decl.name, tScheme(survT, survD, resolvedBody, { binderOrder: order }));
    }
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
  if (node.type === 'TypeApp') {
    // List<D>: the dim of the list IS the dim of the element. Same for
    // any other generic single-arg type constructor referencing a known
    // dim. Multi-arg constructors fall through to error since the
    // runtime can't infer which arg contributes the dim.
    if (node.base.type === 'Ident' && node.base.name === 'List' && node.args.length === 1) {
      return evalDimExpr(node.args[0], env);
    }
    // For user-defined generic structs etc., the runtime doesn't track
    // dim per type arg. Fall through.
    throw new Error(`type application ${node.base.name ?? '?'}<...> not allowed in dimension expression`);
  }
  if (node.type === 'FnTypeAnno') {
    // A Fn[...] annotation isn't a dim — used in fn-type positions only.
    throw new Error(`Fn[...] not allowed in dimension expression`);
  }
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
  sin(q) { mustBeAngleOrScalar(q, 'sin'); return new Quantity(Math.sin(q.value), {}); },
  cos(q) { mustBeAngleOrScalar(q, 'cos'); return new Quantity(Math.cos(q.value), {}); },
  tan(q) { mustBeAngleOrScalar(q, 'tan'); return new Quantity(Math.tan(q.value), {}); },
  asin(q){ mustBeDimensionless(q, 'asin');return new Quantity(Math.asin(q.value), {}); },
  acos(q){ mustBeDimensionless(q, 'acos');return new Quantity(Math.acos(q.value), {}); },
  atan(q){ mustBeDimensionless(q, 'atan');return new Quantity(Math.atan(q.value), {}); },
  // Upstream Numbat defines `log` as an alias for `ln` (natural log) —
  // `fn log(x) = ln(x)` in math/transcendental.nbt. Earlier this was
  // wired to Math.log10, which silently diverged from upstream.
  log(q) { mustBeDimensionless(q, 'log'); return new Quantity(Math.log(q.value), {}); },
  log10(q){mustBeDimensionless(q, 'log10');return new Quantity(Math.log10(q.value), {}); },
  log2(q){ mustBeDimensionless(q, 'log2');return new Quantity(Math.log2(q.value), {}); },
  ln(q)  { mustBeDimensionless(q, 'ln');  return new Quantity(Math.log(q.value), {}); },
  exp(q) { mustBeDimensionless(q, 'exp'); return new Quantity(Math.exp(q.value), {}); },
  sinh(q){ mustBeDimensionless(q, 'sinh');return new Quantity(Math.sinh(q.value), {}); },
  cosh(q){ mustBeDimensionless(q, 'cosh');return new Quantity(Math.cosh(q.value), {}); },
  tanh(q){ mustBeDimensionless(q, 'tanh');return new Quantity(Math.tanh(q.value), {}); },
  asinh(q){ mustBeDimensionless(q,'asinh');return new Quantity(Math.asinh(q.value),{}); },
  acosh(q){ mustBeDimensionless(q,'acosh');return new Quantity(Math.acosh(q.value),{}); },
  atanh(q){ mustBeDimensionless(q,'atanh');return new Quantity(Math.atanh(q.value),{}); },
  floor(q) { return new Quantity(Math.floor(q.value), q.dim); },
  ceil(q)  { return new Quantity(Math.ceil(q.value),  q.dim); },
  round(q) { return new Quantity(Math.round(q.value), q.dim); },
  factorial(q) {
    mustBeDimensionless(q, 'factorial');
    const n = q.value;
    if (n < 0 || !Number.isFinite(n) || Math.floor(n) !== n) {
      throw new Error(`factorial: requires non-negative integer, got ${n}`);
    }
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return new Quantity(r, {});
  },
};

function mustBeDimensionless(q, fnName) {
  if (!dimEmpty(q.dim)) throw new Error(`${fnName}: argument must be dimensionless`);
}

// sin/cos/tan accept dim:{} OR dim:{angle:1} since the canonical value is
// already in radians (degree's mul = π/180). Other dims (length, mass, …)
// still error.
function mustBeAngleOrScalar(q, fnName) {
  if (dimEmpty(q.dim)) return;
  const keys = Object.keys(q.dim);
  if (keys.length === 1 && keys[0] === 'angle' && q.dim.angle === 1) return;
  throw new Error(`${fnName}: argument must be dimensionless or an angle`);
}

// Build a columnar Dataset from a list of struct rows. The column set
// is taken from the first row; every row must carry at least those
// fields (extras are ignored). Shared by the `dataset(...)` builtin and
// the CSV loader (Phase 1.3). Returns a frozen tagged object:
//   { __dataset: true, columns: Map<name, Array>, length: N }
// Column order is the Map's insertion order = the first row's field
// order. An empty input is a valid empty Dataset (no columns).
function datasetFromRows(rows) {
  if (!Array.isArray(rows)) throw new Error('dataset: expected a list of struct rows');
  const isStruct = (v) => v !== null && typeof v === 'object'
    && !Array.isArray(v) && ('__struct' in v);
  if (rows.length === 0) {
    return Object.freeze({ __dataset: true, columns: new Map(), length: 0 });
  }
  if (!isStruct(rows[0])) {
    throw new Error('dataset: list elements must be structs');
  }
  const names = Object.keys(rows[0]).filter(k => k !== '__struct');
  const columns = new Map();
  for (const n of names) columns.set(n, []);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!isStruct(r)) throw new Error(`dataset: list element ${i} is not a struct`);
    for (const n of names) {
      if (!(n in r)) throw new Error(`dataset: row ${i} is missing field '${n}'`);
      columns.get(n).push(r[n]);
    }
  }
  return Object.freeze({ __dataset: true, columns, length: rows.length });
}

// ── CSV parsing (SPEC-DATASETS Phase 1.3) ────────────────────────
//
// A small RFC-4180-ish parser: text → Dataset. Parsing is configured
// by a `parseConfig` object (delimiter / commentChar / skipRows /
// hasHeader / decimal); ep configures it at attach time, the parser
// itself is pure. No library.

function csvDefaultConfig() {
  return { delimiter: ',', commentChar: '#', skipRows: 0, hasHeader: true, decimal: '.' };
}

// Tokenize CSV text into rows of raw string cells. Double-quoted
// fields may contain the delimiter and newlines; `""` is a literal
// quote. A row whose first non-quoted character is the comment char is
// dropped entirely (comment-aware so quoted newlines still work).
function parseCsvRows(text, delimiter, commentChar) {
  const rows = [];
  let row = [], cell = '', inQuotes = false, atRowStart = true;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    // Comment line: at row start, unquoted, first char is commentChar →
    // skip to (and past) the next newline without emitting a row.
    if (atRowStart && commentChar && c === commentChar) {
      while (i < n && text[i] !== '\n') i++;
      i++; // past the \n
      continue;
    }
    if (c === '"') { inQuotes = true; atRowStart = false; i++; continue; }
    if (c === delimiter) { row.push(cell); cell = ''; atRowStart = false; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      row.push(cell); rows.push(row);
      row = []; cell = ''; atRowStart = true; i++; continue;
    }
    cell += c; atRowStart = false; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Best-guess parseConfig for a CSV text: sniff the delimiter, pair the
// decimal separator. Everything else stays at defaults — skipRows and
// hasHeader are set visually by the user against a preview (Phase 1.7).
function detectCsvConfig(text) {
  const cfg = csvDefaultConfig();
  const sample = text.split(/\r?\n/)
    .filter(l => l.trim() && !l.trimStart().startsWith(cfg.commentChar))
    .slice(0, 10);
  if (sample.length) {
    let best = null;
    for (const d of [',', ';', '\t', '|']) {
      const counts = sample.map(l => parseCsvRows(l, d, cfg.commentChar)[0]?.length ?? 0);
      const max = Math.max(...counts);
      if (max < 2) continue;
      const modal = counts.filter(c => c === max).length;  // consistency
      const score = modal * 100 + max;
      if (!best || score > best.score) best = { d, score };
    }
    if (best) cfg.delimiter = best.d;
  }
  // European convention: a ';' delimiter usually pairs with ',' decimal.
  if (cfg.delimiter === ';') cfg.decimal = ',';
  return cfg;
}

// Split a header cell into a column name + optional unit text. A
// trailing parenthesized group is treated as a unit: `grade (g/t)` →
// { name: 'grade', unitText: 'g/t' }.
function parseHeaderCell(raw) {
  const m = raw.trim().match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (m && m[1]) return { name: m[1].trim(), unitText: m[2].trim() };
  return { name: raw.trim(), unitText: null };
}

// Normalize a numeric cell for parseFloat: strip thousands separators,
// fold the configured decimal separator to '.'.
function normalizeNumberCell(s, decimal) {
  s = s.trim();
  if (decimal === ',') return s.replace(/\./g, '').replace(',', '.');
  return s.replace(/,/g, '');
}

const CSV_NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// Parse CSV text into a Dataset. `config` is merged over auto-detection;
// `opts.resolveUnit(text) -> Quantity` applies header unit suffixes
// (omit it and unit-suffixed columns stay dimensionless — the unit
// suffix is still stripped from the column name).
function parseCsv(text, config, opts) {
  const cfg = { ...detectCsvConfig(text), ...(config || {}) };
  const resolveUnit = opts && opts.resolveUnit;

  let raw = text;
  if (cfg.skipRows > 0) {
    raw = text.split(/\r?\n/).slice(cfg.skipRows).join('\n');
  }
  const rows = parseCsvRows(raw, cfg.delimiter, cfg.commentChar);
  if (rows.length === 0) {
    return Object.freeze({ __dataset: true, columns: new Map(), length: 0 });
  }

  // Column headers (+ unit suffixes). Synthesized col1..colN when the
  // file has no header row. Duplicate names are de-duped (`x`, `x_2`).
  const firstLen = rows[0].length;
  let headers, dataRows;
  if (cfg.hasHeader) {
    headers = rows[0].map(parseHeaderCell);
    dataRows = rows.slice(1);
  } else {
    headers = Array.from({ length: firstLen }, (_, i) => ({ name: `col${i + 1}`, unitText: null }));
    dataRows = rows;
  }
  const seen = new Map();
  for (const h of headers) {
    if (seen.has(h.name)) {
      const k = seen.get(h.name) + 1;
      seen.set(h.name, k);
      h.name = `${h.name}_${k}`;
    } else {
      seen.set(h.name, 1);
    }
  }

  // Per-column type inference from a sample of non-empty cells.
  const cellAt = (r, ci) => (ci < r.length ? r[ci] : '');
  const colType = headers.map((_, ci) => {
    let sawNumber = false, sawBool = false;
    let count = 0;
    for (const r of dataRows) {
      const v = cellAt(r, ci).trim();
      if (v === '') continue;
      count++;
      if (CSV_NUM_RE.test(normalizeNumberCell(v, cfg.decimal))) { sawNumber = true; }
      else if (v.toLowerCase() === 'true' || v.toLowerCase() === 'false') { sawBool = true; }
      else { return 'string'; }
      if (count >= 50) break;
    }
    if (count === 0) return 'string';
    if (sawNumber && !sawBool) return 'number';
    if (sawBool && !sawNumber) return 'bool';
    return 'string';  // mixed
  });

  // Resolve each numeric column's header unit once (mul + dim).
  const colUnit = headers.map((h, ci) => {
    if (colType[ci] !== 'number' || !h.unitText || !resolveUnit) return { mul: 1, dim: {} };
    const u = resolveUnit(h.unitText);
    return { mul: u.value, dim: u.dim };
  });

  // Build the columns.
  const columns = new Map();
  headers.forEach((h, ci) => {
    const t = colType[ci];
    const { mul, dim } = colUnit[ci];
    const out = new Array(dataRows.length);
    for (let ri = 0; ri < dataRows.length; ri++) {
      const v = cellAt(dataRows[ri], ci).trim();
      if (t === 'number') {
        out[ri] = v === ''
          ? new Quantity(NaN, dim)
          : new Quantity(parseFloat(normalizeNumberCell(v, cfg.decimal)) * mul, dim);
      } else if (t === 'bool') {
        out[ri] = v.toLowerCase() === 'true';
      } else {
        out[ri] = v;
      }
    }
    columns.set(h.name, out);
  });

  return Object.freeze({ __dataset: true, columns, length: dataRows.length });
}

// Variadic built-in procedures. Differ from BUILTIN_FNS in that they accept
// an args array directly (so they can be 1/2/3-arg overloaded) and may return
// a "void" sentinel — we use Quantity(0, {}) since v0.3 doesn't have a
// dedicated Unit/Void type.
const BUILTIN_PROCS = {
  // assert(bool): error if false. Used by upstream test programs.
  assert(args) {
    if (args.length !== 1) throw new Error(`assert: expected 1 arg, got ${args.length}`);
    const b = args[0];
    if (typeof b !== 'boolean') throw new Error('assert: expected Bool argument');
    if (!b) throw new Error('assertion failed');
    return new Quantity(0, {});
  },
  // error(msg): throws an error with the given string message. Used by
  // upstream stdlib for guard clauses like
  //   `if x == 0 then error("divide by zero") else 1 / x`.
  error(args) {
    if (args.length !== 1) throw new Error(`error: expected 1 arg, got ${args.length}`);
    const msg = args[0];
    if (typeof msg !== 'string') throw new Error('error: argument must be a string');
    throw new Error(msg);
  },
  // print(value): emit to the host-provided output sink (set via
  // setPrintSink). Defaults to no-op so ep's UI doesn't surface print
  // output until it explicitly wires a panel. Tests can capture by
  // calling setPrintSink(buf => …).
  print(args) {
    const text = args.map(v => {
      if (v instanceof Quantity) {
        if (typeof _quantityFormatter === 'function') {
          const p = _quantityFormatter(v);
          return p.unit ? `${p.num} ${p.unit}` : p.num;
        }
        return String(v.value);
      }
      if (typeof v === 'string') return v;
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (Array.isArray(v)) return JSON.stringify(v);
      return String(v);
    }).join(' ');
    if (typeof _printSink === 'function') _printSink(text);
    return new Quantity(0, {});
  },
  println(args) { return BUILTIN_PROCS.print(args); },

  // plot()/scatter()/bar()/hist(): emit a plot descriptor to the host
  // via _plotSink. Same role as print() for canvas/SVG output. Return
  // the void sentinel so the call composes as a statement. Each list
  // arg is coerced from List<Quantity> to plain number[] (canonical
  // values — units captured separately if the host wants them); the
  // host's renderer doesn't need to know about Numbat's Quantity type.
  plot(args) {
    if (args.length < 2 || args.length > 5) throw new Error(`plot: expected 2..5 args (xs, ys [, xlabel, ylabel, title]), got ${args.length}`);
    if (typeof _plotSink === 'function') {
      _plotSink({ type: 'line', ...coerceXY(args[0], args[1]), ...labelOpts(args, 2) });
    }
    return new Quantity(0, {});
  },
  scatter(args) {
    if (args.length < 2 || args.length > 5) throw new Error(`scatter: expected 2..5 args (xs, ys [, xlabel, ylabel, title]), got ${args.length}`);
    if (typeof _plotSink === 'function') {
      _plotSink({ type: 'scatter', ...coerceXY(args[0], args[1]), ...labelOpts(args, 2) });
    }
    return new Quantity(0, {});
  },
  // Note: NOT named `bar` to avoid colliding with the `bar` pressure
  // unit defined in units::misc. `bar_chart` matches upstream Numbat's
  // plot::bar_chart constructor naming.
  bar_chart(args) {
    if (args.length < 1 || args.length > 4) throw new Error(`bar_chart: expected 1..4 args (values [, xlabel, ylabel, title]), got ${args.length}`);
    if (typeof _plotSink === 'function') {
      _plotSink({ type: 'bar', ...coerceValues(args[0]), ...labelOpts(args, 1) });
    }
    return new Quantity(0, {});
  },
  hist(args) {
    if (args.length < 1 || args.length > 4) throw new Error(`hist: expected 1..4 args (values [, xlabel, ylabel, title]), got ${args.length}`);
    if (typeof _plotSink === 'function') {
      _plotSink({ type: 'hist', ...coerceValues(args[0]), ...labelOpts(args, 1) });
    }
    return new Quantity(0, {});
  },

  // ── Iterative list ops — host-native shadows of the recursive defs in
  // core::lists. Same semantics, no JS-stack cost. Numbat's prelude
  // has no `for`/`while` so its `range`/`map`/`filter`/`foldl`/etc. are
  // all recursive; for our tree-walking interpreter that meant ~10
  // JS frames per element, which blew Safari's stack at a few hundred.
  // Hosts that want the original script versions can delete these
  // entries from BUILTIN_PROCS at boot. Upstream-compat is preserved
  // because the script defs still exist in core::lists.nbt — we just
  // shadow them at dispatch time (the host must also delete them from
  // env.fns since fns win over BUILTIN_PROCS in evalCall's lookup order).
  range(args) {
    const start = args[0] instanceof Quantity ? args[0].value : args[0];
    const end   = args[1] instanceof Quantity ? args[1].value : args[1];
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error('range: start and end must be finite scalars');
    }
    const out = [];
    if (start <= end) {
      const lo = Math.round(start), hi = Math.round(end);
      for (let i = lo; i <= hi; i++) out.push(new Quantity(i, {}));
    }
    return out;
  },
  map(args) {
    const [f, xs] = args;
    if (typeof f !== 'function') throw new Error('map: first arg must be a function');
    if (!Array.isArray(xs)) throw new Error('map: second arg must be a list');
    return xs.map(x => f(x));
  },
  map2(args) {
    // map2(f, other, xs): zips xs with `other` via f.  Numbat's signature
    // is map2(f, other, xs) -> [f(other_i, xs_i)] when other is a list
    // OR f(other, xs_i) when other is a scalar. Be permissive at runtime.
    const [f, other, xs] = args;
    if (typeof f !== 'function') throw new Error('map2: first arg must be a function');
    if (!Array.isArray(xs)) throw new Error('map2: third arg must be a list');
    if (Array.isArray(other)) {
      const n = Math.min(other.length, xs.length);
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = f(other[i], xs[i]);
      return out;
    }
    return xs.map(x => f(other, x));
  },
  filter(args) {
    const [p, xs] = args;
    if (!Array.isArray(xs)) throw new Error('filter: second arg must be a list');
    // Mask form: first arg is a List<Bool> the same length as xs. Keeps
    // xs[i] where mask[i] is true. Natural pair with the comparison-
    // broadcasting we added: `filter(xs > 5, xs)` works.
    if (Array.isArray(p)) {
      if (p.length !== xs.length) {
        throw new Error(`filter: mask length ${p.length} doesn't match list length ${xs.length}`);
      }
      const out = [];
      for (let i = 0; i < xs.length; i++) {
        if (p[i] === true) out.push(xs[i]);
        else if (p[i] !== false) {
          throw new Error('filter: mask elements must be Bool');
        }
      }
      return out;
    }
    if (typeof p !== 'function') throw new Error('filter: first arg must be a predicate function or Bool mask');
    return xs.filter(x => p(x) === true);
  },
  // any / all / count — mask reductions. Natural pair with comparison
  // broadcasting: `any(xs > threshold)`, `all(0 <= xs && xs < 1)`,
  // `count(xs == target)`. any and all short-circuit; count must visit
  // every element. All three reject non-Bool entries to surface the
  // common bug of passing a List<Number> by mistake (e.g. forgetting
  // the comparison).
  any(args) {
    if (args.length !== 1) throw new Error(`any: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('any: expected List<Bool>');
    for (const x of xs) {
      if (x === true) return true;
      if (x !== false) throw new Error('any: list element must be Bool');
    }
    return false;
  },
  all(args) {
    if (args.length !== 1) throw new Error(`all: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('all: expected List<Bool>');
    for (const x of xs) {
      if (x === false) return false;
      if (x !== true) throw new Error('all: list element must be Bool');
    }
    return true;
  },
  count(args) {
    if (args.length !== 1) throw new Error(`count: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('count: expected List<Bool>');
    let n = 0;
    for (const x of xs) {
      if (x === true) n++;
      else if (x !== false) throw new Error('count: list element must be Bool');
    }
    return new Quantity(n, {});
  },
  // dataset(rows) — columnarize a list of struct records into a Dataset.
  // The eager dataset value (SPEC-DATASETS Phase 1.2): a tagged object
  // holding one typed array per column. Column access (`d.grade`) is
  // then an O(1) Map lookup. The CSV loader (Phase 1.3) produces a
  // Dataset the same way via datasetFromRows.
  dataset(args) {
    if (args.length !== 1) throw new Error(`dataset: expected 1 arg, got ${args.length}`);
    return datasetFromRows(args[0]);
  },
  // maximum / minimum / median — list reductions. Upstream's
  // math::statistics defines maximum/minimum by direct head/tail
  // recursion and median via a recursive sort, so all three overflow
  // the tree-walker's stack on a few-thousand-element column. ep ships
  // iterative natives and shadows the recursive defs (same pattern as
  // range/map/filter). Empty list throws — an empty List<D> carries no
  // D to return. (sum / mean / variance / stdev stay as the upstream
  // math::statistics fns: they bottom out in native foldl/map, so
  // they're already O(n) and stack-safe.)
  maximum(args) {
    if (args.length !== 1) throw new Error(`maximum: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('maximum: expected a list');
    if (xs.length === 0) throw new Error('maximum: empty list');
    let best = xs[0];
    for (let i = 1; i < xs.length; i++) if (xs[i].value > best.value) best = xs[i];
    return best;
  },
  minimum(args) {
    if (args.length !== 1) throw new Error(`minimum: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('minimum: expected a list');
    if (xs.length === 0) throw new Error('minimum: empty list');
    let best = xs[0];
    for (let i = 1; i < xs.length; i++) if (xs[i].value < best.value) best = xs[i];
    return best;
  },
  median(args) {
    if (args.length !== 1) throw new Error(`median: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('median: expected a list');
    if (xs.length === 0) throw new Error('median: empty list');
    const sorted = xs.slice().sort((a, b) => a.value - b.value);
    const n = sorted.length;
    if (n % 2 === 1) return sorted[(n - 1) / 2];
    const lo = sorted[n / 2 - 1], hi = sorted[n / 2];
    return new Quantity((lo.value + hi.value) / 2, lo.dim);
  },
  // load_csv(name) — resolve a named CSV asset to a Dataset. numbat-js
  // owns no files; the host (ep) registers a resolver via setCsvResolver
  // that maps the name to a parsed Dataset (and owns asset storage +
  // parse config + caching). Outside a host that registered one, this
  // fails cleanly.
  load_csv(args) {
    if (args.length !== 1) throw new Error(`load_csv: expected 1 arg (asset name), got ${args.length}`);
    const name = args[0];
    if (typeof name !== 'string') throw new Error('load_csv: asset name must be a string');
    if (typeof _csvResolver !== 'function') {
      throw new Error(`load_csv: no CSV asset '${name}' (attach a file first)`);
    }
    const ds = _csvResolver(name);
    if (!ds || ds.__dataset !== true) {
      throw new Error(`load_csv: no CSV asset '${name}' (attach a file first)`);
    }
    return ds;
  },
  foldl(args) {
    const [f, acc0, xs] = args;
    if (typeof f !== 'function') throw new Error('foldl: first arg must be a function');
    if (!Array.isArray(xs)) throw new Error('foldl: third arg must be a list');
    let acc = acc0;
    for (const x of xs) acc = f(acc, x);
    return acc;
  },
  concat(args) {
    const [xs, ys] = args;
    if (!Array.isArray(xs) || !Array.isArray(ys)) throw new Error('concat: both args must be lists');
    return xs.concat(ys);
  },
  take(args) {
    const n = args[0] instanceof Quantity ? args[0].value : args[0];
    const xs = args[1];
    if (!Array.isArray(xs)) throw new Error('take: second arg must be a list');
    return xs.slice(0, Math.max(0, Math.round(n)));
  },
  drop(args) {
    const n = args[0] instanceof Quantity ? args[0].value : args[0];
    const xs = args[1];
    if (!Array.isArray(xs)) throw new Error('drop: second arg must be a list');
    return xs.slice(Math.max(0, Math.round(n)));
  },
  reverse(args) {
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('reverse: arg must be a list');
    return xs.slice().reverse();
  },
  element_at(args) {
    const i = args[0] instanceof Quantity ? args[0].value : args[0];
    const xs = args[1];
    if (!Array.isArray(xs)) throw new Error('element_at: second arg must be a list');
    const idx = Math.round(i);
    if (idx < 0 || idx >= xs.length) throw new Error(`element_at: index ${idx} out of bounds (list has ${xs.length} elements)`);
    return xs[idx];
  },
  random_list(args) {
    // random_list(n) → List<Scalar> of n samples uniform on [0, 1).
    // Convenience because plain map(_, range(...)) would require a
    // discard-fn for `random()` which takes no args. ep-flavored.
    const n = args[0] instanceof Quantity ? args[0].value : args[0];
    if (!Number.isFinite(n) || n < 0) throw new Error('random_list: arg must be a non-negative finite scalar');
    const count = Math.round(n);
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = new Quantity(Math.random(), {});
    return out;
  },
  // List constructors — numpy-shaped helpers for the dataset / plot lane.
  // ep-flavored extensions; upstream Numbat's stdlib doesn't ship these
  // (though upstream's plot::common has linspace, used internally).
  zeros(args) {
    const n = args[0] instanceof Quantity ? args[0].value : args[0];
    if (!Number.isFinite(n) || n < 0) throw new Error('zeros: arg must be a non-negative finite scalar');
    const k = Math.round(n);
    const out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = new Quantity(0, {});
    return out;
  },
  ones(args) {
    const n = args[0] instanceof Quantity ? args[0].value : args[0];
    if (!Number.isFinite(n) || n < 0) throw new Error('ones: arg must be a non-negative finite scalar');
    const k = Math.round(n);
    const out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = new Quantity(1, {});
    return out;
  },
  linspace(args) {
    // linspace(start, end, n) → n evenly-spaced points from start to end
    // (both inclusive). Preserves the input quantities' dim — so
    // linspace(0 m, 10 m, 5) yields List<Length>. Mirrors numpy.linspace
    // and upstream Numbat's plot::common::linspace.
    if (args.length !== 3) throw new Error(`linspace: expected 3 args (start, end, n), got ${args.length}`);
    const [startQ, endQ, nArg] = args;
    if (!(startQ instanceof Quantity) || !(endQ instanceof Quantity)) {
      throw new Error('linspace: start and end must be quantities');
    }
    if (!dimEq(startQ.dim, endQ.dim)) {
      throw new Error(`linspace: start and end must have the same dim`);
    }
    const n = nArg instanceof Quantity ? nArg.value : nArg;
    if (!Number.isFinite(n) || n < 0) throw new Error('linspace: n must be a non-negative finite scalar');
    const k = Math.round(n);
    if (k === 0) return [];
    if (k === 1) return [new Quantity(startQ.value, startQ.dim)];
    const step = (endQ.value - startQ.value) / (k - 1);
    const out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = new Quantity(startQ.value + step * i, startQ.dim);
    return out;
  },
  arange(args) {
    // arange(start, stop [, step]) → numpy-style: stop EXCLUSIVE, step
    // optional (default 1). Supports negative step (descending range)
    // and unit-bearing args (preserves dim). Differs from range() which
    // is integer-only / inclusive / step=1 to match upstream Numbat.
    if (args.length < 2 || args.length > 3) {
      throw new Error(`arange: expected 2..3 args (start, stop [, step]), got ${args.length}`);
    }
    const [startQ, stopQ, stepQ] = args;
    if (!(startQ instanceof Quantity) || !(stopQ instanceof Quantity)) {
      throw new Error('arange: start and stop must be quantities');
    }
    if (!dimEq(startQ.dim, stopQ.dim)) {
      throw new Error('arange: start and stop must have the same dim');
    }
    let step = 1;
    if (stepQ !== undefined) {
      if (!(stepQ instanceof Quantity)) throw new Error('arange: step must be a quantity');
      if (!dimEq(stepQ.dim, startQ.dim)) {
        throw new Error('arange: step must have the same dim as start / stop');
      }
      step = stepQ.value;
    }
    if (!Number.isFinite(step) || step === 0) throw new Error('arange: step must be non-zero finite');
    const start = startQ.value, stop = stopQ.value;
    const dim = startQ.dim;
    const out = [];
    if (step > 0) {
      for (let v = start; v < stop; v += step) out.push(new Quantity(v, dim));
    } else {
      for (let v = start; v > stop; v += step) out.push(new Quantity(v, dim));
    }
    return out;
  },
  // String helpers — implementations for upstream's `extern fn …`
  // declarations under core::strings. Match upstream signatures.
  str_length(args)  { return new Quantity(String(args[0] ?? '').length, {}); },
  str_eq(args)      { return String(args[0] ?? '') === String(args[1] ?? ''); },
  str_slice(args)   {
    const start = args[0] instanceof Quantity ? args[0].value : args[0];
    const end   = args[1] instanceof Quantity ? args[1].value : args[1];
    return String(args[2] ?? '').slice(start, end);
  },
  str_append(args)  { return String(args[0] ?? '') + String(args[1] ?? ''); },
  chr(args)         {
    const n = args[0] instanceof Quantity ? args[0].value : args[0];
    return String.fromCodePoint(n);
  },
  ord(args)         { return new Quantity(String(args[0] ?? '').codePointAt(0) || 0, {}); },
  lowercase(args)   { return String(args[0] ?? '').toLowerCase(); },
  uppercase(args)   { return String(args[0] ?? '').toUpperCase(); },

  // max(a, b, ...) / min(a, b, ...): variadic. All args must share the
  // same dimension. Useful as a top-level fn even though upstream
  // numbat defines them inside core::functions via fold.
  max(args) {
    if (!args.length) throw new Error('max: expected at least 1 arg');
    let best = args[0];
    for (let i = 1; i < args.length; i++) {
      if (!dimEq(args[i].dim, best.dim)) throw new Error(`max: dim mismatch at arg ${i}`);
      if (args[i].value > best.value) best = args[i];
    }
    return best;
  },
  min(args) {
    if (!args.length) throw new Error('min: expected at least 1 arg');
    let best = args[0];
    for (let i = 1; i < args.length; i++) {
      if (!dimEq(args[i].dim, best.dim)) throw new Error(`min: dim mismatch at arg ${i}`);
      if (args[i].value < best.value) best = args[i];
    }
    return best;
  },
  // type(value): return a human-readable description of the value's
  // dimension. Matches numbat's `type` builtin used as a REPL aid
  // (`type(2 m/s)` → "Length / Time"). Returns a string; for non-
  // Quantity args, returns the JS type name.
  type(args) {
    if (args.length !== 1) throw new Error(`type: expected 1 arg, got ${args.length}`);
    const v = args[0];
    if (v instanceof Quantity) {
      if (dimEmpty(v.dim)) return 'Scalar';
      // Reuse dimFormat for a readable signature like "Length·Time^-1".
      const sig = Object.keys(v.dim).sort().map(k => {
        const e = v.dim[k];
        const cap = k.charAt(0).toUpperCase() + k.slice(1);
        return e === 1 ? cap : cap + '^' + e;
      }).join(' · ');
      return sig;
    }
    if (typeof v === 'boolean') return 'Bool';
    if (typeof v === 'string') return 'String';
    if (Array.isArray(v)) return 'List';
    return typeof v;
  },

  // Datetime / locale stubs — return Quantities (seconds since Unix epoch
  // with dim {time:1}) so that arithmetic on them in upstream code works.
  // Real DateTime semantics (timezones, formatting, calendar arithmetic)
  // need their own type — that's later work. For now these are best-effort
  // stubs that make module loading succeed.
  // Datetime model: we keep the Quantity({time:1}) shape for the VALUE
  // (seconds since Unix epoch) so existing arith `now() + 1 hour` still
  // works through the standard time-dim path. When globalThis.Temporal
  // is available (Firefox 139+, Chrome shipping, Node with polyfill,
  // Safari with polyfill), datetime() / now() / format_datetime use it
  // for TZ-aware parsing and formatting; otherwise we fall back to JS
  // Date.
  get_local_timezone(args) {
    if (typeof globalThis.Temporal !== 'undefined') {
      try { return globalThis.Temporal.Now.timeZoneId(); } catch {}
    }
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch { return 'UTC'; }
  },
  now(args) {
    // Always seconds-since-epoch as a {time:1} Quantity. Temporal is
    // used here only as a clock source (sub-second precision is the
    // same as Date.now / 1000 in practice).
    if (typeof globalThis.Temporal !== 'undefined') {
      try {
        const ms = Number(globalThis.Temporal.Now.instant().epochMilliseconds);
        return new Quantity(ms / 1000, { time: 1 });
      } catch {}
    }
    return new Quantity(Date.now() / 1000, { time: 1 });
  },
  datetime(args) {
    // Parse via Temporal when available — supports ISO with offsets and
    // TZ identifiers. Falls back to Date.parse for older runtimes.
    const s = String(args[0] ?? '');
    if (typeof globalThis.Temporal !== 'undefined') {
      try {
        const inst = globalThis.Temporal.Instant.from(s);
        return new Quantity(Number(inst.epochMilliseconds) / 1000, { time: 1 });
      } catch { /* fall through to Date */ }
      try {
        const zdt = globalThis.Temporal.ZonedDateTime.from(s);
        return new Quantity(Number(zdt.epochMilliseconds) / 1000, { time: 1 });
      } catch { /* fall through */ }
      try {
        const pdt = globalThis.Temporal.PlainDateTime.from(s);
        const zdt = pdt.toZonedDateTime(globalThis.Temporal.Now.timeZoneId());
        return new Quantity(Number(zdt.epochMilliseconds) / 1000, { time: 1 });
      } catch { /* fall through */ }
    }
    const t = Date.parse(s);
    return new Quantity(Number.isFinite(t) ? t / 1000 : 0, { time: 1 });
  },
  format_datetime(args) {
    // Upstream signature: format_datetime(fmt: String, dt: DateTime, tz?: String)
    // → String. Numbat uses a strftime-ish format string; we recognize
    // the common tokens (%Y %m %d %H %M %S %z %Z %A %B %j) and pass
    // everything else through. Without Temporal we use Date in the
    // detected TZ; with Temporal we use the proper ZonedDateTime.
    const fmt = String(args[0] ?? '');
    const dt  = args[1];
    const tzArg = args[2];
    const tz = typeof tzArg === 'string' ? tzArg : (tzArg && tzArg.name) ||
               (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC');
    const secs = dt instanceof Quantity ? dt.value : Number(dt);
    if (!Number.isFinite(secs)) return '';
    return formatDatetimeWith(fmt, secs, tz);
  },
  tz(args) {
    // Returns an opaque TZ token. Used as the optional 3rd arg to
    // format_datetime. We just carry the string identifier; Temporal
    // accepts that directly.
    return { __struct: 'TzFn', name: String(args[0] ?? 'UTC') };
  },
  exchange_rate(args) {
    // Live currency rates aren't a thing in a static-file browser app.
    // Stub returns 1; users wanting accurate FX should pre-bind their
    // own rates via `let usd_to_eur = 0.92`.
    return new Quantity(1, {});
  },

  // mod(a, b) — least nonnegative remainder. Upstream declares this as
  // `fn mod<T: Dim>(a: T, b: T) -> T` so it's an extern that dispatches here.
  mod(args) {
    if (args.length !== 2) throw new Error(`mod: expected 2 args, got ${args.length}`);
    const [a, b] = args;
    if (!(a instanceof Quantity) || !(b instanceof Quantity)) {
      throw new Error('mod: both args must be Quantities');
    }
    if (!dimEq(a.dim, b.dim)) {
      throw new Error(`mod: dim mismatch [${JSON.stringify(a.dim)}] vs [${JSON.stringify(b.dim)}]`);
    }
    // Euclidean remainder (always non-negative)
    const r = ((a.value % b.value) + b.value) % b.value;
    return new Quantity(r, a.dim);
  },

  // random() — host-provided pseudo-random in [0, 1). Returns a dimensionless
  // Quantity. For deterministic testing the host can override this.
  random(args) {
    if (args.length !== 0) throw new Error(`random: expected 0 args, got ${args.length}`);
    return new Quantity(Math.random(), {});
  },

  // ── list primitives (v0.5) ──────────────────────────────────
  // Upstream's core::lists declares these as `fn head<A>(xs: List<A>) -> A`
  // (extern); the loader routes extern body-less fns here.
  len(args) {
    if (args.length !== 1) throw new Error(`len: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (Array.isArray(xs)) return new Quantity(xs.length, {});
    if (typeof xs === 'string') return new Quantity(xs.length, {});
    // Dataset row count.
    if (xs !== null && typeof xs === 'object' && xs.__dataset) {
      return new Quantity(xs.length, {});
    }
    throw new Error('len: expected List, String, or Dataset');
  },
  head(args) {
    if (args.length !== 1) throw new Error(`head: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('head: expected List');
    if (xs.length === 0) throw new Error('head: empty list');
    return xs[0];
  },
  tail(args) {
    if (args.length !== 1) throw new Error(`tail: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('tail: expected List');
    if (xs.length === 0) throw new Error('tail: empty list');
    return xs.slice(1);
  },
  cons(args) {
    if (args.length !== 2) throw new Error(`cons: expected 2 args, got ${args.length}`);
    const [x, xs] = args;
    if (!Array.isArray(xs)) throw new Error('cons: second arg must be a List');
    return [x, ...xs];
  },
  cons_end(args) {
    if (args.length !== 2) throw new Error(`cons_end: expected 2 args, got ${args.length}`);
    const [x, xs] = args;
    if (!Array.isArray(xs)) throw new Error('cons_end: second arg must be a List');
    return [...xs, x];
  },
  // assert_eq(a, b)        — strict equality (same dim, same value)
  // assert_eq(a, b, eps)   — approximate equality (|a - b| <= eps)
  // Works on Quantity-vs-Quantity (with dim check) or Bool-vs-Bool.
  assert_eq(args) {
    if (args.length < 2 || args.length > 3) {
      throw new Error(`assert_eq: expected 2 or 3 args, got ${args.length}`);
    }
    const [a, b, eps] = args;
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      if (typeof a !== typeof b) throw new Error('assert_eq: cannot compare Bool with Quantity');
      if (eps !== undefined) throw new Error('assert_eq: tolerance not meaningful for Bool');
      if (a !== b) throw new Error(`assert_eq failed: ${a} ≠ ${b}`);
      return new Quantity(0, {});
    }
    if (!dimEq(a.dim, b.dim)) {
      throw new Error(`assert_eq: dim mismatch [${JSON.stringify(a.dim)}] vs [${JSON.stringify(b.dim)}]`);
    }
    if (eps === undefined) {
      // Default tolerance: a tiny relative+absolute epsilon so trivial
      // floating-point noise (e.g. `12 in == 1 ft` → 0.30479999… vs
      // 0.3048) passes. Exact equality is too strict for unit-converted
      // operands. Tolerance scales with the larger operand's magnitude;
      // floor of 1e-12 catches near-zero cases.
      const scale = Math.max(Math.abs(a.value), Math.abs(b.value), 1);
      const defaultEps = scale * 1e-9 + 1e-12;
      if (Math.abs(a.value - b.value) > defaultEps) {
        throw new Error(`assert_eq failed: ${a.value} ≠ ${b.value}`);
      }
    } else {
      if (!dimEq(a.dim, eps.dim)) {
        throw new Error(`assert_eq: tolerance must have same dim as compared values`);
      }
      if (Math.abs(a.value - b.value) > eps.value) {
        throw new Error(`assert_eq failed: |${a.value} - ${b.value}| = ${Math.abs(a.value - b.value)} > ${eps.value}`);
      }
    }
    return new Quantity(0, {});
  },
};

const EVAL_CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

// ── String interpolation ─────────────────────────────────────────
//
// Numbat-script strings like `"value is {x:.3} {unit}"` are parsed as
// plain string literals by the tokenizer; substitution happens at
// evaluation time. `{{` and `}}` are literal braces. Inside a `{...}`
// segment, an optional `:<spec>` tail picks a format:
//   .N        → N significant digits (default 6)
//   nN        → N decimal places, fixed notation
//   e         → scientific notation
//   s         → raw string (default for non-Quantity values)
// Everything before the `:` is parsed as a normal expression against
// the current env. Quantity results format with their auto-scaled unit
// suffix; bool / string / list results format as their JS toString.
function interpolateString(template, env) {
  if (typeof template !== 'string') return template;
  if (template.indexOf('{') < 0 && template.indexOf('}') < 0) return template;

  let out = '';
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === '{' && template[i + 1] === '{') { out += '{'; i += 2; continue; }
    if (c === '}' && template[i + 1] === '}') { out += '}'; i += 2; continue; }
    if (c === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < template.length && depth > 0) {
        const cj = template[j];
        if (cj === '{') depth++;
        else if (cj === '}') { depth--; if (depth === 0) break; }
        j++;
      }
      if (depth !== 0) throw new Error(`unclosed '{' in string template`);
      const inner = template.slice(i + 1, j);
      const colonIdx = findFormatColon(inner);
      const exprText = (colonIdx < 0 ? inner : inner.slice(0, colonIdx)).trim();
      const fmtSpec  = colonIdx < 0 ? null  : inner.slice(colonIdx + 1).trim();
      let value;
      try { value = evalInterpExpr(exprText, env); }
      catch (e) { throw new Error(`in string interpolation \`{${inner}}\`: ${e.message}`); }
      out += formatInterpValue(value, fmtSpec);
      i = j + 1;
      continue;
    }
    if (c === '}') throw new Error(`unexpected '}' in string template (use '}}' for a literal brace)`);
    out += c;
    i++;
  }
  return out;
}

// `:` separates expression from format spec. Inside the expression, `:`
// might appear in dim annotations (`x : Length`) or struct literals;
// don't treat those as the spec separator. Heuristic: only the LAST
// top-level `:` counts, and it must be followed by a short alpha/dot/
// digit format-spec form (no spaces).
function findFormatColon(s) {
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') depth--;
    else if (depth === 0 && c === ':') {
      const after = s.slice(i + 1).trim();
      if (/^[.a-zA-Z0-9]+$/.test(after)) return i;
    }
  }
  return -1;
}

function formatInterpValue(value, fmtSpec) {
  if (value instanceof Quantity) {
    if (fmtSpec) {
      const num = formatNumberSpec(value.value, fmtSpec);
      // For dimensionless Quantity with a format spec, omit the empty
      // unit suffix. For dimensional, include the auto-scaled unit.
      if (dimEmpty(value.dim)) return num;
      // Defer to the formatter's unit picker by sliding the formatted
      // number into the auto-scale output's unit position.
      const auto = formatQuantity(value);
      return num + ' ' + (auto.unit || '');
    }
    const auto = formatQuantity(value);
    return auto.unit ? `${auto.num} ${auto.unit}` : auto.num;
  }
  if (typeof value === 'string')  return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return '[' + value.map(v => formatInterpValue(v, null)).join(', ') + ']';
  if (value == null) return '';
  return String(value);
}

// Numeric format mini-language matching upstream numbat:
//   .N → toPrecision(N)
//   nN → toFixed(N)
//   e  → toExponential()
//   default → toPrecision(6)
function formatNumberSpec(n, spec) {
  if (!spec) return String(n);
  const s = spec.trim();
  if (s.startsWith('.')) {
    const N = parseInt(s.slice(1), 10);
    if (Number.isFinite(N) && N > 0) {
      return parseFloat(n.toPrecision(N)).toString();
    }
  }
  if (s.startsWith('n')) {
    const N = parseInt(s.slice(1), 10);
    if (Number.isFinite(N) && N >= 0) return n.toFixed(N);
  }
  if (s === 'e') return n.toExponential();
  if (s === 's') return String(n);
  return String(n);
}

// Tokenize, parse, and evaluate a single expression from a string
// template. We wrap it as `let __ep_interp__ = <expr>` to reuse the
// existing top-level parser; then pluck the expression AST. Throws on
// any parse / eval error; caller wraps the error.
function evalInterpExpr(text, env) {
  // The parser expects top-level decls. Wrap as `let __interp__ = <expr>`
  // to reuse the existing entry point, then pluck the RHS AST. Skipping
  // the bare-expression parse attempt because numbat's parser throws on
  // anything that doesn't start with a declaration keyword.
  const tokens = tokenize(`let __ep_interp__ = ${text}`, '<interp>');
  const ast = parse(tokens, '<interp>');
  if (!ast.decls.length || ast.decls[0].type !== 'LetDecl') {
    throw new Error('expected an expression');
  }
  return evalValueExpr(ast.decls[0].expr, env);
}

// Format a quantity through the host's number formatter, returning
// {num, unit}. We avoid importing format.js from here by reusing the
// caller-side Numbat instance via `globalThis._numbatHost` set by
// host(). For environments without that hook, fall back to a plain
// value rendering with no unit picker.
function formatQuantity(q) {
  // Without access to a registry, render value as-is. Hosts (ep)
  // can override interpolation by replacing this function via
  // `setQuantityFormatter`.
  if (typeof _quantityFormatter === 'function') return _quantityFormatter(q);
  return { num: String(q.value), unit: dimEmpty(q.dim) ? '' : '[?]' };
}
let _quantityFormatter = null;
function setQuantityFormatter(fn) { _quantityFormatter = fn; }

// Print sink: hosts (or tests) set a callback that receives each
// `print(args)` call's rendered text. ep leaves this null in production
// (no output panel yet); the conformance corpus sets it to a buffer to
// assert on what programs print.
let _printSink = null;
function setPrintSink(fn) { _printSink = fn; }

// Plot output sink — receives a descriptor object whenever a program
// calls plot()/scatter()/bar()/hist(). Same role as _printSink for
// text: numbat-js stays output-medium-agnostic, the host (ep, REPL,
// notebook shell) chooses how to render. Descriptor shape:
//   { type: 'line' | 'scatter' | 'bar' | 'hist',
//     xs?: number[], ys?: number[], values?: number[],
//     xUnit?: string, yUnit?: string }
// Defaults to no-op; hosts that don't render plots simply drop them.
let _plotSink = null;
function setPlotSink(fn) { _plotSink = fn; }

// CSV asset resolver — the host (ep) supplies a function that maps an
// asset name to `{ text, config? }` (or null when no such asset). The
// `load_csv(name)` builtin calls it, then parses the text into a
// Dataset. numbat-js itself has no notion of files / storage; the host
// owns the asset table. Defaults to a resolver that always reports
// "no asset", so load_csv fails gracefully outside ep.
let _csvResolver = null;
function setCsvResolver(fn) { _csvResolver = fn; }

// Extract canonical numbers and unit string from a List<Quantity> arg.
// numbat-js represents Lists as plain JS arrays whose entries are
// Quantity instances. We pull .value from each (canonical units —
// grams, meters, seconds, …) and capture the dim's format as the unit
// label for the host's axis. Bare numbers / mixed types fall back to
// passing through as-is.
function _listToNumbers(arr) {
  if (!Array.isArray(arr)) return { values: [], unit: '' };
  const values = [];
  for (const v of arr) {
    if (v instanceof Quantity) values.push(v.value);
    else if (typeof v === 'number') values.push(v);
    else values.push(Number(v));
  }
  // Capture the dim of the first Quantity entry as the axis label
  // hint. The host can use this for "Time (seconds)" type labeling.
  let unit = '';
  if (arr.length && arr[0] instanceof Quantity) {
    try {
      if (typeof _quantityFormatter === 'function') {
        const p = _quantityFormatter(arr[0]);
        if (p && p.unit) unit = p.unit;
      }
    } catch {}
  }
  return { values, unit };
}
function coerceXY(xsArg, ysArg) {
  const x = _listToNumbers(xsArg);
  const y = _listToNumbers(ysArg);
  return { xs: x.values, ys: y.values, xUnit: x.unit, yUnit: y.unit };
}
function coerceValues(valuesArg) {
  const v = _listToNumbers(valuesArg);
  return { values: v.values, valueUnit: v.unit };
}

// Pull optional trailing strings off a plot/scatter/bar_chart/hist
// args array starting at `start`. Order is [xlabel, ylabel, title] —
// users can pass any prefix. Non-string args are coerced via String()
// so a misplaced number ends up shown verbatim rather than crashing.
function labelOpts(args, start) {
  const labels = ['xLabel', 'yLabel', 'title'];
  const out = {};
  for (let i = 0; i < labels.length; i++) {
    const v = args[start + i];
    if (v === undefined) break;
    out[labels[i]] = String(v);
  }
  return out;
}

// ── Datetime formatting ──────────────────────────────────────────
// strftime-ish formatter used by BUILTIN_PROCS.format_datetime. Recognized
// tokens: %Y (4-digit year), %y (2-digit year), %m (zero-padded month),
// %d (zero-padded day), %H (24h zero-pad hour), %M (zero-pad minute),
// %S (zero-pad second), %B (full month name), %b (abbrev month name),
// %A (full weekday), %a (abbrev weekday), %j (day-of-year), %z (offset
// like +0100), %Z (TZ name). `%%` is a literal %. Unrecognized
// `%<x>` passes through as `%<x>`.
function formatDatetimeWith(fmt, secs, tz) {
  let parts;
  if (typeof globalThis.Temporal !== 'undefined') {
    try {
      const inst = globalThis.Temporal.Instant.fromEpochMilliseconds(Math.round(secs * 1000));
      const zdt = inst.toZonedDateTimeISO(tz);
      parts = {
        Y: String(zdt.year).padStart(4, '0'),
        y: String(zdt.year % 100).padStart(2, '0'),
        m: String(zdt.month).padStart(2, '0'),
        d: String(zdt.day).padStart(2, '0'),
        H: String(zdt.hour).padStart(2, '0'),
        M: String(zdt.minute).padStart(2, '0'),
        S: String(zdt.second).padStart(2, '0'),
        j: String(zdt.dayOfYear).padStart(3, '0'),
        Z: tz,
        z: zdt.offset.replace(':', ''),
        A: intlFmt(zdt.epochMilliseconds, tz, { weekday: 'long' }),
        a: intlFmt(zdt.epochMilliseconds, tz, { weekday: 'short' }),
        B: intlFmt(zdt.epochMilliseconds, tz, { month: 'long' }),
        b: intlFmt(zdt.epochMilliseconds, tz, { month: 'short' }),
      };
    } catch { parts = null; }
  }
  if (!parts) {
    // Fallback via Date — UTC accurate, TZ-arg ignored. Use Intl for
    // weekday/month names so locale formatting works.
    const d = new Date(secs * 1000);
    parts = {
      Y: String(d.getUTCFullYear()).padStart(4, '0'),
      y: String(d.getUTCFullYear() % 100).padStart(2, '0'),
      m: String(d.getUTCMonth() + 1).padStart(2, '0'),
      d: String(d.getUTCDate()).padStart(2, '0'),
      H: String(d.getUTCHours()).padStart(2, '0'),
      M: String(d.getUTCMinutes()).padStart(2, '0'),
      S: String(d.getUTCSeconds()).padStart(2, '0'),
      j: String(Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 0))) / 86400000)).padStart(3, '0'),
      Z: 'UTC',
      z: '+0000',
      A: intlFmt(d.getTime(), 'UTC', { weekday: 'long' }),
      a: intlFmt(d.getTime(), 'UTC', { weekday: 'short' }),
      B: intlFmt(d.getTime(), 'UTC', { month: 'long' }),
      b: intlFmt(d.getTime(), 'UTC', { month: 'short' }),
    };
  }
  return fmt.replace(/%(.)/g, (_, c) => {
    if (c === '%') return '%';
    return parts[c] !== undefined ? parts[c] : '%' + c;
  });
}

function intlFmt(epochMs, tz, opts) {
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz })
      .format(new Date(epochMs));
  } catch { return ''; }
}

function evalValueExpr(node, env) {
  if (node.type === 'Num')  return new Quantity(node.value, {});
  if (node.type === 'Bool') return node.value;   // JS boolean
  if (node.type === 'Str')  return interpolateString(node.value, env);
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
  if (node.type === 'List') {
    return node.items.map(item => evalValueExpr(item, env));
  }
  if (node.type === 'Lambda') {
    // Anonymous fn → JS closure capturing the lexical env at the
    // lambda's definition site. When called (via env.values higher-order
    // dispatch in evalCall, or directly when handed to a BUILTIN_PROC
    // like map), it binds each arg to the corresponding param on top of
    // the captured env's values, then evaluates the body. Same shape as
    // the wrappers `lookupValue` produces for named fns — interchangeable
    // wherever a fn value is expected.
    const closedEnv = env;
    const params = node.params;
    const body = node.body;
    return (...args) => {
      const innerValues = new Map(closedEnv.values);
      for (let i = 0; i < params.length; i++) {
        innerValues.set(params[i].name, args[i]);
      }
      const innerEnv = { ...closedEnv, values: innerValues };
      // Also override lookupValue so identifiers inside the body resolve
      // against the extended `values` map (otherwise the closure'd env
      // would see params as missing and fall through to units/builtins).
      innerEnv.lookupValue = (n) => {
        if (innerValues.has(n)) return innerValues.get(n);
        return closedEnv.lookupValue(n);
      };
      return evalValueExpr(body, innerEnv);
    };
  }
  if (node.type === 'StructInit') {
    // v0.5 stores structs as plain JS objects with a __struct tag for the
    // type name. Field types from the declaration aren't enforced at runtime.
    const obj = { __struct: node.name };
    for (const f of node.fields) obj[f.name] = evalValueExpr(f.value, env);
    return obj;
  }
  if (node.type === 'Field') {
    const o = evalValueExpr(node.obj, env);
    // Field-access broadcasting (ep dataset extension): `.field` over a
    // list of structs projects the column — `[s1, s2, s3].grade` →
    // `[s1.grade, s2.grade, s3.grade]`. Same shape as the arithmetic /
    // comparison broadcasting; it's what makes `model.grade` work once
    // `model` is a list of records (a CSV-loaded table). An empty list
    // projects to an empty list — there's no element to validate the
    // field name against, and that's the correct identity.
    if (Array.isArray(o)) {
      return o.map((el, i) => {
        // A struct value is a tagged plain object (`__struct`). Quantity
        // is also a JS object, so the tag check is what distinguishes
        // "list of records" from "list of numbers".
        if (el === null || typeof el !== 'object' || Array.isArray(el)
            || !('__struct' in el)) {
          throw new Error(`field access: list element ${i} is not a struct`);
        }
        if (!(node.name in el)) {
          throw new Error(`field '${node.name}' not in struct ${el.__struct ?? '(unknown)'}`);
        }
        return el[node.name];
      });
    }
    // Dataset column access: `model.grade` on a columnar Dataset returns
    // the grade column directly — O(1), no per-row projection. (A plain
    // List<Struct> reaches the same result via the broadcast branch
    // above; the Dataset is the columnar form + the Phase-2 seam.)
    if (o !== null && typeof o === 'object' && o.__dataset) {
      if (!o.columns.has(node.name)) {
        throw new Error(`no column '${node.name}' in dataset (have: ${[...o.columns.keys()].join(', ')})`);
      }
      return o.columns.get(node.name);
    }
    if (o === null || typeof o !== 'object') {
      throw new Error(`field access on non-struct value`);
    }
    if (!(node.name in o)) {
      throw new Error(`field '${node.name}' not in struct ${o.__struct ?? '(unknown)'}`);
    }
    return o[node.name];
  }
  if (node.type === 'Unary' && node.op === '!') {
    const v = evalValueExpr(node.expr, env);
    // Array broadcasting: ![true, false, true] → [false, true, false].
    // Mask negation, useful for inverting a selection mask.
    if (Array.isArray(v)) {
      return v.map(x => {
        if (typeof x !== 'boolean') throw new Error('!: list element must be Bool');
        return !x;
      });
    }
    if (typeof v !== 'boolean') throw new Error('! requires a Bool operand');
    return !v;
  }
  if (node.type === 'Factorial') {
    // Postfix n! — always goes to the builtin, bypassing any user-defined
    // `factorial` (which itself often has body `n!` — recursing would
    // overflow the stack).
    const v = evalValueExpr(node.expr, env);
    if (!(v instanceof Quantity)) throw new Error('!: requires a Quantity');
    return BUILTIN_FNS.factorial(v);
  }
  if (node.type === 'Unary' && node.op === '-') {
    const v = evalValueExpr(node.expr, env);
    // Array broadcasting: -[1, 2, 3] negates each element.
    if (Array.isArray(v)) return v.map(x => x.neg());
    return v.neg();
  }
  if (node.type === 'Binary') {
    // Logical operators on booleans (short-circuit) — but if either side
    // is a List<Bool>, broadcast element-wise instead. List broadcasting
    // can't short-circuit (we need to fully evaluate the RHS to align
    // it with the LHS list), so the short-circuit path applies only
    // when both sides are scalar booleans.
    if (node.op === '&&' || node.op === '||') {
      const l = evalValueExpr(node.left, env);
      if (Array.isArray(l)) {
        // List on the left — eval the right and broadcast.
        const r = evalValueExpr(node.right, env);
        return broadcastLogic(node.op, l, r);
      }
      if (typeof l !== 'boolean') throw new Error(`${node.op} requires Bool operands`);
      // Scalar Bool on the left — short-circuit IF the result is
      // determined. Otherwise eval the right; if it's a list, broadcast
      // the scalar across it.
      if (node.op === '&&' && !l) return false;
      if (node.op === '||' &&  l) return true;
      const r = evalValueExpr(node.right, env);
      if (Array.isArray(r)) return broadcastLogic(node.op, l, r);
      if (typeof r !== 'boolean') throw new Error(`${node.op} requires Bool operands`);
      return r;
    }
    if (EVAL_CMP_OPS.has(node.op)) return evalCmp(node, env);
    if (node.op === '->') {
      const left = evalValueExpr(node.left, env);
      let target = node.right;
      while (target.type === 'Paren') target = target.expr;
      // Three meanings for `x -> name` depending on context:
      //   1. left is a Quantity AND name is a unit → set disp tag (conversion)
      //   2. name is a fn/builtin → function application `f(x)`
      //      (upstream uses this pattern: `datetime("…") -> julian_date`)
      //   3. otherwise → error
      if (target.type === 'Ident') {
        if (left instanceof Quantity && env.units.has(target.name)) {
          return left.convertTo(target.name, env.units);
        }
        if (env.fns?.has(target.name)) {
          return invokeUserFn(env.fns.get(target.name), target.name, [left], env);
        }
        if (BUILTIN_PROCS[target.name]) return BUILTIN_PROCS[target.name]([left]);
        if (BUILTIN_FNS[target.name])   return BUILTIN_FNS[target.name](left);
        throw new Error(`-> ${target.name}: unknown unit or function`);
      }
      // Compound case: evaluate the target as a Quantity, verify dim,
      // return left with no disp tag (compound display naming is v0.5+).
      const targetQ = evalValueExpr(target, env);
      if (!(left instanceof Quantity) || !(targetQ instanceof Quantity)) {
        throw new Error('-> compound target requires Quantity on both sides');
      }
      if (!dimEq(left.dim, targetQ.dim)) {
        throw new Error(`-> dim mismatch: [${JSON.stringify(left.dim)}] cannot convert to [${JSON.stringify(targetQ.dim)}]`);
      }
      return new Quantity(left.value, left.dim);
    }
    if (node.op === '^') {
      const base = evalValueExpr(node.left, env);
      const exp = evalValueExpr(node.right, env);
      // Array broadcasting on the base: [a, b, c]^n = [a^n, b^n, c^n].
      // Exponent must be a dimensionless scalar (per-element exponents
      // would be uncommon and require defining per-element semantics).
      if (Array.isArray(base)) {
        if (!(exp instanceof Quantity) || !dimEmpty(exp.dim)) {
          throw new Error('exponent must be a dimensionless scalar (lists not allowed on the right of ^)');
        }
        return base.map(x => x.pow(exp.value));
      }
      if (!dimEmpty(exp.dim)) throw new Error('exponent must be dimensionless');
      return base.pow(exp.value);
    }
    const l = evalValueExpr(node.left, env);
    const r = evalValueExpr(node.right, env);
    // Array broadcasting for arithmetic. Numpy-style rules:
    //   Array op Array → element-wise (length must match)
    //   Array op Scalar → broadcast scalar across the array
    //   Scalar op Array → same
    //   Length mismatch on Array op Array → error
    // Dim arithmetic still applies per-element, so List<Length> + List<Mass>
    // would error per-element on the underlying Quantity.add(). This is
    // an ep-flavored extension to numbat — upstream Numbat's stdlib uses
    // map/foldl for element-wise ops, so programs relying on broadcasting
    // are ep-specific.
    if (Array.isArray(l) || Array.isArray(r)) {
      return broadcastArith(node.op, l, r);
    }
    if (node.op === '+') return l.add(r);
    if (node.op === '-') return l.sub(r);
    if (node.op === '*') return l.mul(r);
    if (node.op === '/') return l.div(r);
    throw new Error(`operator '${node.op}' not supported in value expression`);
  }
  throw new Error(`unexpected node ${node.type} in value expression`);
}

// Element-wise arithmetic broadcasting for the four basic ops. Called
// from evalValueExpr's Binary handler when at least one operand is a
// JS array (i.e., a numbat List). Dim checking happens per-element via
// the underlying Quantity ops, so length-matched lists of incompatible
// dims still surface a useful error (`[3 m] + [2 kg]` → "dim mismatch"
// on the first pair, not a vague type complaint).
function broadcastArith(op, l, r) {
  const elemOp = (a, b) => {
    switch (op) {
      case '+': return a.add(b);
      case '-': return a.sub(b);
      case '*': return a.mul(b);
      case '/': return a.div(b);
    }
    throw new Error(`broadcast: '${op}' not a supported arithmetic op`);
  };
  if (Array.isArray(l) && Array.isArray(r)) {
    if (l.length !== r.length) {
      throw new Error(`list length mismatch in '${op}': ${l.length} vs ${r.length}`);
    }
    return l.map((v, i) => elemOp(v, r[i]));
  }
  if (Array.isArray(l)) return l.map(v => elemOp(v, r));
  /* Array.isArray(r) */ return r.map(v => elemOp(l, v));
}

// Deep equality across Quantity / Bool / String / List values.
function valueEq(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valueEq(v, b[i]));
  }
  if (a instanceof Quantity && b instanceof Quantity) {
    return a.value === b.value && dimEq(a.dim, b.dim);
  }
  return a === b;
}

// Compare two scalar Quantities or primitives — the pre-broadcasting
// element-wise path. Used both for the scalar/scalar case in evalCmp
// AND inside broadcastCmp to apply the op to each pair. Throws on
// cross-kind compares (Bool vs Quantity, String vs Bool, etc.) so
// obvious bugs surface immediately.
function cmpScalar(op, l, r) {
  if (op === '==' || op === '!=') {
    if (typeof l === 'boolean' || typeof r === 'boolean') {
      if (typeof l !== typeof r) {
        throw new Error(`${op}: cannot compare Bool with non-Bool`);
      }
      return op === '==' ? l === r : l !== r;
    }
    if (typeof l === 'string' || typeof r === 'string') {
      if (typeof l !== typeof r) {
        throw new Error(`${op}: cannot compare String with non-String`);
      }
      return op === '==' ? l === r : l !== r;
    }
    // Quantity-vs-Quantity
    if (!dimEq(l.dim, r.dim)) {
      throw new Error(`${op}: dim mismatch [${JSON.stringify(l.dim)}] vs [${JSON.stringify(r.dim)}]`);
    }
    return op === '==' ? l.value === r.value : l.value !== r.value;
  }
  // Ordering ops: Quantity only.
  if (typeof l === 'boolean' || typeof r === 'boolean') {
    throw new Error(`${op}: ordering not defined on booleans`);
  }
  if (typeof l === 'string' || typeof r === 'string') {
    throw new Error(`${op}: ordering only defined on Quantities`);
  }
  if (!dimEq(l.dim, r.dim)) {
    throw new Error(`${op}: dim mismatch [${JSON.stringify(l.dim)}] vs [${JSON.stringify(r.dim)}]`);
  }
  switch (op) {
    case '<':  return l.value <  r.value;
    case '<=': return l.value <= r.value;
    case '>':  return l.value >  r.value;
    case '>=': return l.value >= r.value;
  }
}

// Element-wise comparison broadcasting. Called when at least one of the
// operands is an Array. Result is a List<Bool>. Matches numpy-style
// rules: Array/Array of equal length zip; Array/Scalar broadcasts the
// scalar against every element. Cross-length Array/Array throws to
// catch bugs early.
//
// Note: evalCmp keeps list-vs-list ==/!= on the STRUCTURAL path
// (returns Bool) so upstream Numbat's `is_empty<A>(xs) = xs == []`
// pattern stays semantically correct. This helper is reached for
// every OTHER list-involving case (ordering ops, list-vs-scalar
// ==/!=, etc.).
function broadcastCmp(op, l, r) {
  if (Array.isArray(l) && Array.isArray(r)) {
    if (l.length !== r.length) {
      throw new Error(`${op}: list length mismatch (${l.length} vs ${r.length})`);
    }
    return l.map((x, i) => cmpScalar(op, x, r[i]));
  }
  if (Array.isArray(l)) return l.map(x => cmpScalar(op, x, r));
  return r.map(x => cmpScalar(op, l, x));
}

// Element-wise && / || over List<Bool> operands. Called when at least
// one side of a logical op is an Array. Mirrors broadcastCmp shape:
// list/list same length zips, list/scalar broadcasts scalar across the
// list. Operands must all be Bools — surfaces a clear error if a List<Number>
// accidentally lands in a mask combinator.
function broadcastLogic(op, l, r) {
  const apply = (a, b) => {
    if (typeof a !== 'boolean' || typeof b !== 'boolean') {
      throw new Error(`${op}: list element must be Bool`);
    }
    return op === '&&' ? (a && b) : (a || b);
  };
  if (Array.isArray(l) && Array.isArray(r)) {
    if (l.length !== r.length) {
      throw new Error(`${op}: list length mismatch (${l.length} vs ${r.length})`);
    }
    return l.map((x, i) => apply(x, r[i]));
  }
  if (Array.isArray(l)) return l.map(x => apply(x, r));
  return r.map(x => apply(l, x));
}

// Comparison dispatch:
//
//   ==/!= list-vs-list  → STRUCTURAL (returns Bool). Preserved so the
//                          `xs == []` is_empty pattern used throughout
//                          upstream Numbat keeps working.
//   ==/!= list-vs-scalar → BROADCAST (List<Bool>). Each element is
//                          compared against the scalar.
//   <,<=,>,>= any list  → BROADCAST. No prior semantics, so this is
//                          the natural fit for mask construction.
//   scalar/scalar       → existing cmpScalar.
function evalCmp(node, env) {
  const l = evalValueExpr(node.left, env);
  const r = evalValueExpr(node.right, env);
  const op = node.op;
  const lArr = Array.isArray(l);
  const rArr = Array.isArray(r);
  if (lArr || rArr) {
    if ((op === '==' || op === '!=') && lArr && rArr) {
      const eq = valueEq(l, r);
      return op === '==' ? eq : !eq;
    }
    return broadcastCmp(op, l, r);
  }
  return cmpScalar(op, l, r);
}

// ── generic-fn machinery (v0.4) ──────────────────────────────────
//
// Numbat's dimension generics treat dimensions as a free abelian group.
// `fn sqrt<T: Dim>(q: T^2) -> T = q^(1/2)` types as: "for any dimension T,
// taking a Quantity with dim T^2 produces a Quantity with dim T." At a call
// site, we *unify* the parameter's symbolic pattern with the concrete arg dim
// to solve for T.
//
// A "symbolic dim vector" is a plain object whose keys are either base-axis
// names (lowercase by convention — length, mass, time, ...) or generic
// parameter names (whatever the user declared — typically uppercase: T, U).
// The genericNames set tells us which keys to treat as variables.

// Evaluate a type expression with generics in scope. Returns a symbolic dim
// vector where generic-named keys carry their exponent.
function evalSymDim(node, env, genericNames) {
  if (node.type === 'Num') {
    if (node.value !== 1) throw new Error(`dimension expression: numbers other than 1 not allowed`);
    return {};
  }
  if (node.type === 'Ident') {
    if (genericNames.has(node.name)) {
      return { [node.name]: 1 };
    }
    if (!env.dims.has(node.name)) throw new Error(`unknown dimension: ${node.name}`);
    return env.dims.resolve(node.name);
  }
  if (node.type === 'Paren') return evalSymDim(node.expr, env, genericNames);
  if (node.type === 'TypeApp') {
    // List<D>: dim is the elem's dim. Other constructors are opaque to
    // the symbolic dim solver.
    if (node.base.type === 'Ident' && node.base.name === 'List' && node.args.length === 1) {
      return evalSymDim(node.args[0], env, genericNames);
    }
    throw new Error(`type application ${node.base.name ?? '?'}<...> not allowed in type expression`);
  }
  if (node.type === 'FnTypeAnno') {
    throw new Error(`Fn[...] not allowed in type expression`);
  }
  if (node.type === 'Binary') {
    if (node.op === '^') {
      const base = evalSymDim(node.left, env, genericNames);
      if (node.right.type !== 'Num') throw new Error('dimension exponent must be a number literal');
      return dimPow(base, node.right.value);
    }
    const l = evalSymDim(node.left, env, genericNames);
    const r = evalSymDim(node.right, env, genericNames);
    if (node.op === '*') return dimMul(l, r);
    if (node.op === '/') return dimDiv(l, r);
    throw new Error(`operator '${node.op}' not allowed in type expression`);
  }
  throw new Error(`unexpected node ${node.type} in type expression`);
}

// Unify a symbolic pattern against a concrete dim, solving for generic vars.
// Returns substitutions { genericName: dimVec }. Throws on no-solution.
//
// v0.4 supports patterns with at most ONE generic variable. Multi-variable
// patterns (T * U where both are unknown) need linear-system solving over Z
// and are deferred to a later version.
function unifyOne(pattern, target, genericNames) {
  const concrete = {};
  const variable = {};
  for (const [k, e] of Object.entries(pattern)) {
    if (genericNames.has(k)) variable[k] = e;
    else                     concrete[k] = e;
  }
  // residual = target / concrete  ← what variables must produce
  const residual = dimDiv(target, concrete);
  const varNames = Object.keys(variable);

  if (varNames.length === 0) {
    if (Object.keys(residual).length > 0) {
      throw new Error(`unification failed: argument dim has extra axes ${JSON.stringify(residual)}`);
    }
    return {};
  }
  if (varNames.length === 1) {
    const T = varNames[0];
    const n = variable[T];
    const subT = {};
    for (const [k, e] of Object.entries(residual)) {
      if (e % n !== 0) {
        throw new Error(`unification failed: ${T}^${n} = ... — axis ${k} exponent ${e} not divisible by ${n}`);
      }
      subT[k] = e / n;
    }
    return { [T]: subT };
  }
  throw new Error(`unification: multi-variable patterns not supported (vars: ${varNames.join(', ')})`);
}

// Walk parameters, unify each annotated param's pattern with its concrete arg,
// merge inferences. Params whose type isn't a dim (List<A>, String, Bool)
// can't contribute, so we skip them rather than fail — the fn might still work
// if its body doesn't dim-sensitively reference the unsolved generic. Same
// for Bool/String/List arg values, which carry no dim info.
function solveGenerics(generics, params, argVals, env) {
  const genericNames = new Set(generics.map(g => g.name));
  const subs = {};
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (!p.typeExpr) continue;
    const arg = argVals[i];
    // Only Quantity args carry dim info usable for generic inference. Skip
    // booleans, strings, lists, structs.
    if (!(arg instanceof Quantity)) continue;
    let pattern;
    try { pattern = evalSymDim(p.typeExpr, env, genericNames); }
    catch { continue; }   // param type isn't a dimension — skip
    const newSubs = unifyOne(pattern, arg.dim, genericNames);
    for (const [T, sub] of Object.entries(newSubs)) {
      if (subs[T] && !dimEq(subs[T], sub)) {
        throw new Error(`generic ${T} inferred inconsistently: ${JSON.stringify(subs[T])} vs ${JSON.stringify(sub)}`);
      }
      subs[T] = sub;
    }
  }
  // Unresolved generics stay out of `subs`; the return-type check handles that
  // (it falls back to skipping when substitution doesn't resolve to a real dim).
  return subs;
}

// Substitute generic vars in a symbolic dim, producing a concrete dim.
function substituteVars(symVec, subs) {
  let result = {};
  for (const [k, exp] of Object.entries(symVec)) {
    if (subs[k]) {
      result = dimMul(result, dimPow(subs[k], exp));
    } else {
      result = dimMul(result, { [k]: exp });
    }
  }
  return result;
}

// Invoke a user-defined fn with already-evaluated argument values. Shared by
// evalCall (the AST path) and the `->` function-application form.
function invokeUserFn(userFn, name, argVals, env) {
  if (argVals.length !== userFn.params.length) {
    throw new Error(`${name}: expected ${userFn.params.length} args, got ${argVals.length}`);
  }
  if (userFn.body === null) {
    const proc = BUILTIN_PROCS[name];
    if (proc) return proc(argVals);
    const builtin = BUILTIN_FNS[name];
    if (builtin && argVals.length === 1) return builtin(argVals[0]);
    throw new Error(`extern fn ${name}: no built-in implementation provided by host`);
  }
  // Lexical scope: parameters layered on top of the outer scope's let-bindings.
  const fnValues = new Map(env.values);
  for (let i = 0; i < userFn.params.length; i++) {
    fnValues.set(userFn.params[i].name, argVals[i]);
  }
  const buildFnEnv = () => {
    const fnEnv = { ...env, values: fnValues };
    fnEnv.lookupValue = (n) => {
      if (fnValues.has(n)) return fnValues.get(n);
      if (env.fns.has(n)) {
        const f = env.fns.get(n);
        return (...a) => invokeUserFn(f, n, a, env);
      }
      if (BUILTIN_FNS[n])   return (q) => BUILTIN_FNS[n](q);
      if (BUILTIN_PROCS[n]) return (...a) => BUILTIN_PROCS[n](a);
      const u = env.units.resolve(n);
      if (u) return new Quantity(u.mul, u.dim);
      return null;
    };
    return fnEnv;
  };
  if (userFn.whereClauses) {
    for (const clause of userFn.whereClauses) {
      const v = evalValueExpr(clause.expr, buildFnEnv());
      fnValues.set(clause.name, v);
    }
  }
  let subs = null;
  if (userFn.generics && userFn.generics.length > 0) {
    subs = solveGenerics(userFn.generics, userFn.params, argVals, env);
  }
  const result = evalValueExpr(userFn.body, buildFnEnv());
  if (userFn.returnType && result instanceof Quantity) {
    let expected;
    try {
      if (subs) {
        const genericNames = new Set(userFn.generics.map(g => g.name));
        const symRet = evalSymDim(userFn.returnType, env, genericNames);
        expected = substituteVars(symRet, subs);
        if (Object.keys(expected).some(k => genericNames.has(k))) return result;
      } else {
        expected = evalDimExpr(userFn.returnType, env);
      }
    } catch {
      return result;
    }
    if (!dimEq(expected, result.dim)) {
      throw new Error(`${name}: return type mismatch (annotated [${JSON.stringify(expected)}] vs result [${JSON.stringify(result.dim)}])`);
    }
  }
  return result;
}

// Evaluate a function call. Dispatch order: user-defined fns by name → local
// scope (params holding fn values, for higher-order calls) → builtins.
function evalCall(node, env) {
  const userFn = env.fns?.get(node.name);
  if (userFn) {
    const argVals = node.args.map(a => evalValueExpr(a, env));
    return invokeUserFn(userFn, node.name, argVals, env);
  }
  // Higher-order: the callee may be a fn value bound to a local name
  // (e.g. `foldl(_add, ...)` where `_add` is a fn passed as the `f` param,
  // then called inside foldl's body as `f(acc, x)`).
  if (env.values.has(node.name)) {
    const v = env.values.get(node.name);
    if (typeof v === 'function') {
      const argVals = node.args.map(a => evalValueExpr(a, env));
      return v(...argVals);
    }
  }
  const argVals = node.args.map(a => evalValueExpr(a, env));
  const proc = BUILTIN_PROCS[node.name];
  if (proc) return proc(argVals);
  const builtin = BUILTIN_FNS[node.name];
  if (builtin) {
    if (argVals.length !== 1) {
      throw new Error(`${node.name}: built-in takes 1 argument, got ${argVals.length}`);
    }
    // Array broadcasting: sin([1,2,3]) → [sin(1), sin(2), sin(3)].
    // ep-flavored extension; the typecheck side doesn't carry the
    // List<T>→List<T> signature so ep suppresses tc errors on rows
    // whose runtime result is a list.
    if (Array.isArray(argVals[0])) {
      return argVals[0].map(v => builtin(v));
    }
    return builtin(argVals[0]);
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
          // Upstream modifiers:
          //   short:  prefixable short form (e.g. `m: short`)
          //   long:   long-form alternate name; not prefixed
          //   none:   no auto-pluralization; treat as long-form for our purposes
          //   both:   serves as BOTH long alias AND short (prefixable) form
          //   (none): default = long
          if (arg.modifier === 'short') {
            info.shortAliases.push(arg.name);
          } else if (arg.modifier === 'both' || arg.modifier === 'any') {
            info.aliases.push(arg.name);
            info.shortAliases.push(arg.name);
          } else {
            info.aliases.push(arg.name);
          }
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

function loadModule(ast, env, opts = {}) {
  // Opt-in static typecheck pass. When enabled, runs check → solve before
  // evaluation. Mismatches become exceptions (with span info) so the
  // caller surfaces them at parse time instead of at first-execution-of-
  // the-bad-branch. Off by default — pre-existing callers see no change.
  if (opts.typecheck) {
    const { errors } = typecheckModule(ast, env);
    if (errors.length) {
      // Surface the first error; full list is available via typecheckModule().
      const e0 = errors[0];
      const loc = e0.span ? ` at line ${e0.span.line}:${e0.span.col}` : '';
      throw new Error(`typecheck${loc}: ${e0.message}`);
    }
  }
  for (const decl of ast.decls) {
    try {
      switch (decl.type) {
        case 'UseStmt':       env.resolveUse(decl.path); break;
        case 'DimensionDecl': loadDimensionDecl(decl, env); break;
        case 'UnitDecl':      loadUnitDecl(decl, env); break;
        case 'LetDecl':       loadLetDecl(decl, env); break;
        case 'FnDecl':        loadFnDecl(decl, env); break;
        case 'StructDecl':    loadStructDecl(decl, env); break;
        default:
          throw new Error(`unsupported declaration: ${decl.type}`);
      }
    } catch (e) {
      const where = `${ast.source ?? '<module>'}: ${decl.name ?? decl.type}`;
      throw new Error(`${where}: ${e.message}`);
    }
  }
}

function loadStructDecl(decl, env) {
  env.structs.set(decl.name, {
    name: decl.name,
    generics: decl.generics,
    fields: decl.fields.map(f => ({ name: f.name, type: f.type })),
  });
}

function loadFnDecl(decl, env) {
  if (!env.fns) env.fns = new Map();
  // Store the AST + parameter info for later invocation. No type-check yet —
  // dimension annotations on params and return type are verified at call time.
  env.fns.set(decl.name, {
    generics: decl.generics ?? [],
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
      // `unit thing` with no annotation — upstream numbat auto-creates
      // a fresh base dimension named after the unit, capitalized
      // (`unit thing` → dimension `Thing`). Lets users prototype new
      // domains without two-line boilerplate.
      const dimName = decl.name.charAt(0).toUpperCase() + decl.name.slice(1);
      if (!env.dims.has(dimName)) env.dims.defineBase(dimName);
      dim = env.dims.resolve(dimName);
      mul = 1;
    } else {
      dim = evalDimExpr(decl.dim, env);
      mul = 1;
    }
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
  // Dim check only when both annotation parses as a known dim AND the value
  // is a Quantity. Non-Quantity values (List/Bool/String/fn) skip — proper
  // typecheck for those is future work.
  if (decl.dim !== null && q instanceof Quantity) {
    let expected;
    try { expected = evalDimExpr(decl.dim, env); }
    catch { expected = null; }  // annotation isn't a dim — skip check
    if (expected !== null && !dimEq(expected, q.dim)) {
      throw new Error(`let '${decl.name}': annotated dimension does not match value expression`);
    }
  }
  env.values.set(decl.name, q);
  // Apply @aliases — extra names binding to the same value. Upstream uses this
  // for things like `let speed_of_light @aliases(c)`, `@aliases(µ0, μ0, mu0)`.
  const meta = decoratorInfo(decl.decorators);
  for (const alias of meta.aliases) {
    if (!env.values.has(alias)) env.values.set(alias, q);
  }
  for (const sa of meta.shortAliases) {
    if (!env.values.has(sa)) env.values.set(sa, q);
  }
}

// ── convenience: tokenize + parse + load in one call ─────────────

function loadSource(text, sourceName, env, opts = {}) {
  const tokens = tokenize(text, sourceName);
  const ast = parse(tokens, sourceName);
  loadModule(ast, env, opts);
}

// Build the env object used by the loader. Hosts that want to use the
// loader directly (without going through the Numbat class) call this.
function makeEnv({ dims, units, values, fns, structs, resolveUse }) {
  const env = {
    dims,
    units,
    values,
    fns:     fns     ?? new Map(),
    structs: structs ?? new Map(),
    resolveUse: resolveUse ?? (() => {}),
  };
  // Identifier lookup with first-class fn support. Order: let bindings > user
  // fns (wrapped as JS callables for higher-order use) > builtins > units.
  env.lookupValue = (name) => {
    if (values.has(name)) return values.get(name);
    if (env.fns.has(name)) {
      const userFn = env.fns.get(name);
      return (...args) => invokeUserFn(userFn, name, args, env);
    }
    if (BUILTIN_FNS[name])   return (q) => BUILTIN_FNS[name](q);
    if (BUILTIN_PROCS[name]) return (...args) => BUILTIN_PROCS[name](args);
    const u = units.resolve(name);
    if (u) return new Quantity(u.mul, u.dim);
    return null;
  };
  return env;
}

// ─── vendored.js ───────────────────────────────────────
// AUTO-GENERATED by ext/numbat/build.js — do not edit by hand.
// Source: ext/numbat/vendor/numbat/modules/*.nbt
// Regenerate by running `node ext/numbat/build.js`.

const VENDORED_MODULES = {
  "all": "use prelude\r\n\r\nuse units::currencies\r\nuse units::stoney\r\nuse units::hartree\r\n\r\nuse extra::algebra\r\nuse extra::color\r\nuse extra::astronomy\r\nuse extra::celestial\r\nuse extra::cooking\r\nuse extra::vector3\r\n\r\nuse numerics::diff\r\nuse numerics::solve\r\nuse numerics::fixed_point\r\n",
  "chemistry::elements": "use units::si\r\n\r\nstruct _ChemicalElementRaw {\r\n    symbol: String,\r\n    name: String,\r\n    atomic_number: Scalar,\r\n    atomic_weight: Scalar,\r\n    group: Scalar,\r\n    group_name: String,\r\n    period: Scalar,\r\n    melting_point_kelvin: Scalar,\r\n    boiling_point_kelvin: Scalar,\r\n    density_gram_per_cm3: Scalar,\r\n    electron_affinity_electronvolt: Scalar,\r\n    ionization_energy_electronvolt: Scalar,\r\n    vaporization_heat_kilojoule_per_mole: Scalar,\r\n}\r\n\r\nfn _get_chemical_element_data_raw(pattern: String) -> _ChemicalElementRaw\r\n\r\nstruct ChemicalElement {\r\n    symbol: String,\r\n    name: String,\r\n    atomic_number: Scalar,\r\n    atomic_weight: Mass,\r\n    group: Scalar,\r\n    group_name: String,\r\n    period: Scalar,\r\n    melting_point: Temperature,\r\n    boiling_point: Temperature,\r\n    density: MassDensity,\r\n    electron_affinity: Energy,\r\n    ionization_energy: Energy,\r\n    vaporization_heat: MolarEnthalpyOfVaporization,\r\n}\r\n\r\nfn _convert_from_raw(raw: _ChemicalElementRaw) -> ChemicalElement =\r\n    ChemicalElement {\r\n        symbol: raw.symbol,\r\n        name: raw.name,\r\n        atomic_number: raw.atomic_number,\r\n        atomic_weight: raw.atomic_weight * Da,\r\n        group: raw.group,\r\n        group_name: raw.group_name,\r\n        period: raw.period,\r\n        melting_point: raw.melting_point_kelvin * K,\r\n        boiling_point: raw.boiling_point_kelvin * K,\r\n        density: raw.density_gram_per_cm3 * g/cm³,\r\n        electron_affinity: raw.electron_affinity_electronvolt * eV,\r\n        ionization_energy: raw.ionization_energy_electronvolt * eV,\r\n        vaporization_heat: raw.vaporization_heat_kilojoule_per_mole * kJ/mol,\r\n    }\r\n\r\n@name(\"Chemical element\")\r\n@description(\"Get properties of a chemical element by its symbol or name (case-insensitive).\")\r\n@example(\"element(\\\"H\\\")\", \"Get the entire element struct for hydrogen.\")\r\n@example(\"element(\\\"hydrogen\\\").ionization_energy\", \"Get the ionization energy of hydrogen.\")\r\nfn element(pattern: String) -> ChemicalElement =\r\n    _convert_from_raw(_get_chemical_element_data_raw(pattern))\r\n",
  "core::debug": "use core::scalar\r\n\r\n@description(\"Print the value (and type) of the argument and return it. Useful for debugging.\")\r\n@example(\"inspect(36 km / 1.5 hours) * 1 day\")\r\n@example(\"range(1, 3) |> map(sqr) |> map(inspect) |> sum\")\r\nfn inspect<T>(x: T) -> T\r\n",
  "core::dimensions": "### Physical dimensions\r\n\r\ndimension Angle = 1  # SI: plane angle\r\ndimension SolidAngle = Angle^2\r\n\r\ndimension Length\r\ndimension Area = Length^2\r\ndimension Volume = Length^3\r\ndimension Wavenumber = 1 / Length\r\n\r\ndimension Time\r\ndimension Frequency = 1 / Time\r\ndimension Velocity = Length / Time\r\ndimension Acceleration = Length / Time^2\r\ndimension Jerk = Length / Time^3\r\ndimension FlowRate = Volume / Time\r\n\r\ndimension Mass\r\ndimension Momentum = Mass × Velocity\r\ndimension Force = Mass × Acceleration = Momentum / Time\r\ndimension Energy = Momentum^2 / Mass = Mass × Velocity^2 = Force × Length  # also: work, amount of heat\r\ndimension Power = Energy / Time = Force × Velocity\r\ndimension Pressure = Force / Area = Energy / Volume  # also: stress\r\ndimension Action = Energy × Time\r\ndimension MassDensity = Mass / Length^3\r\ndimension MomentOfInertia = Mass × Length^2 / Angle^2\r\ndimension AngularMomentum = MomentOfInertia × Angle / Time = Mass × Length^2 / Time / Angle\r\ndimension Torque = Length × Force / Angle  # also: moment of force\r\ndimension EnergyDensity = Energy / Volume\r\ndimension MassFlow = Mass / Time\r\n\r\ndimension Current\r\ndimension ElectricCharge = Current × Time\r\ndimension Voltage = Energy / ElectricCharge = Power / Current  # ISQ: electric tension, SI: electric potential difference\r\ndimension Capacitance = ElectricCharge / Voltage\r\ndimension ElectricResistance = Voltage / Current\r\ndimension Resistivity = ElectricResistance × Length\r\ndimension ElectricConductance = 1 / ElectricResistance\r\ndimension Conductivity = ElectricConductance / Length\r\ndimension MagneticFluxDensity = Force / (ElectricCharge × Velocity)\r\ndimension MagneticFlux = MagneticFluxDensity × Area = Voltage × Time\r\ndimension MagneticFieldStrength = Current / Length\r\ndimension Inductance = MagneticFlux / Current\r\ndimension ElectricChargeDensity = ElectricCharge / Volume\r\ndimension CurrentDensity = Current / Area\r\ndimension ElectricDipoleMoment = ElectricCharge × Length\r\ndimension ElectricQuadrupoleMoment = ElectricCharge × Length^2\r\ndimension MagneticDipoleMoment = Current × Area = Torque / MagneticFluxDensity\r\ndimension ElectricFieldStrength = Voltage / Length\r\ndimension ElectricDisplacementFieldStrength = ElectricCharge / Area\r\ndimension ElectricPermittivity = Time^4 × Current^2 / Mass / Length^3 × Angle = ElectricDisplacementFieldStrength / ElectricFieldStrength × Angle\r\ndimension MagneticPermeability = Length × Mass / Time^2 / Current^2 / Angle = MagneticFluxDensity / MagneticFieldStrength / Angle\r\ndimension Polarizability = ElectricDipoleMoment / ElectricFieldStrength = Current^2 × Time^4 / Mass\r\ndimension ElectricMobility = Velocity / ElectricFieldStrength\r\n\r\ndimension Temperature\r\ndimension Entropy = Energy / Temperature\r\ndimension HeatCapacity = Energy / Temperature\r\ndimension SpecificHeatCapacity = HeatCapacity / Mass\r\ndimension ThermalConductivity = Power / (Length × Temperature)\r\ndimension ThermalTransmittance = Power / (Length^2 × Temperature)\r\n\r\ndimension AmountOfSubstance\r\ndimension MolarMass = Mass / AmountOfSubstance\r\ndimension MolarVolume = Volume / AmountOfSubstance\r\ndimension CatalyticActivity = AmountOfSubstance / Time\r\ndimension Molarity = AmountOfSubstance / Volume\r\ndimension Molality = AmountOfSubstance / Mass\r\ndimension ChemicalPotential = Energy / AmountOfSubstance\r\ndimension MolarEnthalpyOfVaporization = Energy / AmountOfSubstance\r\ndimension MolarHeatCapacity = HeatCapacity / AmountOfSubstance\r\n\r\ndimension LuminousIntensity\r\ndimension LuminousFlux = LuminousIntensity × Angle^2\r\ndimension Illuminance = LuminousFlux / Area\r\ndimension Luminance = LuminousIntensity / Area\r\ndimension Irradiance = Power / Area\r\n\r\ndimension Activity = 1 / Time\r\ndimension AbsorbedDose = Energy / Mass\r\ndimension EquivalentDose = Energy / Mass  # also: dose equivalent\r\ndimension SpecificActivity = Activity / Mass\r\n\r\ndimension DynamicViscosity = Pressure × Time\r\ndimension KinematicViscosity = Length^2 / Time\r\n",
  "core::error": "use core::scalar\r\n\r\n@description(\"Throw an error with the specified message. Stops the execution of the program.\")\r\nfn error<T>(message: String) -> T\r\n",
  "core::functions": "use core::scalar\r\n\r\n@name(\"Identity function\")\r\n@description(\"Return the input value.\")\r\n@example(\"id(8 kg)\")\r\nfn id<A>(x: A) -> A = x\r\n\r\n@name(\"Absolute value\")\r\n@description(\"Return the absolute value $|x|$ of the input. This works for quantities, too: `abs(-5 m) = 5 m`.\")\r\n@url(\"https://doc.rust-lang.org/std/primitive.f64.html#method.abs\")\r\n@example(\"abs(-22.2 m)\")\r\nfn abs<T: Dim>(x: T) -> T\r\n\r\n@name(\"Square root\")\r\n@description(\"Return the square root $\\\\sqrt{{x}}$ of the input: `sqrt(121 m^2) = 11 m`.\")\r\n@url(\"https://en.wikipedia.org/wiki/Square_root\")\r\n@example(\"sqrt(4 are) -> m\")\r\nfn sqrt<D: Dim>(x: D^2) -> D = x^(1/2)\r\n\r\n@name(\"Cube root\")\r\n@description(\"Return the cube root $\\\\sqrt[3]{{x}}$ of the input: `cbrt(8 m^3) = 2 m`.\")\r\n@url(\"https://en.wikipedia.org/wiki/Cube_root\")\r\n@example(\"cbrt(8 L) -> cm\")\r\nfn cbrt<D: Dim>(x: D^3) -> D = if x > 0 then x^(1/3) else - (-x)^(1/3)\r\n\r\n@name(\"Square function\")\r\n@description(\"Return the square of the input, $x^2$: `sqr(5 m) = 25 m^2`.\")\r\n@example(\"sqr(7)\")\r\nfn sqr<D: Dim>(x: D) -> D^2 = x^2\r\n\r\n@name(\"Rounding\")\r\n@description(\"Round to the nearest integer. If the value is half-way between two integers, round away from $0$. See also: `round_in`.\")\r\n@url(\"https://doc.rust-lang.org/std/primitive.f64.html#method.round\")\r\n@example(\"round(5.5)\")\r\n@example(\"round(-5.5)\")\r\nfn round(x: Scalar) -> Scalar\r\n\r\n@name(\"Rounding\")\r\n@description(\"Round to the nearest multiple of `base`.\")\r\n@example(\"round_in(m, 5.3 m)\", \"Round in meters.\")\r\n@example(\"round_in(cm, 5.3 m)\", \"Round in centimeters.\")\r\nfn round_in<D: Dim>(base: D, value: D) -> D = round(value / base) × base\r\n\r\n@name(\"Floor function\")\r\n@description(\"Returns the largest integer less than or equal to $x$. See also: `floor_in`.\")\r\n@url(\"https://doc.rust-lang.org/std/primitive.f64.html#method.floor\")\r\n@example(\"floor(5.5)\")\r\nfn floor(x: Scalar) -> Scalar\r\n\r\n@name(\"Floor function\")\r\n@description(\"Returns the largest integer multiple of `base` less than or equal to `value`.\")\r\n@example(\"floor_in(m, 5.7 m)\", \"Floor in meters.\")\r\n@example(\"floor_in(cm, 5.7 m)\", \"Floor in centimeters.\")\r\nfn floor_in<D: Dim>(base: D, value: D) -> D = floor(value / base) × base\r\n\r\n@name(\"Ceil function\")\r\n@description(\"Returns the smallest integer greater than or equal to $x$. See also: `ceil_in`.\")\r\n@url(\"https://doc.rust-lang.org/std/primitive.f64.html#method.ceil\")\r\n@example(\"ceil(5.5)\")\r\nfn ceil(x: Scalar) -> Scalar\r\n\r\n@name(\"Ceil function\")\r\n@description(\"Returns the smallest integer multiple of `base` greater than or equal to `value`.\")\r\n@example(\"ceil_in(m, 5.3 m)\", \"Ceil in meters.\")\r\n@example(\"ceil_in(cm, 5.3 m)\", \"Ceil in centimeters.\")\r\n\r\nfn ceil_in<D: Dim>(base: D, value: D) -> D = ceil(value / base) × base\r\n\r\n@name(\"Truncation\")\r\n@description(\"Returns the integer part of $x$. Non-integer numbers are always truncated towards zero. See also: `trunc_in`.\")\r\n@url(\"https://doc.rust-lang.org/std/primitive.f64.html#method.trunc\")\r\n@example(\"trunc(5.5)\")\r\n@example(\"trunc(-5.5)\")\r\nfn trunc(x: Scalar) -> Scalar\r\n\r\n@name(\"Truncation\")\r\n@description(\"Truncates to an integer multiple of `base` (towards zero).\")\r\n@example(\"trunc_in(m, 5.7 m)\", \"Truncate in meters.\")\r\n@example(\"trunc_in(cm, 5.7 m)\", \"Truncate in centimeters.\")\r\nfn trunc_in<D: Dim>(base: D, value: D) -> D = trunc(value / base) × base\r\n\r\n@name(\"Fractional part\")\r\n@description(\"Returns the fractional part of $x$, i.e. the remainder when divided by 1.\r\n  If $x < 0$, then so will be `fract(x)`. Note that due to floating point error, a\r\n  number’s fractional part can be slightly “off”; for instance, `fract(1.2) ==\r\n  0.1999...996 != 0.2`.\")\r\n@url(\"https://doc.rust-lang.org/std/primitive.f64.html#method.fract\")\r\n@example(\"fract(0.0)\")\r\n@example(\"fract(5.5)\")\r\n@example(\"fract(-5.5)\")\r\nfn fract(x: Scalar) -> Scalar\r\n\r\n@name(\"Modulo\")\r\n@description(\"Calculates the least nonnegative remainder of $a (\\\\mod b)$.\")\r\n@url(\"https://doc.rust-lang.org/std/primitive.f64.html#method.rem_euclid\")\r\n@example(\"mod(27, 5)\")\r\nfn mod<T: Dim>(a: T, b: T) -> T\r\n\r\n@name(\"Parse a string as a quantity\")\r\n@description(\"Parses a string as a quantity. The expected return type (dimension) must be inferable from the surrounding context (see examples).\")\r\n@example(\"let t: Time = parse(\\\"120 s\\\")\")\r\n@example(\"let length: Length = parse(\\\"1 km\\\")\")\r\n@example(\"let mass: Mass = parse(\\\"9.10938e-31 kg\\\")\")\r\n@example(\"let n: Scalar = parse(\\\"-100_000\\\")\")\r\n@example(\"parse(\\\"0xFF\\\") -> bin\")\r\nfn parse<T: Dim>(input: String) -> T\r\n\r\n@name(\"Command-line arguments\")\r\n@description(\"Returns the command-line arguments passed to the script. The first argument is the name of the script itself.\")\r\n@example(\"let xs = tail(args())\", \"Get a list of all arguments except the script name.\")\r\nfn args() -> List<String>\r\n",
  "core::lists": "use core::scalar\r\nuse core::error\r\nuse core::strings\r\n\r\n@description(\"Get the length of a list\")\r\n@example(\"len([3, 2, 1])\")\r\nfn len<A>(xs: List<A>) -> Scalar\r\n\r\n@description(\"Get the first element of a list. Yields a runtime error if the list is empty.\")\r\n@example(\"head([3, 2, 1])\")\r\nfn head<A>(xs: List<A>) -> A\r\n\r\n@description(\"Get everything but the first element of a list. Yields a runtime error if the list is empty.\")\r\n@example(\"tail([3, 2, 1])\")\r\nfn tail<A>(xs: List<A>) -> List<A>\r\n\r\n@description(\"Prepend an element to a list\")\r\n@example(\"cons(77, [3, 2, 1])\")\r\nfn cons<A>(x: A, xs: List<A>) -> List<A>\r\n\r\n@description(\"Append an element to the end of a list\")\r\n@example(\"cons_end(77, [3, 2, 1])\")\r\nfn cons_end<A>(x: A, xs: List<A>) -> List<A>\r\n\r\n@description(\"Check if a list is empty\")\r\n@example(\"is_empty([3, 2, 1])\")\r\n@example(\"is_empty([])\")\r\nfn is_empty<A>(xs: List<A>) -> Bool = xs == []\r\n\r\n@description(\"Concatenate two lists\")\r\n@example(\"concat([3, 2, 1], [10, 11])\")\r\nfn concat<A>(xs1: List<A>, xs2: List<A>) -> List<A> =\r\n  if is_empty(xs1)\r\n    then xs2\r\n    else cons(head(xs1), concat(tail(xs1), xs2))\r\n\r\n@description(\"Get the first `n` elements of a list\")\r\n@example(\"take(2, [3, 2, 1, 0])\")\r\nfn take<A>(n: Scalar, xs: List<A>) -> List<A> =\r\n  if n == 0 || is_empty(xs)\r\n    then []\r\n    else cons(head(xs), take(n - 1, tail(xs)))\r\n\r\n@description(\"Get everything but the first `n` elements of a list\")\r\n@example(\"drop(2, [3, 2, 1, 0])\")\r\nfn drop<A>(n: Scalar, xs: List<A>) -> List<A> =\r\n  if n == 0 || is_empty(xs)\r\n    then xs\r\n    else drop(n - 1, tail(xs))\r\n\r\n@description(\"Get the element at index `i` in a list\")\r\n@example(\"element_at(2, [3, 2, 1, 0])\")\r\nfn element_at<A>(i: Scalar, xs: List<A>) -> A =\r\n  if i == 0\r\n    then head(xs)\r\n    else element_at(i - 1, tail(xs))\r\n\r\n@description(\"Generate a range of integer numbers from `start` to `end` (inclusive)\")\r\n@example(\"range(2, 12)\")\r\nfn range(start: Scalar, end: Scalar) -> List<Scalar> =\r\n  if start > end\r\n    then []\r\n    else cons(start, range(start + 1, end))\r\n\r\n\r\n@description(\"Reverse the order of a list\")\r\n@example(\"reverse([3, 2, 1])\")\r\nfn reverse<A>(xs: List<A>) -> List<A> =\r\n  if is_empty(xs)\r\n    then []\r\n    else cons_end(head(xs), reverse(tail(xs)))\r\n\r\n@description(\"Generate a new list by applying a function to each element of the input list\")\r\n@example(\"map(sqr, [3, 2, 1])\", \"Square all elements of a list.\")\r\nfn map<A, B>(f: Fn[(A) -> B], xs: List<A>) -> List<B> =\r\n  if is_empty(xs)\r\n    then []\r\n    else cons(f(head(xs)), map(f, tail(xs)))\r\n\r\n@description(\"Generate a new list by applying a function to each element of the input list. This function takes two inputs: a variable, and the element of the list.\")\r\n@example(\"map2(contains, 2, [[0], [2], [1, 2], [0, 2, 3], []])\", \"Returns a list of bools corresponding to whether the sublist contains a 2 or not.\")\r\nfn map2<A, B, C>(f: Fn[(A, B) -> C], other: A, xs: List<B>) -> List<C> =\r\n  if is_empty(xs) \r\n    then []\r\n    else cons(f(other, head(xs)), map2(f, other, tail(xs)))\r\n\r\n\r\n@description(\"Filter a list by a predicate\")\r\n@example(\"filter(is_finite, [0, 1e10, NaN, -inf])\")\r\nfn filter<A>(p: Fn[(A) -> Bool], xs: List<A>) -> List<A> =\r\n  if is_empty(xs)\r\n    then []\r\n    else if p(head(xs))\r\n      then cons(head(xs), filter(p, tail(xs)))\r\n      else filter(p, tail(xs))\r\n\r\n@description(\"Fold a function over a list\")\r\n@example(\"foldl(str_append, \\\"\\\", [\\\"Num\\\", \\\"bat\\\", \\\"!\\\"])\", \"Join a list of strings by folding.\")\r\nfn foldl<A, B>(f: Fn[(A, B) -> A], acc: A, xs: List<B>) -> A =\r\n  if is_empty(xs)\r\n    then acc\r\n    else foldl(f, f(acc, head(xs)), tail(xs))\r\n\r\nfn _merge(xs, ys, cmp) =\r\n  if is_empty(xs)\r\n    then ys\r\n    else if is_empty(ys)\r\n      then xs\r\n      else if cmp(head(xs)) < cmp(head(ys))\r\n        then cons(head(xs), _merge(tail(xs), ys, cmp))\r\n        else cons(head(ys), _merge(xs, tail(ys), cmp))\r\n\r\n\r\n@description(\"Sort a list of elements, using the given key function that maps the element to a quantity\")\r\n@example(\"fn last_digit(x) = mod(x, 10)\\nsort_by_key(last_digit, [701, 313, 9999, 4])\",\"Sort by last digit.\")\r\nfn sort_by_key<A, D: Dim>(key: Fn[(A) -> D], xs: List<A>) -> List<A> =\r\n  if is_empty(xs)\r\n    then []\r\n    else if len(xs) == 1\r\n      then xs\r\n      else _merge(sort_by_key(key, take(floor(len(xs) / 2), xs)),\r\n                  sort_by_key(key, drop(floor(len(xs) / 2), xs)),\r\n                  key)\r\n\r\n@description(\"Sort a list of quantities in ascending order\")\r\n@example(\"sort([3, 2, 7, 8, -4, 0, -5])\")\r\nfn sort<D: Dim>(xs: List<D>) -> List<D> = sort_by_key(id, xs)\r\n\r\n@description(\"Returns true if the element `x` is in the list `xs`.\")\r\n@example(\"[3, 2, 7, 8, -4, 0, -5] |> contains(0)\")\r\n@example(\"[3, 2, 7, 8, -4, 0, -5] |> contains(1)\")\r\nfn contains<A>(x: A, xs: List<A>) -> Bool = \r\n  if is_empty(xs)\r\n    then false\r\n    else if x == head(xs)\r\n      then true\r\n      else contains(x, tail(xs))\r\n\r\nfn _unique<A>(acc: List<A>, xs: List<A>) -> List<A> = \r\n  if is_empty(xs)\r\n    then acc\r\n    else if is_empty(acc)\r\n      then _unique([head(xs)], tail(xs))\r\n      else if (acc |> contains(head(xs)))\r\n        then _unique(acc, tail(xs))\r\n        else _unique((cons_end(head(xs), acc)), tail(xs))\r\n\r\n@description(\"Remove duplicates from a given list.\")\r\n@example(\"unique([1, 2, 2, 3, 3, 3])\")\r\nfn unique<A>(xs: List<A>) -> List<A> = xs |> _unique([])\r\n\r\n@description(\"Add an element between each pair of elements in a list\")\r\n@example(\"intersperse(0, [1, 1, 1, 1])\")\r\nfn intersperse<A>(sep: A, xs: List<A>) -> List<A> =\r\n  if is_empty(xs)\r\n    then []\r\n    else if is_empty(tail(xs))\r\n      then xs\r\n      else cons(head(xs), cons(sep, intersperse(sep, tail(xs))))\r\n\r\nfn _add(x, y) = x + y # TODO: replace this with a local function once we support them\r\n@description(\"Sum all elements of a list\")\r\n@example(\"sum([3 m, 200 cm, 1000 mm])\")\r\nfn sum<D: Dim>(xs: List<D>) -> D = foldl(_add, 0, xs)\r\n\r\n# TODO: implement linspace using `map` or similar once we have closures. This is ugly.\r\nfn _linspace_helper(start, end, n_steps, i) =\r\n  if i == n_steps\r\n    then []\r\n    else cons(start + (end - start) * i / (n_steps - 1), _linspace_helper(start, end, n_steps, i + 1))\r\n\r\n@description(\"Generate a list of `n_steps` evenly spaced numbers from `start` to `end` (inclusive)\")\r\n@example(\"linspace(-5 m, 5 m, 11)\")\r\nfn linspace<D: Dim>(start: D, end: D, n_steps: Scalar) -> List<D> =\r\n  if n_steps <= 1\r\n    then error(\"Number of steps must be larger than 1\")\r\n    else _linspace_helper(start, end, n_steps, 0)\r\n\r\n@description(\"Convert a list of strings into a single string by concatenating them with a separator\")\r\n@example(\"join([\\\"snake\\\", \\\"case\\\"], \\\"_\\\")\")\r\nfn join(xs: List<String>, sep: String) =\r\n  if is_empty(xs)\r\n    then \"\"\r\n    else if len(xs) == 1\r\n      then head(xs)\r\n      else \"{head(xs)}{sep}{join(tail(xs), sep)}\"\r\n\r\n@description(\"Split a string into a list of strings using a separator\")\r\n@example(\"split(\\\"Numbat is a statically typed programming language.\\\", \\\" \\\")\")\r\nfn split(input: String, separator: String) -> List<String> =\r\n  if input == \"\"\r\n    then []\r\n    else if !str_contains(separator, input)\r\n      then [input]\r\n      else cons(str_slice(0, idx_separator, input),\r\n                split(str_slice(idx_separator + str_length(separator), str_length(input), input), separator))\r\n  where\r\n    idx_separator = str_find(separator, input)\r\n",
  "core::mixed_units": "use core::strings\r\nuse core::lists\r\nuse core::numbers\r\nuse core::quantities\r\n\r\n# Helper functions for mixed-unit conversions. See units::mixed for more.\r\n\r\nfn _zero_length<A: Dim>(val: A) -> A = val * 0 -> val\r\n\r\nfn _mixed_unit_list<D: Dim>(val: D, units: List<D>, acc: List<D>) -> List<D> =\r\n  if val == 0\r\n    then concat(acc, map(_zero_length, units))\r\n    else if len(units) == 1\r\n      then cons_end(val -> head(units), acc)\r\n      else _mixed_unit_list(val - unit_val, tail(units), cons_end(unit_val, acc))\r\n  where unit_val: D =\r\n    if (len(units) > 0)\r\n      then ((val -> head(units)) |> trunc_in(head(units)))\r\n      else error(\"Units list cannot be empty\")\r\n  \r\nfn _negate<D: Dim>(x: D) = -x\r\n\r\nfn _sort_descending<D: Dim>(xs: List<D>) -> List<D> = sort_by_key(_negate, xs)\r\n\r\nfn _clean_units<D: Dim>(units: List<D>) -> List<D> = units |> unique() |> _sort_descending()\r\n\r\nfn _unit_list<D: Dim>(units: List<D>, value: D) -> List<D> = _mixed_unit_list(value, _clean_units(units), [])\r\n",
  "core::numbers": "use core::scalar\r\nuse core::functions\r\n\r\n@description(\"Returns true if the input is `NaN`.\")\r\n@url(\"https://doc.rust-lang.org/std/primitive.f64.html#method.is_nan\")\r\n@example(\"is_nan(37)\")\r\n@example(\"is_nan(NaN)\")\r\nfn is_nan<T: Dim>(n: T) -> Bool\r\n\r\n@description(\"Returns true if the input is positive infinity or negative infinity.\")\r\n@url(\"https://doc.rust-lang.org/std/primitive.f64.html#method.is_infinite\")\r\n@example(\"is_infinite(37)\")\r\n@example(\"is_infinite(-inf)\")\r\nfn is_infinite<T: Dim>(n: T) -> Bool\r\n\r\n@description(\"Returns true if the input is neither infinite nor `NaN`.\")\r\n@example(\"is_finite(37)\")\r\n@example(\"is_finite(-inf)\")\r\nfn is_finite<T: Dim>(n: T) -> Bool = !is_nan(n) && !is_infinite(n)\r\n\r\n@description(\"Returns true if the input is 0 (zero).\")\r\n@example(\"is_zero(37)\")\r\n@example(\"is_zero(0)\")\r\nfn is_zero<D: Dim>(value: D) -> Bool = value == 0\r\n\r\n@description(\"Returns true unless the input is 0 (zero).\")\r\n@example(\"is_nonzero(37)\")\r\n@example(\"is_nonzero(0)\")\r\nfn is_nonzero<D: Dim>(value: D) -> Bool = !is_zero(value)\r\n\r\n@description(\"Returns true if the input is an integer.\")\r\n@example(\"is_integer(3)\")\r\n@example(\"is_integer(pi)\")\r\nfn is_integer(x: Scalar) -> Bool = is_zero(fract(x))\r\n",
  "core::quantities": "use core::scalar\r\nuse core::error\r\n\r\n@description(\"Extract the plain value of a quantity (the `20` in `20 km/h`). This can be useful in generic code, but should generally be avoided otherwise.\")\r\n@example(\"value_of(20 km/h)\")\r\nfn value_of<T: Dim>(x: T) -> Scalar\r\n\r\n@description(\"Extract the unit of a quantity (the `km/h` in `20 km/h`). This can be useful in generic code, but should generally be avoided otherwise. Returns an error if the quantity is zero.\")\r\n@example(\"unit_of(20 km/h)\")\r\nfn unit_of<T: Dim>(x: T) -> T = if x_value == 0 then error(\"Invalid argument: cannot call `unit_of` on a value that evaluates to 0\") else x / value_of(x)\r\n    where x_value = value_of(x)\r\n\r\n@description(\"Extract the base unit of a quantity without prefixes (e.g., `base_unit_of(5 km)` returns `m` instead of `km`). This can be useful for normalizing values. Returns an error if the quantity is zero.\")\r\n@example(\"base_unit_of(5 km)\")\r\n@example(\"5 km / base_unit_of(5 km)\")\r\nfn base_unit_of<T: Dim>(x: T) -> T\r\n\r\n@description(\"Returns true if `quantity` has the same unit as `unit_query`, or if `quantity` evaluates to zero.\")\r\n@example(\"has_unit(20 km/h, km/h)\")\r\n@example(\"has_unit(20 km/h, m/s)\")\r\nfn has_unit<T: Dim>(quantity: T, unit_query: T) -> Bool\r\n\r\n@description(\"Returns true if `quantity` is dimensionless, or if `quantity` is zero.\")\r\n@example(\"is_dimensionless(10)\")\r\n@example(\"is_dimensionless(10 km/h)\")\r\nfn is_dimensionless<T: Dim>(quantity: T) -> Bool\r\n\r\n@description(\"Returns a string representation of the unit of `quantity`. Returns an empty string if `quantity` is dimensionless.\")\r\n@example(\"unit_name(20)\")\r\n@example(\"unit_name(20 m^2)\")\r\n@example(\"unit_name(20 km/h)\")\r\nfn unit_name<T: Dim>(quantity: T) -> String\r\n\r\n# TODO: Once we support explicitly passing arguments to type parameters, we can remove the second argument and\r\n# replace this with `fn quantity_cast<To: Dim, From: Dim>(f: From) -> To` and call it with `quantity_cast::<Length>(…)`.\r\n@description(\"Unsafe function that returns the quantity `from` unmodified with the target dimension `To`. This can be useful in generic code, but should generally be avoided otherwise.\")\r\n@example(\"quantity_cast(1 nm, m)\")\r\nfn quantity_cast<From: Dim, To: Dim>(f: From, t: To) -> To\r\n",
  "core::random": "use core::scalar\r\n\r\n@name(\"Standard uniform distribution sampling\")\r\n@description(\"Uniformly samples the interval $[0,1)$.\")\r\nfn random() -> Scalar\r\n",
  "core::scalar": "dimension Scalar = 1\r\n",
  "core::strings": "use core::scalar\r\nuse core::functions\r\nuse core::error\r\n\r\n@description(\"The length of a string\")\r\n@example(\"str_length(\\\"Numbat\\\")\")\r\nfn str_length(s: String) -> Scalar\r\n\r\n@description(\"Subslice of a string\")\r\n@example(\"str_slice(3, 6, \\\"Numbat\\\")\")\r\nfn str_slice(start: Scalar, end: Scalar, s: String) -> String\r\n\r\n@description(\"Get a single-character string from a Unicode code point.\")\r\n@example(\"0x2764 -> chr\")\r\nfn chr(n: Scalar) -> String\r\n\r\n@description(\"Get the Unicode code point of the first character in a string.\")\r\n@example(\"\\\"❤\\\" -> ord\")\r\nfn ord(s: String) -> Scalar\r\n\r\n@description(\"Convert a string to lowercase\")\r\n@example(\"lowercase(\\\"Numbat\\\")\")\r\nfn lowercase(s: String) -> String\r\n\r\n@description(\"Convert a string to uppercase\")\r\n@example(\"uppercase(\\\"Numbat\\\")\")\r\nfn uppercase(s: String) -> String\r\n\r\n@description(\"Concatenate two strings\")\r\n@example(\"\\\"!\\\" |> str_append(\\\"Numbat\\\")\")\r\n@example(\"str_append(\\\"Numbat\\\", \\\"!\\\")\")\r\nfn str_append(a: String, b: String) -> String = \"{a}{b}\"\r\n\r\n@description(\"Concatenate two strings\")\r\n@example(\"\\\"Numbat\\\" |> str_prepend(\\\"!\\\")\")\r\n@example(\"str_prepend(\\\"!\\\", \\\"Numbat\\\")\")\r\nfn str_prepend(a: String, b: String) -> String = \"{b}{a}\"\r\n\r\nfn _str_find(needle: String, index: Scalar, haystack: String) -> Scalar =\r\n  if len_haystack == 0\r\n    then -1\r\n    else if str_slice(0, str_length(needle), haystack) == needle\r\n      then index\r\n      else _str_find(needle, index + 1, tail_haystack)\r\n  where len_haystack = str_length(haystack)\r\n    and tail_haystack = str_slice(1, len_haystack, haystack)\r\n\r\n@description(\"Find the first occurrence of a substring in a string\")\r\n@example(\"str_find(\\\"typed\\\", \\\"Numbat is a statically typed programming language.\\\")\")\r\nfn str_find(needle: String, haystack: String) -> Scalar = \r\n  _str_find(needle, 0, haystack)\r\n\r\n@description(\"Check if a string contains a substring\")\r\n@example(\"str_contains(\\\"typed\\\", \\\"Numbat is a statically typed programming language.\\\")\")\r\nfn str_contains(needle: String, haystack: String) -> Bool =\r\n  str_find(needle, haystack) != -1\r\n\r\n@description(\"Replace all occurrences of a substring in a string\")\r\n@example(\"str_replace(\\\"statically typed programming language\\\", \\\"scientific calculator\\\", \\\"Numbat is a statically typed programming language.\\\")\")\r\nfn str_replace(pattern: String, replacement: String, s: String) -> String =\r\n  if pattern == \"\"\r\n    then s\r\n    else if str_contains(pattern, s)\r\n      then if str_slice(0, pattern_length, s) == pattern\r\n          then (s |> str_slice(pattern_length, s_length) |> str_replace(pattern, replacement) |> str_append(replacement))\r\n          else (s |> str_slice(             1, s_length) |> str_replace(pattern, replacement) |> str_append(str_slice(0, 1, s)))\r\n      else s\r\n  where s_length = str_length(s)\r\n    and pattern_length = str_length(pattern)\r\n\r\n@description(\"Repeat the input string `n` times\")\r\n@example(\"str_repeat(4, \\\"abc\\\")\")\r\nfn str_repeat(n: Scalar, a: String) -> String =\r\n  if n > 0\r\n    then str_append(a, str_repeat(n - 1, a))\r\n    else \"\"\r\n\r\nfn _bin_digit(x: Scalar) -> String =\r\n  chr(48 + mod(x, 2))\r\n\r\nfn _oct_digit(x: Scalar) -> String =\r\n  chr(48 + mod(x, 8))\r\n\r\nfn _hex_digit(x: Scalar) -> String =\r\n  if x_16 < 10 then chr(48 + x_16) else chr(97 + x_16 - 10)\r\n  where\r\n    x_16 = mod(x, 16)\r\n\r\nfn _digit_in_base(base: Scalar, x: Scalar) -> String =\r\n  if base < 2 || base > 16\r\n    then error(\"base must be between 2 and 16\")\r\n    else if x_16 < 10 then chr(48 + x_16) else chr(97 + x_16 - 10)\r\n  where\r\n    x_16 = mod(x, 16)\r\n\r\n# TODO: once we have anonymous functions / closures, we can implement base in a way\r\n# that it returns a partially-applied version of '_number_in_base'. This would allow\r\n# arbitrary 'x -> base(b)' conversions.\r\n@description(\"Convert a number to the given base.\")\r\n@example(\"42 |> base(16)\")\r\nfn base(b: Scalar, x: Scalar) -> String =\r\n  if b < 2 || b > 16\r\n    then error(\"base must be between 2 and 16\")\r\n    else if x < 0\r\n      then \"-{base(b, -x)}\"\r\n      else if x < b\r\n        then _digit_in_base(b, x)\r\n        else str_append(base(b, floor(x / b)), _digit_in_base(b, mod(x, b)))\r\n\r\n@description(\"Get a binary representation of a number.\")\r\n@example(\"42 -> bin\")\r\nfn bin(x: Scalar) -> String = if x < 0 then \"-{bin(-x)}\" else \"0b{base(2, x)}\"\r\n\r\n@description(\"Get an octal representation of a number.\")\r\n@example(\"42 -> oct\")\r\nfn oct(x: Scalar) -> String = if x < 0 then \"-{oct(-x)}\" else \"0o{base(8, x)}\"\r\n\r\n@description(\"Get a decimal representation of a number.\")\r\n@example(\"0b111 -> dec\")\r\nfn dec(x: Scalar) -> String = base(10, x)\r\n\r\n@description(\"Get a hexadecimal representation of a number.\")\r\n@example(\"2^31-1 -> hex\")\r\nfn hex(x: Scalar) -> String = if x < 0 then \"-{hex(-x)}\" else \"0x{base(16, x)}\"\r\n",
  "datetime::functions": "use core::strings\r\nuse core::quantities\r\nuse units::si\r\nuse units::time\r\n\r\n@description(\"Returns the current date and time.\")\r\nfn now() -> DateTime\r\n\r\n@description(\"Parses a string (date and time) into a `DateTime` object. See [here](./date-and-time.md#date-time-formats) for an overview of the supported formats.\")\r\n@example(\"datetime(\\\"2022-07-20T21:52+0200\\\")\")\r\n@example(\"datetime(\\\"2022-07-20 21:52 Europe/Berlin\\\")\")\r\n@example(\"datetime(\\\"2022/07/20 09:52 PM +0200\\\")\")\r\nfn datetime(input: String) -> DateTime\r\n\r\n@description(\"Formats a `DateTime` object as a string.\")\r\n@example(\"format_datetime(\\\"This is a date in %B in the year %Y.\\\", datetime(\\\"2022-07-20 21:52 +0200\\\"))\")\r\nfn format_datetime(format: String, input: DateTime) -> String\r\n\r\n@description(\"Returns the users local timezone.\")\r\n@example(\"get_local_timezone()\")\r\nfn get_local_timezone() -> String\r\n\r\n@description(\"Returns a timezone conversion function, typically used with the conversion operator.\")\r\n@example(\"datetime(\\\"2022-07-20 21:52 +0200\\\") -> tz(\\\"Europe/Amsterdam\\\")\")\r\n@example(\"datetime(\\\"2022-07-20 21:52 +0200\\\") -> tz(\\\"Asia/Taipei\\\")\")\r\nfn tz(tz: String) -> Fn[(DateTime) -> DateTime]\r\n\r\n@description(\"Timezone conversion function targeting the users local timezone (`datetime -> local`).\")\r\nlet local: Fn[(DateTime) -> DateTime] = tz(get_local_timezone())\r\n\r\n@description(\"Timezone conversion function to UTC.\")\r\nlet UTC: Fn[(DateTime) -> DateTime] = tz(\"UTC\")\r\n\r\nfn _today_str() = format_datetime(\"%Y-%m-%d\", now())\r\n\r\n@description(\"Returns the current date at midnight (in the local time).\")\r\nfn today() -> DateTime = datetime(\"{_today_str()} 00:00:00\")\r\n\r\n@description(\"Parses a string (only date) into a `DateTime` object.\")\r\n@example(\"date(\\\"2022-07-20\\\")\")\r\nfn date(input: String) -> DateTime =\r\n  if str_contains(\" \", input)\r\n    then datetime(str_replace(\" \", \" 00:00:00 \", input))\r\n    else datetime(\"{input} 00:00:00\")\r\n\r\n@description(\"Parses a string (time only) into a `DateTime` object.\")\r\nfn time(input: String) -> DateTime =\r\n  datetime(\"{_today_str()} {input}\")\r\n\r\nfn _add_days(dt: DateTime, n_days: Scalar) -> DateTime\r\nfn _add_months(dt: DateTime, n_months: Scalar) -> DateTime\r\nfn _add_years(dt: DateTime, n_years: Scalar) -> DateTime\r\n\r\n@description(\"Adds the given time span to a `DateTime`. This uses leap-year and DST-aware calendar arithmetic with variable-length days, months, and years.\")\r\n@example(\"calendar_add(datetime(\\\"2022-07-20 21:52 +0200\\\"), 2 years)\")\r\nfn calendar_add(dt: DateTime, span: Time) -> DateTime =\r\n   if span == 0\r\n     then dt\r\n   else if has_unit(span, days)\r\n     then _add_days(dt, span / days)\r\n   else if has_unit(span, months)\r\n     then _add_months(dt, span / months)\r\n   else if has_unit(span, years)\r\n     then _add_years(dt, span / years)\r\n   else if has_unit(span, seconds) || has_unit(span, minutes) || has_unit(span, hours)\r\n     then dt + span\r\n   else\r\n     error(\"calendar_add: Unsupported unit for `span`\")\r\n\r\n@description(\"Subtract the given time span from a `DateTime`. This uses leap-year and DST-aware calendar arithmetic with variable-length days, months, and years.\")\r\n@example(\"calendar_sub(datetime(\\\"2022-07-20 21:52 +0200\\\"), 3 years)\")\r\nfn calendar_sub(dt: DateTime, span: Time) -> DateTime =\r\n  calendar_add(dt, -span)\r\n\r\n@description(\"Get the day of the week from a given `DateTime`.\")\r\n@example(\"weekday(datetime(\\\"2022-07-20 21:52 +0200\\\"))\")\r\nfn weekday(dt: DateTime) -> String = format_datetime(\"%A\", dt)\r\n",
  "datetime::human": "use core::functions\r\nuse core::lists\r\nuse core::strings\r\nuse core::quantities\r\nuse units::si\r\nuse units::time\r\nuse datetime::functions\r\nuse units::mixed\r\n\r\nfn _human_join(a: String, b: String) -> String =\r\n  if a == \"\" then b else if b == \"\" then a else \"{a} + {b}\"\r\n\r\nfn _prettier(str: String) -> String =\r\n    if str_slice(0, 2, clean_str) == \"0 \" then \"\"\r\n    else if str_slice(0, 2, clean_str) == \"1 \" then str_slice( 0, str_length(clean_str) - 1, clean_str)\r\n    else clean_str\r\n  where clean_str = str_replace(\".0 \", \" \", str)\r\n\r\nfn _human_years(time: Time)   -> String = \"{(time -> years)   /  year   |> floor} years\"   -> _prettier\r\nfn _human_months(time: Time)  -> String = \"{(time -> months)  /  month  |> round} months\"  -> _prettier\r\n\r\nfn _human_days(time: Time)    -> String = \"{(time -> days)    /  day    |> floor} days\"    -> _prettier\r\nfn _human_hours(time: Time)   -> String = \"{(time -> hours)   /  hour   |> floor} hours\"   -> _prettier\r\nfn _human_minutes(time: Time) -> String = \"{(time -> minutes) /  minute |> floor} minutes\" -> _prettier\r\n\r\nfn _precise_human_months(time: Time)  -> String = \"{(time -> months)  /  month } months\"  -> _prettier\r\nfn _precise_human_days(time: Time)    -> String = \"{(time -> days)    /  day   } days\"    -> _prettier\r\nfn _precise_human_seconds(time: Time) -> String = \"{(time -> seconds) /  second} seconds\" -> _prettier\r\n\r\nfn _human_unit(time: Time) -> String =\r\n  if      time_unit >= year    then _human_years(time)\r\n  else if time_unit >= month   then _human_months(time)\r\n  else if time_unit >= day     then _human_days(time)\r\n  else if time_unit >= hour    then _human_hours(time)\r\n  else if time_unit >= minute  then _human_minutes(time)\r\n  else if time      != 0 s     then _precise_human_seconds(time |> round_in(ms))\r\n  else                              \"\"\r\n  where time_unit = if (time == 0) then 0 s else unit_of(time)\r\n\r\nfn _round_mixed_in<D: Dim>(base: D, value: List<D>) -> List<D> =\r\n  value |> sum |> round_in(base) |> _unit_list(units)\r\n    where units: List<D> = value |> filter(is_nonzero) |> map(unit_of)\r\n\r\nfn _human_time(base: Time, time_segments: List<Time>) -> String = \r\n  time_segments |> _round_mixed_in(base) |> map(_human_unit) |> foldl(_human_join, \"\")\r\n\r\nfn _human_for_long_duration(human_days: String, human_years: String) -> String =\r\n  \"{human_days} (approx. {human_years})\"\r\n\r\nfn _abs_human(time: Time) -> String =\r\n  if      abs_time ==  0 seconds then \"0 seconds\"\r\n  else if abs_time <  60 seconds then abs_time -> _precise_human_seconds\r\n  else if abs_time <   2 months  then ((abs_time -> seconds) |> unit_list([day, hour, minute, second]) |> _human_time(0.1 ms))\r\n  else if abs_time <   1 years   then _human_for_long_duration(abs_time -> _precise_human_days, (abs_time |> round_in(month/10)) -> _precise_human_months)\r\n  else if abs_time < 100 years\r\n   then _human_for_long_duration(abs_time -> _precise_human_days, ((abs_time -> months) |> unit_list([year, month]) |> _human_time(month/10)))\r\n  else\r\n    _human_for_long_duration(abs_time -> _precise_human_days, abs_time -> _human_years)\r\n  where abs_time: Time = abs(time)\r\n\r\n@name(\"Human-readable time duration\")\r\n@url(\"https://numbat.dev/docs/basics/date-and-time/\")\r\n@description(\"Converts a time duration to a human-readable string in days, hours, minutes and seconds.\")\r\n@example(\"century/1e6 -> human\", \"How long is a microcentury?\")\r\nfn human(time: Time) -> String = \r\n  if time < 0 s \r\n  then str_append(_abs_human(time),  \" ago\") \r\n  else _abs_human(time)\r\n",
  "datetime::julian_date": "use datetime::functions\r\n\r\n# The origin of the Julian date system: noon on November 24, 4714 BC\r\n# in the proleptic Gregorian calendar.\r\nlet _julian_epoch = datetime(\"-4713-11-24 12:00:00 UTC\")\r\n\r\n@name(\"Convert DateTime to Julian date\")\r\n@url(\"https://en.wikipedia.org/wiki/Julian_day\")\r\n@description(\"Convert a `DateTime` to a Julian date, the number of days since the origin of the Julian date system (noon on November 24, 4714 BC in the proleptic Gregorian calendar).\")\r\n@example(\"datetime(\\\"2013-01-01 00:30:00 UTC\\\") -> julian_date\")\r\nfn julian_date(dt: DateTime) -> Time = dt - _julian_epoch\r\n\r\n@name(\"J2000 epoch\")\r\n@url(\"https://en.wikipedia.org/wiki/Epoch_(astronomy)#J2000\")\r\n@description(\"The Julian date of the J2000 epoch, a standard astronomical reference point corresponding to January 1, 2000, 12:00 TT (Terrestrial Time).\")\r\nlet J2000: Time = datetime(\"2000-01-01 12:00:00 UTC\") -> julian_date\r\n\r\n@name(\"Convert Julian date to DateTime\")\r\n@url(\"https://en.wikipedia.org/wiki/Julian_day\")\r\n@description(\"Convert a Julian date to a `DateTime`.\")\r\n@example(\"from_julian_date(2_456_293.520_833 days)\")\r\nfn from_julian_date(jd: Time) -> DateTime = _julian_epoch + jd\r\n",
  "datetime::unixtime": "use core::functions\r\nuse core::quantities\r\n\r\ndimension UnixTime\r\n\r\n@description(\"Unit for counting seconds since the UNIX epoch (1970-01-01T00:00:00Z).\")\r\nunit unix_s: UnixTime\r\n\r\n@description(\"Unit for counting milliseconds since the UNIX epoch (1970-01-01T00:00:00Z).\")\r\nunit unix_ms: UnixTime = unix_s / 1000\r\n\r\n@description(\"Unit for counting microseconds since the UNIX epoch (1970-01-01T00:00:00Z).\")\r\n@aliases(unix_us)\r\nunit unix_µs: UnixTime = unix_s / 1_000_000\r\n\r\n# FFI functions (internal, return/take raw microseconds as Scalar)\r\nfn _unixtime_µs(input: DateTime) -> Scalar\r\nfn _from_unixtime_µs(input: Scalar) -> DateTime\r\n\r\n@description(\"Converts a `DateTime` to a UNIX timestamp. Can be used on the right hand side of a conversion operator: `now() -> unixtime`.\")\r\n@example(\"datetime(\\\"2022-07-20 21:52 +0200\\\") -> unixtime\")\r\nfn unixtime(input: DateTime) -> UnixTime = _unixtime_µs(input) * unix_µs -> unix_s\r\n\r\n@description(\"Converts a `DateTime` to a UNIX timestamp in seconds.\")\r\n@example(\"datetime(\\\"2022-07-20 21:52 +0200\\\") -> unixtime_s\")\r\nfn unixtime_s(input: DateTime) -> Scalar = unixtime(input) |> floor_in(unix_s) |> value_of\r\n\r\n@description(\"Converts a `DateTime` to a UNIX timestamp in milliseconds.\")\r\n@example(\"datetime(\\\"2022-07-20 21:52:05.123 +0200\\\") -> unixtime_ms\")\r\nfn unixtime_ms(input: DateTime) -> Scalar = unixtime(input) |> floor_in(unix_ms) |> value_of\r\n\r\n@description(\"Converts a `DateTime` to a UNIX timestamp in microseconds.\")\r\n@example(\"datetime(\\\"2022-07-20 21:52:05.123456 +0200\\\") -> unixtime_µs\")\r\nfn unixtime_µs(input: DateTime) -> Scalar = unixtime(input) |> floor_in(unix_µs) |> value_of\r\n\r\n@description(\"Alias for `unixtime_µs`.\")\r\nfn unixtime_us(input: DateTime) -> Scalar = unixtime_µs(input)\r\n\r\n@description(\"Converts a UNIX timestamp to a `DateTime` object.\")\r\n@example(\"from_unixtime(1658346725 unix_s)\")\r\n@example(\"from_unixtime(1658346725000 unix_ms)\")\r\n@example(\"from_unixtime(1658346725000000 unix_µs)\")\r\nfn from_unixtime(input: UnixTime) -> DateTime = _from_unixtime_µs(value_of(input -> unix_µs))\r\n\r\n@description(\"Converts a UNIX timestamp in seconds to a `DateTime` object.\")\r\n@example(\"from_unixtime_s(1658346725)\")\r\nfn from_unixtime_s(input: Scalar) -> DateTime = from_unixtime(input unix_s)\r\n\r\n@description(\"Converts a UNIX timestamp in milliseconds to a `DateTime` object.\")\r\n@example(\"from_unixtime_ms(1658346725123)\")\r\nfn from_unixtime_ms(input: Scalar) -> DateTime = from_unixtime(input unix_ms)\r\n\r\n@description(\"Converts a UNIX timestamp in microseconds to a `DateTime` object.\")\r\n@example(\"from_unixtime_µs(1658346725123456)\")\r\nfn from_unixtime_µs(input: Scalar) -> DateTime = from_unixtime(input unix_µs)\r\n\r\n@description(\"Alias for `from_unixtime_µs`.\")\r\nfn from_unixtime_us(input: Scalar) -> DateTime = from_unixtime_µs(input)\r\n",
  "extra::algebra": "use core::error\r\nuse core::functions\r\nuse math::constants\r\nuse math::trigonometry\r\nuse core::lists\r\n\r\nfn _qe_solution<A: Dim, B: Dim>(a: A, b: B, c: B² / A, sign: Scalar) -> B / A =\r\n  (-b + sign × sqrt(b² - 4 a c)) / 2 a\r\n\r\n@name(\"Solve quadratic equations\")\r\n@url(\"https://en.wikipedia.org/wiki/Quadratic_equation\")\r\n@description(\"Returns the solutions of the equation a x² + b x + c = 0\")\r\n@example(\"quadratic_equation(2, -1, -1)\", \"Solve the equation $2x² -x -1 = 0$\")\r\nfn quadratic_equation<A: Dim, B: Dim>(a: A, b: B, c: B² / A) -> List<B / A> =\r\n  if a == 0\r\n    then if b == 0\r\n      then if c == 0\r\n        then error(\"infinitely many solutions\")\r\n        else []\r\n      else [-c / b]\r\n    else if b² < 4 a c\r\n      then []\r\n      else if b² == 4 a c\r\n        then [-b / 2 a]\r\n        else [_qe_solution(a, b, c, 1), _qe_solution(a, b, c, -1)]\r\n\r\nfn _solve_reduced_less_solution(theta: Scalar, k: Scalar, radius: Scalar) -> Scalar =\r\n  2 * radius * cos( (theta + 2 k pi) / 3 )\r\n\r\nfn _solve_reduced_less(a: Scalar, b2: Scalar) -> List<Scalar> = \r\n  [\r\n    _solve_reduced_less_solution(theta, 0, radius),\r\n    _solve_reduced_less_solution(theta, 1, radius),\r\n    _solve_reduced_less_solution(theta, 2, radius)\r\n  ]\r\n  where radius = sqrt(-a/3) \r\n    and theta = acos(b2 / (radius^3))\r\n\r\nfn _solve_reduced_greater(b2: Scalar, delta: Scalar) -> List<Scalar> = \r\n  [cbrt(b2+rd) + cbrt(b2-rd)]\r\n  where rd = sqrt(delta)\r\n\r\nfn _solve_reduced_equal(b2: Scalar) -> List<Scalar> = \r\n  if b2 == 0 \r\n    then [0]\r\n    else [2*cbrt_b2, -cbrt_b2]\r\n  where cbrt_b2 = cbrt(b2)\r\n\r\nfn _solve_reduced(a: Scalar, b: Scalar) -> List<Scalar> = \r\n  if delta < 0 \r\n    then _solve_reduced_less(a, b2)\r\n    else if delta == 0 \r\n      then _solve_reduced_equal(b2)\r\n      else _solve_reduced_greater(b2, delta)\r\n  where b2 = - b/2 \r\n    and delta = b2^2 + (a/3)^3\r\n\r\nfn _translation_solutions(p: Scalar, y: Scalar) -> Scalar = y - p /3\r\n\r\nfn _solve_true_cubic_equation(a: Scalar, b: Scalar, c: Scalar, e: Scalar) -> List<Scalar> =\r\n  map2(_translation_solutions, p, _solve_reduced(q - p^2/3, 2 * p^3 / 27 - p * q / 3 + r))\r\n  where p = b/a \r\n    and q = c/a \r\n    and r = e/a\r\n\r\n@name(\"Solve cubic equations\")\r\n@url(\"https://en.wikipedia.org/wiki/Cubic_equation\")\r\n@description(\"Returns the solutions of the equation a x³ + b x² + c x + e = 0\")\r\n@example(\"cubic_equation(1, -6, 11, -6)\", \"Solve the equation $x³ - 6x² + 11x - 6 = 0$\")\r\nfn cubic_equation(a: Scalar, b: Scalar, c: Scalar, e: Scalar) -> List<Scalar> = \r\n  if a == 0 \r\n    then sort(quadratic_equation(b, c, e)) \r\n    else sort(_solve_true_cubic_equation(a, b, c, e))\r\n\r\n",
  "extra::astronomy": "use physics::constants\r\nuse units::si\r\nuse units::time\r\nuse units::astronomical\r\nuse units::cgs\r\n\r\n@name(\"Light-second\")\r\n@description(\"The distance that light travels in one second.\")\r\n@url(\"https://en.wikipedia.org/wiki/Light-second\")\r\n@aliases(lightseconds, lsec)\r\nunit lightsecond: Length = speed_of_light × 1 s\r\n\r\n@name(\"Lunar mass\")\r\n@description(\"The mass of Earth's Moon.\")\r\n@url(\"https://en.wikipedia.org/wiki/Moon#Size_and_mass\")\r\nunit lunar_mass: Mass = 7.342e22 kg\r\n\r\n@name(\"Lunar radius\")\r\n@description(\"The radius of Earth's Moon.\")\r\n@url(\"https://en.wikipedia.org/wiki/Moon#Size_and_mass\")\r\nunit lunar_radius: Length = 1737.4 km\r\n\r\n@name(\"Earth mass\")\r\n@description(\"The mass of planet Earth.\")\r\n@url(\"https://en.wikipedia.org/wiki/Earth\")\r\nunit earth_mass: Mass = 5.9722e24 kg\r\n\r\n@name(\"Earth radius\")\r\n@description(\"The radius of planet Earth.\")\r\n@url(\"https://en.wikipedia.org/wiki/Earth\")\r\nunit earth_radius: Length = 6371.0088 km\r\n\r\n@name(\"Earth's axial tilt\")\r\n@description(\"The angle between Earth's rotational axis and its orbital axis, also known as obliquity. This is the mean value for the J2000 epoch.\")\r\n@url(\"https://en.wikipedia.org/wiki/Earth\")\r\nlet earth_axial_tilt: Angle = 23.439_281_1°\r\n\r\n@name(\"Earth's orbital eccentricity\")\r\n@description(\"The eccentricity of Earth's orbit around the Sun at the J2000 epoch. The orbit is nearly circular.\")\r\n@url(\"https://en.wikipedia.org/wiki/Earth%27s_orbit\")\r\nlet earth_orbital_eccentricity: Scalar = 0.016_708_634\r\n\r\n@name(\"Earth's longitude of perihelion at J2000\")\r\n@description(\"The longitude of perihelion for Earth's orbit at the J2000 epoch, measured from the vernal equinox.\")\r\n@url(\"https://ssd.jpl.nasa.gov/planets/approx_pos.html\")\r\nlet earth_longitude_of_perihelion_j2000: Angle = 102.937_348_1°\r\n\r\n@name(\"Earth's perihelion longitude precession rate\")\r\n@description(\"The rate at which Earth's longitude of perihelion changes relative to the mean equinox. This combines apsidal precession (360°/112_000 years, caused by Jupiter and Saturn) and axial precession (360°/25_772 years, the precession of the equinoxes).\")\r\n@url(\"https://en.wikipedia.org/wiki/Apsidal_precession\")\r\nlet earth_perihelion_precession_rate: Angle / Time = 360° / (112_000 years) + 360° / (25_772 years)\r\n\r\n@name(\"Earth's mean anomaly at J2000\")\r\n@description(\"The mean anomaly of Earth's orbit at the J2000 epoch (2000-01-01 12:00 TT).\")\r\n@url(\"https://en.wikipedia.org/wiki/Mean_anomaly\")\r\nlet earth_mean_anomaly_j2000: Angle = 357.529_11°\r\n\r\n@name(\"Anomalistic year\")\r\n@description(\"The time between successive perihelion passages of Earth, approximately 365.259636 days. This is slightly longer than the tropical year due to the precession of Earth's perihelion.\")\r\n@url(\"https://en.wikipedia.org/wiki/Year#Sidereal,_tropical,_and_anomalistic_years\")\r\n@aliases(anomalistic_years)\r\nunit anomalistic_year: Time = 365.259_636 days\r\n\r\n@name(\"Synodic month\")\r\n@description(\"The average time between successive new moons, also known as a lunation. This is the Moon's orbital period as seen from Earth.\")\r\n@url(\"https://en.wikipedia.org/wiki/Lunar_month#Synodic_month\")\r\n@aliases(synodic_months, lunation, lunations)\r\nunit synodic_month: Time = 29.530_588_853 days\r\n\r\n@name(\"Mars mass\")\r\n@description(\"The mass of planet Mars.\")\r\n@url(\"https://en.wikipedia.org/wiki/Mars\")\r\nunit mars_mass: Mass = 6.4171e23 kg\r\n\r\n@name(\"Mars radius\")\r\n@description(\"The radius of planet Mars.\")\r\n@url(\"https://en.wikipedia.org/wiki/Mars\")\r\nunit mars_radius: Length = 3389.5 km\r\n\r\n@name(\"Jupiter mass\")\r\n@description(\"The mass of planet Jupiter.\")\r\n@url(\"https://en.wikipedia.org/wiki/Jupiter\")\r\nunit jupiter_mass: Mass = 1.89813e27 kg\r\n\r\n@name(\"Jupiter radius\")\r\n@description(\"The radius of planet Jupiter.\")\r\n@url(\"https://en.wikipedia.org/wiki/Jupiter\")\r\nunit jupiter_radius: Length = 71_492 km\r\n\r\n@name(\"Solar mass\")\r\n@description(\"The mass of the Sun.\")\r\n@url(\"https://en.wikipedia.org/wiki/Sun\")\r\nunit solar_mass: Mass = 1.98847e30 kg\r\n\r\n@name(\"Solar radius\")\r\n@description(\"The radius of the Sun.\")\r\n@url(\"https://en.wikipedia.org/wiki/Sun\")\r\nunit solar_radius: Length = 6.957e5 km\r\n\r\ndimension RadiantFlux = Power\r\n\r\n@name(\"Solar luminosity\")\r\n@description(\"The total amount of energy emitted by the Sun per unit time.\")\r\n@url(\"https://en.wikipedia.org/wiki/Solar_luminosity\")\r\nunit solar_luminosity: RadiantFlux = 3.828e26 W\r\n\r\ndimension SpectralFluxDensity = RadiantFlux / Area / Frequency\r\n\r\n@name(\"Jansky\")\r\n@url(\"https://en.wikipedia.org/wiki/Jansky\")\r\n@aliases(janskys, Jy: short)\r\nunit jansky: SpectralFluxDensity = 1e-26 W / m^2 / Hz\r\n\r\n@name(\"Solar flux unit\")\r\n@url(\"https://en.wikipedia.org/wiki/Solar_flux_unit\")\r\n@aliases(solarfluxunits, sfu: short)\r\nunit solarfluxunit: SpectralFluxDensity = 1e4 Jy\r\n\r\n@name(\"Foe\")\r\n@description(\"A unit of energy equal to 10⁵¹ ergs. Used to express the energy released by supernovae. The word is an acronym derived from '(ten to the power of) fifty-one ergs'.\")\r\n@url(\"https://en.wikipedia.org/wiki/Foe_(unit)\")\r\nunit foe: Energy = 1e51 erg\r\n",
  "extra::celestial": "# Sunrise, sunset, and moon phase calculations\r\n#\r\n# Useful resources:\r\n# - https://gml.noaa.gov/grad/solcalc/\r\n# - https://en.wikipedia.org/wiki/Sunrise_equation\r\n# - https://en.wikipedia.org/wiki/Equation_of_the_center\r\n# - https://en.wikipedia.org/wiki/Equation_of_time\r\n# - https://en.wikipedia.org/wiki/Lunar_phase\r\n\r\nuse math::trigonometry\r\nuse datetime::julian_date\r\nuse extra::astronomy\r\n\r\nstruct Position {\r\n  lat: Angle,\r\n  lon: Angle,\r\n}\r\n\r\nstruct SunTimes {\r\n  sunrise: DateTime,\r\n  transit: DateTime,\r\n  sunset: DateTime,\r\n}\r\n\r\n@name(\"Sunrise and sunset\")\r\n@description(\"Compute sunrise, solar noon (transit), and sunset times for a given location and date.\")\r\n@example(\"sunrise_sunset(Position {{ lat: 40.713°, lon: -74.006° }}, datetime(\\\"2023-03-21 12:00:00 America/New_York\\\"))\")\r\nfn sunrise_sunset(position: Position, dt: DateTime) -> SunTimes =\r\n    SunTimes {\r\n      sunrise: from_julian_date(J_rise),\r\n      transit: from_julian_date(J_transit),\r\n      sunset: from_julian_date(J_set),\r\n    }\r\n  # Earth's angular velocity (one full rotation per day)\r\n  where ω_earth: Angle / Time = 360° / day\r\n    # Julian date of the input datetime\r\n    and J_date = dt -> julian_date\r\n    # Days since J2000 epoch, rounded to nearest day\r\n    and n: Time = (J_date - J2000) |> round_in(days)\r\n    # Mean solar time at the observer's longitude\r\n    and J_star: Time = n - position.lon / ω_earth\r\n    # Solar mean anomaly: angle from perihelion if orbit were circular\r\n    and M: Angle = mod(earth_mean_anomaly_j2000 + (360° / anomalistic_year) × J_star, 360°)\r\n    # Shorthand for Earth's orbital eccentricity\r\n    and ee = earth_orbital_eccentricity\r\n    # Equation of the center: correction from mean to true anomaly\r\n    and eoc: Angle = (2 ee - ee³/4) × sin(M) + (5/4 × ee²) × sin(2 M) + (13/12 × ee³) × sin(3 M)\r\n    # Longitude of perihelion, which precesses over time\r\n    and ω_perihelion = earth_longitude_of_perihelion_j2000 + earth_perihelion_precession_rate × J_star\r\n    # Ecliptic longitude: Sun's position along the ecliptic\r\n    and λ: Angle = mod(M + eoc + 180° + ω_perihelion, 360°)\r\n    # Solar transit (noon): when the Sun crosses the local meridian\r\n    and J_transit = J2000 + J_star + 7.659 min × sin(M) - 9.863 min × sin(2 λ)\r\n    # Solar declination: Sun's angle north or south of celestial equator\r\n    and sin_δ = sin(λ) × sin(earth_axial_tilt)\r\n    and δ = asin(sin_δ)\r\n    # Sunrise correction: atmospheric refraction (34') + Sun's angular radius\r\n    and sunrise_correction: Angle = -(34 arcmin + atan(solar_radius / AU))\r\n    # Hour angle: angular distance from solar noon to sunrise/sunset\r\n    and cos_ω0 = (sin(sunrise_correction) - sin(position.lat) × sin_δ) / (cos(position.lat) × cos(δ))\r\n    and ω0: Angle = acos(cos_ω0)\r\n    # Sunrise and sunset times as Julian dates\r\n    and J_rise = J_transit - ω0 / ω_earth\r\n    and J_set = J_transit + ω0 / ω_earth\r\n\r\ndimension LunarCycle\r\n\r\n@name(\"Lunar cycle\")\r\n@description(\"Unit for moon phase measurement. 0 = new moon, 0.5 lunar_cycle = full moon, 1 lunar_cycle = next new moon.\")\r\n@aliases(lunar_cycles)\r\nunit lunar_cycle: LunarCycle\r\n\r\n@name(\"Moon phase\")\r\n@description(\"Compute the moon phase for a given date and time. Returns the phase from 0 to 1 lunar_cycle, where 0 is a new moon and 0.5 lunar_cycle is a full moon.\")\r\n@example(\"datetime(\\\"2026-01-30 12:00:00 UTC\\\") -> moon_phase\")\r\nfn moon_phase(dt: DateTime) -> LunarCycle = mod(cycles, 1) × lunar_cycle\r\n  where reference_new_moon = datetime(\"2000-01-06 18:14:00 UTC\")\r\n    and time_since_new_moon = dt - reference_new_moon\r\n    and cycles = time_since_new_moon / synodic_month\r\n\r\n@name(\"Moon phase name\")\r\n@description(\"Convert a moon phase to its name and Unicode symbol (e.g., \\\"🌘 Waning Crescent\\\").\")\r\n@example(\"datetime(\\\"2026-01-30 12:00:00 UTC\\\") -> moon_phase -> moon_phase_name\")\r\nfn moon_phase_name(phase: LunarCycle) -> String =\r\n    if phase < 1/16 × lunar_cycle then \"🌑 New Moon\"\r\n    else if phase < 3/16 × lunar_cycle then \"🌒 Waxing Crescent\"\r\n    else if phase < 5/16 × lunar_cycle then \"🌓 First Quarter\"\r\n    else if phase < 7/16 × lunar_cycle then \"🌔 Waxing Gibbous\"\r\n    else if phase < 9/16 × lunar_cycle then \"🌕 Full Moon\"\r\n    else if phase < 11/16 × lunar_cycle then \"🌖 Waning Gibbous\"\r\n    else if phase < 13/16 × lunar_cycle then \"🌗 Last Quarter\"\r\n    else if phase < 15/16 × lunar_cycle then \"🌘 Waning Crescent\"\r\n    else \"🌑 New Moon\"\r\n",
  "extra::color": "use core::scalar\r\nuse core::functions\r\nuse core::strings\r\n\r\nstruct Color {\r\n  red: Scalar,\r\n  green: Scalar,\r\n  blue: Scalar,\r\n}\r\n\r\n@description(\"Create a `Color` from RGB (red, green, blue) values in the range $[0, 256)$.\")\r\n@example(\"rgb(125, 128, 218)\")\r\nfn rgb(red: Scalar, green: Scalar, blue: Scalar) -> Color =\r\n  Color { red: red, green: green, blue: blue }\r\n\r\n@description(\"Create a `Color` from a (hexadecimal) value.\")\r\n@example(\"color(0xff7700)\")\r\nfn color(rgb_hex: Scalar) -> Color =\r\n  rgb(\r\n    floor(rgb_hex / 256^2),\r\n    floor((mod(rgb_hex, 256^2)) / 256),\r\n    mod(rgb_hex, 256))\r\n\r\nfn _color_to_scalar(color: Color) -> Scalar =\r\n  color.red * 0x010000 + color.green * 0x000100 + color.blue\r\n\r\n@description(\"Convert a color to its RGB representation.\")\r\n@example(\"cyan -> color_rgb\")\r\nfn color_rgb(color: Color) -> String =\r\n  \"rgb({color.red}, {color.green}, {color.blue})\"\r\n\r\n@description(\"Convert a color to its RGB floating point representation.\")\r\n@example(\"cyan -> color_rgb_float\")\r\nfn color_rgb_float(color: Color) -> String =\r\n  \"rgb({color.red / 255:.3}, {color.green / 255:.3}, {color.blue / 255:.3})\"\r\n\r\n@description(\"Convert a color to its hexadecimal representation.\")\r\n@example(\"rgb(225, 36, 143) -> color_hex\")\r\nfn color_hex(color: Color) -> String =\r\n  \"{color -> _color_to_scalar -> hex:>8}\" |> \r\n    str_replace(\"0x\", \"\") |> \r\n    str_replace(\" \", \"0\") |> \r\n    str_append(\"#\")\r\n\r\nlet black: Color = rgb(0, 0, 0)\r\nlet white: Color = rgb(255, 255, 255)\r\nlet red: Color = rgb(255, 0, 0)\r\nlet green: Color = rgb(0, 255, 0)\r\nlet blue: Color = rgb(0, 0, 255)\r\nlet yellow: Color = rgb(255, 255, 0)\r\nlet cyan: Color = rgb(0, 255, 255)\r\nlet magenta: Color = rgb(255, 0, 255)\r\n",
  "extra::cooking": "# (Inverse) densities for various cooking ingredients.\r\n#\r\n# Example usage:\r\n#\r\n#   use extra::cooking\r\n#\r\n#   200g butter to tablespoons\r\n#   500g rice to cups\r\n#\r\n\r\nuse units::si\r\n\r\nlet water = 1 / (1000 g/L)\r\nlet butter = 1 / (911 g/L)\r\nlet olive_oil = 1 / (920 g/L)\r\nlet milk = 1 / (1030 g/L)\r\nlet sugar = 1 / (845 g/L) # Granulated sugar\r\nlet honey = 1 / (1420 g/L)\r\nlet flour = 1 / (550 g/L)\r\nlet salt = 1 / (1217 g/L)\r\nlet rice = 1 / (785 g/L)\r\nlet egg_raw = 1 / (1029 g/L)\r\nlet yogurt = 1 / (1045 g/L)\r\n",
  "extra::vector3": "use core::functions\r\n\r\nstruct Vec<D: Dim> {\r\n    x: D,\r\n    y: D,\r\n    z: D,\r\n}\r\n\r\n@description(\"Create a 3D vector from its components.\")\r\nfn vec<D: Dim>(x: D, y: D, z: D) -> Vec<D> =\r\n    Vec { x: x, y: y, z: z }\r\n\r\n@description(\"Add two 3D vectors.\")\r\nfn add<D: Dim>(v1: Vec<D>, v2: Vec<D>) -> Vec<D> =\r\n    vec(v1.x + v2.x, v1.y + v2.y, v1.z + v2.z)\r\n\r\n@description(\"Multiply a 3D vector by a scalar.\")\r\nfn multiply<A: Dim, D: Dim>(alpha: A, v: Vec<D>) -> Vec<A * D> =\r\n    vec(alpha * v.x, alpha * v.y, alpha * v.z)\r\n\r\n@description(\"Compute the dot product of two 3D vectors.\")\r\nfn dot_product<A: Dim, B: Dim>(v1: Vec<A>, v2: Vec<B>) -> A * B =\r\n    v1.x * v2.x + v1.y * v2.y + v1.z * v2.z\r\n\r\n@description(\"Compute the norm (squared length) of a 3D vector.\")\r\nfn norm<D: Dim>(v: Vec<D>) -> D^2 = dot_product(v, v)\r\n\r\n@description(\"Compute the length of a 3D vector.\")\r\nfn length<D: Dim>(v: Vec<D>) -> D = sqrt(norm(v))\r\n\r\n@description(\"Compute the cross product of two 3D vectors.\")\r\nfn cross<D1: Dim, D2: Dim>(v1: Vec<D1>, v2: Vec<D2>) -> Vec<D1 * D2> =\r\n    vec(\r\n        v1.y * v2.z - v1.z * v2.y,\r\n        v1.z * v2.x - v1.x * v2.z,\r\n        v1.x * v2.y - v1.y * v2.x,\r\n    )\r\n",
  "math::combinatorics": "use core::error\r\nuse core::functions\r\nuse core::numbers\r\nuse math::transcendental\r\n\r\n@name(\"Factorial\")\r\n@description(\"The product of the integers 1 through n. Numbat also supports calling this via the postfix operator `n!`.\")\r\n@url(\"https://en.wikipedia.org/wiki/Factorial\")\r\n@example(\"factorial(4)\")\r\n@example(\"4!\")\r\nfn factorial(n: Scalar) -> Scalar = n!\r\n\r\n@name(\"Falling factorial\")\r\n@description(\"Equal to $n⋅(n-1)⋅…⋅(n-k+2)⋅(n-k+1)$ (k terms total). If n is an integer, this is the number of k-element permutations from a set of size n. k must always be an integer.\")\r\n@url(\"https://en.wikipedia.org/wiki/Falling_and_rising_factorials\")\r\n@example(\"falling_factorial(4, 2)\")\r\nfn falling_factorial(n: Scalar, k: Scalar) -> Scalar =\r\n  if k < 0 || !is_integer(k) then\r\n    error(\"in falling_factorial(n, k), k must be a nonnegative integer\")\r\n  else if is_zero(k) then\r\n    1\r\n  else\r\n    n * falling_factorial(n-1, k-1)\r\n\r\n@name(\"Binomial coefficient\")\r\n@description(\"Equal to falling_factorial(n, k)/k!, this is the coefficient of $x^k$ in the series expansion of $(1+x)^n$ (see “binomial series”). If n is an integer, then this this is the number of k-element subsets of a set of size n, often read \\\"n choose k\\\". k must always be an integer.\")\r\n@url(\"https://en.wikipedia.org/wiki/Binomial_coefficient\")\r\n@example(\"binom(5, 2)\")\r\nfn binom(n: Scalar, k: Scalar) -> Scalar =\r\n   if !is_integer(k) then\r\n    error(\"in binom(n, k), k must be an integer\")\r\n  else if k < 0 || (k > n && is_integer(n)) then\r\n    0\r\n  else\r\n    falling_factorial(n, k) / k!\r\n\r\n@name(\"Fibonacci numbers\")\r\n@description(\"The nth Fibonacci number, where n is a nonnegative integer. The Fibonacci sequence is given by $F_0=0$, $F_1=1$, and $F_n=F_{{n-1}}+F_{{n-2}}$ for $n≥2$. The first several elements, starting with $n=0$, are $0, 1, 1, 2, 3, 5, 8, 13$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Fibonacci_sequence\")\r\n@example(\"fibonacci(5)\")\r\nfn fibonacci(n: Scalar) -> Scalar =\r\n  if !(is_integer(n) && n >= 0) then\r\n    error(\"the argument to fibonacci(n) must be a nonnegative integer\")\r\n  else\r\n    # use Binet's formula for constant time\r\n    round((phi^n - (-phi)^(-n))/sqrt(5))\r\n      where phi = (1+sqrt(5))/2\r\n\r\n@name(\"Lucas numbers\")\r\n@description(\"The nth Lucas number, where n is a nonnegative integer. The Lucas sequence is given by $L_0=2$, $L_1=1$, and $L_n=L_{{n-1}}+L_{{n-2}}$ for $n≥2$. The first several elements, starting with $n=0$, are $2, 1, 3, 4, 7, 11, 18, 29$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Lucas_number\")\r\n@example(\"lucas(5)\")\r\nfn lucas(n: Scalar) -> Scalar =\r\n  if !(is_integer(n) && n >= 0) then\r\n    error(\"the argument to lucas(n) must be a nonnegative integer\")\r\n  else\r\n    # use Binet's formula for constant time\r\n    round(phi^n + (1-phi)^n)\r\n      where phi = (1+sqrt(5))/2\r\n\r\n@name(\"Catalan numbers\")\r\n@description(\"The nth Catalan number, where n is a nonnegative integer. The Catalan sequence is given by $C_n=\\frac{{1}}{{n+1}}\\binom{{2n}}{{n}}=\\binom{{2n}}{{n}}-\\binom{{2n}}{{n+1}}$. The first several elements, starting with $n=0$, are $1, 1, 2, 5, 14, 42, 132, 429$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Catalan_number\")\r\n@example(\"catalan(5)\")\r\nfn catalan(n: Scalar) -> Scalar =\r\n  if !(is_integer(n) && n >= 0) then\r\n    error(\"the argument to catalan(n) must be a nonnegative integer\")\r\n  else\r\n    binom(2*n, n) / (n+1)\r\n",
  "math::constants": "use core::scalar\r\n\r\n### Mathematical\r\n\r\n@name(\"Pi\")\r\n@url(\"https://en.wikipedia.org/wiki/Pi\")\r\n@aliases(pi)\r\nlet π = 3.14159265358979323846264338327950288\r\n\r\n@name(\"Tau\")\r\n@url(\"https://en.wikipedia.org/wiki/Turn_(angle)#Tau_proposals\")\r\n@aliases(tau)\r\nlet τ = 2 π\r\n\r\n@name(\"Euler's number\")\r\n@url(\"https://en.wikipedia.org/wiki/E_(mathematical_constant)\")\r\nlet e = 2.71828182845904523536028747135266250\r\n\r\n@name(\"Golden ratio\")\r\n@url(\"https://en.wikipedia.org/wiki/Golden_ratio\")\r\n@aliases(golden_ratio)\r\nlet φ = 1.61803398874989484820458683436563811\r\n\r\n### Named numbers\r\n\r\n#### Large numbers\r\n\r\n@name(\"Hundred\")\r\n@url(\"https://en.wikipedia.org/wiki/100_(number)\")\r\nunit hundred = 100\r\n\r\n@name(\"Thousand\")\r\n@url(\"https://en.wikipedia.org/wiki/1000_(number)\")\r\nunit thousand = 1_000\r\n\r\n@name(\"Million\")\r\n@url(\"https://en.wikipedia.org/wiki/Million\")\r\nunit million = 1_000_000\r\n\r\n@name(\"Billion\")\r\n@url(\"https://en.wikipedia.org/wiki/Billion\")\r\nunit billion = 10^9\r\n\r\n@name(\"Trillion\")\r\n@url(\"https://en.wikipedia.org/wiki/Trillion\")\r\nunit trillion = 10^12\r\n\r\n@name(\"Quadrillion\")\r\n@url(\"https://en.wikipedia.org/wiki/Quadrillion\")\r\nunit quadrillion = 10^15\r\n\r\n@name(\"Quintillion\")\r\n@url(\"https://en.wikipedia.org/wiki/Quintillion\")\r\nunit quintillion = 10^18\r\n\r\n@name(\"Googol\")\r\n@url(\"https://en.wikipedia.org/wiki/Googol\")\r\nlet googol =  10^100\r\n\r\n### Unicode fractions\r\n\r\n@name(\"One half\")\r\n@url(\"https://en.wikipedia.org/wiki/One_half\")\r\n@aliases(half, semi)\r\nlet ½ = 1 / 2\r\n\r\nlet ⅓ = 1 / 3\r\nlet ⅔ = 2 / 3\r\n\r\n@aliases(quarter)\r\nlet ¼ = 1 / 4\r\n\r\nlet ¾ = 3 / 4\r\n\r\nlet ⅕ = 1 / 5\r\nlet ⅖ = 2 / 5\r\nlet ⅗ = 3 / 5\r\nlet ⅘ = 4 / 5\r\n\r\nlet ⅙ = 1 / 6\r\nlet ⅚ = 5 / 6\r\n\r\nlet ⅐ = 1 / 7\r\n\r\nlet ⅛ = 1 / 8\r\nlet ⅜ = 3 / 8\r\nlet ⅝ = 5 / 8\r\nlet ⅞ = 7 / 8\r\n\r\nlet ⅑ = 1 / 9\r\n\r\nlet ⅒ = 1 / 10\r\n\r\n#### Integers and colloquial names\r\n\r\n@name(\"One\")\r\n@url(\"https://en.wikipedia.org/wiki/1\")\r\nlet one = 1\r\n\r\n@name(\"Two\")\r\n@url(\"https://en.wikipedia.org/wiki/2\")\r\n@aliases(double)\r\nlet two = 2\r\n\r\n@name(\"Three\")\r\n@url(\"https://en.wikipedia.org/wiki/3\")\r\n@aliases(triple)\r\nlet three = 3\r\n\r\n@name(\"Four\")\r\n@url(\"https://en.wikipedia.org/wiki/4\")\r\n@aliases(quadruple)\r\nlet four = 4\r\n\r\n@name(\"Five\")\r\n@url(\"https://en.wikipedia.org/wiki/5\")\r\nlet five = 5\r\n\r\n@name(\"Six\")\r\n@url(\"https://en.wikipedia.org/wiki/6\")\r\nlet six = 6\r\n\r\n@name(\"Seven\")\r\n@url(\"https://en.wikipedia.org/wiki/7\")\r\nlet seven = 7\r\n\r\n@name(\"Eight\")\r\n@url(\"https://en.wikipedia.org/wiki/8\")\r\nlet eight = 8\r\n\r\n@name(\"Nine\")\r\n@url(\"https://en.wikipedia.org/wiki/9\")\r\nlet nine = 9\r\n\r\n@name(\"Ten\")\r\n@url(\"https://en.wikipedia.org/wiki/10\")\r\nlet ten = 10\r\n\r\n@name(\"Eleven\")\r\n@url(\"https://en.wikipedia.org/wiki/11\")\r\nlet eleven = 11\r\n\r\n@name(\"Twelve\")\r\n@url(\"https://en.wikipedia.org/wiki/12\")\r\nlet twelve = 12\r\n\r\n@name(\"Dozen\")\r\n@url(\"https://en.wikipedia.org/wiki/Dozen\")\r\nunit dozen = 12\r\n",
  "math::distributions": "use core::scalar\r\nuse core::random\r\nuse core::quantities\r\nuse core::error\r\nuse core::functions\r\nuse math::constants\r\nuse math::transcendental\r\nuse math::trigonometry\r\n\r\n@name(\"Continuous uniform distribution sampling\")\r\n@url(\"https://en.wikipedia.org/wiki/Continuous_uniform_distribution\")\r\n@description(\"Uniformly samples the interval $[a,b)$ if $a \\\\le b$ or $[b,a)$ if $b<a$ using inversion sampling.\")\r\nfn rand_uniform<T: Dim>(a: T, b: T) -> T =\r\n    if a <= b\r\n    then random() * (b - a) + a\r\n    else random() * (a - b) + b\r\n\r\n@name(\"Discrete uniform distribution sampling\")\r\n@url(\"https://en.wikipedia.org/wiki/Discrete_uniform_distribution\")\r\n@description(\"Uniformly samples integers from the interval $[a, b]$.\")\r\nfn rand_int(a: Scalar, b: Scalar) -> Scalar =\r\n    if a <= b\r\n    then floor( random() * (floor(b) - ceil(a) + 1) ) + ceil(a)\r\n    else floor( random() * (floor(a) - ceil(b) + 1) ) + ceil(b)\r\n\r\n@name(\"Bernoulli distribution sampling\")\r\n@url(\"https://en.wikipedia.org/wiki/Bernoulli_distribution\")\r\n@description(\"Samples a Bernoulli random variable. That is, $1$ with probability $p$ and $0$ with probability $1-p$. The parameter $p$ must be a probability ($0 \\le p \\le 1$).\")\r\nfn rand_bernoulli(p: Scalar) -> Scalar =\r\n    if p>=0 && p<=1\r\n    then (if random() < p\r\n        then 1\r\n        else 0)\r\n    else error(\"Argument p must be a probability (0 <= p <= 1).\")\r\n\r\n@name(\"Binomial distribution sampling\")\r\n@url(\"https://en.wikipedia.org/wiki/Binomial_distribution\")\r\n@description(\"Samples a binomial distribution by doing $n$ Bernoulli trials with probability $p$.\r\n              The parameter $n$ must be a positive integer, the parameter $p$ must be a probability ($0 \\le p \\le 1$).\")\r\nfn rand_binom(n: Scalar, p: Scalar) -> Scalar =\r\n    if n >= 1\r\n    then rand_binom(n-1, p) + rand_bernoulli(p)\r\n    else if n == 0\r\n    then 0\r\n    else error(\"Argument n must be a positive integer.\")\r\n\r\n@name(\"Normal distribution sampling\")\r\n@url(\"https://en.wikipedia.org/wiki/Normal_distribution\")\r\n@description(\"Samples a normal distribution with mean $\\\\mu$ and standard deviation $\\\\sigma$ using the Box-Muller transform.\")\r\nfn rand_norm<T: Dim>(μ: T, σ: T) -> T =\r\n    μ + sqrt(-2 σ² × ln(random())) × sin(2π × random())\r\n\r\n@name(\"Geometric distribution sampling\")\r\n@url(\"https://en.wikipedia.org/wiki/Geometric_distribution\")\r\n@description(\"Samples a geometric distribution (the distribution of the number of Bernoulli trials with probability $p$ needed to get one success) by inversion sampling. The parameter $p$ must be a probability ($0 \\le p \\le 1$).\")\r\nfn rand_geom(p: Scalar) -> Scalar =\r\n    if p>=0 && p<=1\r\n    then ceil( ln(1-random()) / ln(1-p) )\r\n    else error(\"Argument p must be a probability (0 <= p <= 1).\")\r\n\r\n# A helper function for rand_poisson, counts how many samples of the standard uniform distribution need to be multiplied to fall below lim.\r\nfn _poisson(lim: Scalar, prod: Scalar) -> Scalar =\r\n    if prod > lim\r\n    then _poisson(lim,  prod × random()) + 1\r\n    else -1\r\n\r\n@name(\"Poisson distribution sampling\")\r\n@url(\"https://en.wikipedia.org/wiki/Poisson_distribution\")\r\n@description(\"Sampling a poisson distribution with rate $\\\\lambda$, that is, the distribution of the number of events occurring in a fixed interval if these events occur with mean rate $\\\\lambda$. The rate parameter $\\\\lambda$ must be non-negative.\")\r\n# This implementation is based on the exponential distribution of inter-arrival times. For details see L. Devroye, Non-Uniform Random Variate Generation, p. 504, Lemma 3.3.\r\nfn rand_poisson(λ: Scalar) -> Scalar =\r\n    if λ >= 0\r\n    then _poisson(exp(-λ), 1)\r\n    else error(\"Argument λ must not be negative.\")\r\n\r\n@name(\"Exponential distribution sampling\")\r\n@url(\"https://en.wikipedia.org/wiki/Exponential_distribution\")\r\n@description(\"Sampling an exponential distribution (the distribution of the distance between events in a Poisson process with rate $\\\\lambda$) using inversion sampling. The rate parameter $\\\\lambda$ must be positive.\")\r\nfn rand_expon<T: Dim>(λ: T) -> 1/T =\r\n    if value_of(λ) > 0\r\n    then - ln(1-random()) / λ\r\n    else error(\"Argument λ must be positive.\")\r\n\r\n@name(\"Log-normal distribution sampling\")\r\n@url(\"https://en.wikipedia.org/wiki/Log-normal_distribution\")\r\n@description(\"Sampling a log-normal distribution, that is, a distribution whose logarithm is a normal distribution with mean $\\\\mu$ and standard deviation $\\\\sigma$.\")\r\nfn rand_lognorm(μ: Scalar, σ: Scalar) -> Scalar =\r\n    exp( μ + σ × rand_norm(0, 1) )\r\n\r\n@name(\"Pareto distribution sampling\")\r\n@url(\"https://en.wikipedia.org/wiki/Pareto_distribution\")\r\n@description(\"Sampling a Pareto distribution with minimum value `min` and shape parameter $\\\\alpha$ using inversion sampling. Both parameters must be positive.\")\r\nfn rand_pareto<T: Dim>(α: Scalar, min: T) -> T =\r\n    if value_of(min) > 0 && α > 0\r\n    then min / ((1-random())^(1/α))\r\n    else error(\"Both arguments α and min must be positive.\")\r\n",
  "math::geometry": "use core::functions\r\nuse math::constants\r\n\r\n@description(\"The length of the hypotenuse of a right-angled triangle $\\\\sqrt{{x^2+y^2}}$.\")\r\n@example(\"hypot2(3 m, 4 m)\")\r\nfn hypot2<T: Dim>(x: T, y: T) -> T = sqrt(x^2 + y^2)\r\n\r\n@description(\"The Euclidean norm of a 3D vector $\\\\sqrt{{x^2+y^2+z^2}}$.\")\r\n@example(\"hypot3(8, 9, 12)\")\r\nfn hypot3<T: Dim>(x: T, y: T, z: T) -> T = sqrt(x^2 + y^2 + z^2)\r\n\r\n# The following functions use a generic dimension instead of\r\n# 'Length' in order to allow for computations in pixels, for\r\n# example\r\n\r\n@description(\"The area of a circle, $\\\\pi r^2$.\")\r\nfn circle_area<L: Dim>(radius: L) -> L^2 = π × radius^2\r\n\r\n@description(\"The circumference of a circle, $2\\\\pi r$.\")\r\nfn circle_circumference<L: Dim>(radius: L) -> L = 2 π × radius\r\n\r\n@description(\"The surface area of a sphere, $4\\\\pi r^2$.\")\r\nfn sphere_area<L: Dim>(radius: L) -> L^2 = 4 π × radius^2\r\n\r\n@description(\"The volume of a sphere, $\\\\frac{{4}}{{3}}\\\\pi r^3$.\")\r\nfn sphere_volume<L: Dim>(radius: L) -> L^3 = 4/3 × π × radius^3\r\n",
  "math::number_theory": "use core::scalar\r\nuse core::functions\r\n\r\n@name(\"Greatest common divisor\")\r\n@description(\"The largest positive integer that divides each of the integers $a$ and $b$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Greatest_common_divisor\")\r\n@example(\"gcd(60, 42)\")\r\nfn gcd(a: Scalar, b: Scalar) -> Scalar =\r\n  if b == 0\r\n    then abs(a)\r\n    else gcd(b, mod(a, b))\r\n\r\n@name(\"Least common multiple\")\r\n@description(\"The smallest positive integer that is divisible by both $a$ and $b$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Least_common_multiple\")\r\n@example(\"lcm(14, 4)\")\r\nfn lcm(a: Scalar, b: Scalar) -> Scalar = abs(a * b) / gcd(a, b)\r\n",
  "math::percentage_calculations": "use core::scalar\r\nuse units::partsperx\r\n\r\n@description(\"Increase a quantity by the given percentage.\")\r\n@url(\"https://en.wikipedia.org/wiki/Percentage#Percentage_increase_and_decrease\")\r\n@example(\"72 € |> increase_by(15%)\")\r\nfn increase_by<D: Dim>(percentage: Scalar, quantity: D) = quantity * (1 + percentage)\r\n\r\n@description(\"Decrease a quantity by the given percentage.\")\r\n@url(\"https://en.wikipedia.org/wiki/Percentage#Percentage_increase_and_decrease\")\r\n@example(\"210 cm |> decrease_by(10%)\")\r\nfn decrease_by<D: Dim>(percentage: Scalar, quantity: D) = increase_by(-percentage, quantity)\r\n\r\n@description(\"By how many percent has a given quantity increased or decreased?\")\r\n@url(\"https://en.wikipedia.org/wiki/Percentage\")\r\n@example(\"percentage_change(35 kg, 42 kg)\")\r\nfn percentage_change<D: Dim>(old: D, new: D) = (new - old) / old -> %\r\n",
  "math::statistics": "use core::lists\r\n\r\n# TODO: remove these helpers once we support local definitions\r\nfn _max<D: Dim>(x: D, y: D) -> D = if x > y then x else y\r\nfn _min<D: Dim>(x: D, y: D) -> D = if x < y then x else y\r\n\r\n@name(\"Maximum\")\r\n@description(\"Get the largest element of a list.\")\r\n@example(\"maximum([30 cm, 2 m])\")\r\nfn maximum<D: Dim>(xs: List<D>) -> D =\r\n  if len(xs) == 1\r\n    then head(xs)\r\n    else _max(head(xs), maximum(tail(xs)))\r\n\r\n@name(\"Minimum\")\r\n@description(\"Get the smallest element of a list.\")\r\n@example(\"minimum([30 cm, 2 m])\")\r\nfn minimum<D: Dim>(xs: List<D>) -> D =\r\n  if len(xs) == 1\r\n    then head(xs)\r\n    else _min(head(xs), minimum(tail(xs)))\r\n\r\n@name(\"Arithmetic mean\")\r\n@description(\"Calculate the arithmetic mean of a list of quantities.\")\r\n@example(\"mean([1 m, 2 m, 300 cm])\")\r\n@url(\"https://en.wikipedia.org/wiki/Arithmetic_mean\")\r\nfn mean<D: Dim>(xs: List<D>) -> D = if is_empty(xs) then 0 else sum(xs) / len(xs)\r\n\r\n@name(\"Variance\")\r\n@url(\"https://en.wikipedia.org/wiki/Variance\")\r\n@description(\"Calculate the population variance of a list of quantities\")\r\n@example(\"variance([1 m, 2 m, 300 cm])\")\r\nfn variance<D: Dim>(xs: List<D>) -> D^2 =\r\n  mean(map(sqr, xs)) - sqr(mean(xs))\r\n\r\n@name(\"Standard deviation\")\r\n@url(\"https://en.wikipedia.org/wiki/Standard_deviation\")\r\n@description(\"Calculate the population standard deviation of a list of quantities\")\r\n@example(\"stdev([1 m, 2 m, 300 cm])\")\r\nfn stdev<D: Dim>(xs: List<D>) -> D = sqrt(variance(xs))\r\n\r\n@name(\"Median\")\r\n@url(\"https://en.wikipedia.org/wiki/Median\")\r\n@description(\"Calculate the median of a list of quantities\")\r\n@example(\"median([1 m, 2 m, 400 cm])\")\r\nfn median<D: Dim>(xs: List<D>) -> D =  # TODO: this is extremely inefficient\r\n  if mod(n, 2) == 1\r\n    then element_at((n - 1) / 2, sorted)\r\n    else (element_at(n / 2 - 1, sorted) + element_at(n / 2, sorted)) / 2\r\n  where\r\n    n = len(xs)\r\n    and sorted = sort(xs)\r\n",
  "math::transcendental": "use core::scalar\r\n\r\n@name(\"Exponential function\")\r\n@description(\"The exponential function, $e^x$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Exponential_function\")\r\n@example(\"exp(4)\")\r\nfn exp(x: Scalar) -> Scalar\r\n\r\n@name(\"Natural logarithm\")\r\n@description(\"The natural logarithm with base $e$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Natural_logarithm\")\r\n@example(\"ln(20)\")\r\nfn ln(x: Scalar) -> Scalar\r\n\r\n@name(\"Natural logarithm\")\r\n@description(\"The natural logarithm with base $e$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Natural_logarithm\")\r\n@example(\"log(20)\")\r\nfn log(x: Scalar) -> Scalar = ln(x)\r\n\r\n@name(\"Common logarithm\")\r\n@description(\"The common logarithm with base $10$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Common_logarithm\")\r\n@example(\"log10(100)\")\r\nfn log10(x: Scalar) -> Scalar\r\n\r\n@name(\"Binary logarithm\")\r\n@description(\"The binary logarithm with base $2$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Binary_logarithm\")\r\n@example(\"log2(256)\")\r\nfn log2(x: Scalar) -> Scalar\r\n\r\n@name(\"Gamma function\")\r\n@description(\"The gamma function, $\\\\Gamma(x)$.\")\r\n@url(\"https://en.wikipedia.org/wiki/Gamma_function\")\r\nfn gamma(x: Scalar) -> Scalar\r\n",
  "math::trigonometry": "use core::scalar\r\n\r\n@name(\"Sine\")\r\n@url(\"https://en.wikipedia.org/wiki/Trigonometric_functions\")\r\nfn sin(x: Scalar) -> Scalar\r\n\r\n@name(\"Cosine\")\r\n@url(\"https://en.wikipedia.org/wiki/Trigonometric_functions\")\r\nfn cos(x: Scalar) -> Scalar\r\n\r\n@name(\"Tangent\")\r\n@url(\"https://en.wikipedia.org/wiki/Trigonometric_functions\")\r\nfn tan(x: Scalar) -> Scalar\r\n\r\n@name(\"Arc sine\")\r\n@url(\"https://en.wikipedia.org/wiki/Inverse_trigonometric_functions\")\r\nfn asin(x: Scalar) -> Scalar\r\n\r\n@name(\"Arc cosine\")\r\n@url(\"https://en.wikipedia.org/wiki/Inverse_trigonometric_functions\")\r\nfn acos(x: Scalar) -> Scalar\r\n\r\n@name(\"Arc tangent\")\r\n@url(\"https://en.wikipedia.org/wiki/Inverse_trigonometric_functions\")\r\nfn atan(x: Scalar) -> Scalar\r\n\r\n@url(\"https://en.wikipedia.org/wiki/Atan2\")\r\nfn atan2<T: Dim>(y: T, x: T) -> Scalar\r\n\r\n@name(\"Hyperbolic sine\")\r\n@url(\"https://en.wikipedia.org/wiki/Hyperbolic_functions\")\r\nfn sinh(x: Scalar) -> Scalar\r\n\r\n@name(\"Hyperbolic cosine\")\r\n@url(\"https://en.wikipedia.org/wiki/Hyperbolic_functions\")\r\nfn cosh(x: Scalar) -> Scalar\r\n\r\n@name(\"Hyperbolic tangent\")\r\n@url(\"https://en.wikipedia.org/wiki/Hyperbolic_functions\")\r\nfn tanh(x: Scalar) -> Scalar\r\n\r\n@name(\"Area hyperbolic sine\")\r\n@url(\"https://en.wikipedia.org/wiki/Hyperbolic_functions\")\r\nfn asinh(x: Scalar) -> Scalar\r\n\r\n@name(\"Area hyperbolic cosine\")\r\n@url(\"https://en.wikipedia.org/wiki/Hyperbolic_functions\")\r\nfn acosh(x: Scalar) -> Scalar\r\n\r\n@name(\"Area hyperbolic tangent\")\r\n@url(\"https://en.wikipedia.org/wiki/Hyperbolic_functions\")\r\nfn atanh(x: Scalar) -> Scalar\r\n\r\n# Note: there are even more functions in `math::trigonometry_extra`.\r\n",
  "math::trigonometry_extra": "use core::scalar\r\nuse core::functions\r\nuse math::constants\r\nuse math::trigonometry\r\nuse math::transcendental\r\n\r\nfn cot(x: Scalar) -> Scalar = 1 / tan(x)\r\nfn acot(x: Scalar) -> Scalar = atan(1 / x)\r\n\r\nfn coth(x: Scalar) -> Scalar = (e^x + e^-x) / (e^x - e^-x)\r\nfn acoth(x: Scalar) -> Scalar = 1/2 × ln((x + 1) / (x - 1))\r\n\r\nfn secant(x: Scalar) -> Scalar = 1 / cos(x)\r\nfn arcsecant(x: Scalar) -> Scalar = acos(1 / x)\r\n\r\nfn cosecant(x: Scalar) -> Scalar = 1 / sin(x)\r\nfn csc(x: Scalar) -> Scalar = cosecant(x)\r\nfn acsc(x: Scalar) -> Scalar = asin(1 / x)\r\n\r\nfn sech(x: Scalar) -> Scalar = 1 / cosh(x)\r\nfn asech(x: Scalar) -> Scalar = ln(sqrt(1 / x - 1) sqrt(1 / x + 1) + 1 / x)\r\n\r\nfn csch(x: Scalar) -> Scalar = 1 / sinh(x)\r\nfn acsch(x: Scalar) -> Scalar = ln(sqrt(1 + 1 / x^2) + 1 / x)\r\n",
  "numerics::diff": "use core::quantities\r\nuse core::lists\r\n\r\n@name(\"Numerical differentiation\")\r\n@url(\"https://en.wikipedia.org/wiki/Numerical_differentiation\")\r\n@description(\"Compute the numerical derivative of the function $f$ at point $x$ using the central difference method.\")\r\n@example(\"fn polynomial(x) = x² - x - 1\\ndiff(polynomial, 1, 1e-10)\", \"Compute the derivative of $f(x) = x² -x -1$ at $x=1$.\")\r\n@example(\"fn distance(t) = 0.5 g0 t²\\nfn velocity(t) = diff(distance, t, 1e-10 s)\\nvelocity(2 s)\", \"Compute the free fall velocity after $t=2 s$.\")\r\nfn diff<X: Dim, Y: Dim>(f: Fn[(X) -> Y], x: X, Δx: X) -> Y / X =\r\n  (f(x + Δx) - f(x - Δx)) / 2 Δx\r\n\r\nstruct RungeKuttaResult<X: Dim, Y: Dim> {\r\n  xs: List<X>,\r\n  ys: List<Y>,\r\n}\r\n\r\nfn _dsolve_runge_kutta<X: Dim, Y: Dim>(\r\n  f: Fn[(X, Y) -> Y / X],\r\n  Δx: X,\r\n  steps: Scalar,\r\n  prev: RungeKuttaResult<X, Y>,\r\n) -> RungeKuttaResult<X, Y> =\r\n  if steps <= 0\r\n    then prev\r\n    else _dsolve_runge_kutta(f, Δx, steps - 1, RungeKuttaResult {\r\n        xs: cons_end(x_next, prev.xs),\r\n        ys: cons_end(y_next, prev.ys),\r\n      })\r\n  where x = element_at(len(prev.xs) - 1, prev.xs)\r\n    and y = element_at(len(prev.ys) - 1, prev.ys)\r\n    and k1 = f(x, y)\r\n    and k2 = f(x + Δx / 2, y + Δx k1 / 2)\r\n    and k3 = f(x + Δx / 2, y + Δx k2 / 2)\r\n    and k4 = f(x + Δx, y + Δx k3)\r\n    and x_next = x + Δx\r\n    and y_next = y + Δx / 6 × (k1 + 2 k2 + 2 k3 + k4)\r\n\r\n@name(\"Runge-Kutta method\")\r\n@url(\"https://en.wikipedia.org/wiki/Runge-Kutta_methods\")\r\n@description(\"Solve the ordinary differential equation $y' = f(x, y)$ on the interval $x \\\\in [x_0, x_e]$ with initial conditions $y(x_0) = y_0$ using the fourth-order Runge-Kutta method.\")\r\nfn dsolve_runge_kutta<X: Dim, Y: Dim>(\r\n  f: Fn[(X, Y) -> Y / X],\r\n  x_0: X,\r\n  x_e: X,\r\n  y_0: Y,\r\n  steps: Scalar\r\n) -> RungeKuttaResult<X, Y> =\r\n  _dsolve_runge_kutta(f, Δx, steps - 1, RungeKuttaResult { xs: [x_0], ys: [y_0] })\r\n  where Δx = (x_e - x_0) / (steps - 1)\r\n",
  "numerics::fixed_point": "use core::scalar\r\nuse core::functions\r\nuse core::error\r\n\r\nfn _fixed_point<X: Dim>(f: Fn[(X) -> X], x0: X, ε: X, max_iter: Scalar) =\r\n  if abs(x1 - x0) < ε\r\n    then x1\r\n    else\r\n      if max_iter > 0\r\n        then _fixed_point(f, x1, ε, max_iter - 1)\r\n        else error(\"fixed_point: Exceeded max. number of iterations\")\r\n  where\r\n    x1 = f(x0)\r\n\r\n@name(\"Fixed-point iteration\")\r\n@url(\"https://en.wikipedia.org/wiki/Fixed-point_iteration\")\r\n@description(\"Compute the approximate fixed point of a function $f: X \\\\rightarrow X$ starting from $x_0$, until $|f(x) - x| < ε$.\")\r\n@example(\"fn function(x) = x/2 - 1\\nfixed_point(function, 0, 0.01)\", \"Compute the fixed poin of $f(x) = x/2 -1$.\")\r\nfn fixed_point<X: Dim>(f: Fn[(X) -> X], x0: X, ε: X) =\r\n  _fixed_point(f, x0, ε, 100)\r\n",
  "numerics::solve": "use core::functions\r\nuse core::error\r\n\r\n@name(\"Bisection method\")\r\n@url(\"https://en.wikipedia.org/wiki/Bisection_method\")\r\n@description(\"Find the root of the function $f$ in the interval $[x_1, x_2]$ using the bisection method. The function $f$ must be continuous and $f(x_1) \\cdot f(x_2) < 0$.\")\r\n@example(\"fn f(x) = x² +x -2\\nroot_bisect(f, 0, 100, 0.01, 0.01)\", \"Find the root of $f(x) = x² +x -2$ in the interval $[0, 100]$.\")\r\nfn root_bisect<X: Dim, Y: Dim>(f: Fn[(X) -> Y], x1: X, x2: X, x_tol: X, y_tol: Y) -> X =\r\n  if abs(x1 - x2) < x_tol\r\n    then x_mean\r\n    else if abs(f_x_mean) < y_tol\r\n      then x_mean\r\n      else if f_x_mean × f(x1) < 0\r\n        then root_bisect(f, x1, x_mean, x_tol, y_tol)\r\n        else root_bisect(f, x_mean, x2, x_tol, y_tol)\r\n  where x_mean = (x1 + x2) / 2\r\n    and f_x_mean = f(x_mean)\r\n\r\nfn _root_newton_helper<X: Dim, Y: Dim>(f: Fn[(X) -> Y], f_prime: Fn[(X) -> Y / X], x0: X, y_tol: Y, max_iterations: Scalar) -> X =\r\n  if max_iterations <= 0\r\n    then error(\"root_newton: Maximum number of iterations reached. Try another initial guess?\")\r\n    else if abs(f_x0) < y_tol\r\n      then x0\r\n      else _root_newton_helper(f, f_prime, x0 - f_x0 / f_prime(x0), y_tol, max_iterations - 1)\r\n  where\r\n    f_x0 = f(x0)\r\n\r\n@name(\"Newton's method\")\r\n@url(\"https://en.wikipedia.org/wiki/Newton%27s_method\") \r\n@description(\"Find the root of the function $f(x)$ and its derivative $f'(x)$ using Newton's method.\")\r\n@example(\"fn f(x) = x² -3x +2\\nfn f_prime(x) = 2x -3\\nroot_newton(f, f_prime, 0 , 0.01)\", \"Find a root of $f(x) = x² -3x +2$ using Newton's method.\")\r\nfn root_newton<X: Dim, Y: Dim>(f: Fn[(X) -> Y], f_prime: Fn[(X) -> Y / X], x0: X, y_tol: Y) -> X =\r\n  _root_newton_helper(f, f_prime, x0, y_tol, 10_000)\r\n",
  "physics::constants": "use units::si\r\n\r\n@name(\"Speed of light in vacuum\")\r\n@url(\"https://en.wikipedia.org/wiki/Speed_of_light\")\r\n@aliases(c)\r\nlet speed_of_light: Velocity = 299_792_458 m / s\r\n\r\n@name(\"Newtonian constant of gravitation\")\r\n@url(\"https://en.wikipedia.org/wiki/Gravitational_constant\")\r\n@aliases(G)\r\nlet gravitational_constant: Force × Length^2 / Mass^2 =  6.674_30e-11 m³ / (kg s²)\r\n\r\n@name(\"Standard acceleration of gravity on earth\")\r\n@url(\"https://en.wikipedia.org/wiki/Gravity_of_Earth\")\r\n@aliases(g0)\r\nlet gravity: Acceleration = 9.806_65 m / s²\r\n\r\n@name(\"Planck constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Planck_constant\")\r\n@aliases(ℎ)\r\nlet planck_constant: Action = 6.626_070_15e-34 J / Hz\r\n\r\n@name(\"Reduced Planck constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Planck_constant#Reduced_Planck_constant_%E2%84%8F\")\r\n@aliases(h_bar)\r\nlet ℏ: AngularMomentum = planck_constant / 2π\r\n\r\n@name(\"Electron mass\")\r\n@url(\"https://en.wikipedia.org/wiki/Electron_mass\")\r\nlet electron_mass: Mass = 9.109_383_701_5e-31 kg\r\n\r\n@name(\"Elementary charge\")\r\n@url(\"https://en.wikipedia.org/wiki/Elementary_charge\")\r\n@aliases(electron_charge)\r\nlet elementary_charge: ElectricCharge =  1.602_176_634e-19 C\r\n\r\n@name(\"Vacuum permeability / magnetic constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Vacuum_permeability\")\r\n@aliases(µ0,μ0,mu0)\r\nlet magnetic_constant: MagneticPermeability =  1.256_637_062_12e-6 N / A²\r\n\r\n@name(\"Vacuum electric permittivity / electric constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Vacuum_permittivity\")\r\n@aliases(ε0,eps0)\r\nlet electric_constant: ElectricPermittivity = 1 / (µ0 c²) -> F/m\r\n\r\n@name(\"Bohr magneton\")\r\n@aliases(µ_B,μ_B)\r\n@url(\"https://en.wikipedia.org/wiki/Bohr_magneton\")\r\nlet bohr_magneton: Energy / MagneticFluxDensity = electron_charge ℏ / 2 electron_mass -> J/T\r\n\r\n@name(\"Fine structure constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Fine-structure_constant\")\r\n@aliases(α, alpha)\r\nlet fine_structure_constant: Scalar = electron_charge^2 / (2 eps0 ℎ c)\r\n\r\n@name(\"Proton mass\")\r\n@url(\"https://en.wikipedia.org/wiki/Proton\")\r\nlet proton_mass: Mass =  1.672_621_923_69e-27 kg\r\n\r\n@name(\"Neutron mass\")\r\n@url(\"https://en.wikipedia.org/wiki/Neutron\")\r\nlet neutron_mass: Mass = 1.674_927_498_04e-27 kg\r\n\r\n@name(\"Avogadro constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Avogadro_constant\")\r\n@aliases(N_A)\r\nlet avogadro_constant: 1 / AmountOfSubstance = 6.022_140_76e23 / mol\r\n\r\n@name(\"Boltzmann constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Boltzmann_constant\")\r\n@aliases(k_B)\r\nlet boltzmann_constant: Energy / Temperature = 1.380_649e-23 J / K\r\n\r\n@name(\"Stefan-Boltzmann constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Stefan%E2%80%93Boltzmann_law\")\r\nlet stefan_boltzmann_constant: Power / (Area × Temperature^4) = 2 π^5 k_B^4 / (15 planck_constant^3 c^2)\r\n\r\n@name(\"Molar gas constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Gas_constant\")\r\n@aliases(R)\r\nlet gas_constant: Energy / (AmountOfSubstance × Temperature) = k_B × N_A\r\n\r\n@name(\"Bohr radius\")\r\n@url(\"https://en.wikipedia.org/wiki/Bohr_radius\")\r\n@aliases(a0)\r\nlet bohr_radius: Length = 4 pi ε0 ℏ^2 / (electron_charge^2 electron_mass)\r\n\r\n@name(\"Rydberg constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Rydberg_constant\")\r\nlet rydberg_constant: Wavenumber = (electron_mass electron_charge^4) / (8 ε0^2 ℎ^3 c)\r\n\r\n@name(\"Rydberg unit of energy\")\r\n@url(\"https://en.wikipedia.org/wiki/Rydberg_constant\")\r\nunit Ry: Energy = ℎ c × rydberg_constant\r\n\r\n@name(\"Atomic Mass constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Atomic_mass_constant\")\r\n@aliases(m_u)\r\nlet atomic_mass_constant: Mass = 1 dalton -> kg\r\n\r\n@name(\"Conductance quantum\")\r\n@url(\"https://en.wikipedia.org/wiki/Conductance_quantum\")\r\nlet conductance_quantum: ElectricConductance = 2 * elementary_charge^2 / planck_constant\r\n\r\n@name(\"Faraday constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Faraday_constant\")\r\nlet faraday_constant: ElectricCharge / AmountOfSubstance = avogadro_constant * elementary_charge\r\n\r\n@name(\"Magnetic Flux Quantum\")\r\n@url(\"https://en.wikipedia.org/wiki/Magnetic_flux_quantum\")\r\nlet magnetic_flux_quantum: MagneticFlux = planck_constant / (2 * elementary_charge)\r\n\r\n@name(\"Josephson Constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Josephson_constant\")\r\nlet josephson_constant: Frequency / Voltage = 1 / magnetic_flux_quantum -> Hz/V\r\n\r\n@name(\"Von Klitzing Constant\")\r\n@url(\"https://en.wikipedia.org/wiki/Von_Klitzing_constant\")\r\n@aliases(R_K)\r\nlet von_klitzing_constant: ElectricResistance = planck_constant / (elementary_charge^2)\r\n",
  "physics::speed_of_sound": "use core::functions\r\nuse physics::constants\r\nuse physics::temperature_conversion\r\n\r\n@name(\"Speed of sound in dry air\")\r\n@description(\"Calculate the speed of sound in dry air as a function of air temperature.\")\r\n@example(\"speed_of_sound(20 °C)\")\r\n@url(\"https://en.wikipedia.org/wiki/Speed_of_sound#Speed_of_sound_in_ideal_gases_and_air\")\r\nfn speed_of_sound(T_air: Temperature) -> Velocity =\r\n    sqrt(γ_air R T_air / M_air) -> m / s\r\n  where γ_air = 7/5\r\n    and M_air = 28.96 g / mol\r\n",
  "physics::temperature_conversion": "use units::si\r\n\r\n### Temperature conversion functions K <-> °C and K <-> °F\r\n\r\nlet _offset_celsius = 273.15\r\n\r\n# Note: from_celsius is used internally by the `… °C` syntax\r\nfn from_celsius(t_celsius: Scalar) -> Temperature = (t_celsius + _offset_celsius) kelvin\r\n\r\n@description(\"Converts from Kelvin to degree Celsius (°C). Can be used on the right hand side of a conversion operator.\")\r\n@example(\"300 K -> °C\", \"Convert 300 K to degree Celsius.\")\r\n@example(\"55 °F -> °C\", \"Convert 55 °F to degree Celsius.\")\r\n@url(\"https://en.wikipedia.org/wiki/Conversion_of_scales_of_temperature\")\r\nfn °C(t_kelvin: Temperature) -> Scalar = t_kelvin / kelvin - _offset_celsius\r\n\r\n@description(\"An alias for `°C`.\")\r\nfn celsius(t_kelvin: Temperature) -> Scalar = °C(t_kelvin)\r\n\r\n@description(\"An alias for `°C`.\")\r\nfn degree_celsius(t_kelvin: Temperature) -> Scalar = °C(t_kelvin)\r\n\r\nlet _offset_fahrenheit = 459.67\r\nlet _scale_fahrenheit = 5 / 9\r\n\r\n# Note: from_fahrenheit is used internally by the `… °F` syntax\r\nfn from_fahrenheit(t_fahrenheit: Scalar) -> Temperature = ((t_fahrenheit + _offset_fahrenheit) × _scale_fahrenheit) kelvin\r\n\r\n@description(\"Converts from Kelvin to degree Fahrenheit (°F). Can be used on the right hand side of a conversion operator.\")\r\n@example(\"300 K -> °F\", \"Convert 300 K to degree Fahrenheit.\")\r\n@example(\"25 °C -> °F\", \"Convert 25 °C to degree Fahrenheit.\")\r\n@url(\"https://en.wikipedia.org/wiki/Conversion_of_scales_of_temperature\")\r\nfn °F(t_kelvin: Temperature) -> Scalar = (t_kelvin / kelvin) / _scale_fahrenheit - _offset_fahrenheit\r\n\r\n@description(\"An alias for `°F`.\")\r\nfn fahrenheit(t_kelvin: Temperature) -> Scalar = °F(t_kelvin)\r\n\r\n@description(\"An alias for `°F`.\")\r\nfn degree_fahrenheit(t_kelvin: Temperature) -> Scalar = °F(t_kelvin)\r\n",
  "plot::bar_chart": "use core::lists\r\nuse plot::common\r\n\r\nstruct BarChart<V: Dim> {\r\n  value_label: String,\r\n  values: List<V>,\r\n  x_labels: List<String>,\r\n}\r\n\r\nfn _default_label(n: Scalar) -> String = \"{n}\"\r\n\r\nfn bar_chart<V: Dim>(values: List<V>) -> BarChart<V> =\r\n  BarChart {\r\n    value_label: \"\",\r\n    values: values,\r\n    x_labels: map(_default_label, range(1, len(values))),\r\n  }\r\n\r\nfn xlabels<V: Dim>(ls: List<String>, chart: BarChart<V>) -> BarChart<V> =\r\n  BarChart {\r\n    value_label: chart.value_label,\r\n    values: chart.values,\r\n    x_labels: ls,\r\n  }\r\n\r\nfn value_label<V: Dim>(label: String, chart: BarChart<V>) -> BarChart<V> =\r\n  BarChart {\r\n    value_label: label,\r\n    values: chart.values,\r\n    x_labels: chart.x_labels,\r\n  }\r\n",
  "plot::common": "use core::quantities\r\nuse core::strings\r\n\r\n# TODO: this function is overly generic, but we don't have bounded\r\n# polymorphism yet.\r\nfn show<Plot>(plot: Plot) -> String\r\n",
  "plot::line_plot": "use core::quantities\r\nuse core::lists\r\nuse plot::common\r\n\r\nstruct LinePlot<X: Dim, Y: Dim> {\r\n  x_label: String,\r\n  y_label: String,\r\n  xs: List<X>,\r\n  ys: List<Y>,\r\n}\r\nlet _num_points_for_line_plot = 2000\r\n\r\nfn line_plot<X: Dim, Y: Dim>(f: Fn[(X) -> Y], x_start: X, x_end: X) -> LinePlot<X, Y> =\r\n  LinePlot {\r\n    x_label: \"\",\r\n    y_label: \"\",\r\n    xs: xs,\r\n    ys: map(f, xs)\r\n  }\r\n  where\r\n    xs = linspace(x_start, x_end, _num_points_for_line_plot)\r\n\r\nfn xlabel<X: Dim, Y: Dim>(label: String, plot: LinePlot<X, Y>) -> LinePlot<X, Y> =\r\n  LinePlot {  # TODO: this would be much nicer with some form of struct update syntax: `plot { x_label: label }`\r\n    x_label: label,\r\n    y_label: plot.y_label,\r\n    xs: plot.xs,\r\n    ys: plot.ys,\r\n  }\r\n\r\nfn ylabel<X: Dim, Y: Dim>(label: String, plot: LinePlot<X, Y>) -> LinePlot<X, Y> =\r\n  LinePlot {\r\n    x_label: plot.x_label,\r\n    y_label: label,\r\n    xs: plot.xs,\r\n    ys: plot.ys,\r\n  }\r\n",
  "prelude": "use core::scalar\r\nuse core::quantities\r\nuse core::dimensions\r\nuse core::functions\r\nuse core::lists\r\nuse core::strings\r\nuse core::error\r\nuse core::debug\r\nuse core::random\r\nuse core::numbers\r\nuse core::mixed_units\r\n\r\nuse math::constants\r\nuse math::transcendental\r\nuse math::trigonometry\r\nuse math::trigonometry_extra\r\nuse math::statistics\r\nuse math::number_theory\r\nuse math::distributions\r\nuse math::geometry\r\nuse math::percentage_calculations\r\nuse math::combinatorics\r\n\r\nuse units::si\r\nuse units::time\r\nuse units::astronomical\r\nuse units::imperial\r\nuse units::us_customary\r\nuse units::nautical\r\nuse units::cgs\r\nuse units::planck\r\nuse units::fff\r\nuse units::misc\r\nuse units::humorous\r\nuse units::partsperx\r\nuse units::mixed\r\n\r\nuse units::currency\r\nuse units::bit\r\nuse units::placeholder\r\n\r\nuse physics::constants\r\nuse physics::temperature_conversion\r\nuse physics::speed_of_sound\r\n\r\nuse chemistry::elements\r\n\r\nuse datetime::functions\r\nuse datetime::unixtime\r\nuse datetime::human\r\nuse datetime::julian_date\r\n\r\nuse plot::line_plot\r\nuse plot::bar_chart\r\n",
  "units::astronomical": "use units::si\r\n\r\n@name(\"Parsec\")\r\n@url(\"https://en.wikipedia.org/wiki/Parsec\")\r\n@metric_prefixes\r\n@aliases(parsecs, pc: short)\r\nunit parsec: Length = 648_000 / π × au\r\n\r\n@name(\"Light-year\")\r\n@url(\"https://en.wikipedia.org/wiki/Light-year\")\r\n@metric_prefixes\r\n@aliases(lightyears, ly: short, lyr: short)\r\nunit lightyear: Length = 9_460_730_472_580_800 m\r\n\r\n@name(\"Sidereal day\")\r\n@url(\"https://en.wikipedia.org/wiki/Sidereal_time#Sidereal_day\")\r\n@aliases(sidereal_days)\r\nunit sidereal_day: Time = 86164.0905 s\r\n",
  "units::bit": "use units::si\r\n\r\ndimension DigitalInformation\r\ndimension DataRate = DigitalInformation / Time\r\n\r\n@name(\"Bit\")\r\n@url(\"https://en.wikipedia.org/wiki/Bit\")\r\n@metric_prefixes\r\n@binary_prefixes\r\n@aliases(bit: both, bits: both)\r\nunit bit: DigitalInformation\r\n\r\n@name(\"Byte\")\r\n@url(\"https://en.wikipedia.org/wiki/Byte\")\r\n@metric_prefixes\r\n@binary_prefixes\r\n@aliases(B: short, byte: both, bytes: both, Byte: both, Bytes: both, octet, octets, Octet, Octets)\r\nunit byte: DigitalInformation = 8 bit\r\n\r\n@name(\"KB is a non-standard but commonly used abbreviation for kilobyte\")\r\n@url(\"https://en.wikipedia.org/wiki/Kilobyte\")\r\nunit KB: DigitalInformation = kB\r\n\r\n@name(\"Bits per second\")\r\n@url(\"https://en.wikipedia.org/wiki/Bit_per_second\")\r\n@metric_prefixes\r\n@aliases(bps: short)\r\nunit bps: DataRate = bit / second\r\n",
  "units::cgs": "use units::si\r\n\r\n### Centimetre–gram–second system of units\r\n\r\n@name(\"Dyne\")\r\n@url(\"https://en.wikipedia.org/wiki/Dyne\")\r\n@aliases(dyn)\r\nunit dyne: Force = 1e-5 N\r\n\r\n@name(\"Erg\")\r\n@url(\"https://en.wikipedia.org/wiki/Erg\")\r\n@aliases(ergs)\r\nunit erg: Energy = 1 dyn cm\r\n\r\n@name(\"Gauss\")\r\n@url(\"https://en.wikipedia.org/wiki/Gauss_(unit)\")\r\nunit gauss: MagneticFluxDensity = 100 µT\r\n\r\n@name(\"Maxwell\")\r\n@url(\"https://en.wikipedia.org/wiki/Maxwell_(unit)\")\r\n@aliases(Mx)\r\nunit maxwell: MagneticFlux = 1 gauss × cm^2\r\n\r\n@name(\"Oersted\")\r\n@url(\"https://en.wikipedia.org/wiki/Oersted\")\r\n@metric_prefixes\r\n@aliases(Oe: short)\r\nunit oersted: MagneticFieldStrength = 1 / (4 pi) * dyne / maxwell\r\n\r\n@name(\"Poise\")\r\n@url(\"https://en.wikipedia.org/wiki/Poise_(unit)\")\r\n@metric_prefixes\r\nunit poise: DynamicViscosity = 1 dyn × s / cm^2\r\n\r\n@name(\"Stokes\")\r\n@url(\"https://en.wikipedia.org/wiki/Stokes_(unit)\")\r\n@metric_prefixes\r\n@aliases(St: short)\r\nunit stokes: KinematicViscosity = cm^2 / s\r\n",
  "units::currencies": "use core::scalar\r\nuse units::currency\r\n\r\n# This module is currently not part of the prelude, because the 'exchange_rate(\"XYZ\")' calls\r\n# are blocking. For the CLI application, we do however load this module on demand if one of\r\n# the identifiers below is. For the Web version, we asynchronously load exchange rates and then\r\n# pull in this module.\r\n\r\nfn exchange_rate(currency: String) -> Scalar\r\n\r\n@name(\"US dollar\")\r\n@url(\"https://en.wikipedia.org/wiki/United_States_dollar\")\r\n@aliases(dollars, USD, usd, $: short)\r\nunit dollar: Money = EUR / exchange_rate(\"USD\")\r\n\r\n@name(\"Japanese yen\")\r\n@url(\"https://en.wikipedia.org/wiki/Japanese_yen\")\r\n@aliases(JPY, jpy, ¥: short, 円)\r\nunit yen: Money = EUR / exchange_rate(\"JPY\")\r\n\r\n@name(\"Pound sterling\")\r\n@url(\"https://en.wikipedia.org/wiki/Pound_sterling\")\r\n@aliases(pound_sterling, GBP, gbp, £: short)\r\nunit british_pound: Money = EUR / exchange_rate(\"GBP\")\r\n\r\n@name(\"Chinese yuan\")\r\n@url(\"https://en.wikipedia.org/wiki/Renminbi\")\r\n@aliases(yuan, CNY: short, cny, 元)\r\nunit renminbi: Money = EUR / exchange_rate(\"CNY\")\r\n\r\n@name(\"Australian dollar\")\r\n@url(\"https://en.wikipedia.org/wiki/Australian_dollar\")\r\n@aliases(australian_dollars, AUD: short, aud, A$)\r\nunit australian_dollar: Money = EUR / exchange_rate(\"AUD\")\r\n\r\n@name(\"Canadian dollar\")\r\n@url(\"https://en.wikipedia.org/wiki/Canadian_dollar\")\r\n@aliases(canadian_dollars, CAD: short, cad, C$, c$)\r\nunit canadian_dollar: Money = EUR / exchange_rate(\"CAD\")\r\n\r\n@name(\"Swiss franc\")\r\n@url(\"https://en.wikipedia.org/wiki/Swiss_franc\")\r\n@aliases(swiss_francs, CHF: short, chf)\r\nunit swiss_franc: Money = EUR / exchange_rate(\"CHF\")\r\n\r\n@name(\"Bulgarian lev\")\r\n@url(\"https://en.wikipedia.org/wiki/Bulgarian_lev\")\r\n@aliases(bulgarian_leva, BGN: short, bgn)\r\nunit bulgarian_lev: Money = EUR / exchange_rate(\"BGN\")\r\n\r\n@name(\"Czech koruna\")\r\n@url(\"https://en.wikipedia.org/wiki/Czech_koruna\")\r\n@aliases(czech_korunas, CZK: short, czk, Kč)\r\nunit czech_koruna: Money = EUR / exchange_rate(\"CZK\")\r\n\r\n@name(\"Hungarian forint\")\r\n@url(\"https://en.wikipedia.org/wiki/Hungarian_forint\")\r\n@aliases(hungarian_forints, HUF: short, huf, Ft)\r\nunit hungarian_forint: Money = EUR / exchange_rate(\"HUF\")\r\n\r\n@name(\"Polish złoty\")\r\n@url(\"https://en.wikipedia.org/wiki/Polish_złoty\")\r\n@aliases(polish_zlotys, PLN: short, pln, zł)\r\nunit polish_zloty: Money = EUR / exchange_rate(\"PLN\")\r\n\r\n@name(\"Romanian leu\")\r\n@url(\"https://en.wikipedia.org/wiki/Romanian_leu\")\r\n@aliases(romanian_leus, RON: short, ron, lei)\r\nunit romanian_leu: Money = EUR / exchange_rate(\"RON\")\r\n\r\n@name(\"Turkish lira\")\r\n@url(\"https://en.wikipedia.org/wiki/Turkish_lira\")\r\n@aliases(turkish_liras, TRY: short, try, ₺)\r\nunit turkish_lira: Money = EUR / exchange_rate(\"TRY\")\r\n\r\n@name(\"Brazilian real\")\r\n@url(\"https://en.wikipedia.org/wiki/Brazilian_real\")\r\n@aliases(brazilian_reals, BRL: short, brl, R$, r$)\r\nunit brazilian_real: Money = EUR / exchange_rate(\"BRL\")\r\n\r\n@name(\"Hong Kong dollar\")\r\n@url(\"https://en.wikipedia.org/wiki/Hong_Kong_dollar\")\r\n@aliases(hong_kong_dollars, HKD: short, hkd, HK$, hk$)\r\nunit hong_kong_dollar: Money = EUR / exchange_rate(\"HKD\")\r\n\r\n@name(\"Indonesian rupiah\")\r\n@url(\"https://en.wikipedia.org/wiki/Indonesian_rupiah\")\r\n@aliases(indonesian_rupiahs, IDR: short, idr, Rp)\r\nunit indonesian_rupiah: Money = EUR / exchange_rate(\"IDR\")\r\n\r\n@name(\"Indian rupee\")\r\n@url(\"https://en.wikipedia.org/wiki/Indian_rupee\")\r\n@aliases(indian_rupees, INR: short, inr, ₹)\r\nunit indian_rupee: Money = EUR / exchange_rate(\"INR\")\r\n\r\n@name(\"South Korean won\")\r\n@url(\"https://en.wikipedia.org/wiki/South_Korean_won\")\r\n@aliases(south_korean_wons, KRW: short, krw, ₩)\r\nunit south_korean_won: Money = EUR / exchange_rate(\"KRW\")\r\n\r\n@name(\"Malaysian ringgit\")\r\n@url(\"https://en.wikipedia.org/wiki/Malaysian_ringgit\")\r\n@aliases(malaysian_ringgits, MYR: short, RM)\r\nunit malaysian_ringgit: Money = EUR / exchange_rate(\"MYR\")\r\n\r\n@name(\"New Zealand dollar\")\r\n@url(\"https://en.wikipedia.org/wiki/New_Zealand_dollar\")\r\n@aliases(new_zealand_dollars, NZD: short, nzd, NZ$, nz$)\r\nunit new_zealand_dollar: Money = EUR / exchange_rate(\"NZD\")\r\n\r\n@name(\"Philippine peso\")\r\n@url(\"https://en.wikipedia.org/wiki/Philippine_peso\")\r\n@aliases(philippine_pesos, PHP: short, php, ₱)\r\nunit philippine_peso: Money = EUR / exchange_rate(\"PHP\")\r\n\r\n@name(\"Singapore dollar\")\r\n@url(\"https://en.wikipedia.org/wiki/Singapore_dollar\")\r\n@aliases(singapore_dollars, SGD: short, sgd, S$)\r\nunit singapore_dollar: Money = EUR / exchange_rate(\"SGD\")\r\n\r\n@name(\"Thai baht\")\r\n@url(\"https://en.wikipedia.org/wiki/Thai_baht\")\r\n@aliases(thai_bahts, THB: short, thb, ฿)\r\nunit thai_baht: Money = EUR / exchange_rate(\"THB\")\r\n\r\n@name(\"Danish krone\")\r\n@url(\"https://en.wikipedia.org/wiki/Danish_krone\")\r\n@aliases(danish_kroner, DKK: short, dkk)\r\nunit danish_krone: Money = EUR / exchange_rate(\"DKK\")\r\n\r\n@name(\"Swedish krona\")\r\n@url(\"https://en.wikipedia.org/wiki/Swedish_krona\")\r\n@aliases(swedish_kronor, SEK: short, sek)\r\nunit swedish_krona: Money = EUR / exchange_rate(\"SEK\")\r\n\r\n@name(\"Icelandic króna\")\r\n@url(\"https://en.wikipedia.org/wiki/Icelandic_króna\")\r\n@aliases(icelandic_krónur, icelandic_krona, icelandic_kronur, ISK: short, isk)\r\nunit icelandic_króna: Money = EUR / exchange_rate(\"ISK\")\r\n\r\n@name(\"Norwegian krone\")\r\n@url(\"https://en.wikipedia.org/wiki/Norwegian_krone\")\r\n@aliases(norwegian_kroner, NOK: short, nok)\r\nunit norwegian_krone: Money = EUR / exchange_rate(\"NOK\")\r\n\r\n@name(\"Israeli new shekel\")\r\n@url(\"https://en.wikipedia.org/wiki/Israeli_new_shekel\")\r\n@aliases(israeli_new_shekels, ILS: short, ils, ₪, NIS, nis)\r\nunit israeli_new_shekel: Money = EUR / exchange_rate(\"ILS\")\r\n\r\n@name(\"South African rand\")\r\n@url(\"https://en.wikipedia.org/wiki/South_African_rand\")\r\n@aliases(ZAR: short, zar)\r\nunit south_african_rand: Money = EUR / exchange_rate(\"ZAR\")\r\n",
  "units::currency": "dimension Money\r\n\r\n\r\n@name(\"Euro\")\r\n@url(\"https://en.wikipedia.org/wiki/Euro\")\r\n@aliases(euros, EUR, eur, €: short)\r\nunit euro: Money\r\n\r\n# See currencies.nbt for non-Euro currencies\r\n",
  "units::fff": "use units::imperial\r\n\r\n# The furlong–firkin–fortnight system\r\n# https://en.wikipedia.org/wiki/FFF_system\r\n\r\n@name(\"Furlong\")\r\n@url(\"https://en.wikipedia.org/wiki/Furlong\")\r\n@metric_prefixes\r\n@aliases(furlongs)\r\nunit furlong: Length = 220 yard\r\n\r\n@name(\"Firkin\")\r\n@url(\"https://en.wikipedia.org/wiki/Firkin_(unit)\")\r\n@metric_prefixes\r\n@aliases(firkins)\r\nunit firkin: Mass = 90 lb\r\n\r\n@name(\"Fortnight\")\r\n@url(\"https://en.wikipedia.org/wiki/Fortnight\")\r\n@metric_prefixes\r\n@aliases(fortnights)\r\nunit fortnight: Time = 14 days\r\n",
  "units::hartree": "use physics::constants\r\n\r\n@name(\"Hartree\")\r\n@url(\"https://en.wikipedia.org/wiki/Hartree\")\r\n@aliases(hartrees)\r\nunit hartree: Energy = ℏ^2 / (electron_mass a0^2)\r\n\r\n@name(\"Bohr\")\r\n@url(\"https://en.wikipedia.org/wiki/Hartree_atomic_units\")\r\nunit bohr: Length = a0\r\n",
  "units::humorous": "use units::si\r\nuse units::imperial\r\n\r\n@name(\"Smoot\")\r\n@url(\"https://en.wikipedia.org/wiki/Smoot\")\r\nunit smoot: Length = 5 feet + 7 inch\r\n",
  "units::imperial": "use units::si\r\nuse units::misc\r\n\r\n### Imperial unit system\r\n\r\n@name(\"Inch\")\r\n@url(\"https://en.wikipedia.org/wiki/Inch\")\r\n@aliases(inches, in: short)\r\nunit inch: Length = 0.0254 meter\r\n\r\n@name(\"Foot\")\r\n@url(\"https://en.wikipedia.org/wiki/Foot_(unit)\")\r\n@aliases(feet, ft: short)\r\nunit foot: Length = 12 inch\r\n\r\n@name(\"Yard\")\r\n@url(\"https://en.wikipedia.org/wiki/Yard\")\r\n@aliases(yards, yd: short)\r\nunit yard: Length = 3 feet\r\n\r\n@name(\"Mile\")\r\n@url(\"https://en.wikipedia.org/wiki/Mile\")\r\n@aliases(miles, mi: short)\r\nunit mile: Length = 1760 yard\r\n\r\n@name(\"Thousandth of an inch\")\r\n@url(\"https://en.wikipedia.org/wiki/Thousandth_of_an_inch\")\r\n@aliases(mils, mil: short)\r\nunit thou: Length = inch / 1000\r\n\r\n@name(\"Fathom\")\r\n@url(\"https://en.wikipedia.org/wiki/Fathom\")\r\n@aliases(fathoms)\r\nunit fathom: Length = 2 yard\r\n\r\n@name(\"League\")\r\n@url(\"https://en.wikipedia.org/wiki/League_(unit)\")\r\n@aliases(leagues)\r\nunit league: Length = 3 mile\r\n\r\n@name(\"Grain\")\r\n@url(\"https://en.wikipedia.org/wiki/Grain_(unit)\")\r\n@aliases(grains)\r\nunit grain: Mass = 64.79891 milligram\r\n\r\n@name(\"Pound\")\r\n@url(\"https://en.wikipedia.org/wiki/Pound_(mass)\")\r\n@aliases(pounds, lb: short, lbs)\r\nunit pound: Mass = 7000 grain\r\n\r\n@name(\"Ounce\")\r\n@url(\"https://en.wikipedia.org/wiki/Ounce\")\r\n@aliases(ounces, oz: short)\r\nunit ounce: Mass = (1 / 16) × pound\r\n\r\n@name(\"Troy ounce\")\r\n@url(\"https://en.wikipedia.org/wiki/Troy_weight#Troy_ounce\")\r\n@aliases(troy_ounces, ozt: short)\r\nunit troy_ounce: Mass = 480 grain\r\n\r\n@name(\"Pennyweight\")\r\n@url(\"https://en.wikipedia.org/wiki/Pennyweight\")\r\n@aliases(pennyweights, dwt: short)\r\nunit pennyweight: Mass = 24 grain\r\n\r\n@name(\"Stone\")\r\n@url(\"https://en.wikipedia.org/wiki/Stone_(unit)\")\r\nunit stone: Mass = 14 pound\r\n\r\n@name(\"Hundredweight\")\r\n@url(\"https://en.wikipedia.org/wiki/Hundredweight\")\r\n@aliases(cwt)\r\nunit long_hundredweight = 8 stone\r\n\r\n@name(\"Long ton\")\r\n@url(\"https://en.wikipedia.org/wiki/Long_ton\")\r\n@aliases(long_tons)\r\nunit long_ton: Mass = 2240 lb\r\n\r\n@name(\"Miles per hour\")\r\n@url(\"https://en.wikipedia.org/wiki/Miles_per_hour\")\r\n@abbreviation\r\nunit mph: Velocity = miles per hour\r\n\r\n@name(\"Inch of mercury\")\r\n@url(\"https://en.wikipedia.org/wiki/Inch_of_mercury\")\r\n@abbreviation\r\nunit inHg: Pressure = in Hg\r\n\r\n@name(\"Imperial Fluid Ounce\")\r\n@url(\"https://en.wikipedia.org/wiki/Fluid_ounce\")\r\n@aliases(imperial_fluidounces, UK_floz: short)\r\nunit imperial_fluidounce: Volume = 28.4130625 mL\r\n\r\n@name(\"Imperial Pint\")\r\n@url(\"https://en.wikipedia.org/wiki/Pint#Imperial_pint\")\r\n@aliases(imperial_pints, UK_pt: short, UK_pint, UK_pints)\r\nunit imperial_pint: Volume = 20 imperial_fluidounces\r\n\r\n@name(\"Imperial Quart\")\r\n@url(\"https://en.wikipedia.org/wiki/Quart#Imperial_quart\")\r\n@aliases(imperial_quarts, UK_qt: short, UK_quart, UK_quarts)\r\nunit imperial_quart: Volume = 2 imperial_pints\r\n\r\n@name(\"Imperial Gallon\")\r\n@url(\"https://en.wikipedia.org/wiki/Gallon#Imperial_gallon\")\r\n@aliases(imperial_gallons, UK_gal: short, UK_gallon, UK_gallons)\r\nunit imperial_gallon: Volume = 4 imperial_quart\r\n\r\n@name(\"Imperial Bushel\")\r\n@url(\"https://en.wikipedia.org/wiki/Bushel#Imperial_bushel\")\r\n@aliases(imperial_bushels, UK_bu: short)\r\nunit imperial_bushel: Volume = 8 imperial_gallons\r\n\r\n@name(\"Imperial Fluid Drachm\")\r\n@url(\"https://en.wikipedia.org/wiki/Fluid_drachm#Imperial_fluid_drachm\")\r\n@aliases(imperial_fluid_drachms, UK_fldr: short)\r\nunit imperial_fluid_drachm: Volume = 1/8 × imperial_fluidounce\r\n\r\n@name(\"Imperial Gill\")\r\n@url(\"https://en.wikipedia.org/wiki/Gill_(unit)\")\r\n@aliases(imperial_gills, UK_gi: short)\r\nunit imperial_gill: Volume = 5 imperial_fluidounces\r\n\r\n@name(\"UK tablespoon\")\r\n@url(\"https://en.wikipedia.org/wiki/Tablespoon\")\r\n@aliases(imperial_tablespoon, UK_tbsp: short, UK_tablespoon, UK_tablespoons)\r\nunit imperial_tablespoon: Volume = 1/2 × imperial_fluidounce\r\n\r\n@name(\"UK teaspoon\")\r\n@url(\"https://en.wikipedia.org/wiki/Teaspoon\")\r\n@aliases(imperial_teaspoons, UK_tsp: short, UK_teaspoon,UK_teaspoons)\r\nunit imperial_teaspoon: Volume = 1/4 × imperial_tablespoon",
  "units::misc": "use units::si\r\n\r\n### Other units\r\n\r\n@name(\"Bar\")\r\n@url(\"https://en.wikipedia.org/wiki/Bar_(unit)\")\r\n@metric_prefixes\r\n@aliases(bar: both, bars: both)\r\nunit bar: Pressure = 100 kPa\r\n\r\n@name(\"Ångström\")\r\n@url(\"https://en.wikipedia.org/wiki/Angstrom\")\r\n@aliases(angstroms, Å: short, Å: short)\r\nunit angstrom: Length = 1e-10 meter\r\n\r\n@name(\"Barn\")\r\n@url(\"https://en.wikipedia.org/wiki/Barn_(unit)\")\r\n@metric_prefixes\r\n@aliases(barns)\r\nunit barn: Area = 1e-28 meter^2\r\n\r\n@name(\"Calorie\")\r\n@url(\"https://en.wikipedia.org/wiki/Calorie\")\r\n@metric_prefixes\r\n@aliases(calories, cal: both)\r\nunit calorie: Energy = 4.184 joule\r\n\r\n@name(\"British thermal unit\")\r\n@url(\"https://en.wikipedia.org/wiki/British_thermal_unit\")\r\n@aliases(Btu)\r\nunit BTU: Energy = 1055.05585262 joule\r\n\r\n@name(\"Therm\")\r\n@description(\"A non-SI metric unit of heat energy. This is the ISO definition, also called Therm (EC).\")\r\n@url(\"https://en.wikipedia.org/wiki/Therm\")\r\n@aliases(therms)\r\nunit therm: Energy = 100_000 BTU\r\n\r\n@name(\"Thermie\")\r\n@url(\"https://en.wikipedia.org/wiki/Thermie\")\r\n@aliases(thermies)\r\nunit thermie: Energy = 1000 kcal\r\n\r\n@name(\"Pound-force\")\r\n@url(\"https://en.wikipedia.org/wiki/Pound_(force)\")\r\n@aliases(lbf: short)\r\nunit pound_force: Force = 4.448222 newton\r\n\r\n@name(\"Ounce-force\")\r\n@url(\"https://en.wikipedia.org/wiki/Ounce-force\")\r\n@aliases(ozf: short)\r\nunit ounce_force: Force = 1 / 16 * lbf\r\n\r\n@name(\"Kilogram-force\")\r\n@url(\"https://en.wikipedia.org/wiki/Kilogram-force\")\r\n@aliases(kgf: short)\r\nunit kilogram_force: Force = 9.80665 newton\r\n\r\n@name(\"Metric horsepower\")\r\n@url(\"https://en.wikipedia.org/wiki/Horsepower\")\r\n@aliases(hp: short)\r\nunit horsepower: Power = 735.49875 W\r\n\r\n@name(\"Revolution\")\r\n@url(\"https://en.wikipedia.org/wiki/Revolution_(unit)\")\r\n@aliases(revolutions, rev: short)\r\nunit revolution: Angle = 360°\r\n\r\n@name(\"Revolutions per minute\")\r\n@url(\"https://en.wikipedia.org/wiki/Revolutions_per_minute\")\r\n@aliases(RPM: short)\r\nunit rpm: Frequency = 1 / minute\r\n\r\n@name(\"Millimeter of mercury\")\r\n@url(\"https://en.wikipedia.org/wiki/Millimeter_of_mercury\")\r\nunit mmHg: Pressure = 133.322387415 pascal\r\n\r\n@name(\"Mercury\")\r\n@url(\"https://en.wikipedia.org/wiki/Mercury_(element)\")\r\nunit Hg: Force / Volume = mmHg / mm\r\n\r\n@name(\"Torr\")\r\n@url(\"https://en.wikipedia.org/wiki/Torr\")\r\nunit torr: Pressure = 101325 / 760 × pascal\r\n\r\n@name(\"Pound-force per square inch\")\r\n@url(\"https://en.wikipedia.org/wiki/Pounds_per_square_inch\")\r\n@aliases(PSI: short)\r\nunit psi: Pressure = 6.894757 kPa\r\n\r\n@name(\"Kilopound-force per square inch\")\r\n@url(\"https://en.wikipedia.org/wiki/Ksi_(unit)\")\r\n@aliases(KSI: short)\r\nunit ksi: Pressure = 1000 psi\r\n\r\n@name(\"Megapound-force per square inch\")\r\n@url(\"https://en.wikipedia.org/wiki/Ksi_(unit)\")\r\n@aliases(MPSI: short)\r\nunit mpsi: Pressure = 1000000 psi\r\n\r\n@name(\"Standard atmosphere\")\r\n@url(\"https://en.wikipedia.org/wiki/Standard_atmosphere_(unit)\")\r\n@aliases(atmospheres, atm: short)\r\nunit atmosphere: Pressure = 101_325 pascal\r\n\r\n@name(\"Molar\")\r\n@url(\"https://en.wikipedia.org/wiki/Molar_concentration\")\r\n@metric_prefixes\r\nunit molar: Molarity = 1 mol / litre\r\n\r\n@name(\"Molal\")\r\n@url(\"https://en.wikipedia.org/wiki/Molality\")\r\n@metric_prefixes\r\nunit molal: Molality = 1 mole / kilogram\r\n\r\n@name(\"Football field\")\r\n@url(\"https://en.wikipedia.org/wiki/Football_pitch\")\r\nunit footballfield: Area = 105 m × 68 m # Standard FIFA football pitch\r\n\r\n@name(\"Swimming pool\")\r\n@url(\"https://en.wikipedia.org/wiki/Olympic-size_swimming_pool\")\r\nunit swimmingpool: Volume = 50 m × 25 m × 2 m # Olympic-size swimming pool (FR3)\r\n\r\n@name(\"Rack unit\")\r\n@url(\"https://en.wikipedia.org/wiki/Rack_unit\")\r\n@aliases(rackunits, RU: short, U: short)\r\nunit rackunit: Length = 0.04445 meter\r\n\r\n@metric_prefixes\r\n@aliases(darcys, darcies)\r\n@url(\"https://en.wikipedia.org/wiki/Darcy_(unit)\")\r\nunit darcy: Length^2 = (1 bar / 1 atmosphere) × micrometer²\r\n\r\n# Angles\r\n\r\n@name(\"Turn\")\r\n@url(\"https://en.wikipedia.org/wiki/Turn_(geometry)\")\r\n@aliases(turns)\r\nunit turn: Angle = 2 π rad\r\n\r\n@name(\"Gradian\")\r\n@url(\"https://en.wikipedia.org/wiki/Gradian\")\r\n@aliases(gradians, grad, grads, grade, grades, gon, gons)\r\nunit gradian: Angle = 90° / 100\r\n\r\n### Abbreviations\r\n\r\n@name(\"Watt-hour\")\r\n@url(\"https://en.wikipedia.org/wiki/Watt_hour\")\r\n@metric_prefixes\r\n@aliases(Wh: short)\r\n@abbreviation\r\nunit watthour: Energy = W h\r\n\r\n@name(\"Ampere-hour\")\r\n@url(\"https://en.wikipedia.org/wiki/Ampere_hour\")\r\n@metric_prefixes\r\n@aliases(Ah: short)\r\n@abbreviation\r\nunit amperehour: ElectricCharge = A h\r\n\r\n@name(\"Kilometres per hour\")\r\n@url(\"https://en.wikipedia.org/wiki/Kilometres_per_hour\")\r\n@abbreviation\r\nunit kph: Velocity = kilometer per hour\r\n\r\n@name(\"Micron\")\r\n@url(\"https://en.wikipedia.org/wiki/Micrometre\")\r\n@abbreviation\r\nunit micron: Length = µm\r\n\r\n@name(\"Cubic centimetre\")\r\n@url(\"https://en.wikipedia.org/wiki/Cubic_centimetre\")\r\n@aliases(ccm)\r\n@abbreviation\r\nunit cc: Volume = cm^3\r\n\r\n@name(\"Fermi\")\r\n@url(\"https://en.wikipedia.org/wiki/Femtometre\")\r\n@abbreviation\r\nunit fermi: Length = 1 fm\r\n\r\n@name(\"Metric tablespoon\")\r\n@url(\"https://en.wikipedia.org/wiki/Tablespoon\")\r\n@aliases(metric_tablespoons, metric_tbsp: short)\r\nunit metric_tablespoon: Volume = 15 mL\r\n\r\n@name(\"Metric teaspoon\")\r\n@url(\"https://en.wikipedia.org/wiki/Teaspoon\")\r\n@aliases(metric_teaspoons, metric_tsp: short)\r\nunit metric_teaspoon: Volume = 1/3 × metric_tablespoon\r\n",
  "units::mixed": "use core::mixed_units\r\nuse units::si\r\nuse units::imperial\r\n\r\n@name(\"Unit list\")\r\n@description(\"Convert a value to a mixed representation using the provided units.\")\r\n@example(\"5500 m |> unit_list([miles, yards, feet, inches])\")\r\nfn unit_list<D: Dim>(units: List<D>, value: D) -> List<D> = _unit_list(units, value)\r\n\r\n@name(\"Degrees, minutes, seconds\")\r\n@description(\"Convert an angle to a mixed degrees, (arc)minutes, and (arc)seconds representation. Also called sexagesimal degree notation.\")\r\n@url(\"https://en.wikipedia.org/wiki/Sexagesimal_degree\")\r\n@example(\"46.5858° -> DMS\")\r\nfn DMS(alpha: Angle) -> List<Angle> =\r\n  unit_list([degree, arcminute, arcsecond], alpha)\r\n\r\n@name(\"Degrees, decimal minutes\")\r\n@description(\"Convert an angle to a mixed degrees and decimal minutes representation.\")\r\n@url(\"https://en.wikipedia.org/wiki/Decimal_degrees\")\r\n@example(\"46.5858° -> DM\")\r\nfn DM(alpha: Angle) -> List<Angle> =\r\n  unit_list([degree, arcminute], alpha)\r\n\r\n@name(\"Feet and inches\")\r\n@description(\"Convert a length to a mixed feet and inches representation.\")\r\n@url(\"https://en.wikipedia.org/wiki/Foot_(unit)\")\r\n@example(\"180 cm -> feet_and_inches\")\r\nfn feet_and_inches(length: Length) -> List<Length> =\r\n  unit_list([foot, inch], length)\r\n\r\n@name(\"Pounds and ounces\")\r\n@description(\"Convert a mass to a mixed pounds and ounces representation.\")\r\n@url(\"https://en.wikipedia.org/wiki/Pound_(mass)\")\r\n@example(\"1 kg -> pounds_and_ounces\")\r\nfn pounds_and_ounces(mass: Mass) -> List<Mass> =\r\n  unit_list([pound, ounce], mass)",
  "units::nautical": "use units::si\r\n\r\n@name(\"Knot\")\r\n@url(\"https://en.wikipedia.org/wiki/Knot_(unit)\")\r\n@aliases(knots, kn: short, kt: short)\r\nunit knot: Velocity = 463 m / 900 s\r\n\r\n@name(\"Nautical Mile\")\r\n@url(\"https://en.wikipedia.org/wiki/Nautical_mile\")\r\n@aliases(nautical_miles, NM: short, nmi: short)\r\nunit nautical_mile: Length = 1852 m\r\n",
  "units::partsperx": "@name(\"Percent\")\r\n@url(\"https://en.wikipedia.org/wiki/Percentage\")\r\n@aliases(%: short, pct)\r\nunit percent = 1e-02\r\n\r\n@name(\"Permille\")\r\n@url(\"https://en.wikipedia.org/wiki/Per_mille\")\r\n@aliases(‰: short, permil, permill)\r\nunit permille = 1e-03\r\n\r\n@name(\"Parts per million\")\r\n@url(\"https://en.wikipedia.org/wiki/Parts-per_notation\")\r\n@aliases(ppm)\r\nunit partspermillion = 1e-06\r\n\r\n@name(\"Parts per billion\")\r\n@url(\"https://en.wikipedia.org/wiki/Parts-per_notation\")\r\n@aliases(ppb)\r\nunit partsperbillion = 1e-09\r\n\r\n@name(\"Parts per trillion\")\r\n@url(\"https://en.wikipedia.org/wiki/Parts-per_notation\")\r\n@aliases(ppt)\r\nunit partspertrillion = 1e-12\r\n\r\n@name(\"Parts per quadrillion\")\r\n@url(\"https://en.wikipedia.org/wiki/Parts-per_notation\")\r\n@aliases(ppq)\r\nunit partsperquadrillion = 1e-15\r\n",
  "units::placeholder": "use units::imperial\r\n\r\n# Smallest addressable element on a digital display\r\ndimension Pixel\r\n\r\n@name(\"Pixel\")\r\n@url(\"https://en.wikipedia.org/wiki/Pixel\")\r\n@metric_prefixes\r\n@aliases(pixels, px: short)\r\nunit pixel: Pixel\r\n\r\n@name(\"Pixels per inch\")\r\n@url(\"https://en.wikipedia.org/wiki/Pixels_per_inch\")\r\nunit ppi: Pixel / Length = pixel / inch\r\n\r\n\r\n# Smallest possible output resolution on a printing device\r\ndimension Dot\r\n\r\n@name(\"Dot\")\r\n@url(\"https://en.wikipedia.org/wiki/Dots_per_inch\")\r\n@aliases(dots)\r\nunit dot: Dot\r\n\r\n@name(\"Dots per inch\")\r\n@url(\"https://en.wikipedia.org/wiki/Dots_per_inch\")\r\nunit dpi: Dot / Length = dots / inch\r\n\r\n\r\n# A single image in a (video) sequence\r\ndimension Frame\r\n\r\n@name(\"Frame\")\r\n@url(\"https://en.wikipedia.org/wiki/Frame_rate\")\r\n@aliases(frames)\r\nunit frame: Frame\r\n\r\n@name(\"Frames per second\")\r\n@url(\"https://en.wikipedia.org/wiki/Frame_rate\")\r\nunit fps: Frame / Time = frame / second\r\n\r\n# Basic unit of time in music\r\ndimension Beat\r\n\r\n@name(\"Beat\")\r\n@url(\"https://en.wikipedia.org/wiki/Beat_(music)\")\r\n@aliases(beats)\r\nunit beat: Beat\r\n\r\n@name(\"Beats per minute\")\r\n@url(\"https://en.wikipedia.org/wiki/Tempo\")\r\n@aliases(BPM: short)\r\nunit bpm: Beat / Time = beat / minute\r\n\r\n# A separate or limited portion or quantity of something\r\ndimension Piece\r\n\r\n@name(\"Piece\")\r\n@aliases(pieces)\r\nunit piece: Piece\r\n\r\n\r\n# A human being\r\ndimension Person\r\n\r\n@name(\"Person\")\r\n@aliases(persons, people, capita)\r\nunit person: Person\r\n\r\n# A unit for counting lines of code\r\ndimension LinesOfCode\r\n\r\n@name(\"Lines of code\")\r\n@url(\"https://en.wikipedia.org/wiki/Source_lines_of_code\")\r\n@metric_prefixes\r\n@aliases(LOC: short, SLOC: short)\r\nunit LOC: LinesOfCode\r\n",
  "units::planck": "# https://en.wikipedia.org/wiki/Planck_units\r\n\r\nuse core::functions\r\nuse physics::constants\r\n\r\n@name(\"Planck length\")\r\n@url(\"https://en.wikipedia.org/wiki/Planck_length\")\r\nunit planck_length: Length = sqrt(ℏ G / c^3)\r\n\r\n@name(\"Planck mass\")\r\n@url(\"https://en.wikipedia.org/wiki/Planck_mass\")\r\nunit planck_mass: Mass = sqrt(ℏ c / G)\r\n\r\n@name(\"Planck time\")\r\n@url(\"https://en.wikipedia.org/wiki/Planck_time\")\r\nunit planck_time: Time = sqrt(ℏ G / c^5)\r\n\r\n@name(\"Planck temperature\")\r\n@url(\"https://en.wikipedia.org/wiki/Planck_temperature\")\r\nunit planck_temperature: Temperature = sqrt(ℏ c^5 / (G k_B^2))\r\n\r\n@name(\"Planck energy\")\r\n@url(\"https://en.wikipedia.org/wiki/Planck_energy\")\r\nunit planck_energy: Energy = sqrt(ℏ c^5 / G)\r\n",
  "units::si": "use core::dimensions\r\nuse math::constants\r\n\r\n### SI base units\r\n\r\n@name(\"Metre\")\r\n@url(\"https://en.wikipedia.org/wiki/Metre\")\r\n@metric_prefixes\r\n@aliases(metres, meter, meters, m: short)\r\nunit metre: Length\r\n\r\n@name(\"Second\")\r\n@url(\"https://en.wikipedia.org/wiki/Second\")\r\n@metric_prefixes\r\n@aliases(seconds, s: short, sec: none)\r\nunit second: Time\r\n\r\n@name(\"Gram\")\r\n@url(\"https://en.wikipedia.org/wiki/Gram\")\r\n@metric_prefixes\r\n@aliases(grams, gramme, grammes, g: short)\r\nunit gram: Mass\r\n\r\n@name(\"Ampere\")\r\n@url(\"https://en.wikipedia.org/wiki/Ampere\")\r\n@metric_prefixes\r\n@aliases(amperes, A: short)\r\nunit ampere: Current\r\n\r\n@name(\"Kelvin\")\r\n@url(\"https://en.wikipedia.org/wiki/Kelvin\")\r\n@metric_prefixes\r\n@aliases(kelvins, K: short)\r\nunit kelvin: Temperature\r\n\r\n@name(\"Mole\")\r\n@url(\"https://en.wikipedia.org/wiki/Mole_(unit)\")\r\n@metric_prefixes\r\n@aliases(moles, mol: short)\r\nunit mole: AmountOfSubstance\r\n\r\n@name(\"Candela\")\r\n@url(\"https://en.wikipedia.org/wiki/Candela\")\r\n@metric_prefixes\r\n@aliases(candelas, cd: short)\r\nunit candela: LuminousIntensity\r\n\r\n### SI derived units\r\n\r\n@name(\"Radian\")\r\n@url(\"https://en.wikipedia.org/wiki/Radian\")\r\n@metric_prefixes\r\n@aliases(radians, rad: short)\r\nunit radian: Angle = meter / meter\r\n\r\n@name(\"Steradian\")\r\n@url(\"https://en.wikipedia.org/wiki/Steradian\")\r\n@metric_prefixes\r\n@aliases(steradians, sr: short)\r\nunit steradian: SolidAngle = radian^2\r\n\r\n@name(\"Hertz\")\r\n@url(\"https://en.wikipedia.org/wiki/Hertz\")\r\n@metric_prefixes\r\n@aliases(Hz: short)\r\nunit hertz: Frequency = 1 / second\r\n\r\n@name(\"Newton\")\r\n@url(\"https://en.wikipedia.org/wiki/Newton_(unit)\")\r\n@metric_prefixes\r\n@aliases(newtons, N: short)\r\nunit newton: Force = kilogram meter / second^2\r\n\r\n@name(\"Pascal\")\r\n@url(\"https://en.wikipedia.org/wiki/Pascal_(unit)\")\r\n@metric_prefixes\r\n@aliases(pascals, Pa: short)\r\nunit pascal: Pressure = newton / meter^2\r\n\r\n@name(\"Joule\")\r\n@url(\"https://en.wikipedia.org/wiki/Joule\")\r\n@metric_prefixes\r\n@aliases(joules, J: short)\r\nunit joule: Energy = newton meter\r\n\r\n@name(\"Watt\")\r\n@url(\"https://en.wikipedia.org/wiki/Watt\")\r\n@metric_prefixes\r\n@aliases(watts, W: short)\r\nunit watt: Power = joule / second\r\n\r\n@name(\"Coulomb\")\r\n@url(\"https://en.wikipedia.org/wiki/Coulomb\")\r\n@metric_prefixes\r\n@aliases(coulombs, C: short)\r\nunit coulomb: ElectricCharge = ampere second\r\n\r\n@name(\"Volt\")\r\n@url(\"https://en.wikipedia.org/wiki/Volt\")\r\n@metric_prefixes\r\n@aliases(volts, V: short)\r\nunit volt: Voltage = kilogram meter^2 / (second^3 ampere)\r\n\r\n@name(\"Farad\")\r\n@url(\"https://en.wikipedia.org/wiki/Farad\")\r\n@metric_prefixes\r\n@aliases(farads, F: short)\r\nunit farad: Capacitance = coulomb / volt\r\n\r\n@name(\"Ohm\")\r\n@url(\"https://en.wikipedia.org/wiki/Ohm\")\r\n@metric_prefixes\r\n@aliases(ohms, Ω: short, Ω: short)\r\nunit ohm: ElectricResistance = volt / ampere\r\n\r\n@name(\"Siemens\")\r\n@url(\"https://en.wikipedia.org/wiki/Siemens_(unit)\")\r\n@metric_prefixes\r\n@aliases(S: short)\r\nunit siemens: ElectricConductance = 1 / ohm\r\n\r\n@name(\"Weber\")\r\n@url(\"https://en.wikipedia.org/wiki/Weber_(unit)\")\r\n@metric_prefixes\r\n@aliases(webers, Wb: short)\r\nunit weber: MagneticFlux = volt second\r\n\r\n@name(\"Tesla\")\r\n@url(\"https://en.wikipedia.org/wiki/Tesla_(unit)\")\r\n@metric_prefixes\r\n@aliases(teslas, T: short)\r\nunit tesla: MagneticFluxDensity = weber / meter^2\r\n\r\n@name(\"Henry\")\r\n@url(\"https://en.wikipedia.org/wiki/Henry_(unit)\")\r\n@metric_prefixes\r\n@aliases(henrys, henries, H: short)\r\nunit henry: Inductance = weber / ampere\r\n\r\n@name(\"Lumen\")\r\n@url(\"https://en.wikipedia.org/wiki/Lumen_(unit)\")\r\n@metric_prefixes\r\n@aliases(lumens, lm: short)\r\nunit lumen: LuminousFlux = candela steradian\r\n\r\n@name(\"Lux\")\r\n@url(\"https://en.wikipedia.org/wiki/Lux\")\r\n@metric_prefixes\r\n@aliases(lx: short)\r\nunit lux: Illuminance = lumen / meter^2\r\n\r\n@name(\"Nit\")\r\n@url(\"https://en.wikipedia.org/wiki/Candela_per_square_metre\")\r\n@metric_prefixes\r\n@aliases(nt: short)\r\nunit nit: Luminance = candela / meter^2\r\n\r\n@name(\"Becquerel\")\r\n@url(\"https://en.wikipedia.org/wiki/Becquerel\")\r\n@metric_prefixes\r\n@aliases(becquerels, Bq: short)\r\nunit becquerel: Activity = 1 / second\r\n\r\n@name(\"Gray\")\r\n@url(\"https://en.wikipedia.org/wiki/Gray_(unit)\")\r\n@metric_prefixes\r\n@aliases(grays, Gy: short)\r\nunit gray: AbsorbedDose = joule / kilogram\r\n\r\n@name(\"Sievert\")\r\n@url(\"https://en.wikipedia.org/wiki/Sievert\")\r\n@metric_prefixes\r\n@aliases(sieverts, Sv: short)\r\nunit sievert: EquivalentDose = joule / kilogram\r\n\r\n@name(\"Katal\")\r\n@url(\"https://en.wikipedia.org/wiki/Katal\")\r\n@metric_prefixes\r\n@aliases(katals, kat: short)\r\nunit katal: CatalyticActivity = mole / second\r\n\r\n### SI accepted units\r\n\r\n@name(\"Minute\")\r\n@url(\"https://en.wikipedia.org/wiki/Minute\")\r\n@aliases(minutes, min: short)\r\nunit minute: Time = 60 seconds\r\n\r\n@name(\"Hour\")\r\n@url(\"https://en.wikipedia.org/wiki/Hour\")\r\n@aliases(hours, hr, h: short)\r\nunit hour: Time = 60 minutes\r\n\r\n@name(\"Day\")\r\n@url(\"https://en.wikipedia.org/wiki/Day\")\r\n@aliases(days, day: short, d: short)\r\nunit day: Time = 24 hours\r\n\r\n@name(\"Astronomical unit\")\r\n@url(\"https://en.wikipedia.org/wiki/Astronomical_unit\")\r\n@aliases(astronomicalunits, au: short, AU: short)\r\nunit astronomicalunit: Length = 149_597_870_700 meter\r\n\r\n@name(\"Degree\")\r\n@url(\"https://en.wikipedia.org/wiki/Degree_(angle)\")\r\n@aliases(degrees, deg, °: short)\r\nunit degree: Angle = π / 180 × radian\r\n\r\n@name(\"Minute of arc\")\r\n@url(\"https://en.wikipedia.org/wiki/Minute_and_second_of_arc\")\r\n@aliases(arcminutes, arcmin, ′: short)\r\nunit arcminute: Angle = 1 / 60 × degree\r\n\r\n@name(\"Second of arc\")\r\n@url(\"https://en.wikipedia.org/wiki/Minute_and_second_of_arc\")\r\n@metric_prefixes\r\n@aliases(arcseconds, arcsec, ″: short)\r\nunit arcsecond: Angle = 1 / 60 × arcminute\r\n\r\n@name(\"Are\")\r\n@url(\"https://en.wikipedia.org/wiki/Are_(unit)\")\r\nunit are: Area = (10 m)^2\r\n\r\n@name(\"Hectare\")\r\n@url(\"https://en.wikipedia.org/wiki/Hectare\")\r\n@aliases(hectares, ha: short)\r\nunit hectare: Area = 100 are\r\n\r\n@name(\"Litre\")\r\n@url(\"https://en.wikipedia.org/wiki/Litre\")\r\n@metric_prefixes\r\n@aliases(litres, liter, liters, L: short, l: short)\r\nunit litre: Volume = decimeter^3\r\n\r\n@name(\"Tonne\")\r\n@url(\"https://en.wikipedia.org/wiki/Tonne\")\r\n@metric_prefixes\r\n@aliases(tonnes, ton: both, tons: both, metricton: none)\r\nunit tonne: Mass = 10^3 kilogram\r\n\r\n@name(\"Dalton\")\r\n@url(\"https://en.wikipedia.org/wiki/Dalton\")\r\n@aliases(daltons, Da: short)\r\nunit dalton: Mass = 1.660_539_066_60e-27 kilogram\r\n\r\n@name(\"Electron volt\")\r\n@url(\"https://en.wikipedia.org/wiki/Electronvolt\")\r\n@metric_prefixes\r\n@aliases(electronvolts, eV: short)\r\nunit electronvolt: Energy = 1.602_176_634e-19 joule\r\n",
  "units::stoney": "use core::functions\r\nuse math::constants\r\nuse physics::constants\r\n\r\n@name(\"Stoney length\")\r\n@url(\"https://en.wikipedia.org/wiki/Stoney_units\")\r\nunit stoney_length: Length = sqrt(G × electron_charge^2 / 4 π ε0 c^4)\r\n\r\n@name(\"Stoney mass\")\r\n@url(\"https://en.wikipedia.org/wiki/Stoney_units\")\r\nunit stoney_mass: Mass = sqrt(electron_charge^2 / 4 π ε0 G)\r\n\r\n@name(\"Stoney time\")\r\n@url(\"https://en.wikipedia.org/wiki/Stoney_units\")\r\nunit stoney_time: Time = sqrt(G × electron_charge^2 / 4 π ε0 c^6)\r\n",
  "units::time": "use units::si\r\n\r\n@name(\"Week\")\r\n@url(\"https://en.wikipedia.org/wiki/Week\")\r\n@aliases(weeks)\r\nunit week: Time = 7 days\r\n\r\n# The mean tropical year changes over time (half a second per century). It's current\r\n# value can be approximated using\r\n#\r\n#   365.2421896698 - 6.15359e-6 T - 7.29e-10 T^2 + 2.64e-10 T^3\r\n#\r\n# where T is in Julian centuries, measured from noon January 1st, 2000.\r\n# (https://en.wikipedia.org/wiki/Tropical_year#Mean_tropical_year_current_value)\r\n#\r\n# Values of the mean tropical year for the recent past and near future:\r\n#\r\n#   Year    Length (days)\r\n#   ---------------------\r\n#   2020    365.242 189 7\r\n#   2025    365.242 188 1\r\n#   2050    365.242 186 6\r\n#\r\n# For now, we use the 2025 value as a hardcoded constant. Those numbers\r\n# are mainly shown to illustrate that it is not sensible to define this\r\n# number more precise.\r\n#\r\n@name(\"Tropical year\")\r\n@url(\"https://en.wikipedia.org/wiki/Tropical_year\")\r\n@metric_prefixes\r\n@aliases(years, yr: short, tropical_year, tropical_years)\r\nunit year: Time = 365.242_188_1 days\r\n\r\n@name(\"Month\")\r\n@url(\"https://en.wikipedia.org/wiki/Month\")\r\n@aliases(months)\r\nunit month: Time = year / 12\r\n\r\n@name(\"Gregorian year\")\r\n@url(\"https://en.wikipedia.org/wiki/Gregorian_year\")\r\n@metric_prefixes\r\n@aliases(gregorian_years)\r\nunit gregorian_year: Time = 365.2425 days\r\n\r\n@name(\"Julian year\")\r\n@url(\"https://en.wikipedia.org/wiki/Julian_year_(astronomy)\")\r\n@aliases(julian_years)\r\nunit julian_year: Time = 365.25 days\r\n\r\n@name(\"Decade\")\r\n@url(\"https://en.wikipedia.org/wiki/Decade\")\r\n@aliases(decades)\r\nunit decade: Time = 10 years\r\n\r\n@name(\"Century\")\r\n@url(\"https://en.wikipedia.org/wiki/Century\")\r\n@aliases(centuries)\r\nunit century: Time = 100 years\r\n\r\n@name(\"Millennium\")\r\n@url(\"https://en.wikipedia.org/wiki/Millennium\")\r\n@aliases(millennia)\r\nunit millennium: Time = 1000 years\r\n",
  "units::us_customary": "use units::si\r\nuse units::imperial\r\n\r\n@name(\"US liquid gallon\")\r\n@url(\"https://en.wikipedia.org/wiki/Gallon\")\r\n@aliases(gallons, gal: short)\r\nunit gallon: Volume = 231 in^3\r\n\r\n@name(\"US liquid pint\")\r\n@url(\"https://en.wikipedia.org/wiki/Pint\")\r\n@aliases(pints)\r\nunit pint: Volume = 1/8 × gallon\r\n\r\n@name(\"US cup\")\r\n@url(\"https://en.wikipedia.org/wiki/Cup_(unit)\")\r\n@aliases(cups)\r\nunit cup: Volume = 1/2 × pint\r\n\r\n@name(\"US tablespoon\")\r\n@url(\"https://en.wikipedia.org/wiki/Tablespoon\")\r\n@aliases(tablespoons, tbsp: short)\r\nunit tablespoon: Volume = 1/16 × cup\r\n\r\n@name(\"US teaspoon\")\r\n@url(\"https://en.wikipedia.org/wiki/Teaspoon\")\r\n@aliases(teaspoons, tsp: short)\r\nunit teaspoon: Volume = 1/3 × tablespoon\r\n\r\n@name(\"US fluid ounce\")\r\n@url(\"https://en.wikipedia.org/wiki/Fluid_ounce\")\r\n@aliases(fluidounces, floz: short)\r\nunit fluidounce: Volume = 2 tablespoon\r\n\r\n@name(\"US hogshead\")\r\n@url(\"https://en.wikipedia.org/wiki/Hogshead\")\r\n@aliases(hogsheads)\r\nunit hogshead: Volume = 63 gallon\r\n\r\n@name(\"Oil barrel\")\r\n@url(\"https://en.wikipedia.org/wiki/Barrel_(unit)#Oil_barrel\")\r\n@aliases(barrels)\r\nunit barrel: Volume = 42 gallon\r\n\r\n@name(\"US rod\")\r\n@url(\"https://en.wikipedia.org/wiki/Rod_(unit)\")\r\n@aliases(rods, perch)\r\nunit rod: Length = 16.5 ft\r\n\r\n@name(\"Acre\")\r\n@url(\"https://en.wikipedia.org/wiki/Acre\")\r\n@aliases(acres)\r\nunit acre: Area = 4840 yard^2\r\n\r\n@name(\"Miles per gallon\")\r\n@url(\"https://en.wikipedia.org/wiki/Fuel_economy_in_automobiles\")\r\n@abbreviation\r\nunit mpg: Length / Volume = miles per gallon\r\n\r\n@name(\"Foot-candle\")\r\n@url(\"https://en.wikipedia.org/wiki/Foot-candle\")\r\n@aliases(footcandles, fc: short)\r\nunit footcandle: Illuminance = lumen / foot^2\r\n",
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

  // SI base canonicals. Mass: gram is canonical (ep convention); SI base is
  // kilogram but gram is more convenient at calculator scale.
  //
  // We do NOT use prefixSet:'metric' here because that auto-generates the
  // full BIPM 2022 prefix set (including deca/hecto/deci) and the formatter
  // then picks "2 hm" or "5 dam" over "200 m" or "50 m". Instead we register
  // only the common engineering prefixes explicitly. The omitted prefixes
  // (da/h/d, the very-large Q/R/Y/Z/E/P/T-positive ones, and the very-small
  // f/a/z/y/r/q ones) are out of scope for a calculator-shaped tool.
  registry.define('gram',       { dim: {mass: 1}, aliases: ['grams'], shortAliases: ['g']   });
  registry.define('milligram',  { dim: {mass: 1}, mul: 1e-3, aliases: ['milligrams'], shortAliases: ['mg'] });
  registry.define('microgram',  { dim: {mass: 1}, mul: 1e-6, aliases: ['micrograms'], shortAliases: ['µg', 'μg', 'ug'] });
  registry.define('kilogram',   { dim: {mass: 1}, mul: 1e3,  aliases: ['kilograms'], shortAliases: ['kg'] });

  registry.define('meter',      { dim: {length: 1}, aliases: ['meters', 'metre', 'metres'], shortAliases: ['m']  });
  registry.define('millimeter', { dim: {length: 1}, mul: 1e-3, aliases: ['millimeters', 'millimetre', 'millimetres'], shortAliases: ['mm'] });
  registry.define('centimeter', { dim: {length: 1}, mul: 1e-2, aliases: ['centimeters', 'centimetre', 'centimetres'], shortAliases: ['cm'] });
  registry.define('kilometer',  { dim: {length: 1}, mul: 1e3,  aliases: ['kilometers', 'kilometre', 'kilometres'], shortAliases: ['km'] });
  registry.define('micrometer', { dim: {length: 1}, mul: 1e-6, aliases: ['micrometers', 'micrometre', 'micrometres', 'micron', 'microns'], shortAliases: ['µm', 'μm', 'um'] });
  registry.define('nanometer',  { dim: {length: 1}, mul: 1e-9, aliases: ['nanometers', 'nanometre', 'nanometres'], shortAliases: ['nm'] });

  registry.define('second',      { dim: {time: 1}, aliases: ['seconds'], shortAliases: ['s']  });
  registry.define('millisecond', { dim: {time: 1}, mul: 1e-3, aliases: ['milliseconds'], shortAliases: ['ms'] });
  registry.define('microsecond', { dim: {time: 1}, mul: 1e-6, aliases: ['microseconds'], shortAliases: ['µs', 'μs', 'us'] });
  registry.define('minute',      { dim: {time: 1}, mul: 60,         aliases: ['minutes'], shortAliases: ['min'] });
  registry.define('hour',        { dim: {time: 1}, mul: 3600,        aliases: ['hours'], shortAliases: ['h', 'hr'] });
  registry.define('day',         { dim: {time: 1}, mul: 86400,       aliases: ['days'], shortAliases: ['d'] });
  registry.define('year',        { dim: {time: 1}, mul: 31557600,    aliases: ['years'], shortAliases: ['yr'] });

  // Angles are dimensionless in numbat's convention (a radian is a pure
  // ratio). ep matches that so the vendored modules' angular code loads.
  registry.define('radian', { dim: {}, aliases: ['radians'], shortAliases: ['rad'] });

  // Imperial / US customary — convenience for input and explicit `-> ft`
  // conversion. Flagged inputOnly so the auto-scaler still prefers metric
  // for default display.
  registry.define('inch',  { dim: {length: 1}, mul: 0.0254,    aliases: ['inches'], shortAliases: ['in'], inputOnly: true });
  registry.define('foot',  { dim: {length: 1}, mul: 0.3048,    aliases: ['feet'],   shortAliases: ['ft'], inputOnly: true });
  registry.define('yard',  { dim: {length: 1}, mul: 0.9144,    aliases: ['yards'],  shortAliases: ['yd'], inputOnly: true });
  registry.define('mile',  { dim: {length: 1}, mul: 1609.344,  aliases: ['miles'],  shortAliases: ['mi'], inputOnly: true });

  registry.define('pound', { dim: {mass: 1}, mul: 453.59237, aliases: ['pounds'], shortAliases: ['lb', 'lbs'], inputOnly: true });
  registry.define('stone', { dim: {mass: 1}, mul: 6350.293,  aliases: ['stones'], shortAliases: ['st'],         inputOnly: true });

  // DCDMA wireline diamond core sizes — source values mirrored from
  // gcu/units (auditable/ext/units/src/core.js). Registered as length
  // units so `pi/4 * NQ_core^2 * length` computes the sample volume
  // correctly. inputOnly so they don't compete with metric for default
  // display, but they appear in the gutter / sheet pickers.
  // Naming: {CODE}_core = drilled core diameter, {CODE}_hole = bit-cut
  // hole diameter. Multipliers in metres.
  const DCDMA_CORES = [
    ['AQ',  0.0270, 0.0480], ['BQ',  0.0365, 0.0600],
    ['NQ',  0.0476, 0.0757], ['NQ2', 0.0506, 0.0757], ['NQ3', 0.0451, 0.0757],
    ['HQ',  0.0635, 0.0960], ['HQ3', 0.0611, 0.0960],
    ['PQ',  0.0850, 0.1226], ['PQ3', 0.0830, 0.1226],
  ];
  for (const [code, core_m, hole_m] of DCDMA_CORES) {
    registry.define(code + '_core', { dim: {length: 1}, mul: core_m, displayName: code + '_core', inputOnly: true });
    registry.define(code + '_hole', { dim: {length: 1}, mul: hole_m, displayName: code + '_hole', inputOnly: true });
  }

  // Common compound units — give the formatter candidates so velocities,
  // accelerations, forces, etc. render as "60 m/s" / "9.81 m/s²" / "5 N"
  // instead of "60 [length·time^-1]". All canonical-multiplier values are
  // relative to ep's base units (gram for mass, meter for length, second
  // for time), which means newton = kg·m/s² = 1000 g·m/s², so mul=1000.

  // Velocity (dim: length·time^-1).
  registry.define('meter_per_second',    { dim: {length: 1, time: -1}, mul: 1,        displayName: 'm/s',   aliases: ['m/s'] });
  registry.define('kilometer_per_hour',  { dim: {length: 1, time: -1}, mul: 1 / 3.6,  displayName: 'km/h',  aliases: ['km/h'] });
  registry.define('mile_per_hour',       { dim: {length: 1, time: -1}, mul: 0.44704,  displayName: 'mph',   aliases: ['mph'], inputOnly: true });

  // Acceleration (dim: length·time^-2).
  registry.define('meter_per_second_sq', { dim: {length: 1, time: -2}, mul: 1,        displayName: 'm/s²',  aliases: ['m/s^2', 'm/s²'] });

  // Frequency (dim: time^-1).
  registry.define('hertz',               { dim: {time: -1},            mul: 1,        shortAliases: ['Hz'] });

  // Force (dim: mass·length·time^-2). 1 N = 1 kg·m/s² = 1000 g·m/s².
  registry.define('newton',              { dim: {mass: 1, length: 1,  time: -2}, mul: 1000,    shortAliases: ['N'] });

  // Energy (dim: mass·length^2·time^-2). 1 J = 1 N·m = 1000 g·m²/s².
  registry.define('joule',               { dim: {mass: 1, length: 2,  time: -2}, mul: 1000,    shortAliases: ['J'] });

  // Power (dim: mass·length^2·time^-3). 1 W = 1 J/s = 1000 g·m²/s³.
  registry.define('watt',                { dim: {mass: 1, length: 2,  time: -3}, mul: 1000,    shortAliases: ['W'] });

  // Pressure (dim: mass·length^-1·time^-2). 1 Pa = 1 N/m² = 1000 g/(m·s²).
  registry.define('pascal',              { dim: {mass: 1, length: -1, time: -2}, mul: 1000,    shortAliases: ['Pa'] });
  registry.define('kilopascal',          { dim: {mass: 1, length: -1, time: -2}, mul: 1e6,     shortAliases: ['kPa'] });
  registry.define('bar',                 { dim: {mass: 1, length: -1, time: -2}, mul: 1e8,     shortAliases: ['bar'] });

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
  // Imperial volume — inputOnly so auto-scale still prefers metric, but
  // they show up in the gutter unit-picker for Canadian / US datasets.
  // 1 ft³ = (0.3048)³ m³ = 0.028316846592 m³
  // 1 in³ = (0.0254)³ m³ = 0.000016387064 m³
  registry.define('ft3', { dim: {length: 3}, mul: 0.028316846592, displayName: 'ft³', aliases: ['ft^3'], inputOnly: true });
  registry.define('in3', { dim: {length: 3}, mul: 0.000016387064, displayName: 'in³', aliases: ['in^3'], inputOnly: true });

  // Density.
  registry.define('g/cm3', { dim: {mass: 1, length: -3}, mul: 1e6, displayName: 'g/cm³' });
  registry.define('kg/m3', { dim: {mass: 1, length: -3}, mul: 1e3, displayName: 'kg/m³' });
  registry.define('t/m3',  { dim: {mass: 1, length: -3}, mul: 1e6, displayName: 't/m³' });

  // Parts-per-X (mass fraction; treated as dimensionless, matching upstream).
  registry.define('ppm', { dim: {}, mul: 1e-6, shortAliases: ['ppm'] });
  registry.define('ppb', { dim: {}, mul: 1e-9, shortAliases: ['ppb'] });
  registry.define('pct', { dim: {}, mul: 1e-2, displayName: '%', aliases: ['percent'] });
  registry.define('g/t', { dim: {}, mul: 1e-6, shortAliases: ['g/t'] });

  // Angles. Dimensionless per numbat convention; one full turn = 2π radians.
  registry.define('degree', { dim: {}, mul: Math.PI / 180, aliases: ['degrees'], shortAliases: ['deg'] });

  // Tyler / ASTM sieve mesh apertures — discrete table, mirrored from
  // gcu/units (auditable/ext/units/src/sieve.js). Each registered as a
  // length unit so `aperture = mesh200 to um` gives the right answer
  // and the picker lists them under Length. Names use the underscore
  // prefix (mesh_NN) to keep them out of plain identifier collisions;
  // multipliers are aperture in metres. inputOnly so auto-scale ignores.
  const SIEVE_MESH = [
    [635,   20e-6], [500,   25e-6], [450,   32e-6], [400,   38e-6],
    [325,   45e-6], [270,   53e-6], [230,   63e-6], [200,   75e-6],
    [170,   90e-6], [150,  106e-6], [120,  125e-6], [100,  150e-6],
    [80,   180e-6], [70,   212e-6], [60,   250e-6], [50,   300e-6],
    [45,   355e-6], [40,   425e-6], [35,   500e-6], [30,   600e-6],
    [25,   710e-6], [20,   850e-6], [18,  1000e-6], [16,  1180e-6],
    [14,  1400e-6], [12,  1700e-6], [10,  2000e-6], [8,   2360e-6],
    [7,   2800e-6], [6,   3350e-6], [5,   4000e-6], [4,   4750e-6],
  ];
  for (const [mesh, m] of SIEVE_MESH) {
    registry.define('mesh' + mesh, {
      dim: {length: 1}, mul: m,
      displayName: 'mesh' + mesh,
      inputOnly: true,
    });
  }
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
    this.structs  = new Map();          // user-defined struct schemas
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

  format(q, opts) {
    return format(q, this.registry, opts);
  }

  formatParts(q, opts) {
    return formatParts(q, this.registry, opts);
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
  //
  // opts:
  //   typecheck: true → run the typechecker before evaluation, throw on
  //                     dim mismatch / unknown identifier / etc.
  loadSource(text, sourceName = '<inline>', opts = {}) {
    const env = makeEnv({
      dims: this.dims,
      units: this.registry,
      values: this.values,
      fns: this.fns,
      structs: this.structs,
      resolveUse: (path) => this.use(path.join('::')),
    });
    loadSource(text, sourceName, env, opts);
  }

  // Register every vendored .nbt module bundled at build time without
  // loading any of them. Useful when the host wants to keep its own
  // (v0.1) unit prelude but selectively `use` upstream function
  // modules — `core::strings` for hex/bin/oct and the str_* family,
  // `core::lists` for list primitives beyond what's already in scope,
  // `math::statistics` for mean/median/etc.
  //
  // Idempotent: calling twice doesn't re-register or re-load anything,
  // and after this call any later `use('core::strings')` resolves
  // against the bundled source.
  registerAllVendoredModules() {
    for (const [path, source] of Object.entries(VENDORED_MODULES)) {
      this.registerModule(path, source);
    }
  }

  // Register every vendored .nbt module bundled at build time, then load
  // the SI and partsperx modules (which transitively pull in core::dimensions,
  // core::scalar, and math::constants). Provides a Numbat-compatible
  // standard-library subset without a hand-crafted JS prelude.
  loadVendoredPrelude() {
    this.registerAllVendoredModules();
    this.use('units::si');
    this.use('units::partsperx');
  }
}
export { Numbat, Quantity, UnitRegistry, DimRegistry, dimEq, dimMul, dimDiv, dimPow, dimInv, dimEmpty, dimFormat, formatNumber, tokenize, parse, loadSource, loadModule, makeEnv, evalDimExpr, evalValueExpr, setQuantityFormatter, setPrintSink, setPlotSink, setCsvResolver, formatParts, typecheckStatement, typecheckModule, buildTypeEnv, parseCsv, detectCsvConfig, VENDORED_MODULES };
