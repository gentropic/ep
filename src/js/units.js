// Adapter to ext/numbat (v0.1). Re-exports numbat-js primitives under ep's
// existing API shape so parser.js / evaluator.js / render.js don't need to
// change. Over time, callers should migrate to importing from numbat-js
// directly (e.g. `import { Numbat, Quantity } from '../../ext/numbat/...'`).

import { Numbat, Quantity, dimEq, dimMul, dimDiv, dimEmpty, dimFormat, formatNumber } from '../../ext/numbat/dist/numbat.js';

const N = new Numbat();

// Quantity class — ep historically referred to it as `Q`.
export const Q = Quantity;

// Constructors and arithmetic — adapt method API to ep's free-function names.
export const lit      = (v, u) => u ? N.q(v, u) : new Quantity(v, {});
export const qAdd     = (a, b) => a.add(b);
export const qSub     = (a, b) => a.sub(b);
export const qMul     = (a, b) => a.mul(b);
export const qDiv     = (a, b) => a.div(b);
export const qPow     = (a, b) => a.pow(b);
export const qConvert = (q, unitName) => N.convertTo(q, unitName);

// Dimension primitives — ep's short names map to numbat-js's longer ones.
export const dEq    = dimEq;
export const dMul   = dimMul;
export const dDiv   = dimDiv;
export const dEmpty = dimEmpty;
export const fmtDim = dimFormat;

// UNITS — Proxy mimicking ep's old plain-object shape. parser.js does both
// truthy checks (`if (UNITS[word])`) and field access (`UNITS[u].mul`,
// `UNITS[u].dim`), both of which work via Proxy.get returning the registry
// entry or undefined. No iteration support needed: ep's evaluator no longer
// touches UNITS to auto-scale (format does that internally).
export const UNITS = new Proxy({}, {
  get: (_, name) => {
    if (typeof name !== 'string') return undefined;
    return N.resolve(name) ?? undefined;
  },
  has: (_, name) => typeof name === 'string' && N.hasUnit(name),
});

// Formatter — ep's fmt() returns [numString, unitString|null]; adapt from
// numbat-js's formatParts() which returns {num, unit}.
export const fmt = q => {
  const p = N.formatParts(q);
  return [p.num, p.unit];
};

// Number formatter — direct re-export.
export const fmtNum = formatNumber;
