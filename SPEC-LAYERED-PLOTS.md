# SPEC-LAYERED-PLOTS — fluent multi-layer plot builders

**Status**: Phase 1 + 2 shipped (Plot value, fluent builders for every family, multi-layer rendering, multi-layer chip thumbnails, cross-layer hover, grouped bars / alpha hist). Phase 3 adds `with_band` for shaded uncertainty envelopes. Phase 4 adds per-layer styling adders (`with_color` / `with_width` / `with_dash` / `with_alpha` / `with_marker_size`) that target the most-recently-added layer. Phase 5+ deferred items noted at the bottom.

## Motivation

Today every plot builder in ep emits exactly one descriptor and produces exactly one inline block. `plot(xs, ys)` is a line; `scatter(xs, ys)` is a scatter; `stereonet_planes(...)` is a stereonet of planes. You can't show two things in the same plot — fold orientations *and* slip lineations on the same stereonet, measured points *and* a best-fit line on the same xy-axes, a histogram *and* its KDE curve. Every real engineering plot eventually needs layering.

The pattern that fits Numbat best is the **fluent builder** — a `Plot` value (a struct of accumulated layers) that you compose with `with_*` functions, threaded through the `|>` pipe. Stays Numbat-compatible (just functions returning structs), reads as data flow, and generalizes across every plot family.

```ep
stereonet()
  |> with_planes(faults.dd, faults.dip)
  |> with_lines(lineations.trend, lineations.plunge)
  |> with_title("Conjugate faults + slip vectors")
```

A bare expression whose value is a `Plot` auto-renders — no explicit `show()` needed for the common case. The existing one-shot builders (`plot`, `scatter`, `hist`, `stereonet_planes`, `stereonet_lines`) stay as shortcuts: each desugars into the fluent form internally.

## Non-goals

- **Not a charting library.** No matplotlib-grade granular styling, theme system, axis tick formatting controls, or annotation primitives. ep stays a calculator.
- **Not interactive layering.** No "click a layer to edit." Layers are built in source; the editor is the styling surface.
- **Not 3D.** Stereonet stays 2D (equal-area projection); line / scatter stay xy.
- **Not breaking.** Existing programs using `plot()` / `hist()` / `stereonet_planes()` keep working — those builders become shortcuts for the fluent form.

## Design summary

A `Plot` is a tagged struct value: `{__plot: true, family, layers, title, xLabel, yLabel, …}`. The `family` field — `'line'`, `'scatter'`, `'bar'`, `'hist'`, `'stereonet'` — chooses the rendering path. `layers` is a `List<Layer>` accumulated by `with_*` adder functions. A row whose final value is a `Plot` auto-renders by emitting the Plot to `_plotSink`, the same path the existing one-shot builders use.

Each `with_*` adder takes the plot as its first argument and returns a new plot (immutable update), so `|>` threads naturally. Layer features ride per-family: line plots accept `with_line` / `with_scatter` / `with_band`; stereonets accept `with_planes` / `with_lines` / `with_poles` / `with_contours`. Plot-level attributes — `with_title` / `with_xlabel` / `with_ylabel` — work on every family.

The architecture has **five single-point-of-extension layers**, mirroring SPEC-UNCERTAINTY's pattern.

## Extensibility hooks

### 1. Plot value — family-tagged, layer-bearing

```js
// A tagged plain object so it survives Numbat's value pipeline.
{
  __plot: true,
  family: 'line' | 'scatter' | 'bar' | 'hist' | 'stereonet',
  layers: [Layer, ...],
  title:  string,
  xLabel: string, yLabel: string,
  // family-specific extras (axis log/linear, projection variant, …)
  opts:   { ... },
}
```

Each `Layer` is itself a small struct. Adding a new family is a new entry-point builder plus a render branch — no surgery on the layer system.

### 2. Layer types — per-family additions

A `Layer` has:

```js
{ kind: 'line' | 'scatter' | 'bars' | 'bins' | 'planes' | 'lines' | 'poles' | 'contours',
  xs?, ys?, values?, dd?, dip?, trend?, plunge?, …,
  label?, color?, style?: { ... } }
```

Adding `'band'` (an uncertainty envelope around a line), `'errorbars'`, `'arrows'`, `'small_circles'` (stereonet) is one new layer kind. Renderer dispatches on `layer.kind`.

### 3. Builder registry — one entry per family

```js
line_plot()    → empty Plot family='line'
scatter_plot() → empty Plot family='scatter'  (or family='line' with no .line layer; tbd)
bar_plot()     → empty Plot family='bar'
histogram()    → empty Plot family='hist'
stereonet()    → empty Plot family='stereonet'
```

Each is one new BUILTIN_PROC.

### 4. Adder registry — one entry per `with_*`

Common (any family):
```
with_title(plot, title)
with_xlabel(plot, label)
with_ylabel(plot, label)
```

Family-specific:
```
with_line(plot, xs, ys [, label])           # adds a 'line' layer
with_scatter(plot, xs, ys [, label])        # adds a 'scatter' layer
with_bars(plot, values [, label])           # adds a 'bars' layer
with_hist(plot, values [, label])           # adds a 'bins' layer
with_planes(plot, dd, dip [, label])        # stereonet
with_lines(plot, trend, plunge [, label])   # stereonet
with_poles(plot, dd, dip [, label])         # stereonet
```

Adding `with_band(plot, xs, lo, hi)`, `with_smallcircles(plot, axes, angles)`, `with_kde(plot, samples)` later is one new BUILTIN_PROC each.

### 5. Render dispatch — one branch per family

`render.js` has the single dispatch:

```js
function emitPlot(plot, descriptor /* legacy */) {
  if (plot.family === 'stereonet') renderStereonet(plot);
  else                              drawPlot(plot);   // line/scatter/bar/hist
}
```

`drawPlot` already handles the xy families per layer.kind. `renderStereonet` loops over layers calling bearing.js methods (`sn.plane`, `sn.pole`, `sn.line`, etc.). Hover inspection (the existing crosshair + tooltip) iterates all layers to find the closest data point.

## Detailed semantics

### 1. The Plot value

A `Plot` is a host-side plain object with a `__plot: true` tag — invisible to user-side type identity but recognized by the evaluator and renderer. From the user's perspective it behaves like any other value: assignable, passable, prints as `<line plot, 2 layers>` (or similar) when displayed in the gutter.

### 2. Builders

```ep
line_plot()       # → Plot { family: 'line', layers: [], ... }
scatter_plot()    # → Plot { family: 'scatter', layers: [], ... }
bar_plot()        # → Plot { family: 'bar', layers: [], ... }
histogram()       # → Plot { family: 'hist', layers: [], ... }
stereonet()       # → Plot { family: 'stereonet', layers: [], ... }
```

Each takes no arguments and returns an empty Plot of that family. Optional opts may come later (`stereonet(projection: equal-angle)` etc.).

### 3. Adders

All `with_*` functions take the Plot as their first argument (to thread through `|>`) and return a new Plot with the change applied. Plots are immutable; adders never mutate in place.

```ep
line_plot()
  |> with_line(xs, ys, "measured")
  |> with_scatter(xs2, ys2, "predicted")
  |> with_xlabel("temperature")
  |> with_ylabel("rate")
  |> with_title("Reaction rate vs temperature")
```

Each adder validates: dim consistency across xs/ys, equal lengths, value units recognizable. Errors loud.

### 4. Auto-render

A row whose value is a Plot (i.e. `row.result.__plot === true`) triggers an automatic emission to `_plotSink` — same path the current one-shot builders use. No explicit `show()` needed for the common case where the Plot is the bare result of a line.

```ep
# both render the same way:
stereonet() |> with_planes(dd, dip)    # bare expression
show(stereonet() |> with_planes(dd, dip))   # explicit
```

`show(plot)` is a builtin that explicitly emits — useful when you want to bind a plot to a name AND render it (or render it on a different line than the construction).

### 5. Backwards-compat shortcuts

Every existing one-shot builder becomes sugar for the fluent form. They stay (and stay documented), so existing programs continue to work and users still have the concise form when they don't need layering:

```ep
plot(xs, ys, "x", "y", "title")
# ≡
line_plot()
  |> with_line(xs, ys)
  |> with_xlabel("x")
  |> with_ylabel("y")
  |> with_title("title")

stereonet_planes(dd, dip, "title")
# ≡
stereonet()
  |> with_planes(dd, dip)
  |> with_title("title")
```

Implementation-wise: each one-shot builder constructs the Plot internally and returns it (so auto-render fires). No special-case rendering path.

### 6. Hover + modal

The existing plot hover (crosshair + tooltip) iterates layers to find the closest data point across all of them. Tooltip text includes the layer label when the plot has multiple layers (`"x = 220 kt · y = 0.034 · measured"`). The modal handles multi-layer descriptors the same way as inline: each layer drawn in its own color from a small built-in cycle (`--sw-orange`, `--sw-indigo`, `--sw-teal`, …).

## Examples

```ep
# Combined stereonet — fold orientations and slip lineations together
stereonet()
  |> with_planes(faults.dd, faults.dip, "fault planes")
  |> with_lines(slip.trend, slip.plunge, "slip vectors")
  |> with_title("Conjugate fault set + slip")
```

```ep
# Measured points + best-fit line
xs    = sample.temperature
ys    = sample.rate
slope = (ys[1] - ys[0]) / (xs[1] - xs[0])   # placeholder
fit   = xs * slope

line_plot()
  |> with_scatter(xs, ys, "measured")
  |> with_line(xs, fit, "best fit")
  |> with_xlabel("T")
  |> with_ylabel("rate")
```

```ep
# Histogram + KDE — uncertainty visualization
samples = samples(tonnage)
histogram()
  |> with_bins(samples)
  |> with_kde(samples, "density")
  |> with_title("Tonnage distribution")
```

## Phase 1 scope

The minimal vertical slice that's usable end-to-end:

- The `Plot` value type (tagged plain object).
- Five entry-point builders: `line_plot()`, `scatter_plot()`, `bar_plot()`, `histogram()`, `stereonet()`.
- Common adders: `with_title`, `with_xlabel`, `with_ylabel`.
- Family-specific adders for the current data shapes:
  - line / scatter / bar plots: `with_line`, `with_scatter`, `with_bars`, `with_bins`.
  - stereonet: `with_planes`, `with_lines`, `with_poles`.
- Auto-render: a row whose `.result.__plot === true` emits to `_plotSink` after evaluation.
- `show(plot)` for explicit emission.
- Multi-layer rendering in `drawPlot` (line/scatter/bar/hist) — color cycle, per-layer legend labels.
- Multi-layer rendering in `renderStereonet` — bearing.js's `.plane` / `.line` / `.pole` for each layer.
- Backwards-compat: rewrite `plot`, `scatter`, `bar_chart`, `hist`, `stereonet_planes`, `stereonet_lines` as one-shot wrappers around the fluent form.
- Doc entries + a new "Layered plots (ep extension)" group; example program demonstrating layered stereonet.

**Out of Phase 1**:
- Custom layer styling (color picker, linewidth, marker size).
- Multi-axis (twin y-axis) plots.
- Annotations (text, arrows, shaded regions).
- Saved themes.
- Interactive legend (click to toggle layer visibility).

## Phase 2+ (deferred)

- **`with_smallcircles(plot, axes, angles)`** — stereonet small circles.
- **`with_contours(plot, dd, dip)`** — bearing.js's Kamb contouring on density of poles.
- **`with_errorbars(plot, xs, ys, errs)`** — per-point error bars.
- **Combined uncertainty + sweep visualization** — sweep on x-axis, ±1σ band on y. Cross-Sample-Bearing layering.
- **Save/restore plot configurations** — for templates.

## Open questions

- **Auto-render trigger.** Phase 1: a row whose final value is a Plot auto-emits. Edge case: `let p = stereonet()  |> with_planes(...)` (binding the Plot to a name without showing). The binding doesn't render unless followed by `show(p)`. Same heuristic as numbat: a bare expression evaluates and (in ep) emits if it's a Plot; a `let` binding doesn't.

- **Color + label as optional positional args.** Numbat has no user-side default-value or keyword-arg syntax, but `BUILTIN_PROC` adders are variadic on the host side (same mechanism `plot(xs, ys [, xlabel, ylabel, title])` already uses). The Phase 1 shape:
  - `with_line(plot, xs, ys)` — auto-cycle color, auto label
  - `with_line(plot, xs, ys, "label")` — explicit label
  - `with_line(plot, xs, ys, "label", "indigo")` — explicit both
  Color cycle in Phase 1: `--sw-orange`, `--sw-indigo`, `--sw-teal`, then loop.

- **Richer styling.** Resolved by Phase 4 — `with_color` / `with_width` / `with_dash` / `with_alpha` / `with_marker_size` each target the most-recently-added layer. The trailing-struct shape (`StyleOpts { … }`) was rejected because numbat structs require every field at construction (no defaults), which would force callers to spell out fields they don't care about.

- **Chip thumbnail rendering for multi-layer plots.** Resolved — `drawPlot` iterates every layer in compact mode, so the chip already shows all curves in their cycled colors.

- **Hover inspection across layers.** Resolved — `attachPlotHover` picks the nearest sample across every layer in pixel space (honoring grouped bar offsets) and prefixes the tooltip with the winning layer's label when more than one layer is present.

- **Backwards-compat assertions.** The legacy one-shot builders emit the same descriptor shape they do today — implementation will need to make sure `drawPlot`'s old descriptor path still works (or the shortcut wrappers construct full Plot values that the new dispatch handles).

- **Conformance with upstream Numbat.** All new names (`line_plot`, `with_*`, `show`, etc.) are ep-original. Upstream Numbat has its own `LinePlot<X, Y>` struct in `plot::line_plot.nbt` — we're building a different system. Fails loudly on upstream (unknown identifier), matching the additive-divergence rule.

## Status

Phase 1 + 2 shipped. The vertical-slice landed first (`stereonet()` + `with_planes` / `with_lines` / `with_title` + auto-render), then fanned out to xy / bar / hist families with multi-line `|>` anchoring. The Phase-2 polish followed: multi-layer chip thumbnails, cross-layer hover inspection, and grouped bar / alpha-blended hist layouts so overlapping bar/bin layers stay legible. Phase 3 added `with_band` — a shaded-envelope xy layer that pairs naturally with `percentile` on `Uncertain` / `Swept` curves. Phase 4 added per-layer styling via target-the-last-layer adders (`with_color`, `with_width`, `with_dash`, `with_alpha`, `with_marker_size`) that flow through both the canvas families and the stereonet family via bearing.js's `style` arg. Phase 5+ items remain in the deferred list above (Kamb contours, error bars, small circles, save/restore).
