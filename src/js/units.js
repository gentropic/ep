// Units, dimensions, the Q quantity primitive, and formatting.
// Eventually replaced by ext/numbat/ when that lands.

export const UNITS = {
  mg:  {mul: 1e-3,  dim: {mass: 1}},
  g:   {mul: 1,     dim: {mass: 1}},
  kg:  {mul: 1e3,   dim: {mass: 1}},
  t:   {mul: 1e6,   dim: {mass: 1}},
  kt:  {mul: 1e9,   dim: {mass: 1}},
  Mt:  {mul: 1e12,  dim: {mass: 1}},
  oz:  {mul: 28.3495,dim: {mass: 1}},
  ozt: {mul: 31.1035,dim: {mass: 1}},
  mm:  {mul: 1e-3,  dim: {length: 1}},
  cm:  {mul: 1e-2,  dim: {length: 1}},
  m:   {mul: 1,     dim: {length: 1}},
  km:  {mul: 1e3,   dim: {length: 1}},
  mm2: {mul: 1e-6,  dim: {length: 2}},
  cm2: {mul: 1e-4,  dim: {length: 2}},
  m2:  {mul: 1,     dim: {length: 2}},
  ha:  {mul: 1e4,   dim: {length: 2}},
  km2: {mul: 1e6,   dim: {length: 2}},
  cm3: {mul: 1e-6,  dim: {length: 3}},
  L:   {mul: 1e-3,  dim: {length: 3}},
  m3:  {mul: 1,     dim: {length: 3}},
  km3: {mul: 1e9,   dim: {length: 3}},
  'g/cm3': {mul: 1e6, dim: {mass: 1, length: -3}},
  'kg/m3': {mul: 1e3, dim: {mass: 1, length: -3}},
  't/m3':  {mul: 1e6, dim: {mass: 1, length: -3}},
  ppm:   {mul: 1e-6, dim: {}},
  ppb:   {mul: 1e-9, dim: {}},
  pct:   {mul: 1e-2, dim: {}},
  'g/t': {mul: 1e-6, dim: {}},
  deg: {mul: Math.PI/180, dim: {angle: 1}},
  rad: {mul: 1,           dim: {angle: 1}},
};

export const UDISP = {
  mm2:'mm²', cm2:'cm²', m2:'m²', km2:'km²',
  cm3:'cm³', m3:'m³', km3:'km³',
  'g/cm3':'g/cm³', 'kg/m3':'kg/m³', 't/m3':'t/m³',
};
export const disp = n => UDISP[n] || n;

export const dEq = (a, b) => {
  const k = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const x of k) if ((a[x]||0) !== (b[x]||0)) return false;
  return true;
};
export const dMul = (a, b) => {
  const r = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k]||0) + (b[k]||0);
    if (n) r[k] = n;
  }
  return r;
};
export const dDiv = (a, b) => {
  const r = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k]||0) - (b[k]||0);
    if (n) r[k] = n;
  }
  return r;
};
export const dEmpty = d => Object.keys(d).length === 0;
export const fmtDim = d => Object.entries(d).map(([k,v]) => v===1?k:`${k}^${v}`).join('·') || '-';

export class Q {
  constructor(v, d, disp) { this.v = v; this.d = d; this.disp = disp || null; }
}
export const lit = (v, u) => {
  if (!u) return new Q(v, {});
  const x = UNITS[u];
  if (!x) throw new Error(`unknown unit: ${u}`);
  return new Q(v * x.mul, x.dim);
};
export const qAdd = (a, b) => {
  if (!dEq(a.d, b.d)) throw new Error(`can't add [${fmtDim(a.d)}] + [${fmtDim(b.d)}]`);
  return new Q(a.v + b.v, a.d);
};
export const qSub = (a, b) => {
  if (!dEq(a.d, b.d)) throw new Error(`can't subtract [${fmtDim(a.d)}] − [${fmtDim(b.d)}]`);
  return new Q(a.v - b.v, a.d);
};
export const qMul = (a, b) => new Q(a.v * b.v, dMul(a.d, b.d));
export const qDiv = (a, b) => new Q(a.v / b.v, dDiv(a.d, b.d));
export const qPow = (a, b) => {
  if (!dEmpty(b.d)) throw new Error('exponent must be dimensionless');
  const d = {};
  for (const k in a.d) d[k] = a.d[k] * b.v;
  return new Q(Math.pow(a.v, b.v), d);
};
export const qConvert = (a, unitName) => {
  const u = UNITS[unitName];
  if (!u) throw new Error(`unknown unit: ${unitName}`);
  if (!dEq(a.d, u.dim)) {
    throw new Error(`can't convert [${fmtDim(a.d)}] to ${unitName} [${fmtDim(u.dim)}]`);
  }
  // Value is unchanged (canonical units internally); record preferred display
  return new Q(a.v, a.d, unitName);
};

export function fmt(q) {
  if (dEmpty(q.d)) return [fmtNum(q.v), null];
  // If Q has explicit display unit (from `->` conversion), honor it
  if (q.disp && UNITS[q.disp] && dEq(UNITS[q.disp].dim, q.d)) {
    return [fmtNum(q.v / UNITS[q.disp].mul), disp(q.disp)];
  }
  const cands = Object.entries(UNITS).filter(([_, u]) => dEq(u.dim, q.d));
  if (!cands.length) return [fmtNum(q.v), `[${fmtDim(q.d)}]`];
  cands.sort((a, b) => b[1].mul - a[1].mul);
  let best = null;
  // First pass: tight range, prefer the largest unit that lands in [1, 1000)
  for (const [name, u] of cands) {
    const s = q.v / u.mul;
    if (Math.abs(s) >= 1 && Math.abs(s) < 1000) { best = {name, s}; break; }
  }
  // Second pass: more permissive, so 80,000 m³ stays in m³ not 8e-5 km³
  if (!best) {
    for (const [name, u] of cands) {
      const s = q.v / u.mul;
      if (Math.abs(s) >= 0.01 && Math.abs(s) < 1e6) { best = {name, s}; break; }
    }
  }
  // Last resort: closest to magnitude 1 on log scale
  if (!best) {
    cands.sort((a, b) => {
      const la = Math.abs(Math.log10(Math.abs(q.v / a[1].mul) || 1e-30));
      const lb = Math.abs(Math.log10(Math.abs(q.v / b[1].mul) || 1e-30));
      return la - lb;
    });
    const [name, u] = cands[0];
    best = {name, s: q.v / u.mul};
  }
  return [fmtNum(best.s), disp(best.name)];
}
export function fmtNum(n) {
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
