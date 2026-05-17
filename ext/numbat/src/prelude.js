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
  registry.define('gram',       { dim: {mass: 1}, aliases: ['grams'], shortAliases: ['g']   });
  registry.define('milligram',  { dim: {mass: 1}, mul: 1e-3, aliases: ['milligrams'], shortAliases: ['mg'] });
  registry.define('microgram',  { dim: {mass: 1}, mul: 1e-6, aliases: ['micrograms'], shortAliases: ['µg', 'μg', 'ug'] });
  registry.define('kilogram',   { dim: {mass: 1}, mul: 1e3,  aliases: ['kilograms'], shortAliases: ['kg'] });

  registry.define('meter',      { dim: {length: 1}, aliases: ['meters', 'metre', 'metres'], shortAliases: ['m']  });
  registry.define('millimeter', { dim: {length: 1}, mul: 1e-3, aliases: ['millimeters', 'millimetre', 'millimetres'], shortAliases: ['mm'] });
  registry.define('centimeter', { dim: {length: 1}, mul: 1e-2, aliases: ['centimeters', 'centimetre', 'centimetres'], shortAliases: ['cm'] });
  registry.define('kilometer',  { dim: {length: 1}, mul: 1e3,  aliases: ['kilometers', 'kilometre', 'kilometres'], shortAliases: ['km'] });
  registry.define('micrometer', { dim: {length: 1}, mul: 1e-6, aliases: ['micrometers', 'micrometre', 'micrometres', 'micron', 'microns'], shortAliases: ['µm', 'μm', 'um'] });
  registry.define('nanometer',  { dim: {length: 1}, mul: 1e-9, aliases: ['nanometers', 'nanometre', 'nanometres'], shortAliases: ['nm'] });

  registry.define('second',      { dim: {time: 1}, aliases: ['seconds'], shortAliases: ['s']  });
  registry.define('millisecond', { dim: {time: 1}, mul: 1e-3, aliases: ['milliseconds'], shortAliases: ['ms'] });
  registry.define('microsecond', { dim: {time: 1}, mul: 1e-6, aliases: ['microseconds'], shortAliases: ['µs', 'μs', 'us'] });
  registry.define('minute',      { dim: {time: 1}, mul: 60,         aliases: ['minutes'], shortAliases: ['min'] });
  registry.define('hour',        { dim: {time: 1}, mul: 3600,        aliases: ['hours'], shortAliases: ['h', 'hr'] });
  registry.define('day',         { dim: {time: 1}, mul: 86400,       aliases: ['days'], shortAliases: ['d'] });
  registry.define('year',        { dim: {time: 1}, mul: 31557600,    aliases: ['years'], shortAliases: ['yr'] });

  // Angles are dimensionless in numbat's convention (a radian is a pure
  // ratio). ep matches that so the vendored modules' angular code loads.
  registry.define('radian', { dim: {}, aliases: ['radians'], shortAliases: ['rad'] });

  // Imperial / US customary — convenience for input and explicit `-> ft`
  // conversion. Flagged inputOnly so the auto-scaler still prefers metric
  // for default display.
  registry.define('inch',  { dim: {length: 1}, mul: 0.0254,    aliases: ['inches'], shortAliases: ['in'], inputOnly: true });
  registry.define('foot',  { dim: {length: 1}, mul: 0.3048,    aliases: ['feet'],   shortAliases: ['ft'], inputOnly: true });
  registry.define('yard',  { dim: {length: 1}, mul: 0.9144,    aliases: ['yards'],  shortAliases: ['yd'], inputOnly: true });
  registry.define('mile',  { dim: {length: 1}, mul: 1609.344,  aliases: ['miles'],  shortAliases: ['mi'], inputOnly: true });

  registry.define('pound', { dim: {mass: 1}, mul: 453.59237, aliases: ['pounds'], shortAliases: ['lb', 'lbs'], inputOnly: true });
  registry.define('stone', { dim: {mass: 1}, mul: 6350.293,  aliases: ['stones'], shortAliases: ['st'],         inputOnly: true });

  // DCDMA wireline diamond core sizes — source values mirrored from
  // gcu/units (auditable/ext/units/src/core.js). Registered as length
  // units so `pi/4 * NQ_core^2 * length` computes the sample volume
  // correctly. inputOnly so they don't compete with metric for default
  // display, but they appear in the gutter / sheet pickers.
  // Naming: {CODE}_core = drilled core diameter, {CODE}_hole = bit-cut
  // hole diameter. Multipliers in metres.
  const DCDMA_CORES = [
    ['AQ',  0.0270, 0.0480], ['BQ',  0.0365, 0.0600],
    ['NQ',  0.0476, 0.0757], ['NQ2', 0.0506, 0.0757], ['NQ3', 0.0451, 0.0757],
    ['HQ',  0.0635, 0.0960], ['HQ3', 0.0611, 0.0960],
    ['PQ',  0.0850, 0.1226], ['PQ3', 0.0830, 0.1226],
  ];
  for (const [code, core_m, hole_m] of DCDMA_CORES) {
    registry.define(code + '_core', { dim: {length: 1}, mul: core_m, displayName: code + '_core', inputOnly: true });
    registry.define(code + '_hole', { dim: {length: 1}, mul: hole_m, displayName: code + '_hole', inputOnly: true });
  }

  // Common compound units — give the formatter candidates so velocities,
  // accelerations, forces, etc. render as "60 m/s" / "9.81 m/s²" / "5 N"
  // instead of "60 [length·time^-1]". All canonical-multiplier values are
  // relative to ep's base units (gram for mass, meter for length, second
  // for time), which means newton = kg·m/s² = 1000 g·m/s², so mul=1000.

  // Velocity (dim: length·time^-1).
  registry.define('meter_per_second',    { dim: {length: 1, time: -1}, mul: 1,        displayName: 'm/s',   aliases: ['m/s'] });
  registry.define('kilometer_per_hour',  { dim: {length: 1, time: -1}, mul: 1 / 3.6,  displayName: 'km/h',  aliases: ['km/h'] });
  registry.define('mile_per_hour',       { dim: {length: 1, time: -1}, mul: 0.44704,  displayName: 'mph',   aliases: ['mph'], inputOnly: true });

  // Acceleration (dim: length·time^-2).
  registry.define('meter_per_second_sq', { dim: {length: 1, time: -2}, mul: 1,        displayName: 'm/s²',  aliases: ['m/s^2', 'm/s²'] });

  // Frequency (dim: time^-1).
  registry.define('hertz',               { dim: {time: -1},            mul: 1,        shortAliases: ['Hz'] });

  // Force (dim: mass·length·time^-2). 1 N = 1 kg·m/s² = 1000 g·m/s².
  registry.define('newton',              { dim: {mass: 1, length: 1,  time: -2}, mul: 1000,    shortAliases: ['N'] });

  // Energy (dim: mass·length^2·time^-2). 1 J = 1 N·m = 1000 g·m²/s².
  registry.define('joule',               { dim: {mass: 1, length: 2,  time: -2}, mul: 1000,    shortAliases: ['J'] });

  // Power (dim: mass·length^2·time^-3). 1 W = 1 J/s = 1000 g·m²/s³.
  registry.define('watt',                { dim: {mass: 1, length: 2,  time: -3}, mul: 1000,    shortAliases: ['W'] });

  // Pressure (dim: mass·length^-1·time^-2). 1 Pa = 1 N/m² = 1000 g/(m·s²).
  registry.define('pascal',              { dim: {mass: 1, length: -1, time: -2}, mul: 1000,    shortAliases: ['Pa'] });
  registry.define('kilopascal',          { dim: {mass: 1, length: -1, time: -2}, mul: 1e6,     shortAliases: ['kPa'] });
  registry.define('bar',                 { dim: {mass: 1, length: -1, time: -2}, mul: 1e8,     shortAliases: ['bar'] });

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
  // Imperial volume — inputOnly so auto-scale still prefers metric, but
  // they show up in the gutter unit-picker for Canadian / US datasets.
  // 1 ft³ = (0.3048)³ m³ = 0.028316846592 m³
  // 1 in³ = (0.0254)³ m³ = 0.000016387064 m³
  registry.define('ft3', { dim: {length: 3}, mul: 0.028316846592, displayName: 'ft³', aliases: ['ft^3'], inputOnly: true });
  registry.define('in3', { dim: {length: 3}, mul: 0.000016387064, displayName: 'in³', aliases: ['in^3'], inputOnly: true });

  // Density.
  registry.define('g/cm3', { dim: {mass: 1, length: -3}, mul: 1e6, displayName: 'g/cm³' });
  registry.define('kg/m3', { dim: {mass: 1, length: -3}, mul: 1e3, displayName: 'kg/m³' });
  registry.define('t/m3',  { dim: {mass: 1, length: -3}, mul: 1e6, displayName: 't/m³' });

  // Parts-per-X (mass fraction; treated as dimensionless, matching upstream).
  registry.define('ppm', { dim: {}, mul: 1e-6, shortAliases: ['ppm'] });
  registry.define('ppb', { dim: {}, mul: 1e-9, shortAliases: ['ppb'] });
  registry.define('pct', { dim: {}, mul: 1e-2, displayName: '%', aliases: ['percent'] });
  registry.define('g/t', { dim: {}, mul: 1e-6, shortAliases: ['g/t'] });

  // Angles. Dimensionless per numbat convention; one full turn = 2π radians.
  registry.define('degree', { dim: {}, mul: Math.PI / 180, aliases: ['degrees'], shortAliases: ['deg'] });

  // Tyler / ASTM sieve mesh apertures — discrete table, mirrored from
  // gcu/units (auditable/ext/units/src/sieve.js). Each registered as a
  // length unit so `aperture = mesh200 to um` gives the right answer
  // and the picker lists them under Length. Names use the underscore
  // prefix (mesh_NN) to keep them out of plain identifier collisions;
  // multipliers are aperture in metres. inputOnly so auto-scale ignores.
  const SIEVE_MESH = [
    [635,   20e-6], [500,   25e-6], [450,   32e-6], [400,   38e-6],
    [325,   45e-6], [270,   53e-6], [230,   63e-6], [200,   75e-6],
    [170,   90e-6], [150,  106e-6], [120,  125e-6], [100,  150e-6],
    [80,   180e-6], [70,   212e-6], [60,   250e-6], [50,   300e-6],
    [45,   355e-6], [40,   425e-6], [35,   500e-6], [30,   600e-6],
    [25,   710e-6], [20,   850e-6], [18,  1000e-6], [16,  1180e-6],
    [14,  1400e-6], [12,  1700e-6], [10,  2000e-6], [8,   2360e-6],
    [7,   2800e-6], [6,   3350e-6], [5,   4000e-6], [4,   4750e-6],
  ];
  for (const [mesh, m] of SIEVE_MESH) {
    registry.define('mesh' + mesh, {
      dim: {length: 1}, mul: m,
      displayName: 'mesh' + mesh,
      inputOnly: true,
    });
  }
}
