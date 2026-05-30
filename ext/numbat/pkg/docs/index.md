# @gcu/numbat

Unit-aware, **dimension-checked** quantities for adder cells. A pint-shaped
surface over the numbat engine (a JS port of [Numbat](https://github.com/sharkdp/numbat),
MIT) — but a superset: it also carries uncertainty, sensitivity sweeps, and
dimensional solvers.

The engine does all the dimensional algebra. Adding a length to a speed isn't a
silent number — it **throws**.

```python
from numbat import Q, u

wall   = Q(2.4, "m") * Q(5.0, "m")     # 12 m²
paint  = Q(0.18, "L/m^2")
needed = (wall * paint).to("L")        # 2.16 L

wall + Q(60, "km/h")                   # ✗ can't add [length²] + [length·time⁻¹]
```

No preamble — the `from numbat import …` line auto-loads the bridge (and the
engine behind it).

## Quantities

| Form | Meaning |
|---|---|
| `Q(5, "m")` · `Q("5 m")` · `Q(5)` | build a quantity — the unit you ask for is the unit you see |
| `u.meter` · `u("km/h")` · `u.newton` | one of a unit (for `60 * u("km/h")`) |
| `q.to("unit")` | convert; raises if the dimensions don't match |
| `q.magnitude` | the raw canonical (SI-base) number |

Arithmetic uses the normal operators (`+ - * / **`, unary `-`), including the
reflected forms (`2 * u.meter`, `5 + length`). Every op is dimension-checked by
the engine.

```python
Q(60, "km/h").to("m/s")            # 16.667 m/s
Q(2, "kg") * Q(3, "m/s^2")         # 6 N
(Q(230, "V") * Q(10, "A")).to("kW")   # 2.3 kW
```

A quantity renders as `value unit` (`12 m²`). Both a bare last expression in an
adder cell and `ui.display(q)` pick up the rich form.

## Uncertainty — Monte-Carlo with units

Build a distribution; arithmetic propagates the samples; collapse when you want a
number. The unit rides along the whole way.

| Builder | |
|---|---|
| `normal(mu, sigma)` · `uniform(lo, hi)` · `lognormal(mu, sigma)` · `triangular(lo, mode, hi)` | dimensioned distributions |
| `mean(x)` · `stdev(x)` · `percentile(x, p)` · `samples(x)` | collapse to a number / list |

```python
grade   = normal(Q(1.2, "g/t"), Q(0.15, "g/t"))   # 1.20 ± 0.15 g/t
density = normal(Q(2.7, "g/cm^3"), Q(0.1, "g/cm^3"))
tonnes  = (Q(50000, "m^3") * density).to("t")
metal   = (tonnes * grade).to("kg")
percentile(metal, 10)              # the P10 contained metal
```

An uncertain quantity renders as `mean ± stdev unit`.

## Sweeps — one-axis sensitivity

```python
from numbat import sweep
depth = sweep(Q(0, "m"), Q(100, "m"), 11)      # 0 … 100 m
press = (Q(1000, "kg/m^3") * Q(9.81, "m/s^2") * depth).to("kPa")
press                                          # 0 … 981 kPa
```

A swept quantity renders as `min … max unit`.

## Solvers — invert a dimensioned relation

The callback receives and returns `Quantity` values; bounds give the search
interval (and fix the answer's dimension).

```python
from numbat import solve_for, minimize, maximize

# radius of a sphere with volume 1 m³
from math import pi
vol = lambda r: Q(4/3 * pi, "") * r ** 3
solve_for(vol, Q(1, "m^3"), Q(0, "m"), Q(2, "m"))     # ≈ 0.62 m
```

## Time-series

`diff(xs)`, `cumsum(xs)`, `roll(xs, w)` operate on lists of quantities and
return lists of quantities.

```python
from numbat import diff
levels = [Q(1, "m"), Q(3, "m"), Q(6, "m"), Q(10, "m")]
diff(levels)                       # [2 m, 3 m, 4 m]
```

## For JS cells

The raw engine is the package main:

```js
const { Numbat, formatParts } = await load("@gcu/numbat");
```

`@gcu/numbat/adder` is the Python-shape wrapper; JS cells that want the engine
itself use the line above.
