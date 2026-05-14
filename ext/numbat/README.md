# numbat-js

A JavaScript implementation of the [Numbat](https://github.com/sharkdp/numbat) (David Peter, MIT/Apache-2.0) scientific calculator language, built independently from the Rust reference implementation. Targets full Numbat-script compatibility for v1.0.

**Status:** pre-0.1. This subtree lives co-located with [ep](../../README.md) — its primary consumer and feature-driver — and may move into its own repo once the surface stabilizes.

See [`SPEC.md`](SPEC.md) for the design contract and version trajectory.

## What this is

- A JS library that parses and evaluates Numbat-script programs
- A tree-walking interpreter (not a bytecode VM — semantics match upstream, mechanism doesn't)
- Single-file build (`dist/numbat.js`), zero runtime dependencies, no transpile step
- ep imports from it; downstream you can too

## What this is *not*

- Not a port of Numbat's Rust source. Original implementation, same language.
- Not a superset. We aim to track upstream syntax and semantics, not extend.
- Not (yet) feature-complete. See SPEC for the v0.1 → v1.0 trajectory.

## Credit and courtesy

Numbat-script is **David Peter's design**. This implementation exists because we wanted a JS-native Numbat for browser-first tools — not because the Rust version is deficient. Compatibility claims are validated against upstream's example corpus.

Under the principle that **license-permission is not social-permission**, we'll open a courtesy issue on the Numbat repo when this approaches v0.5 (the point where it could realistically be called "a Numbat implementation") — not asking permission (the dual MIT/Apache license covers it) but giving the maintainer awareness.

From v0.2 onward we vendor upstream `.nbt` standard-library modules verbatim under `vendor/numbat/`, with their license file. Updates track upstream releases.

## License

MIT, matching ep. Vendored upstream `.nbt` files retain Numbat's MIT/Apache dual license.
