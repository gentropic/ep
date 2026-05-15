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

---

# Enhancements roadmap

This section describes features beyond the v0.1 core that have been designed but not all built. The earlier sections of this document define ep's design contract; this section is the roadmap of what comes after.

Items are grouped by category; within each category they're roughly ordered by value-to-effort ratio. Each carries an estimated effort flag (S = afternoon, M = day, L = multi-day) and notes about prerequisites.

---

## 1. Drawer / menu / persistence

The hamburger drawer, multi-program storage, and autosave indicator are the first wave of post-v0.1 features. Reference this section when iterating on persistence behavior.

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
localStorage["ep:programs"] = {
  "ore_body": {
    body: ["line 1", "line 2", …],
    updatedAt: 1715792345000,
  },
  "untitled": { … },
}
localStorage["ep:current"] = "ore_body"
```

**Migration to a future VFS abstraction** is the only seam: `readStore()` and `writeStore()` are the only two functions to swap. Schema can stay; just back it onto VFS instead of localStorage.

**Storage backend pivot to IndexedDB** is recommended once snapshots (§7.4) and scenarios (§7.5) land. localStorage's ~5MB per-origin quota is fine for the v0.1 schema (program bodies are small text) but gets cramped quickly once each program carries a history of past versions. IDB is effectively unlimited (browsers typically grant up to ~60% of disk), async, and offers structured indexes for fast "list programs by recency" queries. The same `readStore()` / `writeStore()` seam handles the migration — caller code doesn't need to know the backend.

On boot: read `ep:current`, restore that program's body, evaluate, render. First-run seeds the demo into storage so the drawer isn't empty.

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

## 2. High-value polish — recommended first wave

These are small additions that meaningfully improve the experience without changing the design's shape. Implement in any order.

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

## 3. URL sharing + QR generation

This is the highest-leverage workflow feature in ep beyond the drawer. Detailed because it has subtleties.

### 3.1 The mechanism

ep's URL is `https://gentropic.org/ep/` (or wherever it ends up hosted). A shareable program URL is:

```
https://gentropic.org/ep/?p=<base64url-encoded(lz-compressed(source))>
```

On boot, after the normal restore-from-storage path:
1. Read `location.search` — if it has `?p=...`, decode and decompress
2. Load the decoded source as a fresh untitled program (don't clobber the current program)
3. Replace the URL with the clean `https://gentropic.org/ep/` via `history.replaceState` so a refresh doesn't re-trigger
4. If the user keeps editing the loaded program, it autosaves into storage like any other program

**Note about installation:** This works whether or not the PWA is installed. If installed, Android Chrome routes the URL to the standalone PWA window. If not, it opens in a regular browser tab — same code path either way. No special manifest configuration required for this to work.

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

### 3.7 Future: pointer-based addressing

When a GCU-wide pointer registry exists, the URL pattern becomes:

```
https://gentropic.org/ep/?p=sha256:<hash>
```

ep resolves the pointer through the GCU pointer registry instead of decoding inline. Same URL shape from the user's view; different resolution path. Programs become content-addressable across the GCU stack. Migration is transparent — ep tries pointer-resolution if it sees a `sha256:` prefix, falls back to inline-decoding otherwise. Both URL forms remain valid forever.

---

## 4. Editing affordances

Improvements to the body editor that make day-to-day editing better.

### 4.1 Syntax highlighting (M)

Currently the body uses plain `<input>` rows. Replace with a vendored CodeMirror 6 under `ext/cm6/` and provide a Numbat-shaped highlighter.

Token categories to color:
- Comments (`#` and `--` to end of line) — `--sw-text-soft` italic
- Keywords (`@params`, `@outputs`, eventually `fn`, `where`, `to`) — `--sw-orange`
- Identifiers — `--sw-text`
- Number literals — `--sw-text-mid`
- Unit names (anything in the units table after a number or after `->`) — `--sw-teal`
- Operators — `--sw-text`
- Type annotations (after `:` in a binding) — muted accent
- Error spans (see 4.2) — red underline

Numbat's VS Code extension has a tmGrammar file at `vscode-extension/syntaxes/numbat.tmLanguage.json` in the upstream repo. The token regex set there is a good starting point; just port the patterns to CM6's language definition format.

### 4.2 Error pinpoint (S, depends on 4.1)

When evaluation produces an error with a span (column range in the source), underline the offending token in red within the body row. Hover or tap shows the error message. Errors below the source row (current display) stay as fallback for line-level errors with no specific token.

Parser already tracks token positions; just isn't exposed in the AST yet.

### 4.3 Auto-pair brackets/braces (S)

In the body editor (and the `@params { }` block specifically), typing `(`, `[`, `{` inserts the matching close character with the cursor in the middle. Typing the close character when the next char is already that close just moves the cursor past. Backspace at the empty pair deletes both.

Standard editor affordance. CM6 has this built-in via `closeBrackets()` extension.

### 4.4 Tab-cycle through chips and body rows (S)

Hitting Tab in a chip input moves focus to the next chip. Shift+Tab to previous. Tab from the last chip moves to the first body row. Tab through body rows linearly. Tab from the last body row goes to the first output chip's copy button (or wraps).

Already mostly free from natural DOM tab order, but currently broken because some intermediate elements are tabbable. Audit `tabindex` across the layout and set `-1` on elements that shouldn't be reached by Tab.

---

## 5. Output formatting

How results display, and how users get them out of ep.

### 5.1 Copy-as menu on output chips (S)

Long-press an output chip → menu with multiple format options:

- `copy as number` — `216000` (raw canonical value, no unit, no separators)
- `copy as value` — `216,000 kt` (current display format with thousands separators)
- `copy as plain text` — `216 kt` (auto-scaled, separator-stripped — current tap behavior)
- `copy as JSON` — `{"value": 216, "unit": "kt", "dimension": "mass"}` (structured)
- `copy as LaTeX` — `216\,\text{kt}` (with proper LaTeX spacing)
- `copy as ep-script literal` — `216 kt` (ready to paste into another ep program)

Reuses the long-press helper from the drawer.

Quick tap still copies the default `216 kt` plain-text format. Menu is for power use.

### 5.2 Significant-digits toggle (S)

Add a settings section in the drawer with a precision selector:

| option | example |
|---|---|
| 3 sig figs | `217 kt` |
| 4 sig figs (default) | `216.0 kt` |
| 6 sig figs | `216.000 kt` |
| full | `216000.0 kt` |

Setting lives in `localStorage["ep:settings"]` (separate key from programs so it's per-user, not per-program). Affects all output rendering uniformly. Per-output overrides via format directive (5.4) win when present.

### 5.3 Locale-aware separators (S)

Read `navigator.language` on boot. Pick decimal/thousands separators accordingly:
- `en-*` → `216,000.5 kt`
- `pt-BR`, `de-*`, `fr-*` and most of Europe → `216.000,5 kt`
- Allow explicit override in settings

Implementation lives in `fmtNum`; everything else flows through it.

### 5.4 Format directive in source (M)

A new top-level directive:

```ep
@format {
  tonnage: "0.0 t"
  grade:   "0.000 g/t"
  metal:   "0 kg"
}
```

Patterns use the standard `0.00`/`#,##0.00` notation. When an output name matches a key in the directive, its display ignores auto-scale and global precision and follows the pattern instead.

Useful for reports where specific outputs need consistent representation across runs ("always show tonnage in t, always show grade in g/t to 3 decimals").

### 5.5 Live preview smoothing (S)

Body rows currently flicker their result text on every keystroke during typing. Add a 50ms transition on `.row-res` color and opacity to make this less jarring. Optionally, debounce result rendering by 30ms separately from evaluation, so the result text fades-in shortly after the user stops typing.

Tiny change, big polish gain.

---

## 6. Discoverability + onboarding

Help new users figure out what ep is for. Help returning users find what they want.

### 6.1 Examples section in the drawer (S)

A read-only section at the bottom of the saved-programs list (or as a separate drawer tab) with pre-made example programs. Tapping an example loads it as a new untitled program — the example itself stays unchanged.

Starter set:
- **Ore body tonnage** — the demo we already have
- **Unit conversions** — `3 in -> cm`, `60 mph -> m/s`, common reference values
- **Cutoff sensitivity** — varying a grade cutoff, computing tonnage above
- **Compound interest** — finance-shaped, demonstrates non-mining use
- **Projectile range** — physics-shaped, demonstrates trig
- **Pendulum period** — from the Numbat tutorial (with credit), demonstrates units in physics

Examples live in source — embedded in the bundle as `examples: { name: source }`, not in storage. Loading an example copies it into storage as a new program named e.g. `tonnage_example`.

### 6.2 Drawer sort options (S)

Small toggle in the drawer header (or in the search row from 2.2):

- **Recent** (default) — most-recently-edited first
- **Alphabetical**
- **Pinned first** — see 6.3

Stored in `ep:settings`.

### 6.3 Pinning programs (S)

Long-press menu gains a `pin` / `unpin` item. Pinned programs sort to the top of the drawer regardless of recency. Visual indicator (small `◆` glyph) next to the program name when pinned. Stored as a flag on each program record: `store[name].pinned = true`.

Useful when one program ("our standard QAQC checklist") is the daily-driver and ten others are one-off scratchpads.

### 6.4 First-launch tutorial (M)

On absolute-first launch (no entry in `ep:installedAt`), instead of going straight to the demo program, run a brief interactive walkthrough. ep's UI is unusual enough that a 60-second tour materially improves the conversion rate from "curious visitor" to "actual user."

**Four steps**, each tied to a real interaction rather than a wall of text:

1. **"Tap a chip to edit it."** Highlight one of the `@params` chips. Wait for the user to tap-and-edit. Show a "👀 nice" confirmation on success, then advance.
2. **"Watch the outputs update."** Highlight the `@outputs` chip panel. After the first re-evaluation completes, advance.
3. **"The chips are just source."** Highlight the body's `@params { }` block. Show that the line the user just edited (in the chip) is also visible in source. Tap-to-continue.
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

### 7.2 Inline error messages on chip-edit (S)

When a chip produces an error (invalid value, dimension mismatch with an annotation), show the error inline within the chip itself rather than only down in the body. The chip's result line (currently the right-side preview) goes red and shows the error.

Same data, more visible. The chip is where the user's eye is when they edit it.

### 7.3 Annotation auto-suggest (M)

When a user writes `density = 2.7 g/cm3`, the inferred dimension is `Mass / Volume` which matches the named `Density`. Offer a one-tap fixup: small `+ Density?` chip appears next to the binding for a few seconds. Tap to rewrite to `density : Density = 2.7 g/cm3`.

Pedagogically useful — teaches users the dimension type names without forcing them.

Logic: after evaluation, scan unannotated bindings. For each, check if the inferred dimension exactly matches a named dimension in the table. If yes and no annotation present, offer the fixup.

### 7.4 Snapshots / history (M)

Programs accumulate per-version snapshots so users can recover earlier states. This is the feature that turns ep from "scratch pad" into "trustworthy for serious work" — knowing you can recover a 20-minutes-ago state changes the psychological relationship users have with the tool.

**Data model** (extends the per-program record):

```js
store.programs["ore_body"] = {
  body: [...],                    // current state
  updatedAt: 1715792345000,
  snapshots: [
    {id: "snap_001", takenAt: ..., label: null, body: [...]},
    {id: "snap_002", takenAt: ..., label: "before tweaking grade", body: [...]},
    // newest last
  ],
}
```

**Snapshot triggers:**
- **Manual.** Long-press menu on a program → `snapshot now` → optional label prompt
- **Per-session auto.** First load of each program in a given session takes a silent snapshot of the current state before edits begin
- **Pre-destructive auto.** Before bulk operations (clear all, paste >5 lines, restore from another snapshot), take a silent snapshot. Avoids "undo my undo" lossy states

**Retention policy.** Keep all snapshots from the last 24 hours; keep last 20 older than that; user can pin individual snapshots to never auto-purge. Manual snapshots with labels are pinned by default.

**UI.** Drawer item gets a `▾ history` chevron below the program name (only shown when snapshots exist). Tap to expand inline — list of snapshots with timestamps and optional labels. Tap a snapshot to view it in a read-only modal; restore button there. Restoring creates a new snapshot of the current state first, then replaces the body with the snapshot's body.

**Why IDB.** Snapshots are where storage stops being cheap. A program with 20 snapshots at ~500 chars each is 10KB per program; 50 programs gives 500KB; user with 200 programs could exceed localStorage's ~5MB quota. IDB (effectively unlimited) is the right backend once this lands. The `readStore` / `writeStore` seam absorbs the change.

**Why this matters specifically for geologists.** Resource estimation workflows iterate dozens of times on the same calculation — different cutoffs, different assumptions, different bulk densities. The current "always overwrites" model is hostile to that workflow. Snapshots let users explore branches and come back without losing state.

### 7.5 Param scenarios (S)

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

**UI.** A small horizontal scroller above the `@params` panel showing scenario chips. Each chip is the scenario name. Tap to swap all params to that scenario's values. The currently-active scenario chip is highlighted in `--sw-orange`. A `+` chip at the end opens a "save current as scenario..." dialog (uses `epPrompt`).

When the user edits a param after selecting a scenario, the active-scenario chip goes back to unhighlighted, indicating "you're now off-scenario." Optional: a tiny "save changes to scenario" link surfaces in that state.

**Workflow this serves.** A geologist analyzing three different deposits with the same calculation — the math is identical, only the inputs differ. Currently they'd have three separate programs (`ore_body_pirita`, `ore_body_carajas`, ...) which fragment the calculation across multiple files and make updates painful. Scenarios consolidate them into one program with three preset configurations.

**Interaction with snapshots.** A snapshot captures everything including scenarios, so restoring an old snapshot brings back the scenario set as it was then. Switching scenarios doesn't create a snapshot (would be too noisy — scenario switches are everyday, not version-bump events).

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
