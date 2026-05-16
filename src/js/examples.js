// Built-in example programs surfaced in the drawer. Read-only: tapping an
// example loads it into a fresh storage slot named from the example's slug
// (via uniqueProgramName), leaving the user's existing programs untouched.

import { state, evaluateAll } from './state.js';
import { uniqueProgramName, setCurrentProgramName, applyEphemeralUI, writeDraft } from './storage.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { renderScenariosStrip } from './scenarios.js';

// Each example: slug (becomes the program name on load), display name,
// one-line description for the drawer item, and the source body.
const EXAMPLES = [
  {
    slug: 'cylinder',
    name: 'Cylinder volume',
    desc: 'Simple geometry — π, exponent, units',
    body: `# Cylinder volume — radius, height, area, volume

@params {
  radius = 5 cm
  height = 20 cm
}

base_area = pi * radius^2
volume    = base_area * height

@outputs {
  base_area: cm^2,
  volume:    cm^3,
}
`,
  },

  {
    slug: 'unit_conversions',
    name: 'Unit conversions',
    desc: 'Imperial ↔ metric, mph, km/h — fluent unit math',
    body: `# Unit conversions — type any combination of units

@params {
  height = 6 ft + 2 in
  weight = 175 lb
  speed  = 60 mile/hour
}

# Display each in metric:
@outputs {
  height: cm,
  weight: kg,
  speed:  km/h,
}
`,
  },

  {
    slug: 'ore_body',
    name: 'Ore body tonnage',
    desc: 'Geological resource — volume × density × grade',
    body: `# Ore body — volume × density × grade

@params {
  length    = 200 m
  width     = 50 m
  thickness = 8 m
  density   = 2.7 g/cm3
  grade     = 1_800 ppb
}

volume   = length * width * thickness
tonnage  = volume * density
metal    = tonnage * grade

@outputs {
  volume:  m^3,
  tonnage: kt,
  metal:   kg,
  metal_oz = metal -> ozt,
}
`,
  },

  {
    slug: 'drillhole_sample',
    name: 'Drill core sample',
    desc: 'DCDMA core sizes (NQ / HQ / …) → sample mass via sample_mass()',
    body: `# Drill core sample — DCDMA wireline core diameters
# pre-registered as length units (NQ_core, HQ_core, PQ_core, …).
# sample_mass(diameter, length, density) is a prelude fn.

@params {
  core_size = NQ_core
  length    = 5 m
  density   = 2.7 g/cm3
  rock_type = granite   # options: granite, basalt, sandstone, limestone
}

# Multi-line calls are fine — ep stitches unbalanced parens.
mass = sample_mass(
  core_size,
  length,
  density,
)
volume = cylinder_volume(core_size, length)

@outputs {
  volume: L,
  mass:   kg,
}
`,
  },

  {
    slug: 'sieve_mesh',
    name: 'Sieve mesh sizes',
    desc: 'Tyler / ASTM mesh → aperture in µm',
    body: `# Sieve mesh — Tyler / ASTM lookup baked into the prelude as
# length units (mesh200 = 75 µm, mesh100 = 150 µm, …).

@params {
  coarse = mesh10
  mid    = mesh100
  fine   = mesh200
}

coarse_um = coarse -> um
mid_um    = mid    -> um
fine_um   = fine   -> um

@outputs { coarse_um, mid_um, fine_um }
`,
  },

  {
    slug: 'compound_interest',
    name: 'Compound interest',
    desc: 'Demonstrates fn declarations',
    body: `# Compound interest — uses a fn declaration

fn compound(principal, rate, years) = principal * (1 + rate)^years

@params {
  principal = 10000
  rate      = 0.05
  years     = 30
}

future_value = compound(principal, rate, years)
gain         = future_value - principal

@outputs { future_value, gain }
`,
  },

  {
    slug: 'projectile',
    name: 'Projectile range',
    desc: 'No-drag ballistics — sin, sqrt, angle dimension',
    body: `# Projectile range — no air resistance

@params {
  v0    = 60 m/s
  angle = 45 deg
  g     = 9.81 m/s^2
}

range       = v0^2 * sin(2 * angle) / g
max_height  = (v0 * sin(angle))^2 / (2 * g)
flight_time = 2 * v0 * sin(angle) / g

@outputs {
  range,
  max_height,
  flight_time: s,
}
`,
  },
];

export function getExamples() { return EXAMPLES; }

// Load an example ephemerally: state.body is replaced and the header shows
// the example's slug, but nothing is written to storage. The example only
// becomes a real saved program when the user first edits something (the
// autosave path picks it up under uniqueProgramName(slug)). This lets
// users browse examples freely without cluttering the saved-programs list.
export function loadExample(example) {
  const lines = example.body.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  state.body = lines.map(src => ({src}));
  state.ui.collapsedBlocks = [];
  state.ui.scenarios       = {};
  state.ui.activeScenario  = null;
  state._ephemeral         = true;
  // Pick a non-colliding slot for when the user eventually commits, but
  // don't persist ep:current — the example is ephemeral until then.
  setCurrentProgramName(uniqueProgramName(example.slug), false);
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  renderScenariosStrip();
  applyEphemeralUI();
  writeDraft();
}
