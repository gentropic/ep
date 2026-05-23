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
    slug: 'layered_xy',
    name: 'Layered xy — measured + fit',
    desc: 'Fluent builder: scatter the measurements, overlay a fit line',
    body: `# Layered xy plot — measured points + a fit line on the same axes.
# \`line_plot()\` produces an empty xy plot; \`with_scatter\` and
# \`with_line\` add layers in cycled colors (orange first, indigo
# second). A bare-expression Plot auto-renders inline.

# Synthetic drillhole grade vs depth.
depth     = [10, 20, 35, 50, 70, 100, 140] m
grade     = [0.4, 0.7, 1.1, 1.5, 1.8, 2.3, 2.7] g/t

# Hand-picked linear fit. \`with_line\` overlays it on the scatter.
slope     = 0.018 g/t/m
intercept = 0.3 g/t
fit_y     = depth * slope + intercept

line_plot()
  |> with_scatter(depth, grade, "measured")
  |> with_line(depth, fit_y, "linear fit")
  |> with_xlabel("depth")
  |> with_ylabel("grade")
  |> with_title("Drillhole grade vs depth")
`,
  },

  {
    slug: 'stereonet',
    name: 'Stereonet — fault attitudes',
    desc: 'Fluent builder: layer planes + lineations on one stereonet',
    body: `# Stereonet — structural-geology attitudes plotted on an
# equal-area (Schmidt) projection. Planes are drawn as great
# circles; lineations as points. The fluent builder lets you
# layer multiple feature kinds on a single stereonet via the
# \`|>\` pipe — see SPEC-LAYERED-PLOTS.

# A synthetic conjugate fault set (dip directions clustering
# around 120° and 300°, dips ~45°). Numbat lists are homogeneous —
# the trailing \`deg\` applies to every element.
faults_dd  = [120, 128, 115, 122, 130, 300, 295, 305, 310, 298] deg
faults_dip = [ 45,  52,  48,  44,  50,  47,  52,  43,  49,  51] deg

# A measured slip lineation on one of the planes.
slip_trend  = 240 deg
slip_plunge =  28 deg

# Combined stereonet — planes AND the slip vector in one projection.
# A bare-expression Plot value auto-renders inline (no explicit
# \`show()\` needed).
stereonet()
  |> with_planes(faults_dd, faults_dip, "fault planes")
  |> with_lines(slip_trend, slip_plunge, "slip vector")
  |> with_title("Conjugate faults + slip")

# Shortcut form (single-layer): \`stereonet_planes(...)\` is sugar
# for \`stereonet() |> with_planes(...) |> with_title(...)\`.
stereonet_planes(faults_dd, faults_dip, "Planes alone (shortcut)")
`,
  },

  {
    slug: 'sensitivity_sweep',
    name: 'Sensitivity sweep',
    desc: 'Sweep drill-core diameter — sample volume / mass scale as d²',
    body: `# Sensitivity sweep — the *deterministic* sibling of uncertainty.
# \`sweep(start, end, n)\` varies a value linearly across n samples;
# subsequent arithmetic carries the curve through automatically and
# the output chip renders Y(X) as an inline line plot. Tap to enlarge.
#
# Drill-core sample volume goes as π/4 · d² · length, so sweeping the
# core diameter produces a quadratic curve — the canonical case where
# sensitivity matters. DCDMA sizes for reference: AQ ≈ 30 mm,
# NQ ≈ 47 mm, HQ ≈ 64 mm, PQ ≈ 85 mm.

@input
diameter  = sweep(30 mm, 100 mm, 71)

@input
length    = 5 m

@input
density   = 2.7 g/cm3

@input
grade     = 1500 ppb

@output(L)
volume    = cylinder_volume(diameter, length)

@output(kg)
mass      = sample_mass(diameter, length, density)

@output(g)
metal     = mass * grade
`,
  },

  {
    slug: 'uncertain_resource',
    name: 'Resource with uncertainty',
    desc: 'Monte Carlo propagation — normal / uniform / lognormal / triangular inputs → percentile bounds + PDF',
    body: `# Ore body — propagate measurement uncertainty through to tonnage.
# Each @input below is a *distribution*; arithmetic carries the samples
# forward automatically and the @output chips show \`mean ± stdev unit\`
# plus a histogram thumbnail. \`percentile\` collapses an uncertain back
# to a regular Quantity, so the P05 / P95 chips read as plain numbers.

@input
length    = normal(200 m, 5 m)

@input
width     = uniform(45 m, 55 m)

@input
thickness = 8 m

@input
density   = lognormal(2.7 g/cm3, 0.05 g/cm3)

@input
grade     = triangular(800 ppb, 1500 ppb, 2200 ppb)

volume    = length * width * thickness

@output(kt)
tonnage   = volume * density

@output(kg)
metal     = tonnage * grade

# Pessimistic and optimistic bounds — percentile collapses Uncertain to Quantity.
@output(kt)
p05_tonnage = percentile(tonnage, 5)

@output(kt)
p95_tonnage = percentile(tonnage, 95)

# Inline plots — pdf() draws a Gaussian KDE, cdf() the empirical CDF.
pdf(metal, "metal (kg)", "density", "Metal content distribution")
cdf(tonnage, "tonnage (kt)", "P(X ≤ x)", "Tonnage CDF")
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
  state.assets             = {};
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
