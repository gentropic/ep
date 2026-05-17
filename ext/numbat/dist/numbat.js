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
const MULTI_OPS = ['->', '::', '|>', '!=', '<=', '>=', '==', '&&', '||', '**'];

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
    let kind = 'Dim';
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
  // `<...>` or function-type args `[(A) -> B]`. v0.5 discards the contents —
  // structs will properly typecheck them in a later version. This lets us
  // parse upstream signatures using `List<String>`, `Fn[(X) -> Y]`, etc.,
  // without failing the file.
  function parseTypeExpr() {
    const t = parseAddExpr();
    while (atOp('<') || atOp('[')) {
      const open  = atOp('<') ? '<' : '[';
      const close = open === '<' ? '>' : ']';
      eat();
      let depth = 1;
      while (depth > 0 && peek()) {
        if (atOp(open))       { depth++; eat(); }
        else if (atOp(close)) { depth--; eat(); if (depth === 0) break; }
        else                  { eat(); }
      }
      if (depth !== 0) throw err(peek(), `expected '${close}' to close type-arg bracket`);
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
    return parsePipe();
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
    return { type: 'If', cond, then: thenBranch, else: elseBranch };
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
      l = { type: 'Binary', op: '||', left: l, right: parseAnd() };
    }
    return l;
  }

  function parseAnd() {
    let l = parseCmp();
    while (atOp('&&')) {
      eat();
      l = { type: 'Binary', op: '&&', left: l, right: parseCmp() };
    }
    return l;
  }

  function parseCmp() {
    let l = parseConversion();
    while (peek() && peek().type === 'op' && CMP_OPS.has(peek().op)) {
      const op = eat().op;
      l = { type: 'Binary', op, left: l, right: parseConversion() };
    }
    return l;
  }

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
    while (true) {
      let op;
      if (atOp('*') || atOp('/')) op = eat().op;
      else if (atKw('per'))       { eat(); op = '/'; }   // `meter per second`
      else break;
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
    let base = parseUnary();
    // Postfix forms: field access `.name` and factorial `!`. Loop so chains
    // like `a.b.c!` work. `!` is its own AST node — NOT a Call to factorial —
    // so user-defined `fn factorial(n) = n!` doesn't recurse infinitely.
    while (atOp('.') || atOp('!')) {
      if (atOp('.')) {
        eat();
        const fnameTok = expectType('id', 'field name');
        base = { type: 'Field', obj: base, name: fnameTok.name };
      } else {
        eat();
        base = { type: 'Factorial', expr: base };
      }
    }
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
    // Prefix `!` is boolean NOT. (Postfix `!` factorial is handled in
    // parsePower, after the operand is consumed.)
    if (atOp('!')) {
      eat();
      return { type: 'Unary', op: '!', expr: parseUnary() };
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
      eat();
      const inner = parseExpr();
      expectOp(')');
      return { type: 'Paren', expr: inner };
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
  sin(q) { mustBeAngleOrScalar(q, 'sin'); return new Quantity(Math.sin(q.value), {}); },
  cos(q) { mustBeAngleOrScalar(q, 'cos'); return new Quantity(Math.cos(q.value), {}); },
  tan(q) { mustBeAngleOrScalar(q, 'tan'); return new Quantity(Math.tan(q.value), {}); },
  asin(q){ mustBeDimensionless(q, 'asin');return new Quantity(Math.asin(q.value), {}); },
  acos(q){ mustBeDimensionless(q, 'acos');return new Quantity(Math.acos(q.value), {}); },
  atan(q){ mustBeDimensionless(q, 'atan');return new Quantity(Math.atan(q.value), {}); },
  log(q) { mustBeDimensionless(q, 'log'); return new Quantity(Math.log10(q.value), {}); },
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
  get_local_timezone(args) { return 'UTC'; },
  now(args)                { return new Quantity(Date.now() / 1000, { time: 1 }); },
  format_datetime(args)    { return String(args[1] ?? ''); },
  tz(args)                 { return { __struct: 'TzFn', name: String(args[0] ?? '') }; },
  exchange_rate(args)      { return new Quantity(1, {}); },
  datetime(args) {
    // Parse ISO-ish input into seconds-since-epoch; falls back to 0 on bad input.
    const t = Date.parse(String(args[0] ?? ''));
    return new Quantity(Number.isFinite(t) ? t / 1000 : 0, { time: 1 });
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
    throw new Error('len: expected List or String');
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
  if (node.type === 'StructInit') {
    // v0.5 stores structs as plain JS objects with a __struct tag for the
    // type name. Field types from the declaration aren't enforced at runtime.
    const obj = { __struct: node.name };
    for (const f of node.fields) obj[f.name] = evalValueExpr(f.value, env);
    return obj;
  }
  if (node.type === 'Field') {
    const o = evalValueExpr(node.obj, env);
    if (o === null || typeof o !== 'object' || Array.isArray(o)) {
      throw new Error(`field access on non-struct value`);
    }
    if (!(node.name in o)) {
      throw new Error(`field '${node.name}' not in struct ${o.__struct ?? '(unknown)'}`);
    }
    return o[node.name];
  }
  if (node.type === 'Unary' && node.op === '!') {
    const v = evalValueExpr(node.expr, env);
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
    return evalValueExpr(node.expr, env).neg();
  }
  if (node.type === 'Binary') {
    // Logical operators on booleans (short-circuit).
    if (node.op === '&&') {
      const l = evalValueExpr(node.left, env);
      if (typeof l !== 'boolean') throw new Error('&& requires Bool operands');
      if (!l) return false;
      const r = evalValueExpr(node.right, env);
      if (typeof r !== 'boolean') throw new Error('&& requires Bool operands');
      return r;
    }
    if (node.op === '||') {
      const l = evalValueExpr(node.left, env);
      if (typeof l !== 'boolean') throw new Error('|| requires Bool operands');
      if (l) return true;
      const r = evalValueExpr(node.right, env);
      if (typeof r !== 'boolean') throw new Error('|| requires Bool operands');
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

// Comparison: both operands must agree on shape. ==/!= work on every value
// type; ordering ops only on Quantities (with same dim).
function evalCmp(node, env) {
  const l = evalValueExpr(node.left, env);
  const r = evalValueExpr(node.right, env);
  // ==/!= are total: lists, strings, booleans, quantities all comparable to
  // their own kind. Cross-kind compares throw to surface obvious bugs.
  if (node.op === '==' || node.op === '!=') {
    if (Array.isArray(l) || Array.isArray(r)) {
      if (!Array.isArray(l) || !Array.isArray(r)) {
        throw new Error(`${node.op}: cannot compare List with non-List`);
      }
      const eq = valueEq(l, r);
      return node.op === '==' ? eq : !eq;
    }
    if (typeof l === 'boolean' || typeof r === 'boolean') {
      if (typeof l !== typeof r) {
        throw new Error(`${node.op}: cannot compare Bool with non-Bool`);
      }
      return node.op === '==' ? l === r : l !== r;
    }
    if (typeof l === 'string' || typeof r === 'string') {
      if (typeof l !== typeof r) {
        throw new Error(`${node.op}: cannot compare String with non-String`);
      }
      return node.op === '==' ? l === r : l !== r;
    }
    // Quantity-vs-Quantity
    if (!dimEq(l.dim, r.dim)) {
      throw new Error(`${node.op}: dim mismatch [${JSON.stringify(l.dim)}] vs [${JSON.stringify(r.dim)}]`);
    }
    return node.op === '==' ? l.value === r.value : l.value !== r.value;
  }
  // Ordering ops: Quantity only.
  if (typeof l === 'boolean' || typeof r === 'boolean') {
    throw new Error(`${node.op}: ordering not defined on booleans`);
  }
  if (Array.isArray(l) || Array.isArray(r) || typeof l === 'string' || typeof r === 'string') {
    throw new Error(`${node.op}: ordering only defined on Quantities`);
  }
  if (!dimEq(l.dim, r.dim)) {
    throw new Error(`${node.op}: dim mismatch [${JSON.stringify(l.dim)}] vs [${JSON.stringify(r.dim)}]`);
  }
  switch (node.op) {
    case '<':  return l.value <  r.value;
    case '<=': return l.value <= r.value;
    case '>':  return l.value >  r.value;
    case '>=': return l.value >= r.value;
  }
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

function loadModule(ast, env) {
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

function loadSource(text, sourceName, env) {
  const tokens = tokenize(text, sourceName);
  const ast = parse(tokens, sourceName);
  loadModule(ast, env);
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
  loadSource(text, sourceName = '<inline>') {
    const env = makeEnv({
      dims: this.dims,
      units: this.registry,
      values: this.values,
      fns: this.fns,
      structs: this.structs,
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
export { Numbat, Quantity, UnitRegistry, DimRegistry, dimEq, dimMul, dimDiv, dimPow, dimInv, dimEmpty, dimFormat, formatNumber, tokenize, parse, loadSource, loadModule, makeEnv, evalDimExpr, evalValueExpr, setQuantityFormatter, setPrintSink, formatParts, VENDORED_MODULES };
