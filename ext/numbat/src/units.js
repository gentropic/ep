// UnitRegistry: declarative unit definitions with optional metric-prefix
// auto-generation. All units stored at canonical-unit scale (multiplier from
// the unit to its canonical base — e.g., kilometer.mul = 1000 when meter is
// canonical for Length).

import { dimEq } from './dimensions.js';

// Metric prefixes for v0.1. The full upstream set comes in via .nbt loading
// in v0.2+. 'micro' has both 'µ' and 'u' as common short forms.
const METRIC_PREFIXES = [
  ['tera',  'T',  1e12],
  ['giga',  'G',  1e9],
  ['mega',  'M',  1e6],
  ['kilo',  'k',  1e3],
  ['hecto', 'h',  1e2],
  ['deca',  'da', 1e1],
  // base — handled by the unprefixed registration
  ['deci',  'd',  1e-1],
  ['centi', 'c',  1e-2],
  ['milli', 'm',  1e-3],
  ['micro', 'µ',  1e-6],
  ['micro', 'u',  1e-6],
  ['nano',  'n',  1e-9],
  ['pico',  'p',  1e-12],
];

export class UnitRegistry {
  constructor() {
    this._units = new Map();    // lookup name -> {mul, dim, displayName, fullName}
    this._entries = [];         // ordered, for iteration (auto-scale)
  }

  // Define a unit.
  //   canonicalName:      long name ('metre')
  //   opts.dim:           dimension vector (required)
  //   opts.mul:           canonical multiplier (default 1 = base canonical)
  //   opts.displayName:   pretty form for auto-scale display
  //                       (default: first shortAlias if any, else canonicalName)
  //   opts.aliases:       LONG-form alternate names ['meter', 'meters']. NOT prefixed.
  //   opts.shortAliases:  SHORT-form alternate names ['m']. Each combines with
  //                       the metric prefix's short form (kilo + m = km).
  //   opts.prefixSet:     'metric' | null
  //
  // Upstream Numbat's `@aliases(metres, meter, meters, m: short)` splits
  // into aliases=[metres, meter, meters] and shortAliases=[m]. v0.1 callers
  // that passed `aliases: ['m']` should migrate to `shortAliases: ['m']`.
  define(canonicalName, opts) {
    const dim = opts.dim;
    const mul = opts.mul ?? 1;
    const aliases      = opts.aliases ?? [];
    const shortAliases = opts.shortAliases ?? [];
    const displayName  = opts.displayName ?? shortAliases[0] ?? canonicalName;
    const prefixSet    = opts.prefixSet ?? null;

    this._addEntry({mul, dim, displayName, fullName: canonicalName},
                   [canonicalName, ...aliases, ...shortAliases]);

    if (prefixSet === 'metric') {
      for (const [longName, shortName, factor] of METRIC_PREFIXES) {
        const prefixedDisplay = shortName + displayName;
        const prefixedFull = longName + canonicalName;
        const entry = {
          mul: mul * factor,
          dim,
          displayName: prefixedDisplay,
          fullName: prefixedFull,
        };
        // Generate all prefixed lookup names:
        //   long  prefix + canonical  (kilometre)
        //   long  prefix + long alias (kilometer, kilometres, kilometers)
        //   short prefix + short alias (km)
        // Upstream Numbat applies prefixes to all spellings (so US `decimeter`
        // and UK `decimetre` both resolve).
        const lookups = [prefixedFull];
        for (const alias of aliases)      lookups.push(longName + alias);
        for (const sa    of shortAliases) lookups.push(shortName + sa);
        this._addEntry(entry, lookups);
      }
    }
  }

  _addEntry(entry, lookupNames) {
    // First-come-first-served. Conflicts silently ignored in v0.1.
    let added = false;
    for (const name of lookupNames) {
      if (!this._units.has(name)) {
        this._units.set(name, entry);
        added = true;
      }
    }
    if (added) this._entries.push(entry);
  }

  resolve(name) {
    return this._units.get(name) ?? null;
  }

  has(name) {
    return this._units.has(name);
  }

  // List all unit entries, optionally filtered by exact dimension match.
  // Used by the formatter to find candidate units for auto-scaling.
  list(filterDim = null) {
    if (!filterDim) return this._entries.slice();
    return this._entries.filter(e => dimEq(filterDim, e.dim));
  }
}
