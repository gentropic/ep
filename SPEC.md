# ep — design spec

`ep` is a single-file browser-native calculator that turns one-off calculations into shareable parameterized forms. It's part of the GCU stack — sibling in spirit to `calque`, `dee`, `gcu-press`, `plan`, `rv` (which live in the `auditable` repo) — but ships standalone from its own repo at `gentropic.org/ep`.

The language ep-script is **Numbat-shaped** — syntax inspired by [Numbat](https://github.com/sharkdp/numbat) (David Peter, MIT) — with deliberate simplifications and two form-builder directives (`@params`, `@outputs`) original to ep.

**Status:** pre-0.1. This document describes what the working mock proves and what production should preserve. Expect drift during implementation.

**Working artifact:** `index.html` in this folder is the program. Vanilla JS, ~1700 LOC, no dependencies. When sources are split for development (see *File layout* below), this file will be produced by `build.js` from `src/` rather than edited directly. Read it alongside this doc.

---

## What ep is, what it isn't

ep is in **CalcNote / Soulver** territory — a notepad calculator where you type math and see results inline — with two pieces of differentiation neither competitor has:

1. **Dimensional analysis on geological units.** `1.5 g/t * 100 Mt → 150 t` works. So does sieve mesh, density, grade in any expression of ppm/ppb/g/t/oz/lt. Catches `length + mass` as a dimension mismatch.

2. **Programs are shareable single-file forms.** A program with `@params { … }` and `@outputs { … }` exports as a standalone HTML file your colleague can open, fill in different inputs, and read the results — no server, no install, no auth, no infrastructure. Same auditable single-file ethos as the rest of the GCU stack.

ep is *not*:
- A scientific calculator in the HP-15C sense (no stack mode, no RPN — the keypad mock is in `prior-art/ep-mock-rpn.html` for reference but was retired)
- A spreadsheet (that's calque)
- A general-purpose programming language (no mutation, no I/O, no async, no classes)
- A symbolic CAS (no algebra, no equation solving — those are different tools)

---

## Two views, one source

The same program has two presentations:

**Designer view.** What the program author sees. Editor body shows the full source. `@params { }` block is visible as text with a chevron to collapse it; chips appear above as an editing affordance for the inputs. `@outputs { }` directive is visible as text; chips appear below for the results. Accessory bar of tokens/units sits at the bottom.

**Form view.** What a consumer of the program sees. Editor body is hidden behind a "show calculation" toggle. Big input chips at top, big output chips at bottom with copy buttons. Accessory bar hidden. This is what the exported `.html` opens to by default.

A `form / editor` toggle in the header flips between them in the designer; exported HTML respects the same flag.

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
| anonymous expression | `area * 2` (shows result; doesn't bind) |
| comment | `# explanation` or `-- explanation` |
| `@params { … }` block | reactive input panel (multi-line) |
| `@outputs { names }` directive | output panel selection (single line) |

No `let`, no `fn`, no `if/then/else` statement form, no `while`/`for`, no `return`. The language is pure expressions plus directives.

### Expressions

Infix arithmetic with standard precedence:

| precedence | operators | associativity |
|---|---|---|
| 1 (highest) | `^`, `**`, `²` `³` (unicode exponents) | right |
| 2 | `*` `×` `·`, `/` `÷` | left |
| 3 | `+`, `-` `−` | left |
| 4 (lowest) | `->` / `to` / `→` (unit conversion) | left |

Unary minus, parens. Function calls `f(arg)`. Constants `pi`, `e`. Number literals: integer, decimal, scientific (`1.5e-3`), underscore separators (`12_345`).

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

### `@params { … }` block

A multi-line block with binding-shaped contents. Each line declares a reactive input parameter:

```ep
@params {
  length            = 200 m
  width             = 50 m
  thickness         = 8 m
  density : Density = 2.7 g/cm3
  grade             = 1_800 ppb
}
```

Behavior:
- Each line behaves as a normal binding: visible in scope from that point forward.
- The chip panel above the editor renders these as user-editable input chips.
- Editing a chip writes through to the body source line, preserving the prefix up to `=` (annotation and indentation survive).
- Editing the source line live-updates the chip.
- When the user changes a parameter (in either place), all bindings transitively depending on it re-evaluate.

Programs without an `@params { }` block don't show a top chip panel. Naked bindings still work.

### `@outputs { … }` directive

A single line listing names of bindings to promote to the output panel:

```ep
@outputs { tonnage, metal, metal_oz }
```

The block is purely a layout directive — it doesn't define or modify the named bindings, just promotes them to the bottom chip panel where each gets a copy button. Names must refer to existing bindings; missing names show as `undefined` in the output chip.

Programs without an `@outputs { }` directive don't show a bottom panel.

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

Single global scope. No `let`-locals, no function scope (because no `fn` yet).

When `fn` lands (deferred to a later version), function parameters and `let` bindings inside fn bodies will form local scopes. Top-level scope visibility rules will be unchanged.

### Reactivity / evaluation order

Programs are evaluated as a DAG:

1. Parse all bindings (params, body, output names).
2. Resolve names — each binding's body references zero or more other bindings.
3. Topologically sort. Cycles detected and reported.
4. Evaluate in order.
5. On any source edit: identify the transitive downstream set of changed bindings; re-evaluate only those.

Identical to auditable's notebook reactivity model. Users coming from auditable need no new mental model.

**Current mock:** does full-recompute on every edit. Production should do incremental DAG reactivity (see *Performance future* below).

### Errors

All errors carry line and column. Three categories:

**Parse errors** — bad syntax. Reported at the offending token.

**Name errors** — referenced binding doesn't exist, forward-referenced (cycle), or referenced output name has no binding.

**Dimension errors** — type mismatch in arithmetic, conversion to incompatible dimension, or annotation mismatch:

```
density : Density = 2.7 g
  annotated Density but got [mass]
```

Errors halt evaluation of the affected binding but don't crash the script. Independent bindings continue evaluating. The errored binding shows its error inline (red text in the result margin).

---

## Behavior

### Two-way chip ↔ source sync

The body source is the single source of truth. Chip panels are views.

- Editing a chip → updates `state.body[N].src` for the corresponding line → re-evaluates → re-renders the body row in-place.
- Editing a body line inside `@params { }` → re-evaluates → re-renders chips.
- Adding a new binding inside `@params { }` (just typing a new `name = expr` line) → a new chip appears.
- Removing a line → its chip disappears.

### Collapsible blocks

Block-opening rows (e.g., `@params {`) carry a chevron toggle. Tapping it collapses the block to its opening line plus a summary (`@params { … 5 inputs }`); chevron rotates. Tapping again expands. Per-block collapse state lives in `state.ui.collapsedBlocks` and survives export.

The mechanism is generic — when `fn name() = { … }` or other multi-line forms land, they get the same affordance for free.

### Export

Three formats from the export dialog:

- **`.ep` source** — plain text of `state.body`. Round-trips back through `open`/drag-drop without loss.
- **`.html` standalone** — self-cloning HTML. The page reads its own `outerHTML`, replaces the `INITIAL_STATE` block (delimited by `/* MARKER:STATE_START */` / `/* MARKER:STATE_END */` sentinels), and offers the result as a download. The exported file is structurally identical to ep itself, with the program baked in as initial state and `formView: true` set as default UI. No PWA manifest, no service worker — it's a single HTML file that opens with double-click on any platform.
- *(future)* QR-shareable form via `@gcu/pointer` — not implemented; gated on the broader GCU asset addressing work.

The `.html` export is the killer feature. The pitch is: *you wrote a calculation once; now your colleague opens it as a form you can edit and read but can't accidentally break.*

### Import / load

Three input paths, all feeding the same `loadProgramText(text, sourceName)`:

- **File picker** behind the `open` header button (accepts `.ep`, `text/plain`).
- **Drag-and-drop** anywhere on the window. A Switchboard-orange overlay appears during the drag with "DROP .EP FILE / to load it into the editor". Release to load.
- **(future)** clipboard paste — not implemented; conflicts with chip-paste UX, needs a deliberate gesture.

Load wholesale-replaces `state.body`, discards stale collapse state, re-evaluates, and updates the header filename (extension stripped).

**Not implemented but worth adding:** an "unsaved changes" warning before clobbering a modified program. For mock-grade this was skipped; for production it's the right move.

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

ep-script deliberately diverges on:

- **No `let` keyword.** Bindings are `name = expr`. The scratch-pad form feel matters; every required keyword is friction for the calculator audience.
- **No type annotations on parameters of `fn`** (when `fn` lands). Numbat has them; ep won't unless it earns its keep.
- **No generics, no monomorphization.** Numbat has dimension generics (`fn my_sqrt<T: Dim>(q: T^2) -> T = q^(1/2)`). ep doesn't, for v1.
- **Dropped:** Numbat's `where`, `|>` pipe, modules (`use`), dimension definitions, unit definitions, decorators (`@aliases`, `@metric_prefixes`), strings, datetime, lists. All future-extensible if a real use case pulls.
- **Added:** `@params { }` and `@outputs { }` directives, which are ep's actual differentiation. Both are syntactically harmless extensions — a Numbat-only subset of an ep program is valid Numbat.

A program written in ep that doesn't use `@params` or `@outputs` should round-trip through Numbat without modification. A Numbat program with no generics, no unit definitions, and no module imports should parse in ep. Full feature compatibility is *not* a goal, but syntactic kinship is.

### Originator courtesy

ep and this spec are derivative-by-syntax of Numbat. The implementation is original (no Numbat code ported). Under the principle that **license-permission is not social-permission**, before publishing ep publicly we should open a courtesy issue or discussion on the Numbat repo describing what we're doing — not asking permission (MIT covers it) but giving the maintainer awareness and a chance to weigh in or object.

README must credit Numbat prominently in its first paragraph. Suggested wording:

> ep-script is a JavaScript implementation of a calculator-shaped subset of [Numbat](https://github.com/sharkdp/numbat) (David Peter, MIT), extended with form-builder directives (`@params`, `@outputs`) original to ep. Programs without these directives are syntactically valid Numbat.

---

## Implementation plan

ep is already the working artifact. The "0.1" target is hardening what exists in `index.html` and refactoring for maintainability — not graduating to a different repo.

### Phase 1 (path to 0.1)

| step | rough effort |
|---|---|
| Split sources for development (`src/template.html` + `src/style.css` + `src/js/*.js`) with a small `build.js` that concatenates them into a single `index.html`. No bundler, no transpile. Preserve the `/* MARKER:STATE_… */` self-cloning contract through the build. | 1 evening |
| Vendor CodeMirror 6 under `ext/cm6/` and replace `<input>` rows with a real editor — syntax highlighting, multi-line wrapping, proper editor affordances. Inline at build time. | 1 day |
| Pre-0.1 polish: error message quality (match Numbat's bar), edge cases, mobile keyboard ergonomics, save-confirm dialog before clobbering an unsaved program. | 1 day |

### Phase 2 (post-0.1, language features)

- Incremental DAG reactivity (see *Performance future* below)
- `fn name(args) = expr` function definitions (~50 LOC)
- `if(cond, a, b)` as expression (~30 LOC)
- `iter`, `solve`, `root`, `integrate` primitives (~150 LOC)
- Lists + `map`/`filter`/`reduce` (~200 LOC)

### Phase 3 (numbat-js, co-located in this repo)

Full Numbat port to JS lives under `ext/numbat/` in this repo, not in a separate package. ep is the primary consumer and feature-driver, and ep's single-file ship constraint shapes the library's API more than any other potential consumer's. Can fork into its own repo (e.g. `gentropic-org/numbat-js`) once the surface stabilizes. ep adopts it transparently when ready since the syntax is already compatible — at that point the inline `UNITS` table + `Q` class in the built `index.html` get replaced by inlined code from `ext/numbat/`.

---

## Performance future

For the form-builder use case, the mock's tree-walker is already fast enough. The optimizations matter when:

- Programs grow past ~50 bindings (real Vale-shaped use cases)
- Exported forms get embedded with live data feeds (auto-recompute on streaming inputs)

Worth building when the need is real, not before:

1. **Two-tier IR.** Cold path stays tree-walker; hot bindings compile to specialized closures with dimensions erased, just raw float ops. V8 monomorphizes hard from there.

2. **Incremental DAG reactivity.** Track which bindings depend on which. On `@params` change, re-evaluate only the transitive downstream set, not the whole program. Probably 10-50× speedup for typical edit-and-watch use.

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

These are the decisions that haven't been forced yet. Worth being explicit before they get answered by accident.

- **Functions.** `fn name(args) = expr` is the natural next addition. Format-builder use cases mostly don't need them (the form *is* a function, in a sense). Worth waiting for a real user request rather than speculating.
- **`@outputs` UI for adding/removing.** Currently you edit the `@outputs { … }` directive line directly. A pin icon on each binding row to toggle "include in output panel" is the natural gesture but isn't implemented.
- **Error message quality.** Numbat sets a high bar (multi-line traces with both operands' dimensions, span pointers). The mock does the basic version. Production should match.
- **Save-on-edit / autosave.** Programs currently exist only in-memory unless exported. An IndexedDB-backed autosave + recent-files list is a natural Phase 2 addition; could vendor or mirror auditable's VFS layer if one materializes there first.
- **Form-view-only export.** Currently the exported `.html` is a full clone of the designer with `formView: true` defaulted on. Power-users can hit "editor" and modify the program. For some use cases (handing a sealed form to a consumer), a strip-the-editor option would be wanted. Not urgent.

---

## File layout

This repo is the ship target. The single-file artifact lives at the root; sources split for development:

```
ep/
  README.md
  SPEC.md              ← this document
  LICENSE
  .gitignore
  build.js             ← concatenates src/ into index.html, no deps
  index.html           ← built artifact; served at gentropic.org/ep
  src/
    template.html      ← <head>, body skeleton, STATE markers
    style.css          ← Switchboard tokens + ep-specific
    js/
      main.js          ← entry point (concat order matters)
      state.js
      units.js         ← thin re-export from ext/numbat/ once Phase 3 lands
      parser.js
      evaluator.js
      chips.js
      editor.js
      export.js
      import.js
      menu.js
      init.js
  ext/
    cm6/               ← vendored CodeMirror 6 (Phase 1)
    numbat/            ← co-located numbat-js port (Phase 3)
  prior-art/
    ep-mock-rpn.html       ← retired stack-mode prototype
    ep-mock-notepad.html   ← intermediate notepad pass
    ep-mock.html           ← original keypad pass
```

Until Phase 1's source-split lands, `index.html` at the root is edited directly.

---

*Document originated in design conversation, May 2026. Will drift during implementation; treat as snapshot rather than spec-as-law.*
