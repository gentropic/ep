# SPEC-DATASETS — lazy collections & block models

**Status**: design draft. Not implemented. Forward-looking extension to ep,
deliberately kept separate from `SPEC.md` so the boundary between
"initial implementation" and "dataset-scale extension" is clear.

## Motivation

ep today is calculator-shaped: scalars, units, single-value bindings. The
core SPEC covers programs of the form "twenty inputs, fifty derived
intermediates, ten outputs" — every value is a `Quantity(scalar, dim)`.

The next jump is **datasets**: bindings whose values are collections of
records — block models in mining (millions of voxels each tagged with
grade, lithology, density), drillhole assay tables, time series, sample
sets. The shape of the work is the same as a calculator (compute
derived quantities, react to chip changes, surface results) but the
data is N rows instead of one.

The notepad reactivity is what makes ep different from pandas/spark/SQL
for this. The user drags a cutoff slider, sees tonnage update live,
sees which inputs the answer depends on. Doing that over a million-cell
block model — without losing the calculator UX — is the goal.

## Non-goals

- Replacing pandas / numpy / xarray / Spark. ep is a calculator that
  *also* handles collections; it's not a general-purpose dataframe
  library.
- Arbitrary query languages. SQL-grade joins, window functions, etc.
  are out of scope.
- Distributed computation. ep runs in one browser tab. Datasets that
  fit in browser memory (10⁶-ish cells) are the target.
- Mutation. Bindings remain immutable; derived values are recomputed.

## Design summary

Six decisions locked in (rationale in their sections below):

1. **Laziness by default** — filters and projections produce *views*,
   not materialized copies. Materialization happens at reductions or
   explicit `collect(...)`.
2. **`where` keyword overload** — same token as fn-body `where`,
   disambiguated by context (fn-body form is `where name = expr`,
   filter form is `where <Bool-expr>`).
3. **Masks** — column comparisons return Boolean lists, composable in
   `where` clauses (pandas-style).
4. **Backticks for non-identifier column names** — `` `Au g/t` `` works.
5. **No outer-scope sigil initially** — column-first-then-outer scope
   resolution; defer `$cutoff` until shadowing actually bites.
6. **Numbat-compatible at the type level** — collections are `List<T>`
   schemes, the typechecker already handles these; the extensions are
   surface syntax + runtime, not type-system.

## Detailed semantics

### 1. Laziness

A filter or projection on a collection-typed value returns a *view*:

```
let filtered = model where grade > 2.5 g/cm^3
# filtered is a view: { source: model, predicate: ... }
# NOT a copy of model.

let column = model.tonnage
# column is a view of the tonnage column: { source: model, project: 'tonnage' }
# NOT a copy.
```

Materialization triggers:
- **Reductions**: `sum`, `mean`, `max`, `min`, `std`, `count`, `head`,
  `nth(i, …)`. These walk the source applying the view's
  filter+projection chain and produce a scalar (or short list).
- **Explicit collect**: `collect(view)` returns a materialized `List<T>`.

Views compose:

```
sum((model where grade > cutoff).tonnage)
sum(model.tonnage where grade > cutoff)
# Equivalent. Both lower to: one pass over model's cells,
# accumulating tonnage[i] when grade[i] > cutoff.
```

**Implementation**: a view is `{source, predicate?, projection?}`. The
reduction walker traverses the source's cells, evaluates predicate
inline, applies projection, accumulates. No intermediate lists. AIR
(when integrated) compiles the full chain to a single typed-array loop.

### 2. `where` keyword overload

Numbat already uses `where` for fn-body let bindings:

```
fn area(side: Length) -> Length^2 = a where a = side * side
```

ep adds a *filter* form:

```
sum(model.tonnage where grade > cutoff)
```

The parser disambiguates by what follows `where`:
- `where name = expr` (optionally `and name = expr`…) → fn-body form
- `where <expr>` (no `=`) → filter form

No new keyword. No grammar ambiguity (the two forms are disjoint by
lookahead). Documents as one feature with two contexts.

### 3. Masks

Column comparisons return Boolean lists:

```
model.grade > 2.5 g/cm^3        # → List<Bool>
model.depth < 500 m             # → List<Bool>
(model.grade > 2.5 g/cm^3) and (model.depth < 500 m)  # element-wise
```

These compose naturally in `where`:

```
sum(model.tonnage where (grade > 2.5 g/cm^3) and (depth < 500 m))
```

Mask construction itself is lazy — the comparison produces a view, not
a materialized boolean array. Reductions over a masked view walk the
source once.

Comparison operators on collections: `>`, `>=`, `<`, `<=`, `==`, `!=`.
Logical combinators on Bool masks: `and`, `or`, `not`.

### 4. Backticks for raw identifiers

Real-world data has columns named `Au g/t`, `drillhole id`,
`depth (m)`. Forcing a rename step at import is friction.

```
sum(model.`Au g/t` where `drillhole id` == "DH-001")
```

Backticks tokenize to an identifier token with the raw name. Lookup is
otherwise unchanged. Numbat doesn't currently use backticks for
anything else, so the syntax is free for us to claim.

Escaping inside backticks: TBD. Probably `` \` `` to literal-backtick;
or simpler, just forbid backticks inside identifier names.

### 5. Scope resolution in predicates

Inside a `where` predicate, identifiers resolve in two steps:

1. **Source columns first**: if the source has a column named `grade`,
   bare `grade` in the predicate is `<source>.grade` (a column view).
2. **Outer scope second**: otherwise resolve as a normal let-bound
   value in the surrounding scope.

```
let cutoff = 2.5 g/cm^3
sum(model.tonnage where grade > cutoff)
# `grade`  → model.grade (column view, per-cell)
# `cutoff` → outer scalar (broadcast against every cell)
```

**Shadowing**: if `cutoff` is *also* a column name in `model`, the
column wins. Initial policy: no way to force the outer reference. The
user renames one or the other. If this bites in practice, add `$cutoff`
as the explicit-outer form (chosen over `@cutoff` because `@` already
denotes decorators in ep/Numbat).

### 6. Numbat-compatible type system

The typechecker already handles `List<T>` schemes. The extensions land
as:

- New built-in fn schemes: `sum<D: Dim>(List<D>) -> D`, `mean<D: Dim>`,
  `max<D: Dim>`, `min<D: Dim>`, `std<D: Dim>`, `count<T>(List<T>) -> Scalar`.
- A new type kind `View<T>` (or treat as transparent `List<T>`) for
  views — the typechecker may not need to distinguish; the runtime
  does.
- Mask type: `List<Bool>`. Existing TList machinery handles it.
- Backtick-quoted identifiers: parser-level only; type-checker sees
  them as ordinary identifiers.

No HM-level changes. The dim solver and generalization stay as is.

## Examples

```
# Geological resource calculation against a block model.

@input
cutoff = 2.5 g/cm^3

@input
depth_limit = 500 m

let model = load_block_model("deposit.bm")
# model: BlockModel with columns {grade: Density, density: Density,
#                                 volume: Volume, depth: Length}

# Resource above cutoff, within depth limit:
@output(kt)
tonnage = sum(model.volume * model.density
              where (grade > cutoff) and (depth < depth_limit))

@output(kg)
metal = sum(model.volume * model.density * model.grade
            where (grade > cutoff) and (depth < depth_limit))

@output
grade_avg = metal / tonnage
```

```
# Drillhole sample analysis. Simple time-series-ish.

let samples = load_csv("assays.csv")
# columns: hole_id (String), from (Length), to (Length),
#          `Au g/t` (Density), `Cu pct` (Scalar)

# Composite stats by hole:
@output
n_samples = count(samples)

@output(g/t)
au_mean = mean(samples.`Au g/t`)

# Filter to a specific hole:
@input
@options(DH-001, DH-002, DH-003)
hole = DH-001

@output(g/t)
hole_au_mean = mean(samples.`Au g/t` where hole_id == hole)
```

```
# Mesh-flagged subset.

let model = load_block_model("deposit.bm")
let pit_shell = load_mesh("pit_v3.obj")

# Flag each cell as inside/outside the pit shell:
let pit_flag = flag(pit_shell, model)
# pit_flag: List<Bool> with one entry per model cell

@output(kt)
mineable_tonnage = sum(model.volume * model.density
                       where pit_flag and (grade > cutoff))
```

## Substrate that has to land first

The dataset layer above sits on top of substrate work that's
independently useful:

1. **List/array primitives** (`sum`, `mean`, `where`-via-`filter`, `map`)
   wired into the typed env. Schemes already supported by the typechecker.
2. **Async values in the reactive graph.** `load_block_model(url)`
   returns a promise; downstream bindings need to re-evaluate when it
   resolves; UI needs a "loading…" state per row. ep's evaluator is
   synchronous today — real architectural lift.
3. **AIR integration.** Lower the typed AST through AIR's `lowerJS`
   pipeline. Reductions over a million-cell view compile to a tight
   typed-array loop; slider drags stay interactive.
4. **File import.** Drag-drop or file-picker. Start with CSV, add VTK
   / .bm / OBJ as needed.
5. **Spatial primitives.** `flag(mesh, blockmodel)` wires
   `../auditable/ext/peel` and `../auditable/ext/winding`. Both return
   the same `{proportions, flags}` shape per block.
6. **Inline visualization.** Tiny canvas thumb per dataset binding —
   block model colored by selected column, mesh overlay. Three.js via
   `../auditable/ext/dee`. Strictly optional but it's where users go
   "oh."

Order: do 1-3 first. They're prerequisites and individually useful.
4-6 are the dataset-specific shell on top.

## Numbat divergence

Adds two syntactic forms not in upstream:

- `xs where <Bool-expr>` as a postfix filter
- Backtick-quoted identifiers

Both are upstream-compatible-in-spirit (no semantic conflict) but
require parser extensions. If we want to push them upstream, the
`where`-as-filter is the harder sell because upstream's `where` is
strictly fn-body let-binding sugar.

Decision: keep them as ep extensions, document the divergence in
SPEC.md → "Numbat compatibility status", don't worry about upstream
adoption.

## Open questions

- **Async view semantics**: does `let x = model where grade > cutoff`
  return a sync View (over an async-loaded model)? Or is the View
  itself async until the source loads? Probably: View is sync;
  reductions await the source if it's still loading.
- **Streaming results**: should reductions over partial data emit a
  preliminary value? E.g., a long load could stream `count` as cells
  arrive. Probably not for v1 — wait for full load.
- **Caching**: if a slider re-runs the same `sum(... where ...)` many
  times per second, do we cache by `(source-version, predicate-text)`?
  Likely yes once AIR is in place; the compiled loop is cached but
  results are re-run because the inputs (cutoff) change.
- **Mixed scalar/collection arithmetic**: `model.tonnage + 5 kg` —
  broadcast the scalar across the column? Per pandas convention, yes.
  Document explicitly.
- **Error semantics**: what does `mean(empty_view)` produce? `NaN`?
  An error row? Probably `NaN` quietly, but worth a deliberate choice.
- **Storage**: do we accept block models as Float32Array or do we
  introduce a `BlockModel` Quantity-like type? Probably the latter,
  wrapped over Float32Array internally.
- **Memory footprint warnings**: should ep warn when a binding holds
  ≥ N MB of data? Useful guardrail for the browser-tab scale.

## Status

Draft. Revisit when the calculator-shaped feature set is stable and
list-primitives (substrate #1) are in.
