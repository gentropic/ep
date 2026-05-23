// Quantity: a value in canonical units plus a dimension vector plus an
// optional display-unit tag (set by `->` / convertTo, preserved through unary
// operations but lost in further arithmetic — matches Numbat semantics).
//
// Numbat is purely functional: every arithmetic method returns a new Quantity.

import { dimEq, dimMul, dimDiv, dimPow, dimEmpty, dimFormat } from './dimensions.js';

export class Quantity {
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
    // A datetime on the right has its own affine algebra — defer to it
    // (`duration + datetime` is commutative → `datetime + duration`).
    if (other instanceof DateTime) return other.add(this);
    // An Uncertain on the right gets the same treatment — commute and
    // let the sample-bearing add path run.
    if (other && other.__uncertain) return other.add(this);
    if (!dimEq(this.dim, other.dim)) {
      throw new Error(`can't add [${dimFormat(this.dim)}] + [${dimFormat(other.dim)}]`);
    }
    return new Quantity(this.value + other.value, this.dim);
  }

  sub(other) {
    // `duration − datetime` is meaningless (a vector minus a point).
    if (other instanceof DateTime) {
      throw new Error("can't subtract a datetime from a duration");
    }
    // Scalar − Uncertain: non-commutative; lift scalar and subtract
    // pointwise.
    if (other && other.__uncertain) {
      if (!dimEq(this.dim, other.dim)) {
        throw new Error(`can't subtract [${dimFormat(this.dim)}] − [${dimFormat(other.dim)}]`);
      }
      const N = other.samples.length;
      const r = new Float64Array(N);
      for (let i = 0; i < N; i++) r[i] = this.value - other.samples[i];
      return new Uncertain(r, this.dim);
    }
    if (!dimEq(this.dim, other.dim)) {
      throw new Error(`can't subtract [${dimFormat(this.dim)}] − [${dimFormat(other.dim)}]`);
    }
    return new Quantity(this.value - other.value, this.dim);
  }

  mul(other) {
    if (other instanceof DateTime) throw new Error("can't multiply by a datetime");
    // Commutative: defer to Uncertain.mul which broadcasts the scalar.
    if (other && other.__uncertain) return other.mul(this);
    return new Quantity(this.value * other.value, dimMul(this.dim, other.dim));
  }

  div(other) {
    if (other instanceof DateTime) throw new Error("can't divide by a datetime");
    // Scalar / Uncertain: non-commutative; lift scalar and divide
    // pointwise.
    if (other && other.__uncertain) {
      const N = other.samples.length;
      const r = new Float64Array(N);
      for (let i = 0; i < N; i++) r[i] = this.value / other.samples[i];
      return new Uncertain(r, dimDiv(this.dim, other.dim));
    }
    return new Quantity(this.value / other.value, dimDiv(this.dim, other.dim));
  }

  // pow accepts either a number or a dimensionless Quantity
  pow(exponent) {
    if (exponent && exponent.__uncertain) {
      // An Uncertain exponent on a dim-bearing base makes the result
      // dim depend on the sample — doesn't typecheck statically. Phase 1
      // rejects; Phase 2 can revisit for the dimensionless case.
      throw new Error('Phase 1: uncertain exponents are not supported');
    }
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

// A datetime is a *point* in affine time-space, not a duration: it carries an
// epoch-seconds value and the time dimension, but a restricted algebra —
// datetime ± duration → datetime, datetime − datetime → duration, and nothing
// else. It extends Quantity so the many duck-typed `.value` / `.dim` readers
// (and `instanceof Quantity` checks) keep working unchanged; only the algebra
// and the display differ. The affine rules live here in the overrides, plus
// guard branches in Quantity.add/sub/mul/div for the datetime-on-RHS case.
export class DateTime extends Quantity {
  constructor(epochSeconds, tz = null) {
    super(epochSeconds, { time: 1 }, null);
    // IANA zone id, or null = host-local (resolved at format time).
    this.tz = tz;
  }

  add(other) {
    if (other instanceof DateTime) {
      throw new Error("can't add two datetimes — only a datetime + a duration");
    }
    if (!other || !dimEq(other.dim || {}, { time: 1 })) {
      throw new Error(`can't add [${dimFormat((other && other.dim) || {})}] to a datetime`);
    }
    return new DateTime(this.value + other.value, this.tz);
  }

  sub(other) {
    // datetime − datetime → a duration (a plain Quantity, not a DateTime).
    if (other instanceof DateTime) {
      return new Quantity(this.value - other.value, { time: 1 });
    }
    if (!other || !dimEq(other.dim || {}, { time: 1 })) {
      throw new Error(`can't subtract [${dimFormat((other && other.dim) || {})}] from a datetime`);
    }
    return new DateTime(this.value - other.value, this.tz);
  }

  mul() { throw new Error("can't multiply a datetime"); }
  div() { throw new Error("can't divide a datetime"); }
  pow() { throw new Error("can't raise a datetime to a power"); }
  neg() { throw new Error("can't negate a datetime"); }
  convertTo() {
    throw new Error("a datetime has no display unit — use format_datetime() or tz()");
  }
}

// ── Uncertain quantities (SPEC-UNCERTAINTY) ────────────────────────
//
// An Uncertain is a Quantity carrying a Float64Array of canonical-value
// samples in addition to its scalar `.value` (the sample mean — keeps
// Quantity's `.value` contract for any code that hasn't been taught
// about uncertainty yet). Arithmetic on Uncertain (or `Uncertain ⊕
// Quantity`) is sample-wise: a tight Float64Array loop per operation,
// producing another Uncertain. Nonlinear ops (mul, div, pow, sqrt, …)
// propagate distribution shape correctly because the operation runs on
// each sample independently — no Taylor expansion, no Gaussian
// assumption. Reductions (mean / stdev / percentile) collapse Uncertain
// back to a regular Quantity. See SPEC-UNCERTAINTY.md for the full
// design + the five extensibility hooks.

// Per-call deterministic sub-seeding: the host increments _uCounter
// every time a distribution builder runs; resetUncertaintyRng() zeroes
// it at the start of an evaluation pass so re-rendering the same
// program produces the same samples. Re-ordering a `normal(...)` call
// shifts everything below it — by-name sub-seeding is a Phase 1.5
// follow-up (see SPEC-UNCERTAINTY §Open questions).
let _uSeed    = 42;
let _uCounter = 0;
let _uN       = 1000;   // Phase 1 default; settings panel will tune (100..10000).

export function setUncertaintySeed(seed)   { _uSeed = (seed | 0) >>> 0; }
export function resetUncertaintyRng()      { _uCounter = 0; }
export function setSampleCount(n)          { _uN = Math.max(1, n | 0); }
export function getSampleCount()           { return _uN; }

// Returns a fresh mulberry32 stream — a small, fast PRNG, good enough
// for engineering Monte Carlo. Each distribution builder calls this
// once and draws N samples from the returned function.
export function getUncertaintyRng() {
  let s = (_uSeed + _uCounter++) >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lift any operand to a Float64Array of length N — an Uncertain returns
// its own samples; a deterministic Quantity becomes a constant array.
// This is the single point where future Uncertain kinds (analytical,
// correlated, lazy) plug in: each kind implements its own materialization
// here, and the rest of the arithmetic just works.
export function samplesOf(q, N) {
  if (q && q.__uncertain) {
    if (q.kind === 'samples') {
      if (q.samples.length === N) return q.samples;
      throw new Error(`uncertain: sample count mismatch (have ${q.samples.length}, want ${N})`);
    }
    throw new Error(`uncertain: unknown kind '${q.kind}'`);
  }
  if (q instanceof Quantity) {
    const a = new Float64Array(N);
    a.fill(q.value);
    return a;
  }
  if (typeof q === 'number') {
    const a = new Float64Array(N);
    a.fill(q);
    return a;
  }
  throw new Error('samplesOf: expected a Quantity, number, or Uncertain');
}

function meanOf(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  return sum / samples.length;
}

export class Uncertain extends Quantity {
  constructor(samples, dim, disp = null) {
    // .value is the sample mean — gives Quantity's contract a sensible
    // fallback (any display path that hasn't been taught about samples
    // still gets a meaningful number).
    super(meanOf(samples), dim, disp);
    this.samples    = samples;     // Float64Array(N)
    this.__uncertain = true;
    this.kind       = 'samples';
  }

  add(other) {
    if (!dimEq(this.dim, (other && other.dim) || {})) {
      throw new Error(`can't add [${dimFormat((other && other.dim) || {})}] to [${dimFormat(this.dim)}]`);
    }
    const N = this.samples.length;
    const o = samplesOf(other, N);
    const r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = this.samples[i] + o[i];
    return new Uncertain(r, this.dim, this.disp);
  }

  sub(other) {
    if (!dimEq(this.dim, (other && other.dim) || {})) {
      throw new Error(`can't subtract [${dimFormat((other && other.dim) || {})}] from [${dimFormat(this.dim)}]`);
    }
    const N = this.samples.length;
    const o = samplesOf(other, N);
    const r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = this.samples[i] - o[i];
    return new Uncertain(r, this.dim, this.disp);
  }

  mul(other) {
    const N = this.samples.length;
    const o = samplesOf(other, N);
    const r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = this.samples[i] * o[i];
    return new Uncertain(r, dimMul(this.dim, (other && other.dim) || {}));
  }

  div(other) {
    const N = this.samples.length;
    const o = samplesOf(other, N);
    const r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = this.samples[i] / o[i];
    return new Uncertain(r, dimDiv(this.dim, (other && other.dim) || {}));
  }

  pow(exponent) {
    if (exponent && exponent.__uncertain) {
      // Uncertain exponent on a dim-bearing base makes the result dim
      // depend on the sample, which doesn't typecheck statically.
      // Phase 1: reject. Phase 2 can revisit for the dimensionless case.
      throw new Error('Phase 1: uncertain exponents are not supported');
    }
    const expValue = exponent instanceof Quantity ? exponent.value : exponent;
    if (exponent instanceof Quantity && !dimEmpty(exponent.dim)) {
      throw new Error('exponent must be dimensionless');
    }
    const N = this.samples.length;
    const r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = Math.pow(this.samples[i], expValue);
    return new Uncertain(r, dimPow(this.dim, expValue));
  }

  neg() {
    const N = this.samples.length;
    const r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = -this.samples[i];
    return new Uncertain(r, this.dim, this.disp);
  }

  convertTo(unitName, registry) {
    // Reuse Quantity's resolution + dim check; carry the disp tag onto
    // a new Uncertain so display picks it up. Samples stay canonical.
    const tagged = super.convertTo(unitName, registry);
    return new Uncertain(this.samples, this.dim, tagged.disp);
  }
}
