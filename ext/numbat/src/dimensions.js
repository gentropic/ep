// Dimension primitives.
//
// A dimension is a sparse object {baseAxis: integerExponent}. Dimensions form
// a free abelian group under multiplication (componentwise add); identity is
// {} (scalar / dimensionless); inverse is negation.
//
// Base axis keys are lowercase strings: 'length', 'mass', 'time', 'angle',
// 'current', 'temperature', 'substance', 'luminous'. v0.2+ lets users define
// custom base dimensions; v0.1 uses these conventionally.

export const dimEq = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] || 0) !== (b[k] || 0)) return false;
  return true;
};

export const dimMul = (a, b) => {
  const r = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k] || 0) + (b[k] || 0);
    if (n) r[k] = n;
  }
  return r;
};

export const dimDiv = (a, b) => {
  const r = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const n = (a[k] || 0) - (b[k] || 0);
    if (n) r[k] = n;
  }
  return r;
};

export const dimPow = (d, n) => {
  const r = {};
  for (const k in d) {
    const e = d[k] * n;
    if (e) r[k] = e;
  }
  return r;
};

export const dimInv = (d) => dimPow(d, -1);

export const dimEmpty = (d) => Object.keys(d).length === 0;

export const dimFormat = (d) => {
  const parts = Object.entries(d).map(([k, v]) => v === 1 ? k : `${k}^${v}`);
  return parts.join('·') || '-';
};

// DimRegistry: maps Numbat-style dimension names (Length, Velocity) to dim
// vectors. Base dimensions get a fresh lowercase axis key derived from their
// name; derived dimensions store a computed vector built from arithmetic on
// existing dimensions.
//
// Used by the .nbt loader (see load.js); the runtime Quantity/UnitRegistry
// only cares about the dim vectors themselves.
function dimensionsEqual(a, b) {
  return dimEq(a, b);
}

export class DimRegistry {
  constructor() {
    this._dims = new Map();
  }

  // Declare a base dimension. Allocates a new axis named after the dimension
  // (lowercased). E.g. `defineBase('Length')` → registers Length as {length: 1}.
  // Idempotent: re-defining with the same shape is a no-op (so a vendored
  // module's `dimension Length` doesn't conflict with the host's pre-seed).
  defineBase(name) {
    const axis = name.toLowerCase();
    const desired = { [axis]: 1 };
    if (this._dims.has(name)) {
      if (dimensionsEqual(this._dims.get(name), desired)) return;
      throw new Error(`dimension already defined with different shape: ${name}`);
    }
    this._dims.set(name, desired);
  }

  // Declare a derived dimension with an already-computed dim vector.
  // Same idempotency rule as defineBase.
  defineDerived(name, dim) {
    if (this._dims.has(name)) {
      if (dimensionsEqual(this._dims.get(name), dim)) return;
      throw new Error(`dimension already defined with different shape: ${name}`);
    }
    this._dims.set(name, dim);
  }

  resolve(name) {
    return this._dims.get(name) ?? null;
  }

  has(name) {
    return this._dims.has(name);
  }

  list() {
    return [...this._dims.entries()].map(([name, dim]) => ({ name, dim }));
  }
}
