// Pure evaluator: classify lines, parse dimension annotations, evaluate a body
// of ep-script statements into rows/params/outputs/scope.
//
// Expression evaluation is delegated to numbat-js: each binding/expression is
// wrapped as `let __ep__ = <expr>`, tokenized + parsed by numbat-js, and the
// expression AST is evaluated via evalValueExpr against a shared env. This
// gives ep the full Numbat surface (sin/cos/sqrt/factorial/etc.) and the full
// vendored unit/dim system "for free."
//
// What remains ep-specific:
//   - classify(): recognizes @params { }, @outputs { }, # / -- comments
//   - parseAnno() + DIMENSION_OF: type-annotation syntax for parameters
//   - evaluate() loop: line-level error resilience (one bad row doesn't stop
//     siblings), reactive scope build-up across the body
//
// The Numbat host instance is created lazily and reused across evaluate()
// calls. Values are per-evaluation (fresh Map every time) so chip edits
// don't accumulate stale bindings in the host.

import { dEq, dMul, dDiv, fmtDim } from './units.js';
import { Numbat, Quantity, tokenize, parse, evalValueExpr, makeEnv, loadModule } from '../../ext/numbat/dist/numbat.js';

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

  // Seed the standard dimensions so user-side `dimension X = ...` decls
  // resolve `Length`, `Mass`, etc. The v0.1 prelude registers units only.
  for (const [name, dim] of Object.entries(DIMENSION_OF)) {
    if (Object.keys(dim).length === 0) _host.dims.defineBase(name);
    else                                _host.dims.defineDerived(name, dim);
  }
  return _host;
}

// ── line classification (unchanged) ───────────────────────────────

// Parse a comma-separated list of `name [: unit]` specs from inside an
// @outputs block. Trailing commas and empty pieces are tolerated.
//
//   "volume, metal: kg, moz: oz"
//     → [{name:'volume', unit:null}, {name:'metal', unit:'kg'}, {name:'moz', unit:'oz'}]
export function parseOutputSpecs(text) {
  return text.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(piece => {
      const c = piece.indexOf(':');
      if (c < 0) return { name: piece, unit: null };
      return { name: piece.slice(0, c).trim(), unit: piece.slice(c + 1).trim() || null };
    });
}

export function classify(src) {
  const t = src.trim();
  if (t === '') return {kind: 'empty'};
  if (t.startsWith('--') || t.startsWith('#')) return {kind: 'comment'};
  if (/^@params\s*\{\s*$/.test(t))  return {kind: 'params-open'};
  if (/^@outputs\s*\{\s*$/.test(t)) return {kind: 'outputs-open'};
  if (/^\}\s*$/.test(t))            return {kind: 'block-close'};
  const om = t.match(/^@outputs\s*\{\s*([^}]*)\s*\}\s*$/);
  if (om) return {kind: 'outputs', specs: parseOutputSpecs(om[1])};

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

  // Binding: `[let] name [: Type] = expr`. The optional `let` keyword is
  // stripped so chips render the same way whether or not the user uses it.
  const body = /^let\s+/.test(t) ? t.slice(4).trim() : t;
  const bm = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*([A-Z][a-zA-Z0-9_]*(?:\s*[/*]\s*[A-Z][a-zA-Z0-9_]*(?:\s*\^\s*-?\d+)?)*))?\s*=\s*(.+)$/);
  if (bm) return {kind: 'binding', name: bm[1], anno: bm[2] || null, expr: bm[3]};

  return {kind: 'expr', expr: t};
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
  return { units, functions, dimensions, keywords };
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
  Angle:     {angle: 1},
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
    if (!(t.v in DIMENSION_OF)) throw new Error(`unknown dimension: ${t.v}`);
    p++;
    let d = {...DIMENSION_OF[t.v]};
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
  // Pre-scan: find @params block bounds
  let blockOpen = -1, blockClose = -1;
  for (let i = 0; i < body.length; i++) {
    const t = body[i].src.trim();
    if (blockOpen < 0 && /^@params\s*\{\s*$/.test(t)) { blockOpen = i; continue; }
    if (blockOpen >= 0 && blockClose < 0 && /^\}\s*$/.test(t)) { blockClose = i; break; }
  }
  const blockComplete = (blockOpen >= 0 && blockClose > blockOpen);

  // Pre-scan: find a multi-line @outputs block (independent of @params).
  let oOpen = -1, oClose = -1;
  for (let i = 0; i < body.length; i++) {
    // Skip lines that are inside the @params block — its closing `}` must
    // not be confused with an @outputs close.
    if (blockComplete && i >= blockOpen && i <= blockClose) continue;
    const t = body[i].src.trim();
    if (oOpen < 0 && /^@outputs\s*\{\s*$/.test(t)) { oOpen = i; continue; }
    if (oOpen >= 0 && oClose < 0 && /^\}\s*$/.test(t)) { oClose = i; break; }
  }
  const outputsBlockComplete = (oOpen >= 0 && oClose > oOpen);

  const env = freshEnv();
  const params = [];
  const outputs = [];
  const rows = body.map(() => ({kind: null, name: null, result: null, error: null, outputs: null, inParams: false}));

  // Collect @outputs specs from the multi-line block, if present.
  if (outputsBlockComplete) {
    const pieces = [];
    for (let i = oOpen + 1; i < oClose; i++) {
      const t = body[i].src.trim();
      if (!t || t.startsWith('#') || t.startsWith('--')) continue;
      pieces.push(t);
    }
    // Join with commas so trailing commas on individual lines don't matter.
    outputs.push(...parseOutputSpecs(pieces.join(',')));
  }

  for (let i = 0; i < body.length; i++) {
    const c = classify(body[i].src);
    const row = rows[i];
    row.kind = c.kind;
    row.name = c.name || null;
    row.inParams = blockComplete && i >= blockOpen && i <= blockClose;

    const inBlockBody = blockComplete && i > blockOpen && i < blockClose;

    if (inBlockBody) {
      if (c.kind === 'empty' || c.kind === 'comment') continue;
      if (c.kind !== 'binding') {
        // Recover the binding name from a malformed `name [: anno] = …` line
        // so the chip stays bound during mid-edit (e.g. the user briefly
        // clears the value to retype it). Without this, classify fails on
        // an empty expression, the param drops from state.params, and the
        // chip's input handler can't find its binding on subsequent edits.
        const recovery = body[i].src.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*([^=]+?))?\s*=\s*(.*)$/);
        if (recovery) {
          const recName = recovery[1];
          const recAnno = recovery[2] ? recovery[2].trim() : null;
          const recExpr = (recovery[3] || '').trim();
          const err = recExpr ? `couldn't parse: ${recExpr}` : 'empty expression';
          params.push({
            name: recName, valueSrc: recExpr, anno: recAnno,
            bodyIdx: i, result: null, error: err,
          });
          row.kind  = 'binding';
          row.name  = recName;
          row.error = err;
          continue;
        }
        row.error = 'expected `name = expr` inside @params';
        continue;
      }
      const name = c.name;
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
      } catch (e) { q = null; err = e.message; }
      row.result = q;
      row.error  = err;
      params.push({name, valueSrc: c.expr, anno: c.anno || null, bodyIdx: i, result: q, error: err});
      continue;
    }

    // Inside a multi-line @outputs block: rows are layout-only; specs were
    // already collected in the pre-scan above.
    const inOutputsBlock = outputsBlockComplete && i >= oOpen && i <= oClose;
    if (inOutputsBlock) {
      if (i === oOpen)        row.kind = 'outputs-open';
      else if (i === oClose)  row.kind = 'block-close';
      else                    row.kind = 'outputs-line';
      continue;
    }

    // Lines outside any complete @params block
    if (c.kind === 'empty' || c.kind === 'comment') continue;
    if (c.kind === 'params-open' || c.kind === 'outputs-open' || c.kind === 'block-close') continue;
    if (c.kind === 'outputs') {
      row.outputs = c.specs.map(s => s.name);
      outputs.push(...c.specs);
      continue;
    }
    if (c.kind === 'fn-decl' || c.kind === 'dim-decl' || c.kind === 'unit-decl') {
      try { loadStatement(c.src, env); }
      catch (e) { row.error = e.message; }
      continue;
    }
    try {
      const q = evalExprText(c.expr, env);
      if (c.kind === 'binding' && c.anno) {
        const expected = parseAnno(c.anno);
        if (!dEq(expected, q.dim)) {
          throw new Error(`annotated ${c.anno} but got [${fmtDim(q.dim)}]`);
        }
      }
      row.result = q;
      if (c.kind === 'binding') env.values.set(c.name, q);
    } catch (e) { row.error = e.message; }
  }

  const blocks = [];
  if (blockComplete) {
    blocks.push({open: blockOpen, close: blockClose, kind: 'params', count: params.length});
  }

  // Convert the values Map to a plain object — render.js does `state._scope[name]`.
  // Exclude host-seeded names (pi/tau/e/…) so the returned scope reflects
  // only this program's bindings.
  const scope = {};
  const seeded = host().values;
  for (const [k, v] of env.values) {
    if (!seeded.has(k)) scope[k] = v;
  }

  return {rows, params, outputs, scope, blockComplete, blocks};
}
