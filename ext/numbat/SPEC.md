# numbat-js — design spec

A JavaScript implementation of the Numbat-script language ([upstream](https://github.com/sharkdp/numbat), David Peter, MIT/Apache-2.0). Targets full Numbat compatibility for v1.0, shipped as a single-file no-deps library that ep and other browser-first tools inline.

**Status:** v0.5 in progress. v0.1–v0.4 shipped (runtime, `.nbt` parser, vendored modules, full evaluator with generics, HM-style dimension-aware typechecker). The shape below is the original trajectory; "Implemented" markers added per slice. The typechecker landed as `src/typecheck/` — a 12-file subtree (~2,150 LOC) rather than the single `src/typecheck.js` the original layout assumed.

See [`README.md`](README.md) for the elevator pitch and credit terms.

---

## What "compatible" means

For each released slice (v0.1 onward) we maintain a **behavioral test corpus** lifted from upstream Numbat's `examples/` directory plus a hand-curated set of edge cases. Compatibility is measured as: *the percentage of corpus programs whose output matches upstream within a documented epsilon*. The README and changelog publish that number per release.

This is what lets us make "compatible" a falsifiable claim. v1.0 means "passes the corpus that upstream itself passes."

We do **not** aim to match:
- Internal architecture (bytecode VM, typed AST shape, error message wording)
- Side-effectful primitives that don't make sense in JS (`save`, `load` against a filesystem)
- The CLI / REPL surface (numbat-js is a library; hosts provide their own REPL)
- Performance characteristics (we accept being slower than the Rust VM)

---

## Architecture choices

These are decisions we lock in before code so v0.1 isn't a guess.

- **Tree-walking interpreter, not a bytecode VM.** Numbat's Rust impl compiles to bytecode for speed. JS engines do well on tree-walkers for the program sizes we expect (calculator-scale to small-program-scale). Semantics match upstream; mechanism is irrelevant to users.
- **Static typechecker with dimension generics.** Programs are typechecked before evaluation, just like upstream. This is the most thought-intensive piece and lives in `src/typecheck.js`. Dimensions are integer-exponent vectors (free abelian group over base dimensions); unification is group-theoretic, not structural HM. See "type system" section below.
- **Quantity = (canonical-value, dimension-vector, optional-display-unit).** Same shape ep uses today. Canonical units chosen at registry-init time; the user never sees them.
- **No mutation.** Numbat is purely functional. We preserve that.
- **Modules via lexical inclusion, not async loaders.** `use core::lists` resolves at parse time against a string-keyed module map. The module map is pre-populated at host startup (host loads `.nbt` files synchronously, or they're bundled).
- **Plain ES modules in `src/` → concatenated single-file `dist/numbat.js`** via the same build pattern ep uses. No bundler, no transpile.

---

## Version trajectory

Each slice is independently shippable, with its own LOC budget and what ep gets to delete.

### v0.1 — units library — **Shipped**

Scope: the runtime-and-formatter layer, with a hand-crafted prelude. No parsing of Numbat source yet.

- `Quantity` class — canonical value + dimension vector + optional disp tag
- Arithmetic: `add`, `sub`, `mul`, `div`, `pow`, `convertTo`
- Dimension primitives (port of ep's, generalized)
- Unit registry with declarative `define()` and a prefix system (`@metric_prefixes` equivalent)
- Hand-crafted prelude: SI base + key derived (`meter`, `gram`, `second`, …), plus the ppm/ppb/`g/t` lane ep needs
- Auto-scaling formatter (port of ep's `fmt`, generalized to consult the registry)
- Public API: `import { Numbat } from '.../dist/numbat.js'` — `new Numbat()`, `n.q(value, unitName)`, `Q` methods

**LOC budget:** ~800 LOC src + ~400 LOC test.
**ep delete:** the entire `UNITS` table, the `Q` class, `lit/qAdd/qSub/qMul/qDiv/qPow/qConvert`, `fmt/fmtNum`. `units.js` becomes a re-export from `ext/numbat/dist/numbat.js`.

### v0.2 — `.nbt` mini-parser for the declarative subset — **Shipped**

Scope: parse upstream's unit and dimension definition files. No expressions yet.

- Tokenizer (operators, identifiers, numbers, strings, `@`-decorators)
- Parser for the declarative subset:
  - `dimension X` / `dimension X = expr`
  - `unit X = expr` / `unit X: D = expr` (with `@metric_prefixes`, `@aliases`)
  - `use path::to::module`
- Module loader: synchronously resolves `use` statements against a bundled module map
- Vendored upstream `.nbt` standard library: all 62 modules under `vendor/numbat/modules/` (core, math, physics, chemistry, units, datetime, plot, numerics, extra)

**LOC budget:** ~600 LOC src + ~300 LOC test + vendored .nbt files.
**ep delete:** the hand-crafted v0.1 prelude in numbat-js (replaced by loading vendored `.nbt`).
**Compat target:** parses upstream's prelude.nbt without error. **Met.**

### v0.3 — expressions, bindings, monomorphic functions — **Shipped** (plus generics — see v0.4)

Scope: evaluate Numbat-script programs *without* generics.

- Parser extends to: `let`, `fn` (no `<T: Dim>` yet), `if/then/else`, `where`, `|>`, function calls, arithmetic, unit conversion `->`
- Tree-walking evaluator with lexical scopes
- `assert` / `assert_eq` / `assert_approx_eq` (so we can run upstream examples)
- Type *checking* (not yet inference): annotations are checked, mismatches reported with spans. Untyped vars inferred from RHS in the simple cases.

**LOC budget:** ~1,000 LOC src + ~600 LOC test.
**ep delete:** `tokenize`, `parseExpr`, `applyFn`, most of `evaluator.js` (the directive layer — `@params` / `@outputs` — stays in ep).
**Compat target:** passes upstream's `examples/numbat_basic.nbt` and similar non-generic examples. **Met.**

### v0.4 — dimension generics + full HM typechecker — **Shipped**

Scope: the typechecker that makes `fn my_sqrt<T: Dim>(q: T^2) -> T` work — and a whole lot more.

The original plan called for "unification over dimension expressions" in a single `src/typecheck.js`. The reality grew larger and ships as a 12-file subtree under `src/typecheck/` (~2,150 LOC, ~50% of upstream's typechecker LOC):

- `rat.js` (51 LOC) — normalized rational arithmetic for dim exponents
- `types.js` (285 LOC) — `TVar` / `TDimVar` / `TDim` / `TBool` / `TString` / `TNever` / `TFn` / `TList` / `TStruct` / `TTuple` / `TScheme` constructors, `DimExpr` arithmetic over rational-base + dim-vars
- `env.js` (66 LOC) — scoped typed env
- `constraints.js` (19 LOC) — `cEqual` / `cIsDType` / `cHasField` constraint shapes with context strings
- `subst.js` (128 LOC) — substitution shape, `applyType`, `applyDimExpr`, `extendTVar` / `extendDimVar`, `UnifyError`
- `unify.js` (69 LOC) — main unifier with context strings
- `dim-solve.js` (56 LOC) — incremental dim-equation solver
- `solve.js` (77 LOC) — top-level solver with IsDType promotion of TVars
- `scheme.js` (42 LOC) — `generalize` + `instantiate` (proper HM let-generalization)
- `errors.js` (225 LOC) — `formatDim` with dim aliases, `didYouMean` (Levenshtein), snippet builder
- `check.js` (720 LOC) — `inferExpr` + `checkModule` + `evalTypeAnno` + `tryFoldConst` + blame entry hook
- `integration.js` (480 LOC) — `typecheckStatement` + `buildTypeEnv` + `BUILTIN_FN` / `BUILTIN_PROC` schemes (sqrt, sin, max, mod, type, head / tail / cons / len, str_*, assert_eq variadic, etc.) + `finalizeDecl` with free-var consistency check

Highlights beyond the original sketch:
- **Unrestricted generics** with proper let-generalization across declarations
- **Polymorphic zero**, **rational dim exponents** (so `T^(1/2)` works), **IsDType promotion** of type variables to dim variables on demand
- **Free-var consistency check** post-solve, **context strings** propagated into error messages
- **Levenshtein did-you-mean** for unknown identifiers
- **Test corpus** — ~102 upstream tests ported from `numbat`'s `type_checking.rs` + `type_inference.rs` (`test/typecheck-upstream.test.js` in the ep host)

**Compat target:** passes upstream's `examples/numbat_syntax.nbt` and most of the math / physics / chemistry stdlib. **Met for the corpus we've ported.**

### v0.5 — lists, strings, structs, decorators — **In progress**

- List literals `[1, 2, 3]`, list type `List<A>`, native primitives (`head`, `tail`, `cons`, `cons_end`, `len`, `is_empty`) — **Shipped**
- String type, basic methods — **Shipped** (full interpolation pending)
- `struct Foo { … }` definitions, field access, struct generics (`struct Vec2<D: Dim>`) — **Shipped**
- `@aliases`, `@description`, `@example`, `@url`, `@name` decorators — **Shipped**
- Most of upstream's `core/`, `math/`, `physics/`, `chemistry/`, `units/` modules now load — **Shipped** (all 62 vendored modules under `vendor/numbat/modules/`)
- Higher-order functions, `mod` / `random` / `cosh` builtins, trailing commas, `x -> fn` application, datetime/currency stubs — **Shipped** (see commits `8f28ab0`, `a809e5f`)

**LOC budget:** ~800 LOC src + ~500 LOC test.
**Compat target:** passes upstream's stdlib tests for the modules we've loaded.

### v1.0 — datetime, plot, currency

- Datetime type — `Temporal`-backed (vendored polyfill for Safari / Node fallback under `ext/temporal/`). Parsing and strftime-style format strings shipped on the ep side; calendar-aware arithmetic (`+ 1 month` with variable-length months) remains future work.
- Plot module — ASCII line/bar charts; small enough we can port directly. Vendored upstream module loads; runtime is a stub.
- Currency — **offline snapshot bundled at build time** from a stable free source (Frankfurter.app or ECB's daily XML feed). Stub in place; no active rates yet. Optional `Numbat.refreshRates(fetchFn)` API; ep can wire a "refresh" button. No background fetches.
- Final pass on upstream-example corpus, declare compat percentage in README

**LOC budget:** ~700 LOC src + ~400 LOC test.
**Compat target:** the published number is what it is. Goal: ≥95% of upstream's example corpus.

---

## Architecture: file layout

```
ext/numbat/
  README.md
  SPEC.md            ← this document
  LICENSE            ← MIT (vendored .nbt retain upstream MIT/Apache)
  build.js           ← concat src/ → dist/numbat.js, zero deps
  package.json       ← only for npm scripts
  dist/
    numbat.js        ← built artifact (~5,000 LOC concatenated; ep inlines this)
  src/
    quantity.js      ← Quantity class + arithmetic
    dimensions.js    ← dimension vector primitives + base registry
    units.js         ← unit registry + prefix system
    prelude.js       ← initial hand-crafted bootstrap (mostly superseded by vendored .nbt)
    format.js        ← Quantity → string formatter (auto-scale + disp)
    tokenize.js      ← tokenizer for Numbat-script
    parse.js         ← parser; outputs AST
    load.js          ← module loader, namespace resolution
    vendored.js      ← vendored module loading
    api.js           ← public surface: `Numbat` class
    typecheck/       ← HM-style dim-aware typechecker (12 files, ~2,150 LOC) — see v0.4 above
      rat.js, types.js, env.js, constraints.js,
      subst.js, unify.js, dim-solve.js, solve.js,
      scheme.js, errors.js, check.js, integration.js
  vendor/
    numbat/
      modules/       ← 62 vendored upstream .nbt files (core / math / physics /
                       chemistry / units / datetime / plot / numerics / extra)
      LICENSE        ← upstream MIT/Apache
  test/
    *.test.js        ← per-module tests
```

The host (ep) keeps its own typecheck-side tests under `ep/test/typecheck-*.test.js` — including the ~102 ported upstream tests in `typecheck-upstream.test.js` — since the host owns the integration glue.

---

## Public API (sketch)

```js
import { Numbat } from './dist/numbat.js';

const n = new Numbat();             // v0.1 — loads hand-crafted prelude
// v0.2+: const n = new Numbat({ modules: ['prelude'] });

// Quantity-level (v0.1)
const a = n.q(200, 'm');
const b = n.q(50, 'm');
const c = n.q(8, 'm');
const vol = a.mul(b).mul(c);
console.log(vol.format());          // "80,000 m³"

// Program-level (v0.3+)
const result = n.run(`
  length = 200 m
  width  = 50 m
  thickness = 8 m
  volume = length * width * thickness
`);
result.scope.volume                 // a Quantity
result.errors                       // []
```

ep's adapter layer (in ep's `units.js`) re-exports the bits ep uses, so ep-side code can keep its current import shape.

---

## Type system

For the curious — the typechecker design lives here so v0.4 doesn't drift from intent.

A **dimension** is an integer vector indexed by base dimensions: `Length^2 · Time^-1` is `{length: 2, time: -1}`. Dimensions form a **free abelian group** under multiplication (componentwise addition of the vectors). The identity is `{}` (scalar / dimensionless); inverses are negation.

A **dimension generic** in a function signature introduces a type variable in this group. Example:

```
fn my_sqrt<T: Dim>(q: T^2) -> T
```

At a call site like `my_sqrt(9 m²)`:
1. Argument has concrete dimension `{length: 2}`.
2. Parameter pattern is `T^2`, i.e. the vector `2 · T` where `T` is unknown.
3. Solve `2 · T = {length: 2}` componentwise: `T = {length: 1}` = `Length`.
4. Substitute `T = Length` into the return type. Result has dimension `Length`.

The "divide each exponent by the variable's coefficient" step replaces standard HM's structural unification. It's mechanically simple but has edge cases:
- **Non-integer solution.** `T^2 = Length^3` has no integer solution. Type error.
- **Multiple variables in one expression.** `T · U` matched against `{length: 1, time: 1}` is underdetermined — could be (T=L, U=T) or (T=T, U=L) or any product. v0.4 rejects such patterns; v0.x might add row-style constraints if needed.
- **Constraint propagation across call chain.** `let x = my_sqrt(9 m²)` types `x` as Length. The typechecker plumbs the result type through `let` so downstream code typechecks correctly.

Implementation lives in `src/typecheck.js`. Unification helper in `src/dimensions.js`. Error reporting uses span info attached to AST nodes.

---

## What ep is responsible for (forever)

These don't migrate into numbat-js:

- The `@params { … }` and `@outputs { … }` directives — they're ep-specific UI affordances, not Numbat syntax
- The DAG-reactive evaluator that decides which bindings to re-evaluate on edit (numbat-js exposes `run(source) → result`; ep orchestrates the re-runs)
- All UI (chips, body editor, form view, export)
- File I/O, drag-drop, export

numbat-js owns: parsing, typechecking, evaluation, formatting, the standard library. ep owns: the directive layer + UI + persistence.

---

## Open questions

- **REPL semantics.** Numbat's REPL has `_` for last result and `ans`. ep's notepad model doesn't need this; library API exposes results explicitly. Skip unless we ever ship a CLI.
- **`session_history.rs`-equivalent.** Same — ep handles undo via its own state model. Skip.
- **Pretty-printing with markup.** Numbat's pretty-printer emits structured markup for terminal coloring. We need a plain-string formatter for v0.1, but a structured one (HTML / spans) would let ep render results with proper unit coloring. Worth designing in v0.5+.
- **Error message localization.** Upstream has none. Match that.

---

*This document evolves with implementation. Treat as snapshot, not law.*
