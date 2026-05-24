# SPEC-VARIOGRAPHY — spatial structure: anisotropy, experimental variograms, fitted models

**Status**: Phase 1 designed (this document); implementation pending. Phase 2+ noted at the bottom.

## Motivation

SPEC-GEOSTATS ships the non-grid population-statistics layer: anamorphosis, change of support (with a scalar `r`), recovery functions. That `r` is honest as a shortcut but lossy — the proper derivation is `r² = 1 − γ̄(v, v) / σ²_∞`, where γ̄(v, v) is the average variogram value between two random points in the block `v`. That requires a fitted variogram model and (if the block isn't cubic or the structure isn't isotropic) an anisotropy.

Beyond change-of-support, **every spatial geostatistical method** assumes you've already fit a variogram:

- **Kriging** (ordinary, simple, indicator) uses the variogram to compute the optimal linear estimator weights at each unknown location.
- **Conditional simulation** generates realizations that honor the variogram structure.
- **Cross-validation** of an estimation model checks that residuals are spatially uncorrelated under the chosen variogram.

So variography is the **gateway** to spatial geostats. Phase 1 here covers the practitioner's workflow:

1. **Define a sample dataset** with (coordinates, value) pairs — already half-shipped via ep's CSV + dataset infrastructure.
2. **Compute an experimental variogram** — bin sample pairs by lag distance (optionally also by direction), report `γ(h) = ½ · avg((z_i − z_j)²)` per bin. Visualize as a plot.
3. **Fit a variogram model** — spherical / exponential / Gaussian / nested / nugget effects — to the experimental curve. Either visual-fit (chip-driven, the user moves sill / range / nugget sliders) or numeric-fit (`solve_for` / `minimize` on a sum-squared-error objective).
4. **Define an anisotropy** — rotation angles + axis ratios — so the variogram model represents directional preference (typical case: long horizontal continuity, short vertical).
5. **Use the variogram model** in downstream calls — most immediately, `with_block_support_from_variogram` for SPEC-GEOSTATS.

ep already has every ingredient for steps 2–3 except the variogram-shaped value type and the bin/fit kernels. Step 4 (anisotropy) is new infrastructure but small. Step 5 just hooks into the existing recovery-functions API.

## Non-goals

- **Not kriging itself.** Kriging is a separate SPEC (depends on this one but has its own complexity: neighborhood search, declustering, ordinary vs simple vs indicator, dual-kriging, drift modelling). Future SPEC-KRIGING.
- **Not conditional simulation.** Same reason. Future SPEC-SIMULATION.
- **Not full automated variogram fitting heuristics.** v1 supports manual fitting (the user picks parameters or uses `solve_for`/`minimize` against an objective). Robust auto-fit that picks structure types, identifies nested components, and handles outliers is a bigger problem — deferred.
- **Not 4-D+ or temporal variograms.** v1 covers 1-D, 2-D, and 3-D spatial data. Space-time variograms are a real domain but out of v1.
- **Not non-stationary / drift-bearing variograms.** Trend modelling stays out — variogram inputs are assumed second-order stationary after declustering / detrending.
- **Not indicator variograms.** Variography on binary indicators (for indicator kriging) is a real sub-domain; deferred.

## Design summary

Three new value types, all tagged plain objects:

- **`Anisotropy`** — orientation + ratios. 2-D form: rotation angle + one axis ratio. 3-D form: three angles (azimuth / dip / plunge) + two axis ratios. Carries a method to transform a lag vector `h` into an isotropic-equivalent distance.
- **`Variogram`** (experimental) — bins along distance (and optionally direction), with per-bin lag center, pair count, and `γ(h)` value. Auto-renders as a Plot (single line with point markers; cyclic colors per direction when directional binning is enabled).
- **`VariogramModel`** (fitted / theoretical) — sum of nugget + nested structures, each with shape (`spherical`, `exponential`, `gaussian`), sill contribution, and range. Carries an `Anisotropy`. Evaluatable at any lag vector `h` (or pair of points) to return `γ(h)`. Auto-renders as a smooth curve overlaid on the same axes as the experimental plot.

Five single-point-of-extension layers (same pattern as SPEC-UNCERTAINTY / SPEC-LAYERED-PLOTS / SPEC-GEOSTATS):

1. **Three value types** — `Anisotropy`, `Variogram`, `VariogramModel`.
2. **Numeric kernels** — `_binPairs`, `_evalVariogramModel`, `_lagDistanceUnderAniso`, `_fitVariogramSSE` — pure functions.
3. **BUILTIN_PROC entries** — `anisotropy_2d`, `anisotropy_3d`, `experimental_variogram`, `variogram_spherical`, `variogram_exponential`, `variogram_gaussian`, `nugget`, `variogram_sum`, `eval_variogram`, `fit_variogram`.
4. **Typechecker schemes** — opaque-TVar (same shape Plot / Anamorphosis use).
5. **Render path** — auto-render for `Variogram` / `VariogramModel` Plots; chip thumbnail for `Anisotropy` (a rose-diagram / ellipsoid sketch).

## Mathematical foundation

This section is for implementation reference, not user docs.

### Anisotropy

**2-D.** A rotation angle `θ` (azimuth, measured clockwise from north — geology convention, not math convention) and an axis ratio `a` (the ratio of the minor-axis range to the major-axis range, `a ∈ (0, 1]`).

The lag vector `h = (dx, dy)` in user coordinates is transformed to an isotropic-equivalent distance by:

```
# Rotate so the major axis is along x'
dx' =  dx · cos(θ) + dy · sin(θ)
dy' = −dx · sin(θ) + dy · cos(θ)
# Rescale the minor axis so the ellipse becomes a circle
h_iso = sqrt((dx')² + (dy' / a)²)
```

**3-D.** Three angles — azimuth `θ_a`, dip `θ_d`, plunge `θ_p` (rotation about z, then x', then y'') — and two axis ratios `a_1 = minor / major`, `a_2 = vertical / major`. Same idea: rotate into the principal-axes frame, then rescale each axis to its range-ratio.

The transformation is a 3×3 rotation matrix (composed of three single-axis rotations in azimuth/dip/plunge order — the GSLIB convention) followed by an axis-rescaling diagonal matrix. v1 can either inline the matrix arithmetic (~30 LOC) or wait for SPEC-LINE.

### Variogram model evaluation

A variogram model is a sum of basic structures plus an optional nugget:

```
γ(h) = nugget · 𝟙{h > 0}  +  Σ_k  c_k · g_k(h_iso_k / a_k)
```

Where each structure `k` has its own sill contribution `c_k`, range `a_k`, anisotropy (which transforms `h` → `h_iso_k`), and shape function `g_k`. The basic shapes:

- **Spherical**: `g(t) = 1.5·t − 0.5·t³` for `t ≤ 1`, else `1`.
- **Exponential**: `g(t) = 1 − exp(−3t)` (with the conventional `−3t` so range is the "effective range" at ~95% of the sill).
- **Gaussian**: `g(t) = 1 − exp(−3t²)`.

Total sill = nugget + Σ c_k. Evaluatable at any `h` in O(structures) — typically 2–4 nested structures.

### Experimental variogram

Given a dataset of (coordinates, value) pairs, the experimental variogram at lag-bin `[h_lo, h_hi]` is:

```
γ̂(h) = ½ · (1 / N_h) · Σ_{(i, j) ∈ pairs(h)} (z_i − z_j)²
```

Where `pairs(h)` is the set of sample pairs whose lag distance falls in the bin. For directional binning, also require the lag vector to fall within an angular tolerance of a target direction.

Cost: O(N²) pair-counting for `N` samples — fine for N up to ~10,000 in pure JS. Larger datasets need spatial indexing (kd-tree) which is Phase 2.

The output: a list of bins, each carrying `(h_center, γ̂_value, n_pairs)`.

### Variogram fitting

Manual or numeric fit to minimize sum-squared error between experimental and modeled γ values:

```
SSE = Σ_bins  w_b · (γ̂_b − γ_model(h_b))²
```

Weights `w_b` typically proportional to `n_pairs(b) / h_b²` (the GSLIB convention: weight more by pair count, downweight long lags where the variogram is meaningless). The fit minimizes SSE over the model parameters — `minimize` from the solver work handles 1-D parameter sweeps; multi-parameter fits in v1 use sequential single-parameter sweeps or wait for SPEC-LINE's `lstsq`.

The realistic Phase 1 workflow is **visual fitting**: the user defines a `VariogramModel` with explicit parameter values via `@input` chips, sees both experimental and model overlaid on the same plot, and tweaks the chips until the model hugs the experimental. This is what most practitioners do anyway.

## API surface — Phase 1

### Anisotropy

| Name | Signature | Notes |
|---|---|---|
| `anisotropy_2d` | `anisotropy_2d(azimuth: Angle, ratio_minor_major: Scalar) -> Anisotropy` | Major axis at the given azimuth (clockwise from north — geology convention). `ratio_minor_major` ∈ (0, 1]; 1 means isotropic. |
| `anisotropy_3d` | `anisotropy_3d(azimuth: Angle, dip: Angle, plunge: Angle, ratio_minor: Scalar, ratio_vertical: Scalar) -> Anisotropy` | GSLIB-convention angle order. Major-axis ratios are both ∈ (0, 1]. |
| `isotropic` | `isotropic() -> Anisotropy` | Identity anisotropy; sentinel for "no directional preference". |

### Variogram model — basic structures

| Name | Signature | Notes |
|---|---|---|
| `nugget` | `nugget(c0: D²) -> VariogramModel` | A pure-nugget effect of magnitude c0 (dim is value² since γ values are in squared input dim). |
| `variogram_spherical` | `variogram_spherical(sill: D², range: Length, aniso?: Anisotropy) -> VariogramModel` | Default `aniso = isotropic()`. |
| `variogram_exponential` | `variogram_exponential(sill: D², range: Length, aniso?: Anisotropy) -> VariogramModel` | Range is the "effective" range (95% of sill). |
| `variogram_gaussian` | `variogram_gaussian(sill: D², range: Length, aniso?: Anisotropy) -> VariogramModel` | Smooth-near-origin behavior. |

### Variogram model — composition

| Name | Signature | Notes |
|---|---|---|
| `variogram_sum` | `variogram_sum(models: List<VariogramModel>) -> VariogramModel` | Nested sum: typical practice is `variogram_sum([nugget(c0), variogram_spherical(c1, a1), variogram_spherical(c2, a2)])` for a two-structure plus nugget. |

### Variogram evaluation

| Name | Signature | Notes |
|---|---|---|
| `eval_variogram` | `eval_variogram(v: VariogramModel, h: Length) -> D²` | Scalar lag → γ(h). For isotropic models or omni-directional evaluation. |
| `eval_variogram_vec` | `eval_variogram_vec(v: VariogramModel, hx: Length, hy: Length, hz?: Length) -> D²` | Vector lag → γ(h). Honors the model's anisotropy. |
| `sill` | `sill(v: VariogramModel) -> D²` | Total sill (nugget + structure contributions). |

### Experimental variogram

| Name | Signature | Notes |
|---|---|---|
| `experimental_variogram` | `experimental_variogram(coords: List<List<Length>>, values: List<D>, n_lags?: Scalar, max_lag?: Length, direction?: Anisotropy) -> Variogram` | Bins (coord, value) pairs by lag. `coords` is a list of coordinate-lists ([[x, y, z], ...]) or 2-D / 1-D variants. Default `n_lags = 20`, `max_lag = ½ × bbox diagonal`. With `direction`, restricts to pairs whose lag vector falls within the direction's tolerance cone (a single 1-D experimental curve). |
| `eval_experimental` | `eval_experimental(ev: Variogram, lag_idx: Scalar) -> D²` | Per-bin accessor. |

### Auto-render

A bare-expression `Variogram` or `VariogramModel` auto-renders as a Plot — same mechanism the layered-plot family uses. A `Variogram` shows discrete points at each lag; a `VariogramModel` shows a smooth curve. Overlay them by chaining: `show(experimental |> overlay_model(model))` or via a future `variogram_plot(ev, model)` shortcut.

### Fitting (manual visual)

No new builtins required. The user defines model parameters as `@input` chips (sill, range, nugget) and visually adjusts them until the modeled curve hugs the experimental:

```ep
@input
sill = 1.0
@input
range = 50 m
@input
nugget_c0 = 0.1

v_model = variogram_sum([nugget(nugget_c0), variogram_spherical(sill, range)])
ev = experimental_variogram(model.x, model.grade)

variogram_plot(ev, v_model)
```

### Fitting (numeric)

| Name | Signature | Notes |
|---|---|---|
| `fit_variogram_sse` | `fit_variogram_sse(ev: Variogram, model_builder: Fn[(D) -> VariogramModel], lo: D, hi: D) -> D` | 1-D fit: pass a model-construction function of one parameter (e.g., range), get back the value that minimizes SSE against the experimental. Leans entirely on `minimize` from the solver work. Multi-parameter fits in v1 are sequential single-parameter sweeps; SPEC-LINE's `lstsq` unlocks proper multi-parameter least squares later. |

### Total Phase 1 surface: 13 names + 3 struct types.

## Examples

### Anisotropy + experimental → manual fit

```ep
# Drillhole assay dataset
assays  = load_csv("./assays.csv")  # columns: x, y, z, au_gpt

# Define an east-west horizontal preferred-continuity direction
horiz_ew = anisotropy_3d(90 deg, 0 deg, 0 deg, 1.0, 0.3)
# (azimuth=90° east, no dip / plunge; vertical range = 0.3 × horizontal range)

# Experimental variogram in that direction
ev = experimental_variogram(
  zip(assays.x, assays.y, assays.z),    # coord list
  assays.au_gpt,                         # values
  n_lags: 20, max_lag: 300 m,
  direction: horiz_ew
)

# Modelled variogram — three structures plus nugget
@input
c0 = 0.05         # nugget
@input
c1 = 0.6          # short-range sill
@input
a1 = 50 m         # short-range range
@input
c2 = 0.4          # long-range sill
@input
a2 = 200 m        # long-range range

v_model = variogram_sum([
  nugget(c0),
  variogram_spherical(c1, a1, horiz_ew),
  variogram_spherical(c2, a2, horiz_ew),
])

variogram_plot(ev, v_model)   # auto-renders; user tweaks chips visually
```

### Variogram-derived block support → recovery

This is the cross-spec hook into SPEC-GEOSTATS Phase 2. The variogram from the snippet above feeds the change-of-support calculation:

```ep
au_samples = lognormal(0.8 g/t, 0.6 g/t)       # population from samples
an_point   = anamorphosis(au_samples)

# Block dims (a typical SMU: 10 × 10 × 5 m)
block_dims = [10 m, 10 m, 5 m]

# Now r is computed from γ̄(v, v) integration, not provided as a scalar
an_block   = with_block_support_from_variogram(an_point, block_dims, v_model)

# Lane optimum cutoff
fn profit_at(c: MassPerMass) -> Scalar =
  revenue * metal_above(an_block, c) - processing_cost * tonnage_above(an_block, c)
c_opt = maximize(profit_at, 0 g/t, 5 g/t)
```

### Numeric 1-D fit on the range parameter

```ep
ev = experimental_variogram(zip(assays.x, assays.y), assays.au_gpt)

# Fix sill, vary range to minimize SSE
fn model_with_range(a: Length) -> VariogramModel =
  variogram_spherical(1.0, a)

best_range = fit_variogram_sse(ev, model_with_range, 10 m, 500 m)
```

## Open questions

- **Coordinate value shape.** Phase 1 takes coordinates as a `List<List<Length>>` (a list of per-sample coordinate lists). For datasets already in column-shape (`assays.x`, `assays.y`, `assays.z`), `zip(...)` is the converter. Could introduce a dedicated `Point` / `points_3d(...)` value type later — but it adds surface for marginal benefit when `zip` works. Defer.

- **Azimuth convention.** GSLIB uses clockwise-from-north for azimuth; ep's stereonet (bearing.js) does the same. Math convention is counter-clockwise from east. Going with geology / GSLIB convention because the user base is geology / mining.

- **Dip / plunge conventions.** GSLIB has a specific order (azimuth → dip → plunge applied as three sequential rotations). Document the exact rotation order in the SPEC; users coming from Leapfrog or Vulcan may expect slightly different conventions.

- **Anisotropy stacking.** Each structure in `variogram_sum` can have its OWN anisotropy (geometric anisotropy with different ranges per structure is common; "zonal" anisotropy with the same range in some direction is another). Phase 1 allows per-structure aniso. Phase 2 might add helpers for the common "all-structures-share-aniso" case.

- **Bin width / lag tolerance.** Experimental variograms have two free parameters: the lag-bin width and the directional cone tolerance. Defaults: `lag_width = max_lag / n_lags`, `cone_tolerance = 22.5°` (the GSLIB default — quarter-cardinal). Both should be configurable via optional opts.

- **Variogram inversion (cross-variogram, cross-covariance).** Two-variable / co-variography is a real use case (Au-Cu cross-variograms in poly-metallic deposits). Deferred to Phase 2.

- **Sample weighting.** Declustered datasets need per-sample weights propagated into the experimental γ̂ calculation. Phase 1 unweighted; declustering itself is a separate concern (Phase 2, lives in SPEC-DATASETS / a future SPEC-DECLUSTER).

- **Performance ceiling.** Naive O(N²) pair iteration fine to ~10k samples. Beyond, want a kd-tree or grid-based pair search. Phase 2; the worker-offload story (SPEC §10) is the right umbrella.

- **Conformance with upstream Numbat.** All names (`anisotropy_2d`, `experimental_variogram`, `variogram_*`, etc.) are ep-original. Upstream Numbat has no geostats surface. Fails loudly upstream as "unknown identifier" — matches the additive-divergence rule.

## Phase 2+ (deferred)

- **Cross-variograms / cross-covariance.** Two-variable spatial structure for co-kriging workflows.
- **kd-tree / spatial indexing** for the experimental-variogram pair search. Scales to N >> 10k.
- **Indicator variograms.** Bin-by-bin variography on the indicator transform `𝟙{Z > cutoff}`. Prerequisite for indicator kriging.
- **Sample-weight propagation** for declustered datasets.
- **Auto-fit heuristics** — pick structure types, identify nested components, robust to outliers.
- **Cross-validation diagnostics** — leave-one-out kriging on a sample dataset under a fitted variogram, residual statistics.
- **Multi-parameter least-squares fit** via SPEC-LINE's `lstsq`.
- **Variogram cloud** (the per-pair γ value rather than binned averages) for outlier detection.
- **Anisotropy ellipsoid render** — a chip thumbnail showing the directional-preference ellipse, paired with the existing stereonet visualization.

## Phase 1 scope checklist

- Three new value types (`Anisotropy`, `Variogram`, `VariogramModel`) as tagged plain objects.
- Numeric kernels: `_anisoDistance2D`, `_anisoDistance3D`, `_evalVariogramModel`, `_binPairs`, `_fitVariogramSSE` (the last one a thin wrapper over `_brentMin`).
- 13 BUILTIN_PROC entries in `ext/numbat/src/load.js`.
- Typecheck schemes (opaque-TVar; same shape Plot / Anamorphosis use).
- Optional `variography::functions` numbat-module signatures registered from `ep/src/js/evaluator.js`.
- Auto-render path for `Variogram` and `VariogramModel` (xy-family Plot, leaning on the layered-plot infrastructure).
- Chip thumbnail render for `Anisotropy` (a small 2-D ellipse or 3-D ellipsoid sketch).
- Docs entries + new "Variography (ep extension)" group in `src/js/docs.js`.
- Test coverage at `ext/numbat/test/variography.test.js`: anisotropy transformation, basic variogram model evaluation, experimental binning on a known dataset, 1-D fit against a synthetic experimental curve, the cross-spec hook into `with_block_support_from_variogram`.

## Status

Phase 1 designed (this document). Implementation pending. Order of operations once work resumes: **(a)** anisotropy types + transformations, **(b)** variogram model evaluation, **(c)** experimental binning, **(d)** auto-render path, **(e)** wire `with_block_support_from_variogram` in SPEC-GEOSTATS to depend on this. Numeric fitting (`fit_variogram_sse`) and manual visual fitting via `@input` chips both land in Phase 1; the chip path requires no new code, only the auto-render pieces.

The natural first vertical slice: anisotropy_2d + a spherical model + experimental_variogram on a small CSV → variogram_plot showing both. Once that runs end-to-end (a real assay CSV in, a sensible-looking variogram out), fan out to 3-D anisotropy, nested structures, and the cross-spec hook.
