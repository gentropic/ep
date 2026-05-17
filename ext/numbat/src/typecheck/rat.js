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

export function ratOf(n, d = 1) { return Object.freeze(normalize(n, d)); }

export const RAT_ZERO = ratOf(0);
export const RAT_ONE  = ratOf(1);

export function ratIsZero(r) { return r.n === 0; }
export function ratIsInt(r)  { return r.d === 1; }
export function ratIsOne(r)  { return r.n === 1 && r.d === 1; }

export function ratEq(a, b)  { return a.n === b.n && a.d === b.d; }

export function ratAdd(a, b) { return ratOf(a.n * b.d + b.n * a.d, a.d * b.d); }
export function ratSub(a, b) { return ratOf(a.n * b.d - b.n * a.d, a.d * b.d); }
export function ratMul(a, b) { return ratOf(a.n * b.n, a.d * b.d); }
export function ratDiv(a, b) {
  if (b.n === 0) throw new Error('rational: division by zero');
  return ratOf(a.n * b.d, a.d * b.n);
}
export function ratNeg(a)    { return ratOf(-a.n, a.d); }

export function ratFormat(r) {
  if (r.d === 1) return String(r.n);
  return `${r.n}/${r.d}`;
}
