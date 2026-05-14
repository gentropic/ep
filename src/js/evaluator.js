// Pure evaluator: classify lines, parse dimension annotations, and evaluate a
// body of ep-script statements into rows/params/outputs/scope. No DOM, no
// singleton state — `evaluate(body)` returns everything its caller needs to
// reconcile into a UI state object (state.js does that).

import { dEq, dMul, dDiv, fmtDim } from './units.js';
import { epTokenize as tokenize, epParseExpr as parseExpr } from './parser.js';

export function classify(src) {
  const t = src.trim();
  if (t === '') return {kind: 'empty'};
  if (t.startsWith('--') || t.startsWith('#')) return {kind: 'comment'};
  if (/^@params\s*\{\s*$/.test(t))  return {kind: 'params-open'};
  if (/^\}\s*$/.test(t))            return {kind: 'block-close'};
  const om = t.match(/^@outputs\s*\{\s*([^}]*)\s*\}\s*$/);
  if (om) return {kind: 'outputs', names: om[1].split(',').map(s => s.trim()).filter(Boolean)};
  // Binding with optional type annotation: `name [: Type] = expr`
  const bm = t.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*:\s*([A-Z][a-zA-Z0-9_]*(?:\s*[/*]\s*[A-Z][a-zA-Z0-9_]*(?:\s*\^\s*-?\d+)?)*))?\s*=\s*(.+)$/);
  if (bm) return {kind: 'binding', name: bm[1], anno: bm[2] || null, expr: bm[3]};
  return {kind: 'expr', expr: t};
}

// Dimensions known by short name (for optional type annotations)
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

// Parse a dimension annotation like "Mass / Volume" or "Length ^ 2"
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

// Pure evaluator: takes a body array of {src} and returns a description of
// everything derived from it. Does not mutate the input.
//
// Returns:
//   rows[]:        parallel to body; each {kind, name, result, error, outputs, inParams}
//   params[]:      [{name, valueSrc, anno, bodyIdx, result, error}]
//   outputs[]:     string[] — names listed in @outputs { … }
//   scope:         {[name]: Q} — bindings visible at end of evaluation
//   blockComplete: boolean    — true if a @params { … } pair was found
//   blocks[]:      [{open, close, kind, count}]
export function evaluate(body) {
  // Pre-scan: find @params block bounds (only valid if both `@params {` and a later `}` exist)
  let blockOpen = -1, blockClose = -1;
  for (let i = 0; i < body.length; i++) {
    const t = body[i].src.trim();
    if (blockOpen < 0 && /^@params\s*\{\s*$/.test(t)) { blockOpen = i; continue; }
    if (blockOpen >= 0 && blockClose < 0 && /^\}\s*$/.test(t)) { blockClose = i; break; }
  }
  const blockComplete = (blockOpen >= 0 && blockClose > blockOpen);

  const scope = {};
  const params = [];
  const outputs = [];
  const rows = body.map(() => ({kind: null, name: null, result: null, error: null, outputs: null, inParams: false}));

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
        row.error = 'expected `name = expr` inside @params';
        continue;
      }
      const name = c.name;
      let q = null, err = null;
      try {
        q = parseExpr(tokenize(c.expr), scope);
        if (c.anno) {
          const expected = parseAnno(c.anno);
          if (!dEq(expected, q.d)) {
            throw new Error(`annotated ${c.anno} but got [${fmtDim(q.d)}]`);
          }
        }
        scope[name] = q;
      } catch (e) { q = null; err = e.message; }
      row.result = q;
      row.error  = err;
      params.push({name, valueSrc: c.expr, anno: c.anno || null, bodyIdx: i, result: q, error: err});
      continue;
    }

    // Lines outside any complete @params block
    if (c.kind === 'empty' || c.kind === 'comment') continue;
    if (c.kind === 'params-open' || c.kind === 'block-close') continue;
    if (c.kind === 'outputs') {
      row.outputs = c.names;
      outputs.push(...c.names);
      continue;
    }
    try {
      const q = parseExpr(tokenize(c.expr), scope);
      // Optional type annotation check
      if (c.kind === 'binding' && c.anno) {
        try {
          const expected = parseAnno(c.anno);
          if (!dEq(expected, q.d)) {
            throw new Error(`annotated ${c.anno} but got [${fmtDim(q.d)}]`);
          }
        } catch (e) {
          row.error = e.message;
          continue;
        }
      }
      row.result = q;
      if (c.kind === 'binding') scope[c.name] = q;
    } catch (e) { row.error = e.message; }
  }

  const blocks = [];
  if (blockComplete) {
    blocks.push({open: blockOpen, close: blockClose, kind: 'params', count: params.length});
  }

  return {rows, params, outputs, scope, blockComplete, blocks};
}
