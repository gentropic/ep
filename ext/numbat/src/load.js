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

import { Quantity } from './quantity.js';
import { dimEq, dimMul, dimDiv, dimPow, dimEmpty } from './dimensions.js';
import { tokenize } from './tokenize.js';
import { parse } from './parse.js';
import { typecheckModule } from './typecheck/integration.js';

// ── expression evaluators ────────────────────────────────────────

export function evalDimExpr(node, env) {
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

// Keep the elements of `xs` where the same-index entry of `mask` is
// true. mask must be a List<Bool> the same length as xs. Shared by the
// `where` clause and filter()'s mask form.
function maskFilter(xs, mask) {
  if (!Array.isArray(mask)) throw new Error('mask filter: predicate must produce a Bool mask');
  if (mask.length !== xs.length) {
    throw new Error(`mask filter: mask length ${mask.length} doesn't match list length ${xs.length}`);
  }
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    if (mask[i] === true) out.push(xs[i]);
    else if (mask[i] !== false) throw new Error('mask filter: mask elements must be Bool');
  }
  return out;
}

// Filter every column of a Dataset by a row mask, producing a new
// Dataset with only the matching rows.
function datasetFilter(ds, mask) {
  if (!Array.isArray(mask)) throw new Error('where: predicate must produce a Bool mask');
  if (mask.length !== ds.length) {
    throw new Error(`where: predicate mask length ${mask.length} doesn't match dataset length ${ds.length}`);
  }
  const columns = new Map();
  for (const [name, col] of ds.columns) columns.set(name, maskFilter(col, mask));
  let length = 0;
  for (const b of mask) if (b === true) length++;
  return Object.freeze({ __dataset: true, columns, length });
}

// ── CSV parsing (SPEC-DATASETS Phase 1.3) ────────────────────────
//
// A small RFC-4180-ish parser: text → Dataset. Parsing is configured
// by a `parseConfig` object (delimiter / commentChar / skipRows /
// hasHeader / decimal); ep configures it at attach time, the parser
// itself is pure. No library.

export function csvDefaultConfig() {
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
export function detectCsvConfig(text) {
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

// Parse CSV text into a Dataset. `config` is merged over auto-detection.
// `opts.resolveUnit(text) -> Quantity` resolves a header unit suffix;
// see the column-build comment for which suffixes are actually applied.
export function parseCsv(text, config, opts) {
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

  // Resolve each numeric column's header unit. A `(unit)` suffix is
  // folded into the cells AND recorded as the value's display tag
  // (`disp`) — `grade (g/t)` cells become `Quantity(2.5e-6, {}, 'g/t')`.
  // The disp tag does double duty: the formatter shows `2.5 g/t`, and
  // it marks the column as unit-bearing so comparisons against bare
  // numbers can be flagged (see the poison check in evalCmp).
  const colUnit = headers.map((h, ci) => {
    if (colType[ci] !== 'number' || !h.unitText || !resolveUnit) return null;
    let u;
    try { u = resolveUnit(h.unitText); } catch { return null; }
    if (!u) return null;
    return { mul: u.value, dim: u.dim, disp: h.unitText };
  });

  // Build the columns.
  const columns = new Map();
  headers.forEach((h, ci) => {
    const t = colType[ci];
    const cu = colUnit[ci];
    const out = new Array(dataRows.length);
    for (let ri = 0; ri < dataRows.length; ri++) {
      const v = cellAt(dataRows[ri], ci).trim();
      if (t === 'number') {
        if (v === '') {
          out[ri] = new Quantity(NaN, cu ? cu.dim : {}, cu ? cu.disp : null);
        } else {
          const num = parseFloat(normalizeNumberCell(v, cfg.decimal));
          out[ri] = cu
            ? new Quantity(num * cu.mul, cu.dim, cu.disp)
            : new Quantity(num, {});
        }
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
  // schema(dataset) — print the dataset's columns, one per line, each
  // with its unit (from the disp tag a unit-loaded column carries) or
  // its type. Routes through the print sink, so it shows in the info
  // block below the line like print(). Returns the void sentinel.
  schema(args) {
    if (args.length !== 1) throw new Error(`schema: expected 1 arg, got ${args.length}`);
    const ds = args[0];
    if (!ds || typeof ds !== 'object' || !ds.__dataset) {
      throw new Error('schema: expected a dataset');
    }
    let widest = 0;
    for (const name of ds.columns.keys()) widest = Math.max(widest, name.length);
    const lines = [`${ds.length} rows × ${ds.columns.size} columns`];
    for (const [name, col] of ds.columns) {
      const sample = col.find(v => v !== undefined && v !== null);
      let kind = 'empty';
      if (typeof sample === 'string')  kind = 'String';
      else if (typeof sample === 'boolean') kind = 'Bool';
      else if (sample instanceof Quantity) kind = sample.disp ? sample.disp : 'number';
      lines.push('  ' + name.padEnd(widest + 2) + kind);
    }
    if (typeof _printSink === 'function') _printSink(lines.join('\n'));
    return new Quantity(0, {});
  },

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
    if (Array.isArray(p)) return maskFilter(xs, p);
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
  // sum / mean / stdev — list reductions, native so they can carry the
  // input column's display unit through to the result. Upstream's
  // sum (core::lists) / mean / stdev (math::statistics) bottom out in
  // foldl arithmetic, which drops the `disp` tag — so `mean(grade)`
  // would read `1.62e-6` instead of `1.62 g/t`. These natives compute
  // the same values but re-attach the column's uniform disp.
  //
  // `uniformDisp` is the shared display unit of a quantity list, or
  // null when the elements disagree (or aren't all quantities).
  sum(args) {
    if (args.length !== 1) throw new Error(`sum: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('sum: expected a list');
    if (xs.length === 0) return new Quantity(0, {});   // additive identity
    const dim = xs[0].dim;
    let total = 0;
    let disp = xs[0].disp ?? null;
    for (const q of xs) {
      if (!(q instanceof Quantity)) throw new Error('sum: list elements must be quantities');
      if (!dimEq(q.dim, dim)) throw new Error('sum: list has mixed dimensions');
      total += q.value;
      if ((q.disp ?? null) !== disp) disp = null;
    }
    return new Quantity(total, dim, disp);
  },
  mean(args) {
    if (args.length !== 1) throw new Error(`mean: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('mean: expected a list');
    if (xs.length === 0) throw new Error('mean: empty list');
    const s = BUILTIN_PROCS.sum([xs]);
    return new Quantity(s.value / xs.length, s.dim, s.disp);
  },
  stdev(args) {
    if (args.length !== 1) throw new Error(`stdev: expected 1 arg, got ${args.length}`);
    const xs = args[0];
    if (!Array.isArray(xs)) throw new Error('stdev: expected a list');
    if (xs.length === 0) throw new Error('stdev: empty list');
    const m = BUILTIN_PROCS.mean([xs]);   // also dim-checks + finds the disp
    let sumsq = 0;
    for (const q of xs) sumsq += (q.value - m.value) ** 2;
    // Population standard deviation — matches upstream math::statistics.
    return new Quantity(Math.sqrt(sumsq / xs.length), m.dim, m.disp);
  },
  // maximum / minimum / median — list reductions. Upstream's
  // math::statistics defines maximum/minimum by direct head/tail
  // recursion and median via a recursive sort, so all three overflow
  // the tree-walker's stack on a few-thousand-element column. ep ships
  // iterative natives and shadows the recursive defs (same pattern as
  // range/map/filter). Empty list throws — an empty List<D> carries no
  // D to return. maximum/minimum return an element directly, so they
  // keep its disp; median re-attaches it on the even-length average.
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
    // Keep the column's display unit when both straddling elements
    // agree on it (they will, for a uniform column).
    const disp = (lo.disp ?? null) === (hi.disp ?? null) ? (lo.disp ?? null) : null;
    return new Quantity((lo.value + hi.value) / 2, lo.dim, disp);
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
export function setQuantityFormatter(fn) { _quantityFormatter = fn; }

// Print sink: hosts (or tests) set a callback that receives each
// `print(args)` call's rendered text. ep leaves this null in production
// (no output panel yet); the conformance corpus sets it to a buffer to
// assert on what programs print.
let _printSink = null;
export function setPrintSink(fn) { _printSink = fn; }

// Plot output sink — receives a descriptor object whenever a program
// calls plot()/scatter()/bar()/hist(). Same role as _printSink for
// text: numbat-js stays output-medium-agnostic, the host (ep, REPL,
// notebook shell) chooses how to render. Descriptor shape:
//   { type: 'line' | 'scatter' | 'bar' | 'hist',
//     xs?: number[], ys?: number[], values?: number[],
//     xUnit?: string, yUnit?: string }
// Defaults to no-op; hosts that don't render plots simply drop them.
let _plotSink = null;
export function setPlotSink(fn) { _plotSink = fn; }

// CSV asset resolver — the host (ep) supplies a function that maps an
// asset name to `{ text, config? }` (or null when no such asset). The
// `load_csv(name)` builtin calls it, then parses the text into a
// Dataset. numbat-js itself has no notion of files / storage; the host
// owns the asset table. Defaults to a resolver that always reports
// "no asset", so load_csv fails gracefully outside ep.
let _csvResolver = null;
export function setCsvResolver(fn) { _csvResolver = fn; }

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

export function evalValueExpr(node, env) {
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
  // Filter `where` (ep dataset extension): `<source> where <pred>`.
  //   - source is a Dataset → the predicate is evaluated with the
  //     dataset's columns bound as variables (columns-first scope), so
  //     `model where grade > cutoff` reads `grade` as model.grade and
  //     `cutoff` from the outer scope. Result: a row-filtered Dataset.
  //   - source is a List → the predicate is evaluated in the normal
  //     scope and must itself produce the Bool mask
  //     (`xs where xs > 5`). Result: a filtered List.
  // Either way the predicate must yield a List<Bool> matching the
  // source's length. Eager: the filtered value is materialized now.
  if (node.type === 'Where') {
    const source = evalValueExpr(node.source, env);
    if (source !== null && typeof source === 'object' && source.__dataset) {
      // Columns-first child scope: an env whose lookupValue resolves the
      // dataset's columns before delegating to the outer scope. So
      // `model where grade > cutoff` reads `grade` as the grade column
      // and `cutoff` from the surrounding program.
      const childEnv = { ...env };
      childEnv.lookupValue = (name) =>
        source.columns.has(name) ? source.columns.get(name) : env.lookupValue(name);
      const mask = evalValueExpr(node.pred, childEnv);
      return datasetFilter(source, mask);
    }
    if (Array.isArray(source)) {
      return maskFilter(source, evalValueExpr(node.pred, env));
    }
    throw new Error('where: left side must be a dataset or a list');
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

// The display-unit tag of a value, or null. For a list, the tag of its
// first element — a CSV column is uniform, so the first element speaks
// for the column.
function dispMarkOf(v) {
  if (v instanceof Quantity) return v.disp ?? null;
  if (Array.isArray(v) && v.length > 0 && v[0] instanceof Quantity) {
    return v[0].disp ?? null;
  }
  return null;
}

// True when the AST node is a bare number literal — `5`, `(5)`, `-5` —
// with no unit attached. `5 g/t` is `Binary(*, Num, Ident)` and is NOT
// bare. Used by the comparison poison below.
function isBareNumberLiteral(node) {
  if (!node) return false;
  if (node.type === 'Paren') return isBareNumberLiteral(node.expr);
  if (node.type === 'Unary' && (node.op === '-' || node.op === '+')) {
    return isBareNumberLiteral(node.expr);
  }
  return node.type === 'Num';
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
  // Bare-number poison: a value carrying a display unit (a CSV column
  // loaded with a `(unit)` header, or a `->` result) compared against a
  // bare number literal is almost always a mistake — the bare number
  // isn't in the value's unit. `grade (g/t)` cells are ~1e-6; `grade > 1`
  // would silently match nothing. Flag it loudly instead, naming the
  // unit so the fix (`grade > 1 g/t`) is obvious. A unit-bearing RHS
  // (`1 g/t`) or a variable (`cutoff`) is trusted and passes through.
  const lDisp = dispMarkOf(l);
  if (lDisp && isBareNumberLiteral(node.right)) {
    throw new Error(`comparison: the left side is in '${lDisp}' — compare against a value with that unit (e.g. \`<n> ${lDisp}\`), not a bare number`);
  }
  const rDisp = dispMarkOf(r);
  if (rDisp && isBareNumberLiteral(node.left)) {
    throw new Error(`comparison: the right side is in '${rDisp}' — compare against a value with that unit (e.g. \`<n> ${rDisp}\`), not a bare number`);
  }
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

export function loadModule(ast, env, opts = {}) {
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

export function loadSource(text, sourceName, env, opts = {}) {
  const tokens = tokenize(text, sourceName);
  const ast = parse(tokens, sourceName);
  loadModule(ast, env, opts);
}

// Build the env object used by the loader. Hosts that want to use the
// loader directly (without going through the Numbat class) call this.
export function makeEnv({ dims, units, values, fns, structs, resolveUse }) {
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
