// Public API: the Numbat class is the host's entry point. Wraps a unit
// registry preloaded with the v0.1 prelude and offers convenience methods
// closed over it.

import { Quantity } from './quantity.js';
import { UnitRegistry } from './units.js';
import { DimRegistry } from './dimensions.js';
import { loadPrelude } from './prelude.js';
import { format, formatParts } from './format.js';
import { loadSource, makeEnv } from './load.js';
import { VENDORED_MODULES } from './vendored.js';

export class Numbat {
  // opts:
  //   prelude: 'v0.1' (default) — hand-crafted JS prelude, ep-compatible
  //            'vendored'        — load upstream .nbt prelude (units::si + units::partsperx)
  //            'none'            — no prelude; caller registers/loads modules itself
  constructor(opts = {}) {
    this.registry = new UnitRegistry();
    this.dims     = new DimRegistry();
    this.values   = new Map();          // let bindings
    this.fns      = new Map();          // user-defined functions (fn decls)
    this.structs  = new Map();          // user-defined struct schemas
    this.modules  = new Map();          // path → source text (registered .nbt)
    this.loaded   = new Set();          // paths already loaded (idempotent)

    const prelude = opts.prelude ?? 'v0.1';
    if (prelude === 'v0.1')          loadPrelude(this.registry);
    else if (prelude === 'vendored') this.loadVendoredPrelude();
    else if (prelude === 'none')     { /* caller takes over */ }
    else throw new Error(`unknown prelude option: ${prelude}`);
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

  // Look up a unit. Returns {mul, dim, displayName, fullName} or null.
  resolve(name) {
    return this.registry.resolve(name);
  }

  convertTo(q, unitName) {
    return q.convertTo(unitName, this.registry);
  }

  format(q, opts) {
    return format(q, this.registry, opts);
  }

  formatParts(q, opts) {
    return formatParts(q, this.registry, opts);
  }

  // ── .nbt module loading (v0.2) ───────────────────────────────

  // Register a module's source text under its upstream path
  // (e.g. 'core::dimensions'). No parsing happens until use() is called.
  registerModule(path, source) {
    this.modules.set(path, source);
  }

  // Load a registered module by path. Idempotent (loading the same path
  // twice is a no-op). Recursive: `use` statements inside the module
  // trigger nested loads.
  use(path) {
    if (this.loaded.has(path)) return;
    this.loaded.add(path);
    const source = this.modules.get(path);
    if (source === undefined) throw new Error(`module not registered: ${path}`);
    this.loadSource(source, path);
  }

  // Tokenize, parse, and load a Numbat-script source. Doesn't add to the
  // module map; useful for ad-hoc input.
  //
  // opts:
  //   typecheck: true → run the typechecker before evaluation, throw on
  //                     dim mismatch / unknown identifier / etc.
  loadSource(text, sourceName = '<inline>', opts = {}) {
    const env = makeEnv({
      dims: this.dims,
      units: this.registry,
      values: this.values,
      fns: this.fns,
      structs: this.structs,
      resolveUse: (path) => this.use(path.join('::')),
    });
    loadSource(text, sourceName, env, opts);
  }

  // Register every vendored .nbt module bundled at build time without
  // loading any of them. Useful when the host wants to keep its own
  // (v0.1) unit prelude but selectively `use` upstream function
  // modules — `core::strings` for hex/bin/oct and the str_* family,
  // `core::lists` for list primitives beyond what's already in scope,
  // `math::statistics` for mean/median/etc.
  //
  // Idempotent: calling twice doesn't re-register or re-load anything,
  // and after this call any later `use('core::strings')` resolves
  // against the bundled source.
  registerAllVendoredModules() {
    for (const [path, source] of Object.entries(VENDORED_MODULES)) {
      this.registerModule(path, source);
    }
  }

  // Register every vendored .nbt module bundled at build time, then load
  // the SI and partsperx modules (which transitively pull in core::dimensions,
  // core::scalar, and math::constants). Provides a Numbat-compatible
  // standard-library subset without a hand-crafted JS prelude.
  loadVendoredPrelude() {
    this.registerAllVendoredModules();
    this.use('units::si');
    this.use('units::partsperx');
  }
}
