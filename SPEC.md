# ep — design spec

`ep` is a single-file browser-native calculator that turns one-off calculations into shareable parameterized forms. It's part of the GCU stack — sibling in spirit to `calque`, `dee`, `gcu-press`, `plan`, `rv` (which live in the `auditable` repo) — but ships standalone from its own repo at `gentropic.org/ep`.

The language ep-script is **Numbat-shaped** — syntax inspired by [Numbat](https://github.com/sharkdp/numbat) (David Peter, MIT) — with deliberate simplifications and three form-builder decorators (`@input`, `@output`, `@options`) original to ep.

**Status:** 0.2 shipped. The full Phase 1–3 plan landed (source-split build, CM6 editor, numbat-js evaluator co-located under `ext/numbat/`, multi-program persistence, sharing, examples, scenarios, viewer-only export), plus the v0.2 syntax migration to decorator form (`@input`/`@output`/`@options`), a token-based parser, an idempotent formatter with width-aware breaking, `@gcu/pointer` adoption for the sharing layer, IndexedDB backend for programs and snapshots, snapshots/history (§7.4), PWA wiring (manifest + icons + service worker), a full HM-style dimension-aware typechecker under `ext/numbat/src/typecheck/`, inline-block error/info widgets with bidirectional blame walking, and shape-distinct gutter markers. Sections below are annotated with **Shipped** / **Future** where useful.

A separate forward-looking design doc — [`SPEC-DATASETS.md`](./SPEC-DATASETS.md) — covers the planned lazy-collections / block-model extension. That work is not implemented; the core SPEC (this document) covers what's in the artifact today.

**Working artifact:** `index.html` at the repo root is the deployed program (~1.45 MB single file — most of that is the inlined CM6, numbat-js, and the embedded viewer template). Built by `build.js` from `src/` and `ext/`. Read alongside this doc; when it disagrees with the doc, the code wins. The Enhancements roadmap section at the bottom remains the primary source for design rationale on individual features.

---

## What ep is, what it isn't

ep is in **CalcNote / Soulver** territory — a notepad calculator where you type math and see results inline — with two pieces of differentiation neither competitor has:

1. **Dimensional analysis on geological units.** `1.5 g/t * 100 Mt → 150 t` works. So does sieve mesh, density, grade in any expression of ppm/ppb/g/t/oz/lt. Catches `length + mass` as a dimension mismatch.

2. **Programs are shareable single-file forms.** A program with `@input` and `@output` decorators exports as a standalone HTML file your colleague can open, fill in different inputs, and read the results — no server, no install, no auth, no infrastructure. Same auditable single-file ethos as the rest of the GCU stack.

ep is *not*:
- A scientific calculator in the HP-15C sense (no stack mode, no RPN — the keypad mock is in `prior-art/ep-mock-rpn.html` for reference but was retired)
- A spreadsheet (that's calque)
- A general-purpose programming language (no mutation, no I/O, no async, no classes)
- A symbolic CAS (no algebra, no equation solving — those are different tools)

---

## Two views, one source

The same program has three presentations:

**Designer view.** What the program author sees. CodeMirror 6 editor body shows the full source with syntax highlighting. Chips above for `@input`-tagged bindings; chips below for `@output`-tagged bindings, each with copy buttons. Right-side gutter shows per-line results aligned to source lines. Accessory bar of tokens/units sits at the bottom.

**Form view.** What a consumer of the program sees inside the designer. Same artifact, but the editor body is hidden behind a "show calculation" toggle. Big chips top and bottom. Accessory bar hidden. Toggled via the `form / editor` button in the header.

**Viewer artifact.** The `.html` export is a separate, slimmer artifact (~340 KB vs ~1.45 MB for the designer) built from `src/viewer-template.html`. It includes only the chip rendering pipeline + numbat-js evaluator + the `@gcu/pointer` encoder — no CM6, no drawer, no share-link generation, no editor toggle. The viewer scopes its own polish under `.app.viewer`: program description as a header subtitle (drawn from the first comment line), prominent outputs panel (accent border + larger value font), single-column chip grid on narrow screens, and a footer with attribution + a "modify this calculation" link that round-trips the entire program back into the full editor as a `@gcu/pointer`. The source is locked behind a "show calculation" reveal that's read-only and fills the bottom of the viewport when shown. Exporters can opt out of the modify-link via a checkbox in the export dialog.

---

## Syntax

### Lexical

- Comments: `#` to end of line, `--` accepted as alias. Inline allowed (`x = 5 m  # depth`).
- Statement separator: newline.
- Identifiers: `[a-zA-Z_][a-zA-Z0-9_]*`.
- Whitespace within a statement is insignificant.

### Top-level forms

| form | example |
|---|---|
| binding | `volume = length * width * thickness` |
| typed binding | `density : Density = 2.7 g/cm3` |
| `let` binding | `let volume = length * width * thickness` (alias for bare binding) |
| anonymous expression | `area * 2` (shows result; doesn't bind) |
| comment | `# explanation` or `-- explanation` |
| `fn` declaration | `fn compound(p, r, n) = p * (1 + r)^n` |
| `if`/`then`/`else` | `kicker = if future > threshold then 0.05 * future else 0` (expression-level) |
| `dimension` decl | `dimension Frequency = 1 / Time` |
| `unit` decl | `unit hertz: Frequency = 1 / second` |
| `@input` (decorator) | tags the next binding as an input chip in the top panel |
| `@output[(unit)]` (decorator) | tags the next binding as an output chip; optional unit override |
| `@options(a, b, c)` (decorator) | renders the next binding's chip as a `<select>` with the given options |
| `@range(min, max[, step])` (decorator) | renders the next binding's chip as a numeric slider over the given range |

Multi-line `fn` bodies, `struct` declarations, `where` clauses across multiple lines, and `use module::path` aren't supported at the line classifier level yet. `where` clauses on single-line `fn` definitions work.

### Expressions

Infix arithmetic with standard precedence:

| precedence | operators | associativity |
|---|---|---|
| 1 (highest) | `^`, `**`, `²` `³` (unicode exponents) | right |
| 2 | `*` `×` `·`, `/` `÷` | left |
| 3 | `+`, `-` `−` | left |
| 4 | `==`, `!=`, `<`, `<=`, `>`, `>=` (comparison) | left |
| 5 | `&&`, `\|\|` (logical), `and`, `or` | left |
| 6 (lowest) | `->` / `to` / `→` (unit conversion) | left |

Unary minus, unary `!` (logical not), parens. Function calls `f(arg)`. Postfix `n!` (factorial). Pipe `x \|> f`. Constants `pi`, `e`, `tau`, … Number literals: integer, decimal, scientific (`1.5e-3`), underscore separators (`12_345`).

Comparison and logical operators produce `Bool`; when an operand is a list they broadcast element-wise to `List<Bool>` (see "Lists, broadcasting, and masks" below).

### Quantities

The load-bearing primitive. Two ways to write them:

```
200         # dimensionless 200
200 m       # length, 200 meters
2.7 g/cm3   # density
1.5 g/t     # grade (mass fraction, dimensionless)
1e6 ppb     # 1ppm
```

Internally, every value is a `Q` — a quantity with a value in canonical units (g, m, rad, …) and a dimension signature (sparse map `{mass: 1, length: -2}` etc.). Source-level, users never write `Q` directly; it's the runtime representation.

Operations combine dimensions; mismatch is a runtime error with a precise trace. Display auto-scales (`216,000,000,000 g` → `216 kt`).

### Optional dimension annotations

Annotations are **optional and gradual**. Where present, they assert the inferred dimension matches; mismatch produces a binding-level error. Where absent, the dimension is inferred silently.

```ep
density   : Density            = 2.7 g/cm3   # annotated
volume                         = length * width * thickness   # inferred
velocity  : Length / Time      = 60 km / 2 h   # complex dimension
```

Recognized dimension names: `Scalar`, `Length`, `Mass`, `Time`, `Angle`, `Area`, `Volume`, `Density`, `Velocity`, `Acceleration`, `Force`. Composable with `*`, `/`, `^ <integer>`.

**Design intent:** ep is for calculator-shaped problems where most users won't bother with annotations. Annotations exist for the cases where a working geologist wants to assert "this should be a density" to catch typos in a long form. TypeScript-style gradual typing for dimensions.

### Unit conversion (`->` / `to`)

```ep
metal_oz = metal -> ozt    # display in troy ounces
3 km to mm                 # 3,000,000 mm
60 km/h → m/s              # unicode arrow accepted
```

`expr -> unit` asserts dimension compatibility (raises an error otherwise) and tags the result with a preferred display unit. Internally the canonical value is unchanged; the formatter honors the display tag instead of auto-scaling.

Arithmetic on a `->` -tagged value does NOT propagate the display tag — once you do further math, the result auto-scales again.

### Lists, broadcasting, and masks (ep extension)

Lists are written `[a, b, c]`; all elements share a type (and dimension, for quantities). Upstream Numbat has `List<T>` and a recursive `core::lists` prelude; ep extends that surface for the calculator / dataset lane:

- **Native list ops.** `map`, `map2`, `filter`, `foldl`, `concat`, `take`, `drop`, `reverse`, `element_at`, `range`, plus primitives `head`/`tail`/`cons`/`len`/`is_empty`. ep ships iterative native implementations that shadow the recursive `core::lists` defs — Numbat has no loops, so the upstream versions recurse, and a tree-walking interpreter overflows the stack on lists of a few thousand elements.
- **List builders.** `linspace(a, b, n)` (unit-preserving), `arange(a, b, step?)`, `zeros(n)`, `ones(n)`, `random_list(n)`.
- **Arithmetic broadcasting.** `*`, `/`, `+`, `-`, `^`, unary `-`, and the built-in 1-arg numeric fns (`sin`, `sqrt`, `ln`, …) broadcast element-wise — `xs * 2`, `sin(xs)`, `xs + ys`. List ⊕ List requires equal length; List ⊕ Scalar broadcasts the scalar. Dimensions still apply per element.
- **Comparison broadcasting + masks.** `>`, `<`, `>=`, `<=` and list-vs-scalar `==`/`!=` broadcast to `List<Bool>`. List-vs-list `==`/`!=` stays structural (single `Bool`) so `is_empty(xs) = xs == []` and similar keep working. `&&`/`||`/`!` broadcast over `List<Bool>`.
- **Mask filtering + reductions.** `filter(mask, xs)` keeps elements where the mask is true (the predicate-function form `filter(fn, xs)` also still works — overloaded on the first arg's type). `any(mask)` / `all(mask)` (short-circuiting) and `count(mask)` reduce a `List<Bool>`.

Broadcasting and masks are the substrate for the planned dataset / `where`-clause layer — see `SPEC-DATASETS.md`. The runtime is eager; lazy views land with that work.

### Lambdas (ep extension)

Arrow-function literals: `x => body` for one parameter, `(x, y) => body` for several. Parameters may carry type annotations. Used as first-class arguments to higher-order fns (`filter(x => x > 0, xs)`). Upstream Numbat has no lambda syntax yet; ep adds them as a small parser extension and will adopt upstream's form if/when it lands.

### Plots (ep extension)

`plot`, `scatter`, `bar_chart`, and `hist` render a canvas chart inline below the calling line. Trailing string args are optional x-label / y-label / title. A plot bound to an `@output` also surfaces as a compact, chrome-free thumbnail in the outputs panel — tap to enlarge, long-press to jump to the source row.

### Decorators — `@input`, `@output`, `@options`, `@range`

ep extends numbat-script with four decorators that adorn the binding on the line *below* them. They're real numbat-grammar decorators (`@<name>` or `@<name>(<args>)`) — unknown to upstream numbat at semantic-time but parsed cleanly there, so programs using ep decorators round-trip through pure numbat without errors. See "Numbat compatibility status" below.

```ep
# Drill core sample

@input
core_size = NQ_core

@input
length = 5 m

@input
@options(granite, basalt, sandstone, limestone)
rock_type = granite

@output(L)
volume = cylinder_volume(core_size, length)

@output(kg)
mass = sample_mass(core_size, length, density)
```

**`@input`** — the binding shows up in the top chip panel as a user-editable input. Editing the chip writes through to the source line, preserving the prefix up to `=` (annotation and indentation survive). Editing the source live-updates the chip. When a param changes (in either place), all bindings transitively depending on it re-evaluate.

**`@output[(unit)]`** — the binding shows up in the bottom chip panel with a copy button. The optional argument is a display-unit override (resolved as a Numbat expression, so compound forms like `ft^3`, `kg/m^2`, `km/h` work without pre-registered aliases). Without an argument, the auto-scale formatter picks the unit.

**`@options(a, b, c, …)`** — the binding's chip renders as a `<select>` with exactly those options. Useful for enum-style tags (`rock_type = granite`) where the value is a label, not a numeric quantity. When `@options` is present and the value is a bare label rather than a numbat-resolvable expression, ep skips evaluation entirely (no "unknown identifier" noise). Implies `@input` semantics for chip rendering even without an explicit `@input` line.

**`@range(min, max[, step])`** — the binding's chip renders as a numeric slider over `[min, max]`, with an optional `step` (defaults to a continuous range). For numeric inputs the user wants to sweep — cutoff grades, rates — rather than type. Implies `@input` chip rendering.

Decorators stack — `@input` + `@output(km)` on the same binding makes it both an input chip and an output chip (e.g. for round-tripping unit conversions). Blank lines and `#` comments between a decorator and its target binding are tolerated.

Programs with no `@input`-tagged bindings don't show a top chip panel; programs with no `@output` don't show a bottom panel.

### `@params { … }` and `@outputs { … }` blocks — removed (v0.1 only)

Earlier versions used `@params { … }` and `@outputs { … }` block syntax. v0.2 dropped both in favor of the decorator form above. The old block form is no longer recognized — programs in that style won't parse.

---

## Semantics

### Bindings

Bindings are **immutable**: re-binding the same name is a syntax error, not a re-assignment.

```ep
radius = 5 m
radius = 6 m       # ERROR: duplicate binding 'radius'
```

Bindings are visible to all subsequent statements in source order.

### Scope

Single global scope at the program level. `fn` parameters and any `let` bindings inside an `fn` body form local scopes (numbat-js handles this).

### Reactivity / evaluation order

ep evaluates the program top-to-bottom: each line resolves against the bindings defined above it. There's no topological sort or DAG analysis — on any edit, the whole program re-runs. With the numbat-js tree-walker this stays cheap at calculator scale.

A real incremental DAG (re-evaluate only the transitive downstream set of a changed binding) is in the Performance section below; not built and not gating any current use case.

### Errors

All errors carry line and column. Four categories:

**Parse errors** — bad syntax. Reported at the offending token.

**Name errors** — referenced binding doesn't exist, forward-referenced (cycle), or referenced output name has no binding. Surfaced with a Levenshtein-based did-you-mean suggestion when a similar name is in scope (`unknown identifier 'denisty' — did you mean 'density'?`).

**Type / dimension errors** — caught by the HM-style typechecker (`ext/numbat/src/typecheck/`) at pre-evaluation. Includes generic-instantiation failures, free-var consistency violations across a fn body, dim mismatches in arithmetic, conversion to incompatible dimension, annotation mismatch:

```
density : Density = 2.7 g
  annotated Density but got [mass]
```

**`@output` mismatch with blame** — when an `@output(unit)` decorator's dimension disagrees with the value's dimension, the blame walker (`src/js/blame.js`) traces back through the expression and names the most likely culprit input (`'thickness' has [time] but the chain needs [length]`). The blamed binding's gutter gets an amber square marker. See §4.2.

Errors halt evaluation of the affected binding but don't crash the script. Independent bindings continue evaluating. The errored row shows its error in an inline block widget below the source line (red for errors, amber for warnings, neutral gray for `print()` info), with the offending token underlined in red. See §4.2 for the full surfacing model.

---

## Behavior

### Two-way chip ↔ source sync

The body source is the single source of truth. Chip panels are views.

- Editing a chip → updates `state.body[N].src` for the corresponding line → re-evaluates → re-renders the body row in-place.
- Editing a body line of an `@input`-tagged binding → re-evaluates → re-renders chips.
- Adding a new `@input` + binding pair → a new chip appears.
- Removing a line → its chip disappears.

### Collapsible blocks

No ep-specific folding yet — the old `@params { }` block fold was removed with the v0.2 decorator migration. A future enhancement could group consecutive `@input`-tagged bindings into a foldable section.

### Export

Four outputs from the export dialog:

- **`.ep` source** — plain text of `state.body`. Round-trips back through `open` / drag-drop without loss.
- **`.html` viewer** — a slim purpose-built artifact built from `src/viewer-template.html` (~280 KB). Only includes numbat-js + chip rendering + a read-only "show calculation" reveal. No CM6 editor, no drawer, no share, no export buttons. Locked to form view. The state markers (`/* MARKER:STATE_START */` / `/* MARKER:STATE_END */`) preserve the substitution contract; the viewer template lives embedded in ep's main bundle as a `const VIEWER_HTML = "…"` string so export is single-pass with no extra fetches.
- **`🔗 link`** — `?p=<base64url-encoded(deflate-raw(source))>` URL on the current origin. Uses native `CompressionStream` (no vendored compression lib). Copies to clipboard or routes through `navigator.share` on mobile.
- **`📷 QR`** — inline SVG QR code for the same URL, rendered by the vendored encoder under `ext/qrcode/`. Implements ISO/IEC 18004 Model 2, all 40 versions, ECC L/M/Q/H.

The `.html` viewer is the killer feature. The pitch: *you wrote a calculation once; now your colleague opens it as a form they can drive but can't accidentally re-author. The math is verifiable but the surface is locked.*

### Import / load

Three input paths, all feeding the same `loadProgramText(text, sourceName)`:

- **File picker** behind the `open` header button (accepts `.ep`, `text/plain`).
- **Drag-and-drop** anywhere on the window. A Switchboard-orange overlay appears during the drag with "DROP .EP FILE / to load it into the editor". Release to load.
- **(future)** clipboard paste — not implemented; conflicts with chip-paste UX, needs a deliberate gesture.

Load wholesale-replaces `state.body`, discards stale collapse state, re-evaluates, and updates the header filename (extension stripped).

The chip ↔ source sync also recovers from mid-edit malformed states: if the user briefly empties a chip (so the underlying line momentarily fails the binding regex), the evaluator's `@input` recovery branch keeps the param bound with an `empty expression` error rather than dropping it. Once the user types a valid value, the chip flows through cleanly.

---

## Relationship to Numbat

Numbat is the upstream syntactic reference. ep-script adopts:

- `#` comments (also `--`)
- `_` digit separators (`12_345`)
- `->` / `to` / `→` for unit conversion
- Unicode operators as alternates (`×`, `÷`, `²`, `³`, `π`)
- Quantity literal style (`1.5 g/t`, `200 m`)
- Optional `:` type annotations
- Dimension naming conventions (`Length`, `Mass`, etc.)

ep-script supports (via the co-located numbat-js evaluator):

- Bare `name = expr` bindings, plus optional `let` keyword (same shape).
- `fn name(args) [: ReturnType] = body [where … = …]` — single-line.
- `if cond then a else b` at the expression level.
- `dimension Name = expr` and `unit name [: Dim] = expr` declarations.
- Generics on `fn` (e.g., `fn my_sqrt<T: Dim>(q: T^2) -> T = q^(1/2)`) — numbat-js handles solving generics by free-abelian-group unification. ep classifies the line and hands it to numbat-js.
- Numbat's full library of math/transcendental functions, plus all the vendored modules under `ext/numbat/vendor/numbat/modules/` available via `use module::path` once the line classifier learns it.

ep-script still diverges on:

- **Multi-line `fn` bodies** — the line classifier only recognizes single-line `fn name(args) = body`. Multi-line bodies (`fn foo(x) =\n  long\n  expression`) aren't classified yet.
- **`struct` declarations** — not classified at the line level; would need block-aware parsing.
- **`use module::path`** — classified but not yet wired to the host's module registry. The host has all 62 upstream modules vendored; surfacing them needs a host-side `registerModule` call when `use` is seen.
- **Added decorators:** `@input`, `@output[(unit)]`, `@options(…)` — ep's form-builder differentiation, applied per-binding. These are grammatically real numbat decorators (numbat's parser accepts any `@name`/`@name(args)`); numbat would ignore them at semantic time, so a program using them still parses upstream cleanly. See "Numbat compatibility status" below.

A program written in ep round-trips through Numbat without modification — the decorators are just attached to `let`-shaped declarations and numbat ignores unknown decorator names. Full feature compatibility is the de-facto outcome of the numbat-js migration; remaining gaps (multi-line blocks, struct decls, module imports) are line-classifier ergonomics, not evaluator gaps.

### Numbat compatibility status

ep-script's three form-builder decorators (`@input`, `@output[(unit)]`, `@options(…)`) use real numbat decorator grammar — `@<name>` or `@<name>(<arg>, …)`, adorning the next declaration. Numbat's parser accepts arbitrary decorator names (only specific ones like `@aliases`, `@metric_prefixes` get acted on at semantic time); unknown decorators are kept on the AST node and otherwise ignored.

**Consequence:** an ep program runs through pure numbat without parse errors. The decorators get attached to `let`-shaped declarations; numbat ignores them at semantic time. ep does the form-rendering work on top.

**History (v0.1 → v0.2 migration).** Earlier versions used `@params { … }` and `@outputs { … }` block syntax, which abused the `@` token: numbat's `@` is decorator-only, never followed by `{ }`, so `@params {` would error at parse time in upstream numbat. v0.2 switched to per-binding decorators (real numbat grammar) and dropped the old block form entirely. The `# options: a, b, c` comment-annotation hack from v0.1 was also dropped in favor of the proper `@options(a, b, c)` decorator.

### Originator courtesy

ep and this spec are derivative-by-syntax of Numbat. The implementation is original (no Numbat code ported). Under the principle that **license-permission is not social-permission**, before publishing ep publicly we should open a courtesy issue or discussion on the Numbat repo describing what we're doing — not asking permission (MIT covers it) but giving the maintainer awareness and a chance to weigh in or object.

README must credit Numbat prominently in its first paragraph. Suggested wording:

> ep-script is a JavaScript implementation of a calculator-shaped subset of [Numbat](https://github.com/sharkdp/numbat) (David Peter, MIT), extended with form-builder decorators (`@input`, `@output`, `@options`) original to ep. Decorators use real Numbat decorator grammar, so ep programs round-trip through Numbat unchanged.

---

## Implementation status

The Phase 1–3 plan from earlier versions of this doc has all landed:

- **Source split + build script** — `src/template.html`, `src/style.css`, `src/js/*.js`, plus a second `src/viewer-template.html` for the export artifact. Zero-deps `build.js` at the repo root concatenates them into `index.html`. Two vendor builds run as prerequisites (`ext/numbat/build.js`, `ext/qrcode/build.js`) and a third (`ext/cm6/build.js`) produces the CM6 bundle from npm-installed sources on demand. `node_modules/` is gitignored under `ext/cm6/`; the prebuilt `cm6.min.js` is committed.
- **CodeMirror 6 editor** — vendored from auditable's pattern, ~597 KB IIFE bundle. Syntax highlighting via a StreamLanguage for ep-script (comments, `@decorators`, keywords, type names, constants, operators). Bracket matching + auto-close. `EditorView.lineWrapping` so long lines don't trigger horizontal scroll.
- **numbat-js** — full port under `ext/numbat/`, drives expression evaluation. All 62 upstream Numbat modules vendored as strings; the full test corpus passes (typecheck + integration + conformance + upstream-port + broadcasting = 770 tests at the ep level, plus the per-module suites under `ext/numbat/test/`). ep's own evaluator (`src/js/evaluator.js`, ~900 LOC) classifies each row, drives the per-statement typecheck via `typecheckStatement`, evaluates the runtime, integrates the blame walker for `@output` mismatches, and routes `print()` output to per-row info widgets.
- **Language extensions** — beyond the upstream Numbat surface, ep adds: arrow-function lambdas, arithmetic + comparison + logical broadcasting over lists, mask filtering (`filter(mask, xs)`), the `any`/`all`/`count` mask reductions, native iterative list ops shadowing the recursive `core::lists` prelude, list builders (`linspace`/`arange`/`zeros`/`ones`/`random_list`), and inline plotting (`plot`/`scatter`/`bar_chart`/`hist`). All are designed to round-trip through, or extend cleanly past, upstream Numbat — see "Lists, broadcasting, and masks" and "Lambdas" in the Syntax section.
- **In-editor + in-app docs** — signature help, hover docs, autocomplete info panels (all fed by `src/js/docs.js`), and a drawer `docs` mode with searchable guides + function reference (`src/js/guides.js`). See §4.4–§4.5.

- **Static typechecker** — full HM-style dimension-aware checker under `ext/numbat/src/typecheck/` (12 files, ~2,150 LOC). Handles type variables (`TVar`) and dimension variables (`TDimVar`) separately, with rational-exponent dim arithmetic (`rat.js` for normalized `Rat`), unrestricted generics with proper let-generalization, polymorphic zero, IsDType promotion of type variables to dim variables on demand, and free-var consistency checks across function bodies. Errors include Levenshtein did-you-mean for unknown names, context strings (`in the argument of fn foo`), and a snippet builder that points at the offending token. ~102 upstream tests ported from `numbat`'s `type_checking.rs` and parts of `type_inference.rs`. Every ep row runs through `typecheckStatement` before evaluation; type errors surface through the same inline-block path as runtime errors (see §4.2).

Things deferred to "when use cases pull":

- **Incremental DAG reactivity** — see Performance section below.
- **`iter` / `solve` / `root` / `integrate` primitives** — numbat-js doesn't have these upstream; would need to add. Out of scope until calculator-scale programs hit walls.
- **Dataset-shaped values** — lazy collections, block models. Designed in `SPEC-DATASETS.md`. The eager substrate has landed: comparison broadcasting produces `List<Bool>` masks, `filter(mask, xs)` selects, and `any`/`all`/`count` reduce. Still open: the `where`-clause filter syntax, backtick column names, struct-typed lists with `model.column` projection, lazy view chains, async-loaded sources (CSV / block-model import), and AIR-compiled reductions. The typechecker's `TList` and `TStruct` already support the type-level shape.

---

## Performance future

For the form-builder use case, the mock's tree-walker is already fast enough. The optimizations matter when:

- Programs grow past ~50 bindings (real Vale-shaped use cases)
- Exported forms get embedded with live data feeds (auto-recompute on streaming inputs)

Worth building when the need is real, not before:

1. **Two-tier IR.** Cold path stays tree-walker; hot bindings compile to specialized closures with dimensions erased, just raw float ops. V8 monomorphizes hard from there.

2. **Incremental DAG reactivity.** Track which bindings depend on which. On `@input` change, re-evaluate only the transitive downstream set, not the whole program. Probably 10-50× speedup for typical edit-and-watch use.

3. **Dimension-erase after inference.** Once inference proves a chain dimensionally consistent, runtime values become plain numbers; dimension info lives alongside binding metadata, not in every `Q`. Eliminates per-op allocation.

4. **Constant folding at parse time.** `1 ozt`, `60 * 60 s`, `pi * 2` — known at parse time, fold to single literals.

5. **Specialized power.** `r^2 → r * r`, `r^3 → r * r * r`. Trivial; useful.

6. **Display-string caching.** Auto-scale + format runs on every render of every chip. Cache the formatted string per-binding-version; invalidate on value change only.

**AIR backend.** Once `numbat-js` lands under `ext/numbat/` (or even before, via direct lowering from ep's parser), the ep evaluator can lower to AIR for WASM emission. AIR itself is an auditable dependency — would be vendored under `ext/air/` here if pursued. The honest framing: AIR + reactive DAG can plausibly beat Numbat-on-Rust on workloads where the work is "re-evaluate this DAG 10/sec for 20 minutes" — not because JS beats Rust, but because compiler-style specialization plus incremental DAG re-eval matches the workload better than a bytecode VM running a whole program from scratch each time.

This is future work, not gating. Calculator-scale performance is fine without any of it.

---

## Out of scope (explicitly, to prevent drift)

The following are deliberately not in ep, ever:

- I/O of any kind beyond load/save (no `read`, `write`, `fetch`, network)
- Async, promises, generators
- Mutation
- Pattern matching, destructuring
- Macros, metaprogramming
- Multiple return values (return a list when lists land)
- Currency rates (network dependency, breaks offline-by-default ethos)
- Date/time math (different problem; defer to a sibling tool if needed)
- Symbolic math / CAS (different tool entirely)
- Stack mode / RPN (retired during design; see `prior-art/ep-mock-rpn.html`)

If a feature here turns out to be load-bearing, that's a signal ep isn't the right tool — reach for auditable or build a sibling.

---

## Open questions

What's still genuinely undecided. Items answered by the implementation have been removed; see the Enhancements roadmap below for everything else marked **Future**.

- **Output pin UI.** Currently you toggle a binding into the output panel by adding/removing the `@output` decorator above its definition. A pin icon on each binding row to toggle that decorator visually is the natural gesture but isn't implemented.
- **Multi-tab consistency.** IDB writes from one tab don't propagate to another tab's in-memory cache. A `BroadcastChannel('ep')` listener that invalidates the cache (or merges deltas) is the natural fix; not implemented because nobody's hit it yet.
- **Inline error block dismissal.** Block widgets are always visible while the error stands. A click-to-dismiss (with restoration on next error change) might reduce vertical-space pressure on long error messages.
- **Module discovery.** numbat-js has all 62 upstream modules vendored and `use module::path` works, but users have no way to browse what modules exist or what they provide. A "modules" section in the drawer (or autocomplete after `use `) would surface them.

---

## Numbat conformance

`test/conformance.test.js` is the compatibility surface — a curated corpus of ~80 numbat programs with expected outputs (canonical values, dims, strings, errors). Every entry asserts what `evaluate()` should return for that program. Anything that changes ep's evaluator output for one of these programs has to be an explicit decision: update the expected, or revert.

Coverage: numeric literals (incl. hex / octal / binary / underscore-sep / scientific), arithmetic + precedence + unicode operators, units (SI base, imperial, compound), conversions (`->` / `to`), constants (`pi`, `tau`, `e`, `NaN`, `inf`), transcendentals (`sin`, `cos`, `sqrt`, `ln`, `log10`, `exp`, `abs`, `mod`, `max`, `min`), `let` bindings with type annotations, `fn` declarations including generics and `where`/`and` clauses, pipe operator (`|>`), `if/then/else` (inline + multi-line in fn bodies), `dimension` / `unit` / `struct` declarations, ep-specific helpers (DCDMA cores, sieve mesh, `sample_mass`), error classes, `type()` returns.

Expected values come from first principles or from cross-reference against the upstream numbat CLI / playground. The corpus is the source of truth — if ep diverges from numbat on a real program, add it to the corpus and align.

### Live cross-validation against numbat-wasm — **scaffolded; phase-2 pending**

`ext/numbat-upstream/` holds the harness for running the conformance corpus through the upstream Rust → WASM build of Numbat alongside ep's JS port. The actual WASM blob (~2 MB) is **gitignored**: dev-only, not required by the default `npm test`. Bootstrap:

```sh
sh ext/numbat-upstream/fetch.sh    # pulls numbat_wasm_bg.wasm + numbat_wasm.js
npm test                            # cross-val test wakes up automatically
```

When the WASM is absent the cross-val test reports as `skipped`; `npm test` doesn't require it. When present, the bridge loads and **phase-1** asserts the WASM bridge initialises cleanly. **Phase-2** (TODO in `test/numbat-wasm-cross.test.js`) walks the conformance `CORPUS`, runs each program through both engines, and asserts numeric values match within the corpus's existing tolerance. Lands when there's enough corpus drift to notice — until then, the manual corpus is the source of truth.

### Datetime — Temporal-backed

`now()`, `datetime("…")`, `tz("…")`, `format_datetime("%fmt", dt, tz)` now route through the [Temporal API](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal). Native on Firefox 139+, Chromium, and most evergreen browsers; Safari + Node fall back to `ext/temporal/temporal-polyfill.min.js` (~57 KB raw / ~18 KB gzipped, vendored, self-conditional so modern browsers skip its body).

What this buys us:

- **Real timezone math.** `format_datetime("%H:%M %Z", dt, tz("America/New_York"))` produces the right wall-clock time including DST adjustments. The fallback `Date`-based path before this was UTC-only and silently wrong.
- **More forgiving parse.** `datetime("2026-05-17T15:30:00+02:00")` and `datetime("2026-05-17T15:30:00[Europe/Berlin]")` both parse correctly via `Temporal.Instant.from` / `Temporal.ZonedDateTime.from`.
- **strftime-style format strings.** `%Y %m %d %H %M %S %j %A %a %B %b %z %Z %%` are all supported. Unrecognised `%<x>` passes through untouched.

The VALUE model is unchanged — a datetime is still a `Quantity` with `{time: 1}` dim representing seconds since Unix epoch — so existing arith (`now() + 1 hour`) keeps working. The Temporal upgrade only affects parsing and formatting, not the type system. Calendar-aware arithmetic (`now() + 1 month` where "month" has variable length) would require a dedicated Datetime value type and remains future work.

## File layout

```
ep/
  README.md
  SPEC.md                  ← this document
  LICENSE
  .gitignore
  package.json             ← scripts only ("build", "test"), no deps
  build.js                 ← zero-deps; concatenates src/ + ext/ into index.html
  dev.html                 ← optional dev shell, loads src/ as native ES modules
  index.html               ← built artifact; served at gentropic.org/ep
  dist/                    ← gitignored; build emits dist/viewer.html here

  src/
    template.html          ← editor body + STATE markers
    viewer-template.html   ← viewer artifact's HTML scaffold
    style.css              ← Switchboard tokens + ep-specific styles
    js/
      main.js              ← editor entry point
      viewer-main.js       ← viewer entry point
      state.js             ← state singleton + evaluateAll()
      units.js             ← adapter re-exporting numbat-js primitives
      evaluator.js         ← classify + parseAnno + evaluate() + typecheck wiring
      blame.js             ← bidirectional blame walker for @output dim mismatches
      render.js            ← chip + CM6 editor rendering + inline block widgets,
                             sig help, hover docs, plot drawing
      docs.js              ← DOCS table + DOC_GROUPS (autocomplete / sig help /
                             hover / docs-mode reference)
      guides.js            ← long-form guide pages + tiny markdown renderer
      storage.js           ← persistence + autosave + draft slot + ephemeral
      share.js             ← URL share encode/decode + QR rendering
      dialogs.js           ← in-app epConfirm / epPrompt
      ctxmenu.js           ← long-press + program context menu
      drawer.js            ← hamburger drawer: programs / history / docs modes
      scenarios.js         ← named @input presets
      examples.js          ← built-in starter programs
      tutorial.js          ← first-launch walkthrough
      accessory.js         ← bottom token bar
      view.js              ← form / editor toggle, panel collapse
      export.js            ← .ep / .html / link dialog
      io.js                ← file picker + drag-and-drop

  ext/
    cm6/                   ← vendored CodeMirror 6 (rebuilds via npm + rollup)
      cm6.min.js           ← committed prebuilt bundle
      entry.mjs            ← rollup entry — exports the symbols ep uses
      build.js / package.json / rollup.config.mjs
    numbat/                ← co-located numbat-js (full port + 62 upstream modules)
      src/                 ← Quantity/dim runtime, parser, evaluator, prelude
      src/typecheck/       ← HM dim-aware typechecker (12 files, ~2,150 LOC)
      dist/, test/, vendor/numbat/modules/, build.js
    qrcode/                ← vendored ISO/IEC 18004 QR encoder
      qrcode.js, dist/, test/, build.js
    temporal/              ← Temporal polyfill (Safari/Node fallback, vendored)

  test/
    units.test.js          ← ep adapter tests
    evaluator.test.js      ← ep evaluator + classify tests

  prior-art/
    ep-mock-rpn.html       ← retired stack-mode prototype
    ep-mock-notepad.html   ← intermediate notepad pass
    ep-mock.html           ← original keypad pass
```

`npm run build` is `node build.js`; `npm test` is `node --test`. Both zero-dep at the ep level; CM6's vendor build needs `npm install` under `ext/cm6/` to rebuild the bundle (the bundle is committed so this is only needed when updating CM6).

---

*Document originated in design conversation, May 2026; revised through 0.1 implementation. Treat as snapshot rather than spec-as-law — when the doc disagrees with `index.html`, the code wins.*

---

# Enhancements roadmap

This section describes features beyond the v0.1 core that have been designed but not all built. The earlier sections of this document define ep's design contract; this section is the roadmap of what comes after.

Items are grouped by category; within each category they're roughly ordered by value-to-effort ratio. Each carries an estimated effort flag (S = afternoon, M = day, L = multi-day) and notes about prerequisites.

---

## 1. Drawer / menu / persistence — **Shipped**

The hamburger drawer, multi-program storage, autosave indicator, ephemeral state model, and draft slot persistence are all live. Reference this section when iterating on persistence behavior.

### 1.1 Hamburger drawer

Slide-in left panel triggered by the hamburger icon in the header (replaces a top-bar `open` button which moved into the drawer). Width: `min(320px, 84vw)`. Slides via CSS `transform: translateX()` with a 180ms ease transition.

**Contents top-to-bottom:**
- Header: title `ep · programs` plus close button
- New-program action (`+ new program`)
- Saved programs section (scrollable, takes remaining vertical space)
- File section (`↑ open .ep file`)
- About section (fixed at bottom, slightly raised background)

Open/close paths:
- Tap hamburger to open
- Tap close button, tap scrim, press Escape, or swipe-left to close

### 1.2 Continuous autosave to storage

Every chip edit and every body-row edit calls `scheduleAutosave()` — debounced ~400ms. Save status shown next to the filename in the header: amber `saving` then green `saved` then fades. Storage schema:

```js
// IDB: object store `programs`, keyed by `name`
[
  {
    name: "ore_body",
    body: ["line 1", "line 2", …],
    updatedAt: 1715792345000,
    pinned: false,
    scenarios: { … },
    activeScenario: null,
    gutterUnits: { … },
    snapshots: [ {id, takenAt, label, pinned, body, …}, … ],
  },
  …
]

// localStorage (small / sync / often-touched)
localStorage["ep:current"]   = "ore_body"
localStorage["ep:settings"]  = { theme, sigDigits, sort, … }
localStorage["ep:draft"]     = { … }      // in-flight ephemeral state
```

**Hybrid cache architecture.** `readStore()` and `writeStore()` keep their sync API by mirroring the IDB programs store into an in-memory `Map`. `bootStorage()` (async, called once at boot) loads the cache from IDB and runs the one-shot legacy-`ep:programs` → IDB migration. Reads from the cache are instant; writes update the cache + fire-and-forget the IDB persist.

On boot: `bootStorage()` → read `ep:current` → restore that program's body → evaluate → render. First-run seeds the demo into storage so the drawer isn't empty.

### 1.3 Per-program context menu

Each program row in the drawer has an ellipsis (`⋯`) button on the right. Tap or long-press anywhere on the row → popup menu with `rename`, `duplicate`, `export`, separator, `delete` (in red).

Long-press parameters: 500ms hold + < 8px movement tolerance. Touch start position serves as menu anchor.

Right-click on desktop opens the same menu at the cursor.

`export` from the menu switches to that program first (if not already current), then triggers the export dialog. Useful when grabbing a `.ep` from a saved program without manually navigating to it.

### 1.4 In-app modal dialogs

Native `confirm()` and `prompt()` are blocked in some PWA/artifact environments and silently return null. Use the in-app `epConfirm({title, message, okLabel, danger})` and `epPrompt({title, message, label, value, okLabel})` helpers instead. Both return promises. Dialog uses the existing scrim+dialog styling, layered at `z-index: 80` (above drawer).

Modal must always close any open context menu when opening.

### 1.5 Swipe-left to close

When the drawer is open, touches starting inside the drawer that move leftward more than 10px (and more horizontally than vertically) drag-track the drawer position. On release: snap closed if past 50% threshold or velocity > 0.5 px/ms leftward; otherwise snap back open.

**Critical: open-by-swipe is NOT implemented and should not be.** Conflicts with Android's system back gesture. Open is hamburger-only.

### 1.6 Drag-and-drop file load

Drag a `.ep` file onto the window. An orange-bordered scrim appears with "DROP .EP FILE / to load it into the editor"; release loads. Implementation tracks dragenter depth to avoid flicker; only `Files` drags activate the overlay (text drags pass through).

---

## 2. High-value polish — **Shipped** (except where noted)

All of 2.1–2.4 are live. Soft-delete-with-undo was deliberately skipped.

### 2.1 Keyboard shortcuts (S)

Desktop-only. No need for indicators in the UI (discoverable via standard expectations).

| shortcut | action |
|---|---|
| `Cmd/Ctrl+N` | New program |
| `Cmd/Ctrl+O` | Open file picker |
| `Cmd/Ctrl+S` | Force-save now + flash the save indicator (autosave makes this mostly cosmetic but matches expectations) |
| `Cmd/Ctrl+E` | Open export dialog |
| `Cmd/Ctrl+P` or `Cmd/Ctrl+K` | Open drawer with focus on search input (see 2.2) |
| `Esc` | Close drawer / modal / context menu (already partly wired) |

Implement as a single window-level keydown listener that checks modifier + key and routes to the right action. Don't fire if focus is inside `input`/`textarea` for typing keys, only for the modifier combinations.

### 2.2 Quick-search in the drawer (S)

Once a user has 20+ programs, scanning the list gets tiring. Small filter input at the top of the saved-programs section, monospace style matching the rest. As-you-type filter: simple substring match against program name (case-insensitive), with a fallback to fuzzy match (longest common subsequence) for the 0-result case.

Keyboard: `Cmd/Ctrl+P` opens drawer + focuses the search; arrow keys navigate filtered results; Enter loads the highlighted program.

Reset on drawer close.

### 2.3 Per-program description from first comment (S)

If a program's first non-blank source line is a `#` or `--` comment, treat it as the program's description. Display in the drawer item, below the program name, in muted text:

```
ore_body
Pirita Q4 2025 — Au cutoff sensitivity
23 lines · 28m ago
```

Bigger drawer-row height, more useful at scale. Also display in the export dialog as a header.

Implementation: split out the first comment when reading from storage; cache on the in-memory program list. No source mutation — the description IS the comment line, no separate field.

### 2.4 Copy ep-script source to clipboard (S)

Button in the export dialog: `⧉ copy source`. Copies the current program's serialized source to clipboard, same content as the `.ep` download. Useful for pasting into Slack/email/notebook without going through file save.

Falls back to the same `document.execCommand('copy')` path as the output-chip copy in cases where `navigator.clipboard.writeText` is unavailable.

> **Deliberately skipped: soft-delete with undo.** Delete is delete — simpler model, no trash semantics, no toast affordance to maintain. The confirmation dialog is enough friction.

---

## 3. URL sharing + QR generation — **Shipped**

The killer feature beyond the drawer. Implementation now uses the `@gcu/pointer` Phase-1 grammar (see `SPEC-pointer.md`) — share URLs are fragment-based pointers (`#i:d<base64url>`) rather than the original `?p=…` query parameter, and QR codes use the QR-optimised form (`#q:d<base45>`) which is ~22% denser in QR alphanumeric mode. Both formats decode to the same bytes; ep's pointer module also accepts the long-form `inline:deflate:` for interop.

A small divergence from the spec: ep uses the browser-native `CompressionStream` (deflate-raw) rather than vendoring lz-string. Saves ~3 KB of bundle and works in every browser ep targets.

The legacy `?p=…` query format is still recognized on boot as a shim (resolved as if it were `#i:d<payload>`) so any historic URLs continue to work.

### 3.1 The mechanism

ep's URL is `https://gentropic.org/ep/` (or wherever it ends up hosted). A shareable program URL is:

```
https://gentropic.org/ep/#i:d<base64url(deflate-raw(source))>
```

On boot, after the normal restore-from-storage path:
1. Read `location.hash` (and `location.search` for legacy `?p=`) — if a pointer is present, resolve via the dispatcher in `src/js/pointer.js`
2. Load the decoded source as a fresh untitled program (don't clobber the current program)
3. Replace the URL with the clean path via `history.replaceState` so a refresh doesn't re-trigger
4. If the user keeps editing the loaded program, it autosaves into storage like any other program

**Note about installation:** This works whether or not the PWA is installed. If installed, Android Chrome routes the URL to the standalone PWA window. If not, it opens in a regular browser tab — same code path either way. The pointer being in the fragment (not the query) means resolution is purely client-side: the bytes never travel to the server.

### 3.2 Why NOT custom protocol handlers (`web+ep://`)

Considered and rejected:
- Custom protocols only work after the PWA is installed
- The `web+` prefix is mandatory (browsers won't let web apps claim bare `ep://`)
- No graceful fallback for non-installed users
- Less recognizable / less shareable than a normal URL
- Anyone scanning a QR with a `web+ep://` scheme might bail thinking it's malformed

URL capture (just visiting your origin) gets all the benefits of protocol handlers when installed, plus working when not. Strictly better tradeoff for the QR-share use case.

### 3.3 Compression and size

A typical ep program of 500 source chars:

```
raw source          → 500 chars
lz-string compress  → ~280 chars
base64url encode    → ~370 chars
+ URL overhead      → ~400 chars total
```

QR Version 9 (53×53 modules) at medium error correction holds ~530 alphanumeric chars; Version 13 (69×69) holds ~770. So a typical program fits in a Version 9 QR with room to spare. Maximum (Version 40, 177×177) handles up to ~4300 chars; far beyond any realistic program.

Compression library: `lz-string`. ~3KB minified, zero deps, MIT. Battle-tested. Used by tools that need URL-compatible compression.

### 3.4 Share-link UI

In the export dialog, alongside `↓ .ep` and `↓ .html`, add `🔗 link`. Tap → generates the URL, copies to clipboard, briefly shows the URL in a read-only field below the existing source preview. Also shows the encoded length so users have feedback when programs are getting large.

If `navigator.share` is available (mobile), the `link` button uses the OS share sheet directly: shares text containing the URL plus a description like "ep program: {name}".

### 3.5 QR generation

Below the share-link field, a small QR code rendered as inline SVG.

Library: `qr-creator` (~3KB, MIT) or hand-rolled (~150 LOC for a reasonable encoder). SVG output is preferred — scales cleanly and is part of the single-file ethos when embedded.

QR rendering happens when the export dialog opens, against the currently-serialized source. Re-renders when the export-name field changes (which doesn't affect the program content but provides a clear "this is what gets shared" feedback). Long-press the QR to download as an image.

### 3.6 Receiving a share

Boot sequence with `?p=` present:

```
1. parse URL params
2. if "p" present:
     try decompress + parse
     on success: load as new program named "shared-N" or "imported-Mar-14"
     on failure: show a non-blocking error toast, continue with normal restore
3. replace URL with clean path via history.replaceState
4. proceed with normal restore (which now shows the loaded shared program as current)
```

The user can then save-as a more permanent name if desired (the loaded program already autosaves as "shared-N" but renaming is one tap).

### 3.7 Pointer-based addressing — **Adopted via `@gcu/pointer` Phase 1**

ep ships a minimal `@gcu/pointer` implementation inline (`src/js/pointer.js`, ~200 lines). It supports the three inline schemes (`inline:`, `i:`, `q:`) with `raw` and `deflate` codecs. Reference schemes (`gh:` / `gist:` / `rentry:` / `url:` / `doi:` / `zenodo:`) intentionally fall through to `EUNKNOWN`; per the spec (§17) that's the conforming graceful-degradation path. Phase 2 lands those loaders when there's a real use case for "load this ep program from a GitHub repo".

When the implementation graduates to its own package (`@gcu/pointer`), `src/js/pointer.js` becomes the seed — same surface, same behavior. Other GCU shells (auditable, etc.) adopting the same spec will read ep's share URLs natively, and vice versa.

---

## 4. Editing affordances — §4.1–§4.5 **Shipped**; §4.6 **Future**

### 4.1 Syntax highlighting — **Shipped** (M)

Currently the body uses plain `<input>` rows. Replace with a vendored CodeMirror 6 under `ext/cm6/` and provide a Numbat-shaped highlighter.

Token categories to color:
- Comments (`#` and `--` to end of line) — `--sw-text-soft` italic
- Keywords (`@input`, `@output`, `@options`, eventually `fn`, `where`, `to`) — `--sw-orange`
- Identifiers — `--sw-text`
- Number literals — `--sw-text-mid`
- Unit names (anything in the units table after a number or after `->`) — `--sw-teal`
- Operators — `--sw-text`
- Type annotations (after `:` in a binding) — muted accent
- Error spans (see 4.2) — red underline

Numbat's VS Code extension has a tmGrammar file at `vscode-extension/syntaxes/numbat.tmLanguage.json` in the upstream repo. The token regex set there is a good starting point; just port the patterns to CM6's language definition format.

### 4.2 Error pinpoint + inline block widgets + blame — **Shipped** (M)

Errors surface in three coordinated places:

**Token-span underline.** Same mechanism as v0.1 — `Decoration.mark` via a `StateField`/`StateEffect` pair in `render.js`. When the underlying error carries a `line:col`, the underline starts at the offending token (with shifts for the `name = ` / `let name = ` prefix accounted for); otherwise it spans from leading-whitespace end to end-of-line.

**Inline block widgets.** Below the offending line, a block-decoration widget (CM6 `Decoration.widget({block: true, side: 1})`) renders the full error message in a colored panel — red for errors, amber for warnings, neutral gray for `print()` output. Three kinds share the `EpErrorWidget` class: `error`, `warn`, `info`. Replaces the earlier "truncate the error in the gutter" approach (the gutter couldn't fit long messages). The gutter's background is rendered transparent (`.cm-gutters-after`) so the block extends visually across the full editor width.

**Gutter shape markers.** Per-line result markers use shape *and* color for accessibility:
- Orange `▲` (CSS-border triangle) for `@input`-tagged bindings
- Teal `▼` for `@output`-tagged bindings
- Amber `▪` square for bindings flagged as the blame suspect (see below)
- Red `✕` (text symbol) for errors

**Bidirectional blame.** When an `@output(unit)` annotation mismatches the resulting dimension, `src/js/blame.js` walks the expression tree looking for a multiplicative chain of `Ident` leaves (handling `*`, `/`, `^n`, `->`, unary `-`, and `Paren`; bails on `+` / `-` / `Call` / anything non-linear). For each leaf it computes the required dimension that would make the output annotation correct, and picks the leaf whose required dim has the *lowest complexity* — that's the most likely culprit. The error message names it: `'thickness' has [time] but the chain needs [length]`. The suspect's binding row gets the amber square marker via a parallel `suspects` queue threaded back through `evaluate()`.

**Pre-evaluation typechecking.** Errors don't only surface from runtime — every statement now passes through the HM typechecker (`ext/numbat/src/typecheck/integration.js#typecheckStatement`) before evaluation. Type errors carry context strings (`in the argument of fn foo`, `in the binding of x`) and include did-you-mean Levenshtein suggestions for unknown identifier names. Type errors render through the same inline-block path as runtime errors.

The full error text remains visible as a native `title` tooltip on the marked span as well, in case the block widget is dismissed (currently always visible — dismissibility is **Future**).

**Mid-edit quiet.** Two refinements keep errors from being noisy while the user is actively typing. (1) *Cursor-line suppression* — the line the cursor is on shows no error indicators at all (block widget, squiggle, gutter ✕): the user is editing right there and a mid-keystroke "unknown identifier" is just noise. The indicators reappear when the cursor leaves the line. (2) *Debounce* — evaluation stays synchronous (results, gutter, chip values update live every keystroke), but the error-decoration pass waits ~300 ms past the last edit, so downstream rows that transiently error mid-keystroke don't flicker red. Cursor-only moves apply marks immediately, so the cursor-line suppression releases without lag.

### 4.3 Auto-pair brackets/braces — **Shipped** (S)

In the body editor, typing `(`, `[`, `{` inserts the matching close character with the cursor in the middle. Typing the close character when the next char is already that close just moves the cursor past. Backspace at the empty pair deletes both.

Standard editor affordance. CM6 has this built-in via `closeBrackets()` extension.

### 4.4 In-editor documentation — **Shipped** (M)

Three coordinated surfaces, all fed by the hand-curated `DOCS` table in `src/js/docs.js` (~150 entries: signature, description, optional example):

**Autocomplete info panel.** Each completion option carries an `info` field; CM6 renders it beside the popup.

**Signature help.** When the cursor sits inside a function call's argument list, a tooltip shows the function signature with the active argument highlighted (comma-counted at paren depth 0, string-aware). Cursor-anchored on desktop; on mobile it docks as a strip just above the accessory bar (which itself rides above the soft keyboard via `--ep-kbd-inset`), since a cursor-anchored tooltip tends to land off-screen there.

**Hover docs.** Resting the pointer (~350 ms) on a builtin / decorator / keyword shows its `DOCS` entry as a tooltip. Desktop-only by nature; mobile reaches the same content through the autocomplete panel and the sig-help strip.

`showTooltip` and `hoverTooltip` are exported from the CM6 bundle for these.

### 4.5 In-app docs viewer — **Shipped** (M)

The drawer gains a third mode (`docs`, alongside `programs` / `history`):

- **Guides** — long-form pages from `src/js/guides.js`: ep-specific topics (decorators, broadcasting + masks, plots, export, form view, persistence) plus Numbat fundamentals (numbers/units, dimensions, conversion, functions, lists, strings) adapted with MIT/Apache attribution. A ~120-line hand-rolled markdown renderer (no library) drives them; prev/next nav between pages; fenced code blocks have copy buttons.
- **Function reference** — the `DOCS` table grouped by category (`DOC_GROUPS`), searchable.

`guides.js` is deliberately excluded from `VIEWER_JS_FILES`, so program-form `.html` exports (which clone the viewer artifact) don't carry the doc weight — the recipient only sees the form anyway.

### 4.6 Tab-cycle through chips and body rows (S) — **Future**

Hitting Tab in a chip input moves focus to the next chip. Shift+Tab to previous. Tab from the last chip moves to the first body row. Tab through body rows linearly. Tab from the last body row goes to the first output chip's copy button (or wraps).

Already mostly free from natural DOM tab order, but currently broken because some intermediate elements are tabbable. Audit `tabindex` across the layout and set `-1` on elements that shouldn't be reached by Tab.

---

## 5. Output formatting

How results display, and how users get them out of ep.

### 5.1 Copy-as menu on output chips — **Shipped** (S)

Long-press an output chip → menu with multiple format options:

- `copy as number` — `216000` (raw canonical value, no unit, no separators)
- `copy as value` — `216,000 kt` (current display format with thousands separators)
- `copy as plain text` — `216 kt` (auto-scaled, separator-stripped — current tap behavior)
- `copy as JSON` — `{"value": 216, "unit": "kt", "dimension": "mass"}` (structured)
- `copy as LaTeX` — `216\,\text{kt}` (with proper LaTeX spacing)
- `copy as ep-script literal` — `216 kt` (ready to paste into another ep program)

Reuses the long-press helper from the drawer.

Quick tap still copies the default `216 kt` plain-text format. Menu is for power use.

### 5.2 Significant-digits toggle — **Shipped** (S)

Settings → display → "significant digits": pills 3 / 4 / 5 / 6, default 4. Numbat-js's `formatNumber` / `formatParts` take an `opts.sig`; ep's `units.js` wraps with `setFmtSigDigits()` and threads the user setting through. Per-output unit overrides via `@output(unit)` still win when present.

### 5.3 Locale-aware separators (S)

Read `navigator.language` on boot. Pick decimal/thousands separators accordingly:
- `en-*` → `216,000.5 kt`
- `pt-BR`, `de-*`, `fr-*` and most of Europe → `216.000,5 kt`
- Allow explicit override in settings

Implementation lives in `fmtNum`; everything else flows through it.

### 5.4 Format directive — **Superseded** by `@output(unit)` decorator (M)

The originally-designed `@format { name: "0.00 unit" }` directive was superseded by putting unit overrides directly on the `@output` decorator:

```ep
@output(t)
tonnage = volume * density

@output(g/t)
grade = metal / tonnage

@output(kg)
metal = tonnage * grade
```

This handles the "show this in a specific unit" case (the dominant use case) without introducing a new directive. The precision / pattern aspect of the original `@format` design is still **Future**.

### 5.5 Live preview smoothing — **Shipped** (S)

80ms color transition on `.chip-res` and `.ep-gutter-result` so rapid edits don't flash red/grey on every keystroke.

### 5.6 Format document — **Shipped** (M)

Three-layer formatter (`src/js/formatter.js`):

  - **v0** — trim trailing whitespace, collapse blank-line runs, ensure single trailing newline
  - **v1** — decorator stacks sit flush above their binding (no blank lines between them), one blank line between top-level statements
  - **v2** — function calls and `@options(...)` lists that would exceed the target width break into one-arg-per-line form. Long arithmetic wraps in `(...)` and breaks at the lowest-precedence top-level binary operator (`+`/`-` preferred over `*`/`/`, never `^`). Operator floats to the start of the next line (Prettier convention).

Comments are preserved via a separate line-scan that attaches each comment to a statement as `_leadingComments` / `_intervalComments` / `_trailingComment`.

Width is a user setting (Settings → display → "format width": 30 / 40 / 50 / 60 / 80, default 40 to fit the narrowest mobile viewport after the floating result gutter steals its share).

Triggers: `Shift+Alt+F` keyboard shortcut, "format document" button in the drawer's file section, and "format" button in Settings → tools.

### 5.7 Per-line gutter unit override — **Shipped** (S)

Click any result in the right gutter on a named binding → menu of every unit compatible with the result's dimension. Pick one and the gutter swaps to that unit; an "auto-scale" entry restores the default. The override is keyed by binding name (not row), persisted in `state.ui.gutterUnits`, so it survives reload + scenarios and isn't position-dependent.

Priority for what the gutter shows: per-line override → `@output(unit)` → `fmt()` auto-scale (which honors source-level `to`/`->` via the `.disp` tag).

---

## 6. Discoverability + onboarding — **Shipped**

### 6.1 Examples section in the drawer — **Shipped** (S)

A read-only section at the bottom of the saved-programs list (or as a separate drawer tab) with pre-made example programs. Tapping an example loads it as a new untitled program — the example itself stays unchanged.

Starter set:
- **Ore body tonnage** — the demo we already have
- **Unit conversions** — `3 in -> cm`, `60 mph -> m/s`, common reference values
- **Cutoff sensitivity** — varying a grade cutoff, computing tonnage above
- **Compound interest** — finance-shaped, demonstrates non-mining use
- **Projectile range** — physics-shaped, demonstrates trig
- **Pendulum period** — from the Numbat tutorial (with credit), demonstrates units in physics

Examples live in `src/js/examples.js` as an EXAMPLES array. Loading an example creates an **ephemeral** in-memory program (no storage write) so browsing the library doesn't pollute the saved-programs list. The first explicit save commits the example to storage under a unique slug.

### 6.2 Drawer sort options — **Shipped** (S)

Toggle button in the drawer search row + a "drawer sort" row in Settings. Two options: `recent` (default, by `updatedAt` desc) / `alpha`. Stored in `ep:settings.sort`. Pinned programs always sort first regardless of the chosen mode.

### 6.3 Pinning programs — **Shipped** (S)

Per-program ctxmenu gains a `pin` / `unpin` item. Pinned programs sort to the top of the drawer regardless of the active sort mode. Visual indicator: small `◆` glyph next to the program name when pinned. Stored as `store[name].pinned = true`.

### 6.4 First-launch tutorial — **Shipped** (M)

On absolute-first launch (no entry in `ep:installedAt`), instead of going straight to the demo program, run a brief interactive walkthrough. ep's UI is unusual enough that a 60-second tour materially improves the conversion rate from "curious visitor" to "actual user."

**Four steps**, each tied to a real interaction rather than a wall of text:

1. **"Tap a chip to edit it."** Highlight one of the `@input`-tagged chips. Wait for the user to tap-and-edit. Show a "👀 nice" confirmation on success, then advance.
2. **"Watch the outputs update."** Highlight the `@output`-tagged chip panel. After the first re-evaluation completes, advance.
3. **"The chips are just source."** Highlight the body's `@input` bindings. Show that the line the user just edited (in the chip) is also visible in source. Tap-to-continue.
4. **"Programs travel as files or links."** Highlight the `export` button. Tap-to-continue closes the tutorial.

**Visual treatment.** Semi-opaque dark overlay (`rgba(0,0,0,0.55)`) over the whole screen with a hole cut out around the currently-highlighted element. Implement via SVG mask or CSS `clip-path` with a generous padding. Tooltip near the highlighted element with the step text + `next →` or `skip tutorial` links.

**State tracking.** `localStorage["ep:tutorialDone"] = true` once finished or skipped. The about section in the drawer gets a `replay tutorial` button so curious users can rerun it.

**Failure handling.** If the user does something unexpected during a step (closes the drawer, exports without prompting, etc.), gracefully exit the tutorial state — never trap them in a flow.

Effort: ~150 LOC. Probably the highest-leverage UX investment in this entire roadmap for the actual unfamiliar-user-tries-ep moment.

---

## 7. Power-user / language-side

Smaller items that catch the eyes of careful users.

### 7.1 Recent values per param (M)

Each `@params` chip remembers its last 5 distinct values across the program's lifetime. Long-press the chip → menu listing recent values; tap to set. Currently the chip just shows the canonical-units result on the right side — that real estate could host a small history indicator (`▾ 5`) when there's history to show.

Useful when iterating on the same calc against several scenarios. `length = 200 m` → run → `length = 350 m` → run → tap-back to 200 without retyping.

Stored as `store[name].paramHistory = { length: ["200 m", "350 m", ...], ... }`. Capped at 5 entries per param.

### 7.2 Inline error messages on chip-edit — **Shipped** (S)

The chip's right-side preview (`.chip-res`) goes red and shows the error message when the binding fails. Implemented in `renderChipResults()` in `src/js/render.js`.

### 7.3 Annotation auto-suggest (M)

When a user writes `density = 2.7 g/cm3`, the inferred dimension is `Mass / Volume` which matches the named `Density`. Offer a one-tap fixup: small `+ Density?` chip appears next to the binding for a few seconds. Tap to rewrite to `density : Density = 2.7 g/cm3`.

Pedagogically useful — teaches users the dimension type names without forcing them.

Logic: after evaluation, scan unannotated bindings; the HM typechecker (`ext/numbat/src/typecheck/`) already computes inferred types for every binding, so this is now mostly a UX wire-up — for each binding, check if the inferred dimension exactly matches a named dimension in the table; if yes and no annotation present, offer the fixup. The typechecker landed since the original spec — the "infer dimension" prereq is no longer the blocker.

### 7.4 Snapshots / history — **Shipped** (M)

Per-program version history. The feature that turns ep from "scratch pad" into "trustworthy for serious work."

**Data model** — `store.programs[name].snapshots` is an array of
`{id, takenAt, label, pinned, body, scenarios, activeScenario, gutterUnits}`
sorted newest-last.

**Snapshot triggers:**
- **Manual** — program ctxmenu → "snapshot now…" with optional label prompt (labeled snaps auto-pin)
- **Session-first-load** — silent snap the first time each program is loaded in the current page session
- **Pre-restore** — `restoreSnapshot` snapshots current state first so "undo my restore" works

**Retention** (`pruneSnapshots` in `src/js/snapshot-retention.js` — pure function, unit-tested): keep ALL snapshots from the last 24h; keep the most recent 20 unpinned older than that; pinned snapshots never auto-purge.

**UI** — slide-in panel (modeled on settings), opened from the ctxmenu "history" entry. Each row shows label or "auto" + timestamp + restore / pin / delete actions. Restore confirms; the auto pre-restore snap lands at the top of the list right after.

**Backend** — IDB. Programs and their snapshots live in the `programs` object store keyed by name. `bootStorage()` loads everything into an in-memory cache on page load (sync reads from cache, async writes to IDB) so `readStore()` / `writeStore()` keep their sync API. One-shot localStorage → IDB migration runs on first boot after the upgrade and removes the legacy LS key. Settings, drafts, and the current-program pointer all stay in localStorage (small, sync, often-touched).

**Why this matters specifically for geologists.** Resource estimation workflows iterate dozens of times on the same calculation — different cutoffs, different assumptions, different bulk densities. The current "always overwrites" model is hostile to that workflow. Snapshots let users explore branches and come back without losing state.

### 7.5 Param scenarios — **Shipped** (S)

Distinct from snapshots: a scenario saves a named set of `@params` values within one program, not the whole program history. Lets one program serve multiple cases.

**Data model** (also on the per-program record):

```js
store.programs["ore_body"] = {
  body: [...],
  scenarios: {
    "pirita":   {length: "200 m", width: "50 m",  thickness: "8 m",  ...},
    "carajas":  {length: "350 m", width: "70 m",  thickness: "12 m", ...},
    "samarco":  {length: "180 m", width: "45 m",  thickness: "6 m",  ...},
  },
  activeScenario: "pirita",     // optional; null when freely editing
}
```

**UI.** A horizontal scroller above the `@params` panel showing scenario chips. The strip is **hidden by default** — first-scenario creation happens via the drawer's per-program `⋯` menu ("save scenario…"). Once at least one scenario exists for the program, the strip appears with its own `+ scenario` chip for adding more.

Tap a chip to swap all params to that scenario's values. The currently-active scenario chip is highlighted in `--sw-orange`. When the user edits a param after selecting a scenario, the active chip un-highlights and an amber `save <name>` chip appears alongside `+ scenario` so the user can either overwrite the active scenario or capture a new one.

**Workflow this serves.** A geologist analyzing three different deposits with the same calculation — the math is identical, only the inputs differ. Currently they'd have three separate programs (`ore_body_pirita`, `ore_body_carajas`, ...) which fragment the calculation across multiple files and make updates painful. Scenarios consolidate them into one program with three preset configurations.

**Interaction with snapshots.** A snapshot captures everything including scenarios, so restoring an old snapshot brings back the scenario set as it was then. Switching scenarios doesn't create a snapshot (would be too noisy — scenario switches are everyday, not version-bump events).

### 7.6 Date/time ergonomics (M) — **Partially shipped**

The datetime *substrate* exists — `now()`, `datetime("…")`, `tz("…")`, `format_datetime(…)`, Temporal-backed, with `now() + 1 hour`-style arithmetic (see "Datetime — Temporal-backed" above). What's thin is the friendly *surface* a notepad calculator wants. The surface is bounded by ep's Numbat-compatibility rule: a non-decorator program must either run identically on upstream Numbat *or fail loudly* — it must never silently diverge. That admits *additive* divergence (new identifiers/keywords Numbat rejects with a clear error) and forbids *collision* divergence (reinterpreting syntax that is already valid Numbat). The surviving surface:

- **Friendly durations** — `3 weeks`, `2 days`, `90 minutes` in date arithmetic. Pure Numbat — `weeks`/`days`/`minutes` are units. **Shipped** (the `datetime::functions` module pulls `units::time`, so these resolve).
- **Date functions** — `date("…")`, `time("…")`, `today()`, `weekday(…)`, `format_datetime(…)`. **Shipped** — ep's host loads `datetime::functions` (`use datetime`); numbat-js now has a real `DateTime` value type, so these typecheck and round-trip cleanly.
- **`today` / `now` as bare values**, not just `now()`. **Shipped** — seeded as `DateTime` values in `evaluate()`, the same env-binding pattern as `above` / `_N`. `now()` the function is untouched (separate namespace).
- **Common queries** — `days until date("2026-12-25")`, time between two dates. **Future** (Tier 2). The `until` / time-between forms need new grammar; ep sends expressions verbatim to numbat-js's parser and has no desugar layer, so this needs either an ep-side preprocessor or a numbat-js parser change (which would cost numbat-js its own Numbat-compat goal). Low priority — `date("2026-12-25") - today -> days` already expresses the same thing.

**Rejected: bare date and clock literals.** Writing `2026-12-25` or `3pm` directly is the obvious Soulver-ism, but both *collide* with valid Numbat — `2026-12-25` parses as `2026 - 12 - 25` → `1989`, and `3pm` is `3` picometres. A non-decorator program using them would silently miscompute upstream, exactly the failure mode the compatibility rule forbids. Date and time values stay spelled `date("…")` / `time("…")`, which already work and round-trip cleanly.

Comparison point is Soulver, which is strong here. numbat-js now carries a real **`DateTime` value type** (`class DateTime extends Quantity` — a point in affine time-space): datetimes render as calendar dates instead of auto-scaled durations, the affine algebra is enforced at runtime (`datetime ± duration → datetime`, `datetime − datetime → duration`; `datetime + datetime`, `datetime * n`, `−datetime` rejected), and the typechecker carries a distinct nullary `TDateTime`. Still **Future**: calendar-aware arithmetic (`now() + 1 month`, variable-length months — `calendar_add` is loaded but blocked by a polymorphic-zero bug on its `span == 0` guard and the unimplemented `_add_months` / `_add_years` FFI), and timezone *conversion* via `->` (`datetime -> tz("…")` / `-> UTC`, which the `->` operator doesn't yet apply for a function-valued RHS).

Considered and *rejected* from the Soulver feature set:
- **Contextual percentages** (`50 + 20%` → 60, `20% off 50`). `20%` is the number `0.2` at runtime, indistinguishable from a bare `0.2` — so making `+`/`-` reinterpret a percent RHS needs an AST-level special case, and then `50 + 20%` ≠ `p = 20%; 50 + p`. Same literal-vs-variable inconsistency as the CSV-unit / comparison-poison cases. The everyday utility doesn't outweigh the trap.
- **`of` as a multiply word** (`20% of 50`). Clean and unambiguous, but small enough that it's not worth a keyword; `0.2 * 50` already reads fine.

---

## 8. Roadmap out-of-scope

For clarity and to prevent drift. (These are in addition to the core "Out of scope" section above, which forbids them at the language level.)

- **Sync across devices** — not a single coherent feature yet. The URL-share pattern from §3 covers ~70% of cross-device needs (export URL on one device, bookmark on another via browser sync). Real sync would require either: (a) cloud-provider OAuth via PKCE (Drive / Dropbox / OneDrive — no client secret needed, works for SPAs by design, ~500 LOC per provider plus conflict resolution); (b) WebDAV for users running their own server (Nextcloud / ownCloud); or (c) peer-to-peer transfer via WebRTC (handles "send to my other device" but not ongoing sync). The right architectural home for any of these is a shared VFS abstraction, not ep-specific code. Build URL-sharing now, defer cloud sync until VFS has the backends.
- **Multiplayer / shared editing** — auditable's lane, not ep's.
- **Block-model input chips** — different product or future phase (see SPEC.md's note on `Grid<T>` types).
- **AI-suggested next steps** — off-brand; ep's pitch is "just math, deterministic." Adding AI features would actively undermine that positioning.
- **Cloud features generally** — encourage exporting to `.html` or sharing via URL instead. If cloud sync ships eventually, it ships through VFS for the whole GCU stack, not as an ep-only feature.
- **Theming beyond Switchboard light/dark** — Switchboard is the brand. Custom user themes are a feature ladder we don't need to climb.
- **Soft-delete with undo** — delete is delete. The confirmation dialog is enough friction; trash semantics add state nobody asked for.

---

## 9. PWA updates

How users get new versions of ep. Not optional once ep is deployed — without an update story, users either never see new versions (if their tab stays open forever) or get them randomly mid-edit (if auto-skip is naively enabled). Worth designing on purpose.

### 9.1 The mechanics

ep is served at `https://gentropic.org/ep/` (or wherever it ends up hosted). On first visit, a service worker (`sw.js`) registers and caches the assets. Subsequent visits load from cache — fast, works offline.

The browser auto-checks for a new `sw.js` periodically (typically every 24 hours, also on app launch in most browsers). On byte-difference, a new service worker installs in parallel with the old one and enters a "waiting" state. The new SW doesn't take over until either:

- All tabs controlled by the old SW close (default behavior, conservative)
- Or the page sends a message asking the new SW to `skipWaiting()` and then reloads

The waiting state is deliberate platform behavior: don't change the running version under the user's feet.

### 9.2 The UX pattern

For ep, layer three mechanisms:

**Quiet wait by default.** New SW installs in the background, doesn't activate until next reload. Zero interruption.

**Soft notification when an update arrives.** When the SW reports a waiting worker, surface a one-time non-blocking toast at the bottom of the drawer: `ep v0.1.3 available · reload`. Tap the link to apply.

**Settings button in the drawer's about section.** Permanent affordance: `check for updates` button. Shows current version, last-checked time. When an update is pending, the button becomes `reload to update`. Manually opening the drawer also triggers an opportunistic `registration.update()` check.

This combination handles the three personas:
- Users who reload constantly → get updates naturally, no UI needed
- Users with always-open tabs → see the toast, decide when to reload
- Power users who want to verify → tap the settings button

### 9.3 Implementation sketch

Main thread (`main.js`):

```js
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      incoming.addEventListener('statechange', () => {
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          // Had an old version AND a new one just installed
          showUpdateAvailable();
        }
      });
    });
  });

  // Exposed for the about-section button and on-drawer-open trigger
  window.epCheckForUpdate = async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  };

  // Exposed for the toast link and the about-section "reload to update" button
  window.epApplyUpdate = async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && reg.waiting) {
      reg.waiting.postMessage({type: 'SKIP_WAITING'});
    }
    window.location.reload();
  };
}
```

Service worker (`sw.js`):

```js
const VERSION = 'v0.1.2';
const CACHE = `ep-${VERSION}`;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([
    '/', '/index.html', '/manifest.json', /* …assets */
  ])));
});

self.addEventListener('activate', e => {
  // Clean up old caches
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
});

self.addEventListener('fetch', e => {
  // Cache-first with network fallback (standard offline-first pattern)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
```

Bumping the `VERSION` constant on each release is what invalidates the old cache. Both `main.js` and `sw.js` should read this from a shared source — either hardcoded in both files (with a build-step assertion that they match) or injected at build time.

### 9.4 About-section content

Replace the current static about text with version + update status:

```
ABOUT
ep · eval-print calculator
v0.1.2 — installed 2 weeks ago
Last update check: just now
syntax inspired by Numbat
part of the GCU stack

[ check for updates ]
```

When an update has been detected and is waiting:

```
ABOUT
ep · eval-print calculator
v0.1.2 → v0.1.3 ready
syntax inspired by Numbat
part of the GCU stack

[ reload to update ]
```

The "installed N ago" timestamp comes from `localStorage["ep:installedAt"]` set on first run. "Last update check" comes from a timestamp set after each `epCheckForUpdate()` call.

### 9.5 The exported-standalone-HTML angle

The `location.protocol !== 'file:'` guard in the registration call gives us a clean architectural property for free:

- **Hosted PWA** at `https://gentropic.org/ep/` — registers SW, supports updates, install prompt, offline-capable. Living product.
- **Exported standalone HTML** — opened from disk, doesn't register SW, behaves exactly like a saved document. Open it from a USB stick in 5 years; same code, same program. Frozen snapshot by design.

Same source file, different runtime behavior depending on origin. No special handling needed beyond the protocol check. The exported about-section just shows the version it was exported from with no update affordance.

### 9.6 What can go wrong

- **Schema migration.** If `ep:programs` schema changes between versions, the new code needs to handle the old format. Standard practice: on boot, check for a `schemaVersion` field; if missing or older, run a migration before normal evaluation. Keep migrations cheap and idempotent.
- **Mid-edit reload.** Autosave debounce is 400ms; if the user taps "reload to update" within 400ms of an edit, that edit might not have persisted yet. Either flush autosave synchronously before reloading, or accept this as a tiny edge case.
- **Cached old `index.html` after SW update.** If `index.html` references the old `main.js` URL while the cache holds the new one (or vice versa), things break weird. Standard mitigation: hash assets in their filenames (`main-abc123.js`) and reference them from index.html. Build step handles this.
- **Stuck waiting worker.** Some users will have a tab open for weeks with a waiting worker that never activates. The toast / settings button is what gets it across. If they ignore both, that's their choice.

### 9.7 Effort

S–M total. The boilerplate is ~50 LOC of SW + ~30 LOC of main-thread plumbing + the about-section UI (~20 LOC). Schema migration code adds up over time but is small per migration.

---

## 10. Long-running jobs and progress

For the heaviest current use cases (scalar ore-body math, parameter sweeps over a few hundred values), this section is overkill. Once `Grid<T>` and block-model handlers land — even on toy 1M-cell datasets — it becomes load-bearing. Build the protocol early so the shell-kernel contract carries progress reporting from day one; the UI treatments here can grow as use cases require.

### 10.1 The platform reality

PWAs cannot do true persistent background processing. When the page closes, the worker is killed. When the user switches tabs, the worker keeps running on a best-effort basis — the OS may suspend or kill it under memory pressure, but it usually survives a tab switch for minutes-to-hours. There is **no API** for "run this computation in the background, wake me up when done."

The relevant W3C discussion is open (ServiceWorker issue #1728) and the dormant Progress Notification API proposal aimed at exactly this case, but neither is shipping anytime soon. Periodic Background Sync, Background Sync (one-time), and Push API are wrong tools — they're for network sync, not arbitrary computation, and Push requires a server ep doesn't have.

What ep *can* do, layered:

1. Foreground worker with inline progress UI
2. Background-tab worker with local notification on completion
3. Resumable via IDB checkpoints for genuinely long jobs

This covers ~99% of the "let it rip and tell me when done" experience. The missing 1% is "close the laptop and walk away" — genuinely not a thing the web platform offers.

### 10.2 The shell-kernel job protocol (architectural)

Even before any of the UI affordances below, the kernel-shell contract should carry job-level message types. This is part of the broader kernel-shell architecture (see future `ARCHITECTURE.md`) and isn't ep-specific — every shell hosting numbat-js (or any other GCU kernel) benefits.

Message types:

```js
// Shell → Worker
{type: "evaluate", jobId, source, params}
{type: "cancel",   jobId}

// Worker → Shell
{type: "progress", jobId, fraction: 0.43, label: "computing tonnage", eta: 8.2}
{type: "result",   jobId, outputs: {...}}
{type: "error",    jobId, error: {message, span}}
{type: "checkpoint", jobId, state: {...}}  // optional; for resumable jobs
```

Most short jobs simply emit a single `progress: 1.0` immediately followed by `result`. The protocol is uniform regardless of expected job length — instant scalar calcs and minute-long reductions go through the same path. The shell decides when to show progress UI based on duration (typically: wait 300ms before showing anything, so quick jobs never flash a bar).

### 10.3 Inline progress UI

For jobs that pass the 300ms threshold:

- **Header status line** replaces the save indicator: `computing tonnage · 45%`, with a small spinner and a tap-to-cancel `×`. Color is `--sw-amber` while in progress, `--sw-green` on completion, `--sw-red` on cancel/error.
- **Per-output spinner on the relevant chip.** The `@outputs` chip shows a small spinner where the value would go, plus its own fraction text. Useful when only one output is heavy and others are instant.
- **Cancellation.** Tap the `×` next to the header status → main thread posts `{type: "cancel", jobId}` to the worker. Worker checks for cancellation between chunks and exits cleanly. UI returns to last-good state immediately.

If progress reporting is unavailable (job didn't emit `progress` messages), show an indeterminate spinner instead of a fraction.

### 10.4 Chunked workers

The Worker processes the job in chunks rather than all at once. After each chunk:
- Yields the event loop (`await new Promise(r => setTimeout(r, 0))` or similar)
- Posts a progress message
- Checks the cancellation flag (set by `{type: "cancel"}` messages)

For numbat-js operations over grids, the chunk size should be tuned so each chunk takes ~50ms (smooth progress updates, responsive cancellation, low overhead). Default chunk size starting point: 50,000 elements per chunk for scalar-shaped reductions. Tunable per-handler — denser ops want smaller chunks, simple ops want larger.

### 10.5 Background-tab notification

When `document.visibilityState === 'hidden'` and a job completes that ran for more than ~10 seconds total, fire a local `Notification`:

```js
new Notification('ep · tonnage computed', {
  body: '216 kt — tap to view',
  icon: '/icon.png',
  data: {jobId},
});
```

The notification's `onclick` brings the tab to front via `window.focus()`.

**Permission flow.** Don't ask for notification permission on first load — that's hostile. Ask the first time a user starts a job estimated to take > 30 seconds, with explanatory copy ("ep can notify you when this finishes if you switch tabs. Allow notifications?"). Users who decline never see this prompt again. Users who allow get notifications going forward.

**Opt-out toggle** in settings. Some users explicitly hate desktop notifications — let them disable the entire mechanism without revoking browser-level permission.

### 10.6 IDB checkpoint and resume

For jobs that legitimately run for minutes, write progress to `ep:jobs` IDB store every ~5 seconds (or every N chunks, whichever is larger):

```js
ep:jobs[jobId] = {
  programName: "block_model_reduce",
  startedAt: 1715792345000,
  lastProgressAt: 1715792400000,
  fraction: 0.43,
  partialState: {accumulator: {...}, iteratorCursor: ...},
}
```

On ep boot, scan `ep:jobs`:
- Jobs younger than 24h with `fraction < 1.0` are candidates for resume
- Surface them in the drawer or via a one-time toast: `Interrupted job from 2h ago · resume?`
- Tap to resume the worker from the saved state
- Tap dismiss to abandon (deletes the job entry)

Stale entries auto-expire after 24 hours of inactivity. Don't keep them forever — IDB has room, but stale UI surface is hostile.

Resumability requires per-handler support. Streaming reductions (Welford, t-digest, sum, count) are trivially resumable — the partial state is the accumulator. Other operations (e.g. anything iterative with non-monotone state) may not be; mark them as non-resumable and just rerun on resume.

### 10.7 What to actually build, when

- **Now (v0.1):** the protocol shape from 10.2 — even if the only message types emitted are `result` and `error`. Lays the foundation; cheap to add later if the contract is wrong from day one.
- **When the first job exceeds ~500ms:** the inline progress UI (10.3) and chunked workers (10.4). Probably coincides with adding `iter` / `solve` primitives or list reductions.
- **When grid types land:** notification on completion (10.5) and checkpoint/resume (10.6). The first 10M-cell reduction is when these stop being theoretical.

### 10.8 Effort

| component | effort |
|---|---|
| Protocol shape only (placeholder messages) | S |
| Inline progress UI + cancellation | S |
| Chunked worker pattern | S (per handler) |
| Background-tab notification + permission flow | S |
| IDB checkpoint + resume offer | M |

Total: M–L for the full stack, but spreadable over multiple releases. The protocol shape is the only piece that's hard to retrofit, which is why it's worth nailing down before the rest.

---

## 11. Implementation order (suggested)

If picking what to ship first, in order:

1. **§1 (drawer / autosave / persistence)** — first wave; already designed in the mock, just port faithfully
2. **§10.2 (job protocol shape)** — get the message types right in v0.1 even before there's any long-running work; retrofitting later means rewriting the kernel-shell boundary
3. **§2.3 (per-program descriptions)** — tiny code, huge UX win once programs accumulate
4. **§9 (PWA updates)** — not optional once deployed; build alongside the initial PWA wiring
5. **§3 (URL sharing + QR)** — the killer feature beyond what's in the mock
6. **§6.4 (first-launch tutorial)** — highest-leverage cosmetic investment for unfamiliar-user conversion
7. **§7.4 (snapshots / history)** — turns ep from "scratch pad" into "trustworthy for serious work"; co-migrate to IDB at the same time
8. **§7.5 (param scenarios)** — natural companion to snapshots, lighter to implement
9. **§2.1 (keyboard shortcuts)** — power-users notice immediately
10. **§5.1 (copy-as menu)** — visible improvement, low risk
11. **§4.1 (syntax highlighting)** — the natural moment to vendor CodeMirror 6
12. **§10.3–10.4 (progress UI + chunked workers)** — when the first job actually goes long enough to need them
13. **§5.4 (format directive)** — once people have real reports to produce
14. **§10.5–10.6 (notification + checkpoint/resume)** — when grid types land
15. Everything else — as use cases pull

Roughly the first six deliver the bulk of the value (mock, protocol, descriptions, updates, URL-share, tutorial); the next two (snapshots, scenarios) raise ep's seriousness ceiling; the rest are visible polish or scale-driven work.

---

*Roadmap section originated as a separate ENHANCEMENTS.md, May 2026, merged in alongside the original spec. Will drift during implementation; treat as a guide rather than a contract.*
