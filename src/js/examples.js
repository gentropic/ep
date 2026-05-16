// Built-in example programs surfaced in the drawer. Read-only: tapping an
// example loads it into a fresh storage slot named from the example's slug
// (via uniqueProgramName), leaving the user's existing programs untouched.

import { state, evaluateAll } from './state.js';
import { uniqueProgramName, setCurrentProgramName, applyEphemeralUI, writeDraft } from './storage.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { renderScenariosStrip } from './scenarios.js';

// Each example: slug (becomes the program name on load), display name,
// one-line description for the drawer item, and the source body.
//
// All examples use v0.2 decorator form — @input / @output(unit) / @options
// adorn the binding they modify, instead of the old @params { } /
// @outputs { } block syntax.
const EXAMPLES = [
  {
    slug: 'cylinder',
    name: 'Cylinder volume',
    desc: 'Simple geometry — π, exponent, units',
    body: `# Cylinder volume — radius, height, area, volume

@input
radius = 5 cm

@input
height = 20 cm

@output(cm^2)
base_area = pi * radius^2

@output(cm^3)
volume = base_area * height
`,
  },

  {
    slug: 'unit_conversions',
    name: 'Unit conversions',
    desc: 'Imperial ↔ metric, mph, km/h — fluent unit math',
    body: `# Unit conversions — type any combination of units

@input
@output(cm)
height = 6 ft + 2 in

@input
@output(kg)
weight = 175 lb

@input
@output(km/h)
speed = 60 mile/hour
`,
  },

  {
    slug: 'ore_body',
    name: 'Ore body tonnage',
    desc: 'Geological resource — volume × density × grade',
    body: `# Ore body — volume × density × grade

@input
length = 200 m

@input
width = 50 m

@input
thickness = 8 m

@input
density = 2.7 g/cm3

@input
grade = 1_800 ppb

@output(m^3)
volume = length * width * thickness

@output(kt)
tonnage = volume * density

@output(kg)
metal = tonnage * grade

@output(ozt)
metal_oz = metal
`,
  },

  {
    slug: 'drillhole_sample',
    name: 'Drill core sample',
    desc: 'DCDMA core sizes (NQ / HQ / …) → sample mass via sample_mass()',
    body: `# Drill core sample — DCDMA wireline core diameters
# pre-registered as length units (NQ_core, HQ_core, PQ_core, …).
# sample_mass(diameter, length, density) is a prelude fn.

@input
core_size = NQ_core

@input
length = 5 m

@input
density = 2.7 g/cm3

@input
@options(granite, basalt, sandstone, limestone)
rock_type = granite

# Multi-line calls are fine — ep stitches unbalanced parens.
@output(kg)
mass = sample_mass(
  core_size,
  length,
  density,
)

@output(L)
volume = cylinder_volume(core_size, length)
`,
  },

  {
    slug: 'sieve_mesh',
    name: 'Sieve mesh sizes',
    desc: 'Tyler / ASTM mesh → aperture in µm',
    body: `# Sieve mesh — Tyler / ASTM lookup baked into the prelude as
# length units (mesh200 = 75 µm, mesh100 = 150 µm, …).

@input
coarse = mesh10

@input
mid = mesh100

@input
fine = mesh200

@output(um)
coarse_um = coarse

@output(um)
mid_um = mid

@output(um)
fine_um = fine
`,
  },

  {
    slug: 'compound_interest',
    name: 'Compound interest',
    desc: 'Demonstrates fn declarations',
    body: `# Compound interest — uses a fn declaration

fn compound(principal, rate, years) = principal * (1 + rate)^years

@input
principal = 10000

@input
rate = 0.05

@input
years = 30

@output
future_value = compound(principal, rate, years)

@output
gain = future_value - principal
`,
  },

  {
    slug: 'projectile',
    name: 'Projectile range',
    desc: 'No-drag ballistics — sin, sqrt, angle dimension',
    body: `# Projectile range — no air resistance

@input
v0 = 60 m/s

@input
angle = 45 deg

@input
g = 9.81 m/s^2

@output
range = v0^2 * sin(2 * angle) / g

@output
max_height = (v0 * sin(angle))^2 / (2 * g)

@output(s)
flight_time = 2 * v0 * sin(angle) / g
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
