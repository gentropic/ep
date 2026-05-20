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

---

# Phase 1 — eager dataset implementation spec

The full design above assumes laziness, AIR, and async values. Phase 1
delivers the **eager, synchronous subset** that's useful on its own and
ships without the architectural lifts. It covers calculator-scale data
— assay tables, sample sets, drillhole logs, small block models — up to
roughly 10⁵ rows, where materializing the whole table in memory is fine.

The eager substrate (substrate item 1) has already landed: comparison
broadcasting produces `List<Bool>` masks, `filter(mask, xs)` selects,
and `any`/`all`/`count` reduce. Phase 1 builds the dataset shell on top.

## Phase 1 scope

**In:** the `Dataset` value, column access, a CSV parser, `load_csv`
with embedded + file-referenced assets, the eager `where` clause, list
reductions (`sum`/`mean`/`std`), the attach UI, and dataset display.

**Out (deferred to Phase 2):** lazy views, streaming single-pass
reductions, async values during evaluation, AIR-compiled loops, spatial
primitives, block-model visualization.

## The seam that makes Phase 2 not-a-rewrite

`load_csv` returns an **opaque `Dataset` handle**, never a bare
`List<Struct>`. Every operation — column access, `where`, reductions —
goes through the handle. In Phase 1 the handle wraps an eagerly
materialized columnar store; in Phase 2 it can wrap a streaming source.
The surface API (`model.grade`, `model where …`, `sum(model.tonnage)`)
does not change between phases — only the handle's internals.

If `load_csv` returned a raw list, Phase 2 would be a breaking change.
With the handle, it's an internal swap.

## 1. The `Dataset` value

Runtime representation — a tagged, frozen object, **columnar**:

```js
{
  __dataset: true,
  schema:  [ { name: 'grade', type: <Type> }, … ],   // ordered
  columns: Map<string, Array>,    // name → typed value array
  length:  Number,                // row count
}
```

Columnar (not row-of-structs) because: column access is then O(1) — no
per-row projection; reductions iterate one contiguous array; it matches
the CSV's own shape; and it's the representation a Phase-2 streaming
backend would also expose column-wise.

At the **type level** a Dataset is `List<Struct{col: T, …}>` — the
typechecker already has `TList` and `TStruct`, and SPEC-DATASETS treats
collections as `List<T>` schemes. The struct's fields are synthesized
from the CSV header at runtime; see §7 for how the typechecker copes
with not knowing them statically.

Datasets are immutable like every ep value — `where` and projections
produce new Datasets / Lists, never mutate.

## 2. Column access

`dataset.grade` returns the `grade` column — a plain `List`. This reuses
field-access syntax; the evaluator dispatches on the object kind in the
`FieldAccess` case of `evalValueExpr`:

- **Dataset** → look up the column in `columns`; error
  `no column 'grade' in dataset (have: depth, density, …)` if absent.
- **`List<Struct>`** (a plain list of struct values, not a Dataset) →
  *broadcast* field access: map `.grade` over every element, returning
  the column. Same shape as the arithmetic/comparison broadcasting
  already shipped — keeps `someList.field` consistent whether the list
  came from `load_csv` or a struct literal.
- **single struct** → existing behavior (return the field).

Column access composes with everything already built: `model.grade * 2`
broadcasts, `sin(model.depth)` broadcasts, `plot(model.x, model.y)`
plots, `model.grade > cutoff` is a mask.

## 3. CSV parsing

A small RFC-4180-ish parser (~80 LOC, no library):

- Handles quoted fields, embedded commas / newlines inside quotes,
  CRLF and LF line endings.
- **Header unit suffix.** A header of the form `grade (g/t)` is split:
  column name `grade`, and the unit `g/t` is applied to that column's
  otherwise-bare-number cells. Without a suffix, a numeric column is
  dimensionless `Scalar` (the user can re-dimension later with
  broadcasting: `grade = model.grade * 1 g/t`).
- **Per-column type inference.** Sample the first N non-empty cells of
  each column: all parse as numbers → quantity column (dim from the
  header suffix, else Scalar); all `true`/`false` → Bool column; else
  String column.
- **Cells** parse as a number with an optional inline unit
  (`2.5`, `2.5 g/t`). Empty cells become a hole — see open questions on
  missing-value semantics; Phase 1 starting point: empty numeric cell →
  `NaN`-valued quantity, empty string → `""`.
- **Column names with spaces** (`Au g/t`, `drillhole id`) are kept
  verbatim and reached with backtick identifiers: ``model.`Au g/t` ``.
  Backtick tokenization is a small lexer addition (SPEC-DATASETS §4).

### Parse configuration — at attach time, not in code

Real CSVs vary: `;`-delimited European exports, leading metadata
preamble rows, `#`-commented lines, comma decimal separators. Pandas
puts these in `read_csv` keyword arguments because pandas is code-first
and re-run. ep is not — the data is an **attached asset**, and Numbat
has no keyword arguments, so `load_csv("name", ";", 3, "#")` would be
an unmemorable positional mess.

Instead, parsing is **configured at attach time**. The attach dialog
(§8) shows a live preview of the parsed table; ep auto-detects what it
can; the user eyeballs the preview and overrides anything wrong. The
config is stored as **asset metadata** — it travels with the program
(embedded or referenced), so the program stays fully reproducible. The
ep-script stays clean: `load_csv("deposit")`, no parsing arguments.

`parseConfig` fields (all per-asset):

| field | default | notes |
|---|---|---|
| `delimiter` | auto-sniffed | `,` `;` `\t` `\|` — pick the one giving consistent column counts across sample rows |
| `commentChar` | `#` | lines starting with it are dropped; can be disabled |
| `skipRows` | `0` | leading preamble lines to drop before the header. Hard to auto-detect; easy to set visually against the preview |
| `hasHeader` | `true` | off ⇒ columns become `col1, col2, …` |
| `decimal` | `.` | `.` vs `,`; auto-paired with the delimiter (a `;` delimiter ⇒ likely `,` decimal) |

A code-level escape hatch (a `load_csv` options-struct) can be added
later if a real need appears — YAGNI for Phase 1; the attach dialog
covers it.

## 4. `load_csv` + the asset model

A program gains an **asset table** — `name → AssetRef` — stored
alongside the program record in IndexedDB. An `AssetRef` has two halves
with **different lifetimes**:

- **Always persisted** — `parseConfig` (§3) plus the detected
  `schema` (ordered column names + inferred types) and `rowCount`.
  This half is small, lives in IDB with the program, and travels with
  exports.
- **The file payload** — persisted or not depending on kind (below).

Two kinds:

- **`embedded`** — `{ kind: 'embedded', text: <csv string>, parseConfig,
  schema, rowCount }`. The CSV text lives in the program. Survives
  reload, travels with `.ep` / `.html` exports, bloats the program
  file. Right for small reference tables you want the program to be
  self-contained around.
- **`file`** — a reference to a user-picked file, NOT copied into the
  program. `parseConfig` / `schema` / `rowCount` still persist; the
  file payload itself:
  - **Desktop (Chromium):** a `FileSystemFileHandle` from the File
    System Access API, structured-cloned into IndexedDB. On program
    load ep re-acquires it (`queryPermission` / `requestPermission`)
    and re-reads — so a desktop file reference *persists across
    reloads* without re-picking.
  - **Mobile / Firefox / Safari (no FSAA):** a session-only `File`
    from `<input type="file">`. The file payload is lost on reload —
    but the asset record (with its `parseConfig`, `schema`,
    `rowCount`) survives. ep flags the asset "needs re-attach"; when
    the user re-picks the file, ep **silently re-applies the
    remembered `parseConfig`** — zero reconfiguration. And because the
    `schema` is remembered, downstream `model.grade` references still
    typecheck and display sensibly *before* the re-pick, so the
    program doesn't light up red while waiting for the file.

`load_csv("name")` resolves the asset, parses it, returns a `Dataset`.
When a `file`-kind asset is in the "needs re-attach" state, `load_csv`
returns a **schema-only `Dataset` shell** (columns present and typed
from the remembered `schema`, zero rows) so downstream code stays
green; the row carries a non-fatal "re-attach 'name'" hint (§8).

**Caching.** Parsing happens once per program-load, keyed by asset name
+ a version counter, not per re-evaluation. Dragging a slider re-runs
the program but reuses the already-parsed `Dataset` — `load_csv` is a
cache lookup after the first eval.

## 4. `load_csv` + the asset model

A program gains an **asset table** — `name → AssetRef` — stored
alongside the program record in IndexedDB. Two kinds of `AssetRef`:

- **`embedded`** — `{ kind: 'embedded', text: <csv string> }`. The CSV
  text lives in the program. Survives reload, travels with `.ep` /
  `.html` exports, bloats the program file. Right for small reference
  tables you want the program to be self-contained around.
- **`file`** — a reference to a user-picked file, NOT copied into the
  program:
  - **Desktop (Chromium):** a `FileSystemFileHandle` from the File
    System Access API, structured-cloned into IndexedDB. On program
    load ep re-acquires it (`queryPermission` / `requestPermission`)
    and re-reads — so a desktop file reference *persists across
    reloads* without re-picking.
  - **Mobile / Firefox / Safari (no FSAA):** a session-only `File`
    from `<input type="file">`. The reference is lost on reload; ep
    shows a "re-attach 'name'" affordance. No persistence — but no
    file-size ceiling either.

`load_csv("name")` resolves the asset, parses it, returns a `Dataset`.

**Caching.** Parsing happens once per program-load, keyed by asset name
+ a version counter, not per re-evaluation. Dragging a slider re-runs
the program but reuses the already-parsed `Dataset` — `load_csv` is a
cache lookup after the first eval.

## 5. The `where` clause

Grammar — postfix filter: `<expr> where <bool-expr>`. Numbat already
uses `where` for fn-body let-bindings (`… = body where a = expr`); the
two disambiguate by lookahead — an `=` after the first identifier is
the fn-body form, otherwise it's the filter form (SPEC-DATASETS §2). No
new keyword.

- **Operand.** `dataset where <pred>` → a filtered `Dataset`.
  `column where <pred>` → a filtered `List`. Both walk once, build a
  mask, keep matching rows.
- **Predicate scope.** Inside the predicate, identifiers resolve
  **columns-first**: in `model where grade > cutoff`, `grade` is
  `model.grade` (a column), `cutoff` falls through to outer scope.
  Implemented by evaluating the predicate in a child env whose first
  lookup tier is the operand Dataset's columns. A column name that
  shadows an outer binding: the column wins (SPEC-DATASETS §5; the
  `$outer` escape hatch stays deferred).
- **Equivalence.** `sum((model where grade > cutoff).tonnage)` and
  `sum(model.tonnage where grade > cutoff)` produce the same result.
- **Eager** in Phase 1 — `where` materializes the filtered Dataset
  immediately. Phase 2 makes it a lazy view.
- **Precedence.** `where` binds looser than comparison/arithmetic and
  extends to the end of the enclosing expression / paren, so
  `sum(model.tonnage where grade > cutoff)` groups as
  `sum( (model.tonnage) where (grade > cutoff) )`.

## 6. List reductions

`where` and column access produce Lists; reductions collapse them to
scalars. Add native, dimension-aware:

- `sum<D>(List<D>) -> D`, `mean<D>(List<D>) -> D`, `std<D>(List<D>) -> D`.
- `min` / `max` already exist as 2-arg; add `List` overloads, or keep
  separate `minimum`/`maximum` list forms — decide at implementation.
- Row count is `len(dataset)`; `count` stays the mask reduction.
- **Empty input** throws `reduction over an empty list` rather than
  guessing a dimensioned zero (an empty `List<D>` carries no `D` to
  return).

These compose with everything: `mean(model.grade where depth < 500 m)`.

## 7. Typechecking

The CSV schema isn't known until the file is read at runtime, but the
typechecker runs *before* evaluation. So:

- `load_csv` is typed `(String) -> Dataset`, where `Dataset` is an
  opaque `List<Struct{}>` with **open / unknown fields**.
- Column access on a Dataset yields a fresh type variable — the
  typechecker does not verify column names statically.
- `where` on a Dataset → Dataset; the predicate is typed loosely.

No HM extensions. Phase 1 leans on the existing **"drop typecheck
errors when the runtime succeeds"** policy (the same policy that lets
broadcasting and `filter(mask, xs)` typecheck cleanly) — the runtime
owns column-name correctness and reports precise errors there.

## 8. UI — attaching CSVs

### The attach dialog

Opening any attach flow (see entry points below) brings up one dialog:

- **Live preview** of the parsed table — the first ~10 rows rendered
  with the current `parseConfig`.
- **Auto-detected** delimiter, comment char, decimal separator filled
  in; the preview reflects them immediately.
- **Manual overrides** for every `parseConfig` field (§3) — change one,
  the preview re-parses live so the user *sees* the result instead of
  guessing flags.
- **Embed vs reference** choice — *embed* copies the CSV text into the
  program (self-contained, travels with exports); *reference* keeps a
  file handle (desktop) or session `File` (mobile).
- **Asset name** — the key `load_csv("…")` resolves against.

On confirm, the `parseConfig` + detected `schema` + `rowCount` are
written to the asset record (always persisted; §4).

### Entry points

All four routes open the same dialog:

1. **Drag-drop.** `io.js` already accepts `.ep` files; extend it to
   `.csv`.
2. **File-picker button** for mobile, where drag-drop isn't practical —
   a plain `<input type="file" accept=".csv">`.
3. **Inline editor affordance.** When a binding line is
   `model = load_csv("deposit")`, an end-of-line widget — the same
   mechanism as the `+Length?` annotation-suggestion buttons (`suggest`
   kind in the widget system) — tracks the asset state:
   - no asset yet → `attach…`
   - `file`-kind, unloaded (mobile post-reload, or revoked permission)
     → `⚠ re-attach`
   - loaded → a quiet `deposit · 1,240×5` info chip; click to change.
4. **`@input` chip as a file-picker.** When a `load_csv` binding also
   carries `@input`, its chip *is* the file picker / drop zone rather
   than a text field. This is the strong case for **exported forms**:
   a recipient opens your `.html` calculator, the input chip says
   "drop your assay CSV here", they do, and the outputs compute against
   *their* data. The program becomes a reusable analysis, not a
   one-off — a genuinely new shape for ep forms, falling out of the
   asset model for free. `makeChipControl` gains a file-picker control
   variant for the case where an `@input` binding's expression is a
   `load_csv(...)` call.

### Missing-asset feedback

`load_csv("x")` with no asset `x` → the inline affordance (#3) shows
`attach…` and the row carries a non-fatal hint rather than a hard
error. A `file`-kind asset whose payload is gone after reload → the
`⚠ re-attach` state; `load_csv` returns the schema-only shell (§4) so
downstream rows stay green until the file is re-picked.

### Assets list

An **assets list** so the user can see / rename / drop / re-embed
attached files, and see each one's "loaded / needs re-attach" state.
Candidate home: a fourth drawer mode (`data`) alongside `programs` /
`history` / `docs`, or a small panel — decide at implementation.

## 9. Dataset display

- A Dataset-valued binding shows a compact summary in the gutter:
  `1,240 × 5` (rows × columns).
- An optional inline preview widget — first ~5 rows as a table —
  rendered like the plot block widget. Nice-to-have; the summary alone
  is acceptable for the first cut.
- Column reductions and `plot(model.x, model.y)` render through the
  existing result / plot paths — no new display work.

## 10. Export interaction

- `.ep` / `.html` exports carry **embedded** assets inline — the
  program stays self-contained.
- **File-referenced** assets do NOT travel. An export carries the
  reference name only; opening it prompts to attach. The export dialog
  should say so ("3 referenced datasets won't be included — embed them
  to share") and, since embedding a large CSV bloats the export, show
  the resulting size.

## 11. Phase 2 seam (set up now, built later)

- The `Dataset` handle is the abstraction Phase 2 swaps. Reductions and
  `where` already route through it.
- **Lazy opt-in.** Numbat has no keyword arguments, so the lazy variant
  is likely a separate function — `stream_csv("name")` returning a
  lazy-backed `Dataset` — rather than a `load_csv` flag. The reactive
  caveat: a streamed source can't be re-walked on every slider drag, so
  `stream_csv` only pays off once `where` + reductions are lazy and
  fuse into a single pass. Exact surface decided in Phase 2.
- **Persistence asymmetry stays.** Desktop FSAA handles already
  persist; mobile session-`File`s already don't. Phase 2 changes how
  the file is *consumed* (stream vs. materialize), not how it's
  *referenced*.

## Phase 1 implementation order

1. **Field-access broadcasting** — `List<Struct>.field` → column.
   Small, independently testable.
2. **`Dataset` value** — columnar representation, column access,
   construction from an inline source for tests.
3. **CSV parser** — quoting, header units, per-column type inference.
4. **Asset model** — IDB storage of the split-lifetime `AssetRef`
   (always-persisted `parseConfig` / `schema` / `rowCount` vs. the
   file payload), `load_csv` resolution incl. the schema-only shell
   for the needs-re-attach state. Embedded assets first, then file
   references (desktop FSAA handle, then mobile session File).
5. **`where` clause** — parser disambiguation + columns-first predicate
   scope + eager filtering.
6. **List reductions** — `sum` / `mean` / `std`, empty-input handling.
7. **Attach UI** — the attach dialog (live preview + auto-detect +
   manual `parseConfig` overrides), its four entry points (drag-drop,
   file-picker, inline `load_csv` affordance, `@input` chip
   file-picker), missing/re-attach feedback, the assets list.
8. **Display + export** — gutter summary, export embed/reference rules.

Steps 1-3 are pure language/runtime work with no UI or storage
dependency — they can land and be tested first. 4 and 7 bring in
storage + DOM. 5-6 are language work that can interleave. Within 7,
the attach dialog + drag-drop + file-picker are the core; the inline
affordance and `@input`-chip file-picker can follow as polish.

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
- ~~**Mixed scalar/collection arithmetic**~~ — *resolved.* Scalar ⊕
  collection broadcasts the scalar across the column; shipped as part
  of the eager broadcasting substrate.
- ~~**Error semantics**: what does `mean(empty)` produce?~~ —
  *resolved for Phase 1.* Reductions over an empty list **throw**
  (`reduction over an empty list`) rather than returning a guessed
  dimensioned zero / `NaN` — an empty `List<D>` carries no `D`.
- **Storage**: do we accept block models as Float32Array or do we
  introduce a `BlockModel` Quantity-like type? Probably the latter,
  wrapped over Float32Array internally. (Phase 2.)
- **Memory footprint warnings**: should ep warn when a binding holds
  ≥ N MB of data? Useful guardrail for the browser-tab scale.
- **Missing-value semantics**: Phase 1 starts with empty numeric cell →
  `NaN`-valued quantity. Whether reductions skip `NaN`s or propagate
  them needs a deliberate choice before Phase 1 ships.

## Status

Draft. The high-level design stands; **Phase 1 (eager dataset
implementation)** is specced in detail above and ready to build —
substrate #1 (list primitives, broadcasting, masks) has landed.
Phases 2+ (lazy views, streaming, AIR) remain design-level.
