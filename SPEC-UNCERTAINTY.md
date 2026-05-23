# SPEC-UNCERTAINTY — first-class probabilistic quantities

**Status**: Phase 1 designed (this document); implementation pending. Phases 2+ noted at the bottom.

## Motivation

ep already respects two things most calculators ignore: **units** (a Quantity carries its dim through every operation) and **shareability** (a calculator exports as a standalone HTML form). This doc adds the third leg an engineering calculator wants — **uncertainty**.

A geological resource calculation is `tonnage = length × width × thickness × density`, but `density` isn't `2.7 g/cm³` exactly — it's a measurement with a real spread, typically `2.7 ± 0.1 g/cm³`. The honest answer is therefore a distribution: `1,180 ± 35 kt`, with P05 / P95 bounds for the pessimistic and optimistic ends.

In mining practice this kind of Monte Carlo propagation lives in **Excel add-ins** — @Risk (Palisade / Lumivero), Crystal Ball (Oracle), ModelRisk (Vose) — and in **GoldSim**, a heavyweight standalone Windows app. It's routine on the *project-economics* side (NPV, reserves, scenario analysis). It's notably **missing from the resource-estimation side itself**: Datamine, Leapfrog, GSLIB, Snowden Supervisor and the like are mostly deterministic at the equation level, with geostatistical simulation (multiple block-model realizations via SGSIM / SISIM / etc.) as a separate, spatial form of uncertainty modeling — different problem, doesn't propagate scalar input distributions through an arbitrary formula.

A calculator-script language that just *speaks* distributions natively — type `normal(2.7 g/cm³, 0.1 g/cm³)` as an input and the propagation happens without ceremony — would be novel in the offline-single-file space, on either side of that gap. The form-export ethos compounds it: a recipient of an ep form drops their own measured density distribution into a chip and reads back their own uncertain tonnage, with a histogram thumbnail, in a `.html` file they can email.

## Non-goals

- **Not a probabilistic programming language.** No MCMC, no variational inference. The runtime draws Monte Carlo samples; it doesn't infer posteriors from data.
- **Not symbolic algebra.** Distributions are sampled at evaluation time; we don't derive a closed-form output distribution.
- **Not unbounded.** Sample count `N` is a settings knob (default 1000, max 10000). Memory is `N × number of uncertain values`, which is fine for scalar `@input`s and bounded for any reasonable calculation. Per-cell dataset uncertainty (a 1772-row column where each cell is sampled) is **Phase 2**.
- **Not stealthy.** A program that uses `normal(...)` fails loudly on upstream Numbat (`unknown identifier`) — that's the right failure mode per ep's compatibility rule. No silent divergence.

## Design summary

A new `Uncertain` value **extends `Quantity`** — same `dim`, same `disp`, same instanceof checks — but carries a `Float64Array(N)` of canonical-value samples in addition to the scalar `value` (which is the mean of the samples, used as the display fallback). Distribution builders (`normal`, `uniform`, `lognormal`, `triangular`) construct `Uncertain` values from `(μ, σ)` / `(lo, hi)` / etc. Arithmetic on `Uncertain` (or `Uncertain ⊕ Quantity`) is sample-wise — a tight `Float64Array` loop per operation — and produces another `Uncertain`. Nonlinear operations propagate distribution shape correctly because the operation runs on each sample independently (no Taylor approximation, no Gaussian assumption). Reductions (`mean`, `stdev`, `percentile`) collapse an `Uncertain` back to a regular `Quantity`. Display recognizes `__uncertain` and shows `mean ± stdev` plus a small canvas histogram thumbnail.

The architecture has **five single-point-of-extension layers**. The whole design pivots on them — adding a new distribution, reduction, display mode, or representation kind is one addition, not surgery across the codebase.

## Extensibility hooks

### 1. `Uncertain` interface — kind-tagged for swappable representations

```js
class Uncertain extends Quantity {
  __uncertain = true;
  kind        = 'samples';     // future: 'analytical' | 'correlated' | 'lazy'
  samples;                     // Float64Array(N) — present when kind === 'samples'
}
```

`kind` lets future representations coexist without rewriting existing ones:

- `'samples'` — Phase 1. A Float64Array of N draws.
- `'analytical'` — Phase 2. `{ mean, variance }` (Gaussian only); O(1) memory and arithmetic when the chain is linear; materializes to samples when it isn't.
- `'correlated'` — Phase 2. A shared sample matrix across multiple `Uncertain` values that came from the same source (e.g. drillhole density and grade).
- `'lazy'` — Phase 3. Symbolic; computes samples on demand.

The single helper `samplesOf(quantity, N) → Float64Array` lifts anything to a sample array — a scalar `Quantity` becomes a constant `Float64Array(N)`; an `Uncertain` of any kind materializes via its own kind-specific path. **All arithmetic broadcasting passes through this helper**, so a new kind only implements `samplesOf` for itself and the rest is free.

### 2. Distribution registry — one entry per distribution

Each distribution is a `BUILTIN_PROC` in `ext/numbat/src/load.js`:

```js
normal:      (args) => { /* Box-Muller × N → new Uncertain */ },
uniform:     (args) => { ... },
lognormal:   (args) => { ... },
triangular:  (args) => { ... },
```

Adding `beta(α, β)`, `gamma(k, θ)`, `empirical(samples)`, `mixture(weights, components)` later: one new BUILTIN_PROC, one doc entry, one signature line in `uncertainty/functions.nbt`. Done.

### 3. Reduction registry — one entry per stat

Reductions detect `Uncertain` at the top of the proc and dispatch:

```js
mean(args) {
  const q = args[0];
  if (q instanceof Uncertain) return new Quantity(meanOf(q.samples), q.dim, q.disp);
  /* else fall through to the existing list-reduction path */
}
stdev(args)       { ... }
percentile(args)  { ... }   // percentile(unc, 95) → Quantity
```

Adding `skewness`, `kurtosis`, `entropy`, `mode`, `iqr` later: one new entry per stat.

### 4. Display registry — one render function, mode branches

A single `formatUncertain(unc, mode) → { html, text, dom? }` lives next to the existing `fmt()` formatter. Modes:

- `'mean-stdev'` (default) — `1,234 ± 45 kt`
- `'histogram'` — a 200×60 canvas thumbnail
- `'pdf'`, `'cdf'` — curve thumbnails
- `'percentiles'` — `P05 / P50 / P95`
- `'samples'` — first-N preview (debug)

Default mode is a global setting. Per-output override (Phase 2) via `@output(unit, mode)` — `@output(kg, hist)`. Adding a new mode is one branch in `formatUncertain`.

### 5. Sample count + seeding — settings

Two settings:

- **`samples.n`** — default 1000. Slider 100–10000. (10000 is "final answer" mode; chip editing gets sluggish above ~5000.)
- **`samples.seed`** — default `'program'` (seeded per-program for stability across re-renders). Other modes: `'random'` (fresh each render), `'fixed:<n>'`.

Per-distribution seeding uses a fast PRNG (mulberry32, ~10 lines) keyed by the program seed plus a hash of the *binding name* (not source position) — reordering bindings doesn't shift all samples. Re-rendering the same program produces the same samples; no flicker.

## Detailed semantics

### 1. The `Uncertain` class

`ext/numbat/src/quantity.js`:

```js
export class Uncertain extends Quantity {
  constructor(samples, dim, disp = null) {
    // .value is the sample mean — keeps Quantity's contract (.value as a
    // canonical number) and gives display a sensible fallback.
    super(meanOf(samples), dim, disp);
    this.samples    = samples;     // Float64Array(N)
    this.__uncertain = true;
    this.kind       = 'samples';
  }
  add(other) {
    const o = samplesOf(other, this.samples.length);
    const r = new Float64Array(this.samples.length);
    for (let i = 0; i < r.length; i++) r[i] = this.samples[i] + o[i];
    return new Uncertain(r, this.dim, this.disp);
  }
  sub(other) { /* like add */ }
  mul(other) { /* loop × ; dim = dimMul(this.dim, other.dim ?? {}) */ }
  div(other) { /* loop ÷ ; dim = dimDiv(this.dim, other.dim ?? {}) */ }
  pow(n)     { /* loop ** scalar n */ }
  neg()      { /* loop -x */ }
  convertTo(unitName, units) {
    /* same disp-tag mechanic as Quantity — operates on the mean for display,
       samples stay canonical. */
  }
}
```

`Quantity.add` (and sub/mul/div) get a single guard:

```js
add(other) {
  if (other && other.__uncertain) return other.add(this);   // commute
  /* ... existing logic ... */
}
```

### 2. Propagation rules

- **Linear ops** (`+`, `−`, scalar `×`, scalar `÷`): correct in the limit of `N → ∞`. Monte Carlo standard error on the mean falls as `1/√N`, so `N=1000` gives ~3% relative — fine for well-behaved distributions. Heavy-tailed shapes (high-σ lognormal, mixtures with rare modes) want a higher N for stable statistics.
- **Nonlinear ops** (`Uncertain × Uncertain`, `÷`, `^`, `sqrt`, `sin`, `log`, `exp`, …): Monte Carlo gets the shape right by running the scalar operation on each sample. No Taylor expansion, no Gaussian-assumption distortion.
- **Element-wise built-in fns** (`sin`, `cos`, `sqrt`, `ln`, `abs`, …): each gets a guard `if (x.__uncertain) return new Uncertain(x.samples.map(f), x.dim);`. One pattern, repeated.
- **Comparison** (`<`, `>`, `==`): Phase 1 returns a `List<Bool>` of length `N` — i.e. the comparison is broadcast over samples. Phase 2 adds `P(x > y)` returning a Scalar in `[0,1]`.
- **Dim arithmetic**: identical to Quantity. Dimension errors fire before sample math runs.
- **Array broadcasting**: `[a, b, c] + uncertain` works — the list path iterates, calls `a.add(uncertain)`, which routes through the guard above. So lists of regular Quantities `+` an Uncertain produce a list of Uncertains.

### 3. Distribution builders (Phase 1)

```ep
density   = normal(2.7 g/cm³, 0.1 g/cm³)         # μ, σ — preserves dim
length    = uniform(180 m, 220 m)                # (low, high)
grade     = lognormal(1.5 g/t, 0.4 g/t)          # μ, σ — real-space mean and stdev; converted to log-space internally
recovery  = triangular(0.82, 0.91, 0.95)         # (low, mode, high)
```

All return `Uncertain` with the dim of their arguments. Type signatures live in a new `ext/numbat/vendor/numbat/modules/uncertainty/functions.nbt`:

```numbat
fn normal<D>(mu: D, sigma: D) -> D
fn uniform<D>(lo: D, hi: D) -> D
fn lognormal<D>(mu: D, sigma: D) -> D
fn triangular<D>(lo: D, mode: D, hi: D) -> D
```

Numbat-js's typechecker sees them returning `D` (the dim) — the Uncertain-ness is a runtime concern that the typechecker doesn't model. This keeps typing simple and lets `normal(2.7 g/cm³, 0.1 g/cm³)` typecheck as a Density value.

### 4. Reductions (Phase 1)

```ep
mean(density)              # → 2.7 g/cm³    (regular Quantity)
stdev(density)             # → 0.1 g/cm³    (regular Quantity)
percentile(density, 95)    # → ~2.86 g/cm³  (regular Quantity)
```

Each detects `instanceof Uncertain` at the top; otherwise falls through to the existing list-reduction behavior (so `mean([1, 2, 3])` still works).

`samples(unc) → List<Quantity>` materializes an `Uncertain` to a regular ep list — for ad-hoc work, custom reductions, exporting. **Phase 1.5** (cheap).

### 5. Display

- **Output chip default**: `1,234 ± 45 kt` text + 200×60 canvas histogram thumbnail underneath.
- **Tooltip on hover**: P05 / P50 / P95 numeric summary.
- **Gutter / inline result**: `mean unit` (no ± — keep the gutter tight; the chip carries the spread).
- **Plot helpers**: `hist(unc)` already works (the existing `hist(list)` accepts the materialized sample list — implement via `unc.__uncertain → bin unc.samples`). `pdf(unc)` and `cdf(unc)` are new — return PlotDescriptor objects routed through the existing plot infrastructure.
- **Copy / export**: clipboard / CSV / JSON include mean + stdev + key percentiles. Full sample dump is a separate "copy samples" menu item.

### 6. Sample count + seeding

- `state.ui.samplesN` — sample count. Default 1000. Settings panel slider 100..10000.
- `state.ui.samplesSeed` — seed mode. `'program'` (default), `'random'`, or `'fixed:<n>'`.
- PRNG: `mulberry32(seed)`. Each distribution call gets a sub-seed = `hash(programSeed + bindingName)`, so the samples for `density` don't shift when an unrelated binding above gets re-ordered.

## Examples

```ep
# A small uncertain resource calculation.

@input
length    = normal(200 m, 5 m)            # ± 5 m on the length
@input
width     = uniform(45 m, 55 m)           # known to be in [45, 55] m
@input
thickness = 8 m                           # known precisely (Quantity, not Uncertain)
@input
density   = lognormal(2.7 g/cm³, 0.05 g/cm³)

volume    = length * width * thickness    # Uncertain × Uncertain × Quantity → Uncertain

@output(kt)
tonnage   = volume * density              # → "1,180 ± 35 kt" + canvas histogram

# Plot the tonnage distribution:
pdf(tonnage)

# Pessimistic bound — P05:
@output(kt)
p05_tonnage = percentile(tonnage, 5)      # regular Quantity ≈ 1,118 kt
```

What renders:
- The `length` / `width` / `density` chips show their dist-builder source as text; the result panel shows `200 ± 5 m` etc. (mean ± stdev).
- The `tonnage` output chip shows `1,180 ± 35 kt` + a small canvas histogram.
- A `pdf(tonnage)` block below that line — a KDE curve.
- The `p05_tonnage` chip shows `1,118 kt` (a regular Quantity — percentile collapses Uncertain to scalar).

## Phase 1 scope

The minimal vertical slice that's usable end-to-end:

- `Uncertain extends Quantity` in `quantity.js` — add/sub/mul/div/pow/neg.
- `samplesOf(q, N)` lifting helper.
- Distribution builders: `normal`, `uniform`, `lognormal`, `triangular` (Box-Muller for normal; trivial for the rest).
- Reductions: `mean`, `stdev`, `percentile`.
- Plot helpers: `pdf`, `cdf` (plus `hist` lifted to accept Uncertain).
- Element-wise builtin guards: `sqrt`, `sin`, `cos`, `tan`, `ln`, `log`, `exp`, `abs` propagate Uncertain.
- Output chip display: `mean ± stdev` text + canvas histogram thumbnail.
- Gutter / inline display: `mean unit`.
- Settings: sample count slider + seed mode dropdown.
- Seeded RNG (mulberry32), per-binding-name sub-seeding.
- Doc entries for every new name (and DOC_GROUPS section).
- Vendored `uncertainty/functions.nbt` with type signatures.
- Tests in `ext/numbat/test/uncertain.test.js` — round-trip arithmetic, distribution sanity (mean ≈ μ, stdev ≈ σ to within Monte Carlo tolerance), reductions, propagation through nonlinear ops.
- Numbat-js conformance: plain (non-uncertain) programs unaffected — all guards check `__uncertain` first.

**Out of Phase 1**: correlated inputs, per-cell dataset uncertainty, comparison-returns-probability, custom / empirical distributions, Bayesian update.

## Phase 2+ (deferred)

- **Correlated inputs** — a `correlated(...)` builder returning multiple `Uncertain` values sharing a covariance matrix, or a domain-specific `from_drillhole(...)` bundling multiple properties with their natural correlation. Implemented as `kind: 'correlated'` with a shared sample matrix.
- **Per-cell dataset uncertainty** — a Dataset column whose cells are each Uncertain. Reductions over the column (`mean(model.grade)`) become Uncertain themselves. Memory grows N×; needs lazy sampling.
- **Probability comparisons** — `P(tonnage > 100 kt)` returns a `Scalar` in `[0,1]`. Boolean use in conditionals (`if tonnage > 100 kt then …`) needs a semantics — probably "true if P > 0.5" with a warning, or a hard error.
- **Empirical / mixture distributions** — `empirical(samples)`, `mixture(weights, components)`.
- **Analytical kind** — `kind: 'analytical'` with `{ mean, variance }` for fast Gaussian-linear chains. Mixed-kind ops materialize to samples via `samplesOf`.
- **Bayesian update** — `update(prior, likelihood, observation) → posterior`. Explicit, no MCMC; uses importance-weighted resampling on the sample array. Phase 3 territory.

## Open questions

- **Gutter density.** Should the gutter show `mean unit` (compact) or `mean ± stdev unit` (richer)? Phase 1: `mean` only. Easy to swap later if it feels too thin.
- **`@input x = normal(...)` chip design.** Phase 1: the chip is a plain text editor; you type the dist-builder call. **Phase 1.5** could add a `@dist` decorator that gives the chip a richer editor (two sliders, μ and σ, with the chip header showing the distribution name).
- **Reproducibility under edit.** Sub-seed each distribution by the binding *name*, not source position — reordering or adding a binding above doesn't shift `density`'s samples. Anonymous bindings (no name) sub-seed by source position; not ideal but a Phase-1 trade-off.
- **`hist` overload.** `hist(list)` already exists for a `List<Quantity>`. `hist(unc)` should bin `unc.samples` — same builtin, one extra branch at the top.
- **Format-document interaction.** A `normal(2.7 g/cm³, 0.1 g/cm³)` line is a regular function call; the existing format rules — whitespace normalization plus long-call breaking — should handle it without new logic. Verify when implementing.
- **Conformance with upstream Numbat.** ep-original extension. `normal(...)` upstream fails loudly with "unknown identifier" — the right failure mode per the additive-divergence rule. No silent miscomputation.
- **Performance.** N=1000 × ~10 arithmetic ops × ~100 bindings = ~10⁶ float ops per re-eval. Well under one frame. N=10000 ramps to 10⁷ — still fine for non-interactive "final answer" rendering. Per-cell dataset uncertainty (Phase 2) is where this gets interesting and the analytical kind becomes valuable.

## Status

Phase 1 designed (this document). Implementation pending — see Phase 1 scope. The natural first vertical slice: `Uncertain` class + `normal` builder + `mean` / `stdev` reductions + chip display (mean ± stdev + histogram thumbnail). One end-to-end test program demonstrates the propagation; then fan out the other builders, reductions, plot helpers, settings.
