# SPEC-GEOSTATS — non-grid geostatistics: anamorphosis, change of support, recovery functions

**Status**: Phase 1 designed (this document); implementation pending. Phase 2+ noted at the bottom.

## Motivation

ep has shipped sample-bearing arithmetic (`Uncertain`), order-statistic reductions (`percentile`, `mean`, `stdev`), and the layered-plot Plot family. The natural next domain layer is **non-grid geostatistics** — the population-statistics side of mining engineering that doesn't need a spatial grid, distance metric, or variogram model. Everything in this layer operates on an `Uncertain<Grade>` (or a `List<Grade>`) and the user's chosen support / cutoff parameters.

The four classic operations:

1. **Gaussian anamorphosis** — fit a polynomial transform Z(y) mapping a raw grade distribution to a standard normal. Hermite-polynomial expansion is the canonical method.
2. **Change of support (DGM)** — given a point-support anamorphosis, derive the block-support anamorphosis via the variance-reduction factor `r`. In the Discrete Gaussian Model, this is a one-line transformation on the Hermite coefficients (`φ_k_block = φ_k_point · r^k`).
3. **Recovery functions** — for a cutoff `z_c`, compute the tonnage above cutoff `T(z_c)`, the mean grade above cutoff `m(z_c)`, and the contained metal `M(z_c) = T · m`. Closed-form integrals over the standard normal, so each cutoff is O(degree).
4. **Theoretical grade-tonnage curves** — sweep cutoffs across a range; auto-render the resulting curve as a layered Plot.

These are the daily-bread operations for open-pit cutoff optimization, ore-reserve estimation, and selectivity studies. ep doesn't have them today; a mining engineer would lift their grade distribution into Isatis or a Python notebook to run anamorphosis + recovery, then paste numbers back.

The whole stack lands on top of what's already shipped:

- `Uncertain` already represents a sample distribution; anamorphosis is fit FROM one.
- `Quantity.disp` carries dimensional units through (`g/t`, `%`, etc.) — recovery outputs read correctly.
- `with_line` / `with_band` give us grade-tonnage rendering for free.
- `erf` lives in `math::functions` already (vendored), so closed-form integrals over the normal are reachable.

Critically: **no matrix infrastructure is needed**. Hermite coefficients have closed-form empirical estimators (a single O(N·K) sum); change-of-support is coefficient-list arithmetic; recovery integrals are O(K) per cutoff. The whole API is small numeric kernels.

## Non-goals

- **Not spatial geostats.** No coordinates, no distance, no variogram modelling, no kriging. Those live in a separate (much bigger) "spatial geostats" story — possibly leaning on SPEC-LINE once landed.
- **Not block-model storage.** The block-support anamorphosis describes a population. Wiring it onto a 3-D block model is the block-model story (SPEC-DATASETS Phase 2 + SPEC §10 worker offload).
- **Not non-Gaussian anamorphosis.** Empirical CDF anamorphosis, indicator-based recovery, multi-Gaussian uniform-conditioning extensions — all out of v1.
- **Not real-world conditioning.** No "given these neighboring samples, what's the local recovery" — that's geostatistical simulation, kriging-flavored, out of scope.
- **Not enforcement of physical constraints.** Polynomial fits can produce negative grades at extreme quantiles (Gibbs-like ringing). v1 surfaces the raw fit; the user sees what they get. Phase 2 could add isotonic / monotonic correction or hard clipping.

## Design summary

A new `Anamorphosis` value type — a tagged plain object (`__anamorphosis: true`) carrying:

- `coefficients: Float64Array` — Hermite expansion coefficients [φ_0, φ_1, …, φ_K]
- `degree: number` — K, the polynomial degree
- `dim` + `disp` — the grade unit (e.g. `g/t`)
- `r: number` — current support factor (1.0 for point support; <1 for block support after `with_block_support`)

And a `Recovery` value type — `{ __recovery: true, cutoff, tonnage, mean_grade, metal }` carrying the four numbers a mining engineer wants for a given cutoff.

Both are constructed by host BUILTIN_PROCs that wrap the underlying numeric kernels (~50-200 LOC each). The Plot family gains a new `gradetonnage` variant (or, simpler v1: emit a standard `xy` Plot with two layers via `with_line`).

Five single-point-of-extension layers (same pattern as SPEC-UNCERTAINTY / SPEC-LAYERED-PLOTS):

1. **`Anamorphosis` + `Recovery` value types** — tagged plain objects.
2. **Numeric kernels** — `_fitHermite`, `_evalHermiteRecurrence`, `_recoveryAtCutoff` — pure functions over typed arrays.
3. **BUILTIN_PROC entries** — `anamorphosis`, `with_block_support`, `recovery`, `grade_tonnage`, etc.
4. **Typechecker schemes** — opaque-TVar treatment (same shape Plot uses).
5. **Render path** — chip thumbnail for `Anamorphosis` (e.g., a small Z(y) curve); auto-render path for `grade_tonnage` plots.

## Mathematical foundation

This section is for implementation reference, not user docs.

### Hermite polynomials (probabilists', normalized)

Let `H̃_k(y) = He_k(y) / sqrt(k!)` — the orthonormal Hermite polynomials under the standard-normal density:

```
∫ H̃_i(y) H̃_j(y) φ(y) dy = δ_ij
```

Recurrence (efficient for evaluation at a point):

```
H̃_0(y) = 1
H̃_1(y) = y
H̃_{k+1}(y) = (y · H̃_k(y) − sqrt(k) · H̃_{k-1}(y)) / sqrt(k+1)
```

### Empirical anamorphosis fit

Given sorted samples `z_1 ≤ z_2 ≤ … ≤ z_N`, with corresponding normal quantiles `y_i = Φ^(-1)((i − 0.5) / N)`:

```
φ_k ≈ (1 / N) · Σ_{i=1..N} z_i · H̃_k(y_i)
```

Cost: O(N · K). For N=1000 samples, K=30, that's 30,000 multiplications — negligible.

`Φ^(-1)` (inverse normal CDF) ships in `math::functions` already, or can be implemented via the Beasley-Springer-Moro approximation in ~30 LOC.

### Change of support (DGM)

Given point-support coefficients φ_k^point and a variance-reduction factor `r` ∈ (0, 1]:

```
φ_k^block = φ_k^point · r^k
```

That's it. `r` is user-input in the non-grid context (typically 0.4–0.9 depending on block size relative to sample support); in the full spatial context it would be derived from the variogram.

### Recovery functions

Given an anamorphosis with coefficients φ_k and a cutoff `z_c`, find the Gaussian cutoff `y_c` such that `Z(y_c) = z_c` (root-find via Newton; Z is monotonic if the fit is reasonable):

```
T(z_c) = 1 − Φ(y_c)                           [tonnage above cutoff]
m(z_c) = (1/T) · Σ_k φ_k · U_k(y_c)            [mean above cutoff]
M(z_c) = T · m                                [metal above cutoff]
```

Where U_k(y_c) is the tail-conditional Hermite integral:

```
U_0(y_c) = 1 − Φ(y_c) = T
U_1(y_c) = φ(y_c)
U_k(y_c) = (1/sqrt(k)) · H̃_{k-1}(y_c) · φ(y_c)    for k ≥ 1
```

(`φ` here is the standard normal density.) Cost per cutoff: O(K). A grade-tonnage sweep over M cutoffs costs O(M · K).

## API surface — Phase 1

### Construction

| Name | Signature | Notes |
|---|---|---|
| `anamorphosis` | `anamorphosis(z: Uncertain<D> \| List<D>, degree?: Scalar) -> Anamorphosis<D>` | Fit Hermite expansion to a sample distribution. Default `degree = min(30, floor(sqrt(N)))`. |
| `with_block_support` | `with_block_support(an: Anamorphosis<D>, r: Scalar) -> Anamorphosis<D>` | DGM change of support. `r` ∈ (0, 1]; r=1 is identity. |

### Recovery (single cutoff)

| Name | Signature | Notes |
|---|---|---|
| `recovery` | `recovery(an: Anamorphosis<D>, cutoff: D) -> Recovery<D>` | Returns `{cutoff, tonnage, mean_grade, metal}`. |
| `tonnage_above` | `tonnage_above(an: Anamorphosis<D>, cutoff: D) -> Scalar` | Just the tonnage (∈ [0, 1]). |
| `mean_above` | `mean_above(an: Anamorphosis<D>, cutoff: D) -> D` | Just the conditional mean. |
| `metal_above` | `metal_above(an: Anamorphosis<D>, cutoff: D) -> D` | Just `T · m`. |

### Recovery (curve)

| Name | Signature | Notes |
|---|---|---|
| `grade_tonnage` | `grade_tonnage(an: Anamorphosis<D>, cutoffs?: List<D>) -> Plot` | Auto-rendering. Default cutoff sweep: p1 → p99 in 41 steps. Two-line plot (tonnage + normalized mean grade) until twin-axis lands. |
| `metal_curve` | `metal_curve(an: Anamorphosis<D>, cutoffs?: List<D>) -> Plot` | Single-line plot of metal `M(z_c)` vs cutoff. |

### Diagnostics

| Name | Signature | Notes |
|---|---|---|
| `qq_plot` | `qq_plot(an: Anamorphosis<D>) -> Plot` | Scatter of sample quantiles vs reconstructed-from-Hermite quantiles. Should hug the diagonal for a good fit. |
| `samples_from` | `samples_from(an: Anamorphosis<D>, n?: Scalar) -> Uncertain<D>` | Draw n samples from the anamorphosis (round-trip back to Uncertain). Default n = the SettingsContext sample count. |

### Accessors

| Name | Signature | Notes |
|---|---|---|
| `coefficients` | `coefficients(an: Anamorphosis<D>) -> List<D>` | Inspect φ_k. |
| `support_factor` | `support_factor(an: Anamorphosis<D>) -> Scalar` | Returns the `r` value. 1.0 for point support. |

### Total Phase 1 surface: 11 names + 2 struct types.

## Examples

### Cutoff optimization (open-pit)

```ep
# Sample grade distribution (e.g. from drillhole assays)
au = lognormal(0.8 g/t, 0.6 g/t)

# Fit Hermite anamorphosis at point support
anam_point = anamorphosis(au, degree: 30)

# Block support — typical r for SMU vs sample support
anam_block = with_block_support(anam_point, 0.65)

# Single-cutoff recovery
cog        = recovery(anam_block, 0.5 g/t)
tonnage    = cog.tonnage          # e.g. 0.62
mean_grade = cog.mean_grade       # e.g. 1.4 g/t
metal      = cog.metal            # 0.62 × 1.4 ≈ 0.87 g/t per ton of resource

# Grade-tonnage curve auto-renders inline
grade_tonnage(anam_block)
```

### Sensitivity to support

```ep
au = lognormal(0.8 g/t, 0.6 g/t)
anam = anamorphosis(au)

# Sweep r to see how support smoothing affects metal at fixed cutoff
fn metal_at_r(r) = metal_above(with_block_support(anam, r), 0.5 g/t)
rs   = linspace(0.4, 1.0, 41)
metal = map(metal_at_r, rs)

line_plot()
  |> with_line(rs, metal, "metal at 0.5 g/t cutoff")
  |> with_xlabel("support factor r")
  |> with_ylabel("metal (g/t per ton)")
```

### Diagnostic: did the fit reproduce the input?

```ep
au   = lognormal(0.8 g/t, 0.6 g/t)
anam = anamorphosis(au, degree: 50)

# Q-Q plot — points should hug the diagonal if the fit is faithful
qq_plot(anam)

# Histogram overlay: input samples + Hermite-reconstructed samples
histogram()
  |> with_bins(au)                     |> with_color("teal")  |> with_alpha(0.55)
  |> with_bins(samples_from(anam))     |> with_color("orange") |> with_alpha(0.55)
  |> with_title("input vs Hermite reconstruction")
```

## Open questions

- **Hermite normalization convention.** Going with **normalized** (orthonormal under the normal density) because the empirical estimator and the change-of-support formula both come out cleaner. Document the convention explicitly so users porting from Isatis (which uses non-normalized) know to expect a factor of `sqrt(k!)`.

- **Default degree.** Typical geostats practice: K=30 for ~1000 samples. Auto-pick by `degree = min(30, floor(sqrt(N)))` for v1; revisit if users hit ringing on small datasets. Surface as the second positional arg for explicit control.

- **Default cutoff sweep range.** `grade_tonnage(an)` without explicit cutoffs needs a default sweep. p1–p99 in 41 steps is a sensible "show me the curve" baseline. Trade-off: misses very-high-cutoff behavior where mining-engineering decisions usually live. Alternative: p1–p999 (capture the top tail). Punt this to user feedback.

- **`recovery` polymorphism.** Should `recovery(an, single_cutoff)` and `recovery(an, list_of_cutoffs)` both work? Numbat has no polymorphism on positional arg types beyond TVar. Simpler v1: single-cutoff only via `recovery`; for sweep use `grade_tonnage` (which builds the Plot) or `map(fn (z) = recovery(an, z), cutoffs)`.

- **Grade-tonnage twin-axis rendering.** The classical grade-tonnage plot has tonnage and mean grade on different y-axes. ep doesn't have twin-axis Plots yet. v1 options: (a) emit two `Plot`s side-by-side, (b) render mean grade normalized to [0,1] on the same axis as tonnage (lose units), (c) introduce a `gradetonnage` Plot family with custom drawing. Recommend (a) for v1 — clean, no new infrastructure, leaves the door open for (c) later.

- **Negative grades from polynomial fit.** Hermite expansion can produce Z(y) < 0 at extreme y. Physically impossible for grades; the user sees the artifact via the Q-Q plot. v1 doesn't enforce monotonicity or non-negativity. Phase 2 could add `anamorphosis_pchip` (monotonic spline) or clip-to-zero.

- **Discrete data with ties.** Empirical normal-score transform needs to break ties — common approaches are random tie-breaking or midrank. v1 picks midrank (deterministic; reproducible). Document.

- **The `r` parameter source.** For non-grid contexts, `r` is user input. v1 takes it as a Scalar with a docs blurb on typical values (~0.4 for selective mining, ~0.7 for bulk). Spatial contexts would derive `r` from a variogram — that's a future SPEC-VARIOGRAPHY.

- **Reset on parameter change.** When the user edits the source grade distribution (e.g., tweaks σ in `lognormal(μ, σ)`), the anamorphosis re-fits automatically because everything's in the topo-sorted DAG. Same reactive shape Uncertain / Swept already use. No special handling needed.

- **Conformance with upstream Numbat.** All names (`anamorphosis`, `with_block_support`, `recovery`, `grade_tonnage`, …) are ep-original. Upstream Numbat has no geostats surface. Fails loudly upstream as "unknown identifier" — matches the additive-divergence rule.

## Phase 2+ (deferred)

- **`anamorphosis_pchip`** — monotonic-spline anamorphosis (no Gibbs ringing, guarantees non-negative grades when the input is).
- **`with_block_support_from_variogram`** — derive `r` from a variogram model + block size. Pulls in spatial work; out of v1 scope.
- **Lane's cutoff optimization** — `lane_optimum(an, mining_cost, processing_cost, metal_price)` returns the economic optimum cutoff. Closed-form once recovery functions exist.
- **Indicator-based recovery** — for non-Gaussian distributions where Hermite expansion is a bad fit (e.g., bimodal grade populations from multiple mineralization styles).
- **Uniform conditioning** — multi-Gaussian extension for local recovery estimation given panel grades. Requires SPEC-LINE for the conditional-covariance math.
- **Multi-element / co-anamorphosis** — joint anamorphosis on (Au, Cu) for poly-metallic recovery. Pulls in matrix ops.
- **Block-model integration** — apply recovery functions cell-by-cell over a block model. Depends on SPEC-DATASETS Phase 2.

## Phase 1 scope checklist

- New `Anamorphosis` value class (tagged plain object) in `ext/numbat/src/load.js` (or a new `ext/numbat/src/geostats.js` source file).
- New `Recovery` value class (struct-shaped tagged object).
- Numeric kernels (`_fitHermite`, `_evalHermiteAt`, `_invertAnamorphosis`, `_recoveryAtCutoff`) — pure functions over typed arrays.
- Φ + Φ^(-1) helpers if not already in `math::functions`. Beasley-Springer-Moro for inverse-normal.
- 11 BUILTIN_PROC entries.
- Typecheck schemes (Anamorphosis-as-TVar approach; same shape Plot uses).
- Optional `geostats::functions` numbat-module signatures registered from `ep/src/js/evaluator.js`.
- Chip thumbnail render for `Anamorphosis` (small Z(y) curve, ~80×40 px).
- Auto-render path for `grade_tonnage` / `metal_curve` / `qq_plot` Plots.
- Docs entries + new "Geostatistics (ep extension)" group in `src/js/docs.js`.
- Test coverage at `ext/numbat/test/geostats.test.js`: fit a known distribution, check coefficients are sensible, check recovery against known closed-form (lognormal has analytic recovery — great test oracle), check change-of-support reduces variance by `r²`.

## Status

Phase 1 designed (this document). Implementation pending. The natural first vertical slice: `anamorphosis(uncertain)` + `recovery(an, cutoff)` returning a single Recovery, with the chip-thumbnail render showing Z(y) and `recovery.tonnage` / `.mean_grade` / `.metal` accessible by field. Once that runs end-to-end (an Uncertain → Anamorphosis → Recovery program prints sensible numbers), fan out to `with_block_support`, `grade_tonnage`, `qq_plot`.
