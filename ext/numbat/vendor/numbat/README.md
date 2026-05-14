# Vendored Numbat modules

These `.nbt` files are copied verbatim from upstream [Numbat](https://github.com/sharkdp/numbat) (David Peter), commit-level fidelity tracked manually by the numbat-js maintainer.

They're loaded at runtime by `Numbat.loadVendoredPrelude()` (or individually via `Numbat.use('path::name')`) to provide a Numbat-compatible standard library subset.

## What's here (v0.2)

```
modules/
  core/
    scalar.nbt        # dimension Scalar = 1
    dimensions.nbt    # all standard physical dimensions
  math/
    constants.nbt     # π, τ, e, φ, unicode fractions, named numbers
  units/
    si.nbt            # SI base + derived units + metric prefixes
    partsperx.nbt     # ppm, ppb, ppt, percent, permille
```

Subsequent versions of numbat-js will vendor more of upstream's standard library as the loader handles more of the language (lists in v0.5, etc.).

## License

Vendored files retain their original dual MIT / Apache-2.0 license from upstream Numbat. See `LICENSE-MIT` and `LICENSE-APACHE` in this directory.

## Updating

When tracking an upstream Numbat release:
1. Replace these files from the corresponding tag of `sharkdp/numbat`.
2. Re-run `node ext/numbat/build.js` to regenerate `ext/numbat/src/vendored.js` (the build-time bundle of these files as JS string constants).
3. Re-run tests to verify nothing regressed.
