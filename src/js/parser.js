// Tokenizer and expression parser for ep-script.
// Calls into units.js for quantity arithmetic.

import { Q, UNITS, lit, qAdd, qSub, qMul, qDiv, qPow, qConvert, dEmpty } from './units.js';

export function tokenize(s) {
  const ci1 = s.indexOf('--'), ci2 = s.indexOf('#');
  let cut = Infinity;
  if (ci1 >= 0) cut = Math.min(cut, ci1);
  if (ci2 >= 0) cut = Math.min(cut, ci2);
  if (cut < Infinity) s = s.slice(0, cut);

  s = s
    .replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
    .replace(/π/g, ' pi ').replace(/√/g, 'sqrt')
    .replace(/²/g, '^2').replace(/³/g, '^3')
    .replace(/→/g, ' -> ').replace(/➞/g, ' -> ')
    .replace(/·/g, '*');

  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i+1]))) {
      let j = i, dot = false, eExp = false;
      while (j < s.length) {
        const ch = s[j];
        if (/[0-9]/.test(ch)) j++;
        else if (ch === '_' && /[0-9]/.test(s[j+1])) j++;          // digit separator: 12_345
        else if (ch === '.' && !dot && !eExp) { dot = true; j++; }
        else if ((ch === 'e' || ch === 'E') && !eExp) {
          eExp = true; j++;
          if (s[j] === '+' || s[j] === '-') j++;
        } else break;
      }
      const raw = s.slice(i, j).replace(/_/g, '');
      toks.push({type: 'num', v: parseFloat(raw)});
      i = j; continue;
    }
    // '->' as conversion (lookahead before falling through to single-char ops)
    if (c === '-' && s[i+1] === '>') {
      toks.push({type: 'op', v: '->'}); i += 2; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
      let word = s.slice(i, j);
      if (s[j] === '/' && /[a-zA-Z]/.test(s[j+1])) {
        let k = j + 1;
        while (k < s.length && /[a-zA-Z0-9]/.test(s[k])) k++;
        const compound = word + '/' + s.slice(j+1, k);
        if (UNITS[compound]) { word = compound; j = k; }
      }
      // `to` as conversion keyword
      if (word === 'to') { toks.push({type: 'op', v: '->'}); i = j; continue; }
      if (UNITS[word]) toks.push({type: 'unit', name: word});
      else toks.push({type: 'id', name: word});
      i = j; continue;
    }
    if (':'.includes(c))           { toks.push({type: 'op', v: ':'}); i++; continue; }
    if ('+-*/^()'.includes(c))     { toks.push({type: 'op', v: c}); i++; continue; }
    throw new Error(`unexpected: ${c}`);
  }
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === 'num' && toks[k+1] && toks[k+1].type === 'unit') {
      out.push({type: 'qnum', v: t.v, u: toks[k+1].name});
      k++;
    } else if (t.type === 'unit') {
      out.push({type: 'qnum', v: 1, u: t.name});
    } else {
      out.push(t);
    }
  }
  return out;
}

export function parseExpr(toks, scope) {
  let p = 0;
  const peek = () => toks[p];
  const eat  = () => toks[p++];
  function expr() {
    let l = addExpr();
    while (peek() && peek().type === 'op' && peek().v === '->') {
      eat();
      // RHS must be a unit name; consume the next token as a unit reference
      const t = peek();
      if (!t || t.type !== 'qnum' || !t.u || t.v !== 1) {
        throw new Error('expected unit name after ->');
      }
      eat();
      l = qConvert(l, t.u);
    }
    return l;
  }
  function addExpr() {
    let l = term();
    while (peek() && peek().type === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = eat().v;
      const r = term();
      l = op === '+' ? qAdd(l, r) : qSub(l, r);
    }
    return l;
  }
  function term() {
    let l = factor();
    while (peek() && peek().type === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = eat().v;
      const r = factor();
      l = op === '*' ? qMul(l, r) : qDiv(l, r);
    }
    return l;
  }
  function factor() {
    const b = unary();
    if (peek() && peek().type === 'op' && peek().v === '^') {
      eat();
      const e = factor();
      return qPow(b, e);
    }
    return b;
  }
  function unary() {
    if (peek() && peek().type === 'op' && peek().v === '-') {
      eat();
      const v = unary();
      return new Q(-v.v, v.d, v.disp);
    }
    return primary();
  }
  function primary() {
    const t = peek();
    if (!t) throw new Error('unexpected end');
    if (t.type === 'qnum') { eat(); return lit(t.v, t.u); }
    if (t.type === 'num')  { eat(); return new Q(t.v, {}); }
    if (t.type === 'op' && t.v === '(') {
      eat();
      const e = expr();
      if (!peek() || peek().v !== ')') throw new Error('expected )');
      eat();
      return e;
    }
    if (t.type === 'id') {
      eat();
      const name = t.name;
      if (name === 'pi') return new Q(Math.PI, {});
      if (name === 'e')  return new Q(Math.E,  {});
      if (peek() && peek().type === 'op' && peek().v === '(') {
        eat();
        const arg = expr();
        if (!peek() || peek().v !== ')') throw new Error('expected )');
        eat();
        return applyFn(name, arg);
      }
      if (Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
      throw new Error(`undefined: ${name}`);
    }
    throw new Error('unexpected token');
  }
  if (toks.length === 0) throw new Error('empty');
  const r = expr();
  if (p < toks.length) throw new Error('trailing input');
  return r;
}

export function applyFn(name, q) {
  const v = q.v;
  switch (name) {
    case 'sin':  return new Q(Math.sin(v), {});
    case 'cos':  return new Q(Math.cos(v), {});
    case 'tan':  return new Q(Math.tan(v), {});
    case 'sqrt':
      if (!dEmpty(q.d)) {
        const nd = {};
        for (const k in q.d) {
          if (q.d[k] % 2 !== 0) throw new Error('sqrt: odd dim exponent');
          nd[k] = q.d[k] / 2;
        }
        return new Q(Math.sqrt(v), nd);
      }
      return new Q(Math.sqrt(v), {});
    case 'log':
      if (!dEmpty(q.d)) throw new Error('log expects dimensionless');
      return new Q(Math.log10(v), {});
    case 'ln':
      if (!dEmpty(q.d)) throw new Error('ln expects dimensionless');
      return new Q(Math.log(v), {});
    case 'abs':  return new Q(Math.abs(v), q.d);
    case 'exp':
      if (!dEmpty(q.d)) throw new Error('exp expects dimensionless');
      return new Q(Math.exp(v), {});
    default: throw new Error(`unknown fn: ${name}`);
  }
}
