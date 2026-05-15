// Hand-crafted v0.1 prelude. Covers what ep currently uses (geological lane:
// SI base + key derived + density + ppm/ppb/g/t). Replaced in v0.2 by .nbt
// module loading from upstream Numbat's vendored modules.

export function loadPrelude(registry) {
  // Mass scales used in mining/commodity contexts. Registered BEFORE 'gram'
  // so the auto-scaler prefers `t` / `kt` / `Mt` over the equivalent
  // metric-prefixed gram variants (megagram, gigagram, teragram) on ties.
  // No prefixSet — these are explicit standalone scales.
  registry.define('tonne',      { dim: {mass: 1}, mul: 1e6,    shortAliases: ['t']   });
  registry.define('kilotonne',  { dim: {mass: 1}, mul: 1e9,    shortAliases: ['kt']  });
  registry.define('megatonne',  { dim: {mass: 1}, mul: 1e12,   shortAliases: ['Mt']  });
  registry.define('ounce',      { dim: {mass: 1}, mul: 28.3495,shortAliases: ['oz']  });
  registry.define('troy_ounce', { dim: {mass: 1}, mul: 31.1035,shortAliases: ['ozt'] });

  // SI base canonicals. Mass: gram is canonical (ep convention); SI base is
  // kilogram but gram is more convenient at calculator scale.
  //
  // We do NOT use prefixSet:'metric' here because that auto-generates the
  // full BIPM 2022 prefix set (including deca/hecto/deci) and the formatter
  // then picks "2 hm" or "5 dam" over "200 m" or "50 m". Instead we register
  // only the common engineering prefixes explicitly. The omitted prefixes
  // (da/h/d, the very-large Q/R/Y/Z/E/P/T-positive ones, and the very-small
  // f/a/z/y/r/q ones) are out of scope for a calculator-shaped tool.
  registry.define('gram',       { dim: {mass: 1}, shortAliases: ['g']   });
  registry.define('milligram',  { dim: {mass: 1}, mul: 1e-3, shortAliases: ['mg'] });
  registry.define('microgram',  { dim: {mass: 1}, mul: 1e-6, shortAliases: ['µg', 'μg', 'ug'] });
  registry.define('kilogram',   { dim: {mass: 1}, mul: 1e3,  shortAliases: ['kg'] });

  registry.define('meter',      { dim: {length: 1}, shortAliases: ['m']  });
  registry.define('millimeter', { dim: {length: 1}, mul: 1e-3, shortAliases: ['mm'] });
  registry.define('centimeter', { dim: {length: 1}, mul: 1e-2, shortAliases: ['cm'] });
  registry.define('kilometer',  { dim: {length: 1}, mul: 1e3,  shortAliases: ['km'] });

  registry.define('second',      { dim: {time: 1}, shortAliases: ['s']  });
  registry.define('millisecond', { dim: {time: 1}, mul: 1e-3, shortAliases: ['ms'] });
  registry.define('microsecond', { dim: {time: 1}, mul: 1e-6, shortAliases: ['µs', 'μs', 'us'] });

  registry.define('radian', { dim: {angle: 1},  shortAliases: ['rad'] });

  // Area — explicit squared units (parser-level `m^2` syntax in v0.3+).
  registry.define('m2',  { dim: {length: 2}, displayName: 'm²',  aliases: ['m^2'] });
  registry.define('cm2', { dim: {length: 2}, mul: 1e-4, displayName: 'cm²' });
  registry.define('mm2', { dim: {length: 2}, mul: 1e-6, displayName: 'mm²' });
  registry.define('km2', { dim: {length: 2}, mul: 1e6,  displayName: 'km²' });
  registry.define('ha',  { dim: {length: 2}, mul: 1e4,  displayName: 'ha' });

  // Volume — explicit cubed units.
  registry.define('m3',    { dim: {length: 3}, displayName: 'm³',  aliases: ['m^3'] });
  registry.define('cm3',   { dim: {length: 3}, mul: 1e-6, displayName: 'cm³' });
  registry.define('km3',   { dim: {length: 3}, mul: 1e9,  displayName: 'km³' });
  registry.define('liter', { dim: {length: 3}, mul: 1e-3, displayName: 'L', shortAliases: ['L'] });

  // Density.
  registry.define('g/cm3', { dim: {mass: 1, length: -3}, mul: 1e6, displayName: 'g/cm³' });
  registry.define('kg/m3', { dim: {mass: 1, length: -3}, mul: 1e3, displayName: 'kg/m³' });
  registry.define('t/m3',  { dim: {mass: 1, length: -3}, mul: 1e6, displayName: 't/m³' });

  // Parts-per-X (mass fraction; treated as dimensionless, matching upstream).
  registry.define('ppm', { dim: {}, mul: 1e-6, shortAliases: ['ppm'] });
  registry.define('ppb', { dim: {}, mul: 1e-9, shortAliases: ['ppb'] });
  registry.define('pct', { dim: {}, mul: 1e-2, displayName: '%', aliases: ['percent'] });
  registry.define('g/t', { dim: {}, mul: 1e-6, shortAliases: ['g/t'] });

  // Angles.
  registry.define('degree', { dim: {angle: 1}, mul: Math.PI / 180, shortAliases: ['deg'] });
}
