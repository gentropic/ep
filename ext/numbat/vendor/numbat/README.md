# Vendored Numbat modules

These `.nbt` files are copied verbatim from upstream [Numbat](https://github.com/sharkdp/numbat) (David Peter), commit-level fidelity tracked manually by the numbat-js maintainer.

They're loaded at runtime by `Numbat.loadVendoredPrelude()` (or individually via `Numbat.use('path::name')`) to provide a Numbat-compatible standard library subset.

## What's here (v0.3 reach: 12 / 62 upstream modules)

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
    time.nbt          # minute, hour, day, week, year, decade, century, ...
    astronomical.nbt  # parsec, light-year, AU, julian-year, ...
    nautical.nbt      # knot, nautical mile, fathom, league
    bit.nbt           # bit, byte, KiB/MiB/GiB, kbit/Mbit
    currency.nbt      # abstract Currency dimension + named units (rates needed)
  physics/
    temperature_conversion.nbt   # celsius / fahrenheit helpers
  extra/
    cooking.nbt       # cup, tablespoon, teaspoon, etc.
```

The remaining 50 of 62 upstream modules need features still ahead of us:
- **Dimension generics** (`fn sqrt<T: Dim>(x: T^2) -> T`) — v0.4
- **Structs** (`struct Vec2<D: Dim> { x: D, y: D }`) — v0.5
- **Lists, strings, datetime types** — v0.5+
- A few have minor blockers (units::misc needs `kcal` definition outside `use`,
  physics::constants references a let binding before its definition, etc.) —
  fixable opportunistically.

## License

Vendored files retain their original dual MIT / Apache-2.0 license from upstream Numbat. See `LICENSE-MIT` and `LICENSE-APACHE` in this directory.

## Updating

When tracking an upstream Numbat release:
1. Replace these files from the corresponding tag of `sharkdp/numbat`.
2. Re-run `node ext/numbat/build.js` to regenerate `ext/numbat/src/vendored.js` (the build-time bundle of these files as JS string constants).
3. Re-run tests to verify nothing regressed.
