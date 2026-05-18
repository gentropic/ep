# ep

A unit-aware notepad calculator that exports itself as a standalone form.

ep is a small single-file web app: open `index.html` in a browser, type a calculation that uses real units (`length = 200 m`, `density = 2.7 g/cm3`, `volume = length^2 * width * thickness`), tag the inputs you want as `@input` and the results you want as `@output`, then **export the page as a new HTML file** that anyone can open, fill in different numbers, and read the answers. No install. No server. No account. No JavaScript runtime — just a browser.

Live at **[gentropic.org/ep](https://gentropic.org/ep)**.

Part of the [GCU](https://github.com/endarthur/auditable) stack of single-file working tools.

---

## The idea

A calculator that respects two things most calculators don't:

**Units are part of the math.** `200 m * 50 m * 8 m` is `80,000 m³`, not `80,000`. Add a `g/cm³` density and you get tonnes. Try to add a length to a mass and you get a dimension-mismatch error, not a silent wrong answer. This is the [Numbat](https://github.com/sharkdp/numbat) (David Peter, MIT) idea — ep adopts it via a co-located JS port of Numbat (`ext/numbat/`).

**Calculations want to be shared.** Most calculations live a private life — somebody types them once, gets an answer, throws it away. ep treats every program as a potential form. Tag inputs with `@input`, outputs with `@output(unit)`, hit "export", and you've got a single `.html` file your colleague can open. They get exactly your calculation, exactly your units, with sliders/dropdowns/text-boxes for every input. They never need to know it was you who set it up.

It's the same single-file-tool ethos as the rest of the GCU stack — a thing you can email, host on any static URL, or stash on a USB stick. It will work in a browser ten years from now without an internet connection.

---

## A first calculation

```ep
# Drill core sample

@input
core_size = NQ_core            # pre-registered DCDMA wireline sizes

@input
length = 5 m

@input
density = 2.7 g/cm3

@input
@options(granite, basalt, sandstone, limestone)
rock_type = granite

@output(L)
volume = cylinder_volume(core_size, length)

@output(kg)
mass = sample_mass(core_size, length, density)
```

What you get in the editor:
- **Top chip panel** with editable inputs for `core_size` (rendered as a `<select>` of every DCDMA core size), `length`, `density`, and `rock_type` (a `<select>` of the four rock types).
- **Body editor** with syntax-highlighted source, error underlines, and a per-line result gutter.
- **Bottom chip panel** with the two outputs, in the units you specified, with copy buttons.

Tap any input chip → result updates everywhere. Click a gutter result → menu of other compatible units. Open the export sheet → get a standalone HTML form that ships exactly this calculation to anyone.

---

## Syntax: ep-script

ep-script is a calculator-shaped subset of [Numbat](https://github.com/sharkdp/numbat) plus three form-builder decorators.

### Bindings

```ep
x = 5
density : Density = 2.7 g/cm3      # optional type annotation
let z = 2 * x                      # `let` is accepted but optional
```

### Expressions

Quantities with units, full arithmetic, unit conversion via `->` or `to`:

```ep
height = 6 ft + 2 in
speed = 60 mile/hour
speed_kmh = speed -> km/h
energy = 0.5 * 10 kg * (3 m/s)^2   # → 45 J
```

### Decorators (ep extension)

Three decorators adorn the binding *below* them. They use real Numbat decorator grammar, so a program using them parses cleanly through upstream Numbat too (decorators with unknown names are ignored at semantic time).

| Decorator | What it does |
|---|---|
| `@input` | The binding becomes an editable chip in the top input panel. |
| `@output[(unit)]` | The binding becomes an output chip in the bottom panel. Optional argument is a display-unit override (`@output(kg)`). |
| `@options(a, b, c, …)` | The binding's chip renders as a `<select>` with exactly those options. Skips evaluation when the value is a bare label. |

Decorators stack. Comments and blank lines between a decorator and its binding are tolerated:

```ep
@input
@output(L)             # an input chip AND an output chip
volume = some_expr
```

### Function declarations

Real Numbat `fn` syntax. Multi-line bodies aren't recognized yet.

```ep
fn compound(principal, rate, years) = principal * (1 + rate)^years

@input
years = 30

@output
future_value = compound(10000, 0.05, years)
```

### Built-in helpers

ep's prelude adds a few domain-specific things on top of Numbat's standard units:

- **DCDMA wireline drill core sizes** as length units: `AQ_core`, `BQ_core`, `NQ_core`, `NQ2_core`, `NQ3_core`, `HQ_core`, `HQ3_core`, `PQ_core`, `PQ3_core` (and `*_hole` variants). Values mirrored from [`gcu/units`](https://github.com/endarthur/auditable/tree/main/ext/units).
- **Tyler / ASTM sieve mesh sizes** as length units: `mesh4` … `mesh635`, where the multiplier is the aperture in metres. `mesh200 -> um` = 75 µm.
- **Helper fns:** `cylinder_volume(diameter, length)`, `sample_mass(diameter, length, density)`.
- **Imperial length / mass / volume** units (`ft`, `lb`, `ft³`, etc.) registered as input-only so auto-scale still prefers metric for display, but they show up in the unit picker for working with US/Canadian datasets.

See `ext/numbat/src/prelude.js` for the full list.

---

## The single-file artifact

ep is built as one self-contained `index.html` (~1.45 MB). Everything is inlined: the CodeMirror 6 editor (~600 KB), the numbat-js evaluator + 62 vendored stdlib modules, the QR-code encoder, ep's own JS, the CSS, the HTML. It loads from disk with no network requests.

When you export a program:

- **`.ep` file** — plain text of your source. Reopens cleanly in any ep instance.
- **Viewer HTML** — a slimmer purpose-built single-file form (~340 KB, no editor, no drawer) with your program baked in. Open it in any browser, fill in different inputs, read the outputs. Has its own copy of the evaluator + a "modify this calculation" link back to the full editor (optional — opt out at export time).
- **Share link** — `@gcu/pointer` fragment-based pointer (`#i:d<base64url>`). Long but copyable; resolution is client-side so the URL is never sent to a server.
- **QR code** — generated client-side. Uses the QR-optimised `q:d<base45>` pointer form (~22% denser in QR alphanumeric mode than the link form).

The exported viewer is meant to be the recipient's whole interaction: no install, no install instructions, no "this requires…" — just a URL or an attached file.

## Install as an app

ep ships as a PWA. On Chrome/Edge/Android, the address bar offers "install ep" once the page has loaded — it lands in your app drawer / home screen and launches in a standalone window without browser chrome. On iOS Safari, use "Add to Home Screen" from the share sheet.

The PWA isn't doing anything magical beyond installability — the single-file artifact already runs offline by virtue of having no network dependencies. The manifest + minimal service worker are there to let the OS recognize ep as installable and surface the right icon, theme color, and app name.

Your saved programs (including snapshot history) live in your browser's local storage and IndexedDB; they're not synced anywhere. Export to a file or share via the pointer URL to move them between devices.

---

## Status

Honest take, written 2026-05-17:

**What's working:**

- Full numbat-script evaluator (functions, generics, dimension/unit declarations, the standard math library, `if`/`then`/`else`, lists, structs, where clauses, multi-line fn bodies).
- Token-based parser with multi-line expressions and decorators (paren / bracket continuation just works).
- **HM-style dimension-aware typechecker** under `ext/numbat/src/typecheck/` (~2,150 LOC across 12 files). Pre-evaluation pass; surfaces dim mismatches, generic-instantiation failures, free-var consistency errors, and unknown-name errors with did-you-mean (Levenshtein) suggestions.
- **Inline error blocks** in the editor — when a row errors, a red/amber/info block widget renders directly below the offending line (no more gutter truncation). Same widget mechanism powers `print()` output (neutral gray info block).
- **Output blame** — when an `@output(unit)` mismatches the resulting dimension, ep traces backward through the expression to identify the culprit input. Error message names the suspect (`'thickness' has [time] but the chain needs [length]`) and the suspect's row gets an amber square marker in the gutter.
- **Shape-distinct gutter markers** — orange `▲` for inputs, teal `▼` for outputs, amber `▪` for blamed bindings, red `✕` for errors. Accessibility-friendly without relying solely on color.
- Three-layer formatter: whitespace normalization, decorator stacking, line-width-aware breaking (function calls, `@options(...)` lists, and long arithmetic expressions wrapped in parens). Idempotent. `Shift+Alt+F` or the drawer "format document" entry.
- DCDMA + Tyler/ASTM helpers, drill / sieve fns, ~25 derived unit names beyond the SI base.
- Single-file export in four shapes (file, viewer, link, QR). Share URLs use the `@gcu/pointer` Phase-1 grammar (fragment-based, `#i:d…` for links / `#q:d…` for QR).
- IndexedDB-backed program storage with per-program snapshot history (§7.4): manual or auto-on-session-first-load, retention pruning, pin / restore / delete from a slide-in history panel.
- Installable PWA — manifest, icons, minimal service worker. Install from Chrome/Edge or "Add to Home Screen" on iOS.
- Hamburger drawer with saved programs, search, sort, pinning, examples panel, settings panel.
- Light/dark theme toggle, configurable sig digits + format width, configurable bottom palette + new-file template, auto-hide of empty input/output panels.
- Mobile-friendly: floating result gutter (doesn't push body width), unit-picker bottom sheet, touch-friendly tap targets.
- Viewer artifact polish: program subtitle from first comment, accent-highlighted outputs panel, single-column on narrow screens, "modify this calculation" footer link that round-trips back to the editor via pointer.
- **749 tests** for the pure layers (units / parser / evaluator / typechecker / formatter / pointer / snapshot retention / conformance corpus); the DOM layers are exercised by manual browser testing only.

**What's not yet:**

- The "scenarios" feature (named presets of input values) ships but its UX is rough.
- No incremental DAG evaluation. Every keystroke re-evaluates the whole program. Fast enough for typical programs (sub-millisecond on the demo).
- No automated UI tests. JSDOM or Playwright would be nice when there's specific behavior worth pinning.
- Dataset-shaped values (lazy collections, masks, block models) — designed in `SPEC-DATASETS.md`, not built.
- `@gcu/pointer` Phase 2 reference loaders (`gh:` / `gist:` / `rentry:` / `url:`) aren't implemented — pointers using those schemes fall through to `EUNKNOWN`, which is the conforming graceful-degradation path per the spec.
- Multi-tab consistency — IDB writes from one tab don't propagate to another tab's in-memory cache. `BroadcastChannel` install is the natural fix when it bites.

**Recent syntax change (v0.1 → v0.2):**

The earlier `@params { … }` and `@outputs { … }` block syntax was replaced with per-binding `@input` / `@output` / `@options` decorators. Programs in the old block form no longer parse — but there shouldn't be any in the wild yet.

---

## Try it locally

No build step required to run — just open `index.html`:

```sh
git clone https://github.com/endarthur/ep
cd ep
# Then open index.html in your browser.
```

### Build from source

```sh
node build.js            # rebuild index.html + dist/viewer.html from src/
node --test              # run the test suite (749 tests, no deps)
```

Zero npm dependencies for the main build. `ext/cm6/` does use npm + rollup to produce the CodeMirror bundle, but the resulting `cm6.min.js` is committed so you don't need to rebuild it unless you're upgrading CM6 itself.

---

## Repository layout

```
index.html        ← built artifact, served at gentropic.org/ep
build.js          ← Node, zero deps; concatenates src/ → index.html
src/
  template.html   ← head, body markup, STATE markers
  style.css       ← Switchboard tokens + ep-specific
  js/             ← parser, evaluator, formatter, render, blame, settings, …
ext/
  numbat/
    src/          ← Quantity/dim runtime, parser, evaluator, prelude
    src/typecheck/← HM dim-aware typechecker (12 files, ~2,150 LOC)
    vendor/numbat/modules/  ← 62 vendored upstream .nbt modules
  cm6/            ← CodeMirror 6 bundle (vendored + built)
  qrcode/         ← QR encoder (ISO/IEC 18004)
  temporal/       ← Temporal polyfill (Safari/Node fallback)
test/             ← Node-builtin test runner; pure-logic suite
dist/
  viewer.html     ← purpose-built viewer artifact (built from src/viewer-template.html)
SPEC.md           ← design spec; load-bearing for syntax + semantics
SPEC-DATASETS.md  ← forward-looking design for lazy collections / block models (not implemented)
```

See `SPEC.md` for the full design rationale, decisions, and roadmap, and `SPEC-DATASETS.md` for the planned dataset/block-model extension. CLAUDE.md is local working-context for the AI assistant used during development and is gitignored.

---

## Credit

**[Numbat](https://github.com/sharkdp/numbat)** by David Peter (MIT) is the upstream language ep draws from. ep-script adopts Numbat's syntax for quantities, units, conversion (`->`), type annotations, `fn` declarations, decorator grammar, and the general "calculator-shaped programming language" idea. The implementation in `ext/numbat/` is an original JavaScript port written for ep; no Numbat code is copied.

ep extends Numbat with three form-builder decorators (`@input`, `@output`, `@options`) that use real Numbat decorator grammar — so ep programs round-trip through upstream Numbat unchanged.

If ep is useful to you, the credit upstream is to Numbat for the language design that made any of this possible.

---

## License

MIT. See [LICENSE](LICENSE).
