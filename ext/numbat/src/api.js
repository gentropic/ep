// Public API: the Numbat class is the host's entry point. Wraps a unit
// registry preloaded with the v0.1 prelude and offers convenience methods
// closed over it.

import { Quantity } from './quantity.js';
import { UnitRegistry } from './units.js';
import { loadPrelude } from './prelude.js';
import { format, formatParts } from './format.js';

export class Numbat {
  constructor() {
    this.registry = new UnitRegistry();
    loadPrelude(this.registry);
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

  convertTo(q, unitName) {
    return q.convertTo(unitName, this.registry);
  }

  format(q) {
    return format(q, this.registry);
  }

  formatParts(q) {
    return formatParts(q, this.registry);
  }
}
