# numbat-upstream (cross-validation harness)

The Rust → WASM build of upstream Numbat, used by ep's cross-validation
tests to verify that `ext/numbat/`'s JS port computes the same answers
as the reference implementation.

**Not committed** — the WASM blob is ~2 MB and dev-only. Runtime ep
doesn't load this. Tests skip when the WASM is absent.

## Fetch

```sh
sh ext/numbat-upstream/fetch.sh
```

Downloads `numbat_wasm_bg.wasm` and the generated JS glue from numbat.dev
into this directory (or use the deploy mirror, whichever's current).

## Run

```sh
node --test test/numbat-wasm-cross.test.js
```

When `ext/numbat-upstream/numbat_wasm_bg.wasm` is present, the cross
test runs the conformance corpus through both engines and asserts the
outputs match numerically (with the same tolerance the in-tree
conformance corpus uses).

When the WASM is absent the test reports as skipped — `npm test`
doesn't require it.

## Refresh

The upstream WASM changes whenever numbat releases. Re-run `fetch.sh`
to update. Pin a specific build if a regression in upstream is
shadowing an ep change you want to test against.
