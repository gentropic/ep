# numbat-js

A JavaScript implementation of the [Numbat](https://github.com/sharkdp/numbat) (David Peter, MIT/Apache-2.0) scientific calculator language, built independently from the Rust reference implementation. Targets full Numbat-script compatibility for v1.0.

**Status:** v0.5 in progress. v0.1–v0.4 complete: full Quantity/dimension runtime, tokenizer, parser, tree-walking evaluator with lexical scopes, lists, structs, multi-line fn bodies with `where` clauses, generics, the full HM-style dimension-aware typechecker (`src/typecheck/` — 12 files, ~2,150 LOC, ~50% of upstream's typechecker LOC), all 62 upstream `.nbt` modules vendored under `vendor/numbat/modules/`. ~102 upstream tests ported from `numbat`'s `type_checking.rs` + `type_inference.rs`. Total: 749 tests at the ep host level (plus per-module suites under `test/`).

This subtree lives co-located with [ep](../../README.md) — its primary consumer and feature-driver — and may move into its own repo once the surface stabilizes.

See [`SPEC.md`](SPEC.md) for the design contract and version trajectory.

## What this is

- A JS library that parses, typechecks, and evaluates Numbat-script programs
- A tree-walking interpreter (not a bytecode VM — semantics match upstream, mechanism doesn't)
- A Hindley-Milner style typechecker with dimension generics — type variables (`TVar`) and dimension variables (`TDimVar`) tracked separately, with rational-exponent arithmetic over dim expressions and a constraint-based solver
- Single-file build (`dist/numbat.js`, ~5,000 LOC concatenated), zero runtime dependencies, no transpile step
- ep imports from it; downstream you can too

## What this is *not*

- Not a port of Numbat's Rust source. Original implementation, same language.
- Not a superset. We aim to track upstream syntax and semantics, not extend.
- Not yet feature-complete for v1.0. Datetime / currency / plot modules need wiring; some module-level edge cases remain. See SPEC for the v0.5 → v1.0 trajectory.

## Credit and courtesy

Numbat-script is **David Peter's design**. This implementation exists because we wanted a JS-native Numbat for browser-first tools — not because the Rust version is deficient. Compatibility claims are validated against upstream's example corpus and a sizeable port of upstream's typecheck/type-inference tests.

Under the principle that **license-permission is not social-permission**, we'll open a courtesy issue on the Numbat repo at v0.5 graduation — not asking permission (the dual MIT/Apache license covers it) but giving the maintainer awareness.

From v0.2 onward we vendor upstream `.nbt` standard-library modules verbatim under `vendor/numbat/`, with their license file. Updates track upstream releases.

## License

MIT, matching ep. Vendored upstream `.nbt` files retain Numbat's MIT/Apache dual license.
