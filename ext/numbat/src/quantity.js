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
    if (!dimEq(this.dim, other.dim)) {
      throw new Error(`can't subtract [${dimFormat(this.dim)}] − [${dimFormat(other.dim)}]`);
    }
    return new Quantity(this.value - other.value, this.dim);
  }

  mul(other) {
    if (other instanceof DateTime) throw new Error("can't multiply by a datetime");
    return new Quantity(this.value * other.value, dimMul(this.dim, other.dim));
  }

  div(other) {
    if (other instanceof DateTime) throw new Error("can't divide by a datetime");
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
