# @gcu/numbat

Unit-aware, **dimension-checked** quantities for [auditable](https://gentropic.org)
notebooks — pint-shaped, but a superset: it also carries numbat's uncertainty
(Monte-Carlo-with-units), sensitivity sweeps, and dimensional solvers.

It's a thin Python-shaped skin over the **numbat engine** (a JS port of
[Numbat](https://github.com/sharkdp/numbat), David Peter, MIT) that powers
[ep](https://gentropic.org/ep). The engine does all the dimensional algebra and
**throws on a dimension mismatch** — adding a length to a speed is an error, not
a silent number.

## Install

Drop `_gcu_numbat@<version>.gcupkg` onto a Works window, or `install("…gcupkg")`
in a cell. Then, in any `/// adder` cell:

```python
from numbat import Q, u

wall   = Q(2.4, "m") * Q(5.0, "m")     # 12 m²
paint  = Q(0.18, "L/m^2")
needed = (wall * paint).to("L")        # 2.16 L

speed  = Q(60, "km/h")
speed.to("m/s")                        # 16.667 m/s

wall + speed                           # ✗ raises: can't add [length²] + [length·time⁻¹]
```

No preamble `load()` needed — the `from numbat import …` line auto-loads the
bridge (and the engine behind it).

The package ships a **docs reference** (Works docs surface) and **three runnable
example notebooks** (Help → Open example…): a units tour, a Monte-Carlo-with-units
ore-block calculation, and sweeps + dimensional solvers.

## Surface

| Name | Shape | Notes |
|---|---|---|
| `Q(v, unit)` · `Q("5 m")` · `Q(5)` | quantity builder | the unit you ask for is the unit you see |
| `u.meter` · `u("km/h")` · `u.newton` | unit constants | one of each unit |
| `Quantity` | the class | arithmetic dunders incl. reflected (`2 * u.meter`) + `.to(unit)` + `.magnitude` |
| `normal` · `uniform` · `lognormal` · `triangular` | uncertainty builders | dimensioned Monte-Carlo, e.g. `normal(Q(2.7,"g/cm^3"), Q(0.1,"g/cm^3"))` |
| `mean` · `stdev` · `percentile` · `samples` | collapses | reduce an uncertain/swept quantity |
| `sweep(start, end, n)` | sensitivity axis | renders as `min … max` |
| `solve_for(f, target, lo, hi)` · `minimize` · `maximize` | dimensional solvers | the callback receives + returns `Quantity` |
| `diff` · `cumsum` · `roll` | time-series | operate on lists of quantities |

Rich display: a `Quantity` renders as `value unit` (`12 m²`), an uncertain one as
`mean ± stdev unit` (`2.70 ± 0.10 g/cm³`), a sweep as `lo … hi unit`. Both adder
cells (bare last expression) and `ui.display(q)` pick up `_repr_html_`.

## For JS cells

The raw engine is the package's main entry:

```js
const { Numbat, formatParts } = await load("@gcu/numbat");
```

`@gcu/numbat/adder` is the Python-shape wrapper around it; JS cells that want the
engine itself use the line above.

## Build

```
node build.js            # at the ep root — (re)builds ext/numbat/dist/numbat.js
node ext/numbat/pkg/pack.js   # → ext/numbat/pkg/dist/_gcu_numbat@<version>.gcupkg
```

The packer reads the built engine dist as `index.js` and bundles `adder.js`, the
manifest, LICENSE, and README into a `.gcupkg` (EXTENSION_SPEC.md §6.1) with a
SHA-256 integrity hash over `[adder.js, index.js]`.

## License

MIT — © Geoscientific Chaos Union. Vendors numbat-js (a port of Numbat, MIT).
