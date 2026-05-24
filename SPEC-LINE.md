# SPEC-LINE — matrix / linear algebra surface (via @gcu/line)

**Status**: Phase 1 designed (this document); implementation pending. Phase 2+ noted at the bottom.

## Motivation

ep today is calculator-shaped and list-of-scalars-shaped. Element-wise arith over lists works (`xs * 2`, `xs + ys`), reductions work (`sum`, `mean`, `stdev`), and `Uncertain` / `Swept` carry samples through arithmetic. What ep can't express:

- **Matrix arithmetic.** Stress tensors, stiffness matrices, rotation matrices, orientation matrices, covariance matrices — none are reachable from ep-script.
- **Eigendecomposition.** Principal-stress analysis, best-fit-plane fitting on a point cloud, PCA on a dataset, structural-geology orientation-matrix work — all require eigvals/eigvecs.
- **Linear systems.** `solve(A, b)` for a 3-equation 3-unknown system; least-squares fits for regression on a data series; closed-form inverses for small matrices.
- **Decompositions.** QR for stable least-squares, SVD for rank/pinv, Cholesky for SPD systems.

These are the operations the user's structural-geology + mining-engineering workflow already wants — they're currently lifted out to a separate tool, then results pasted back into ep as scalars. Folding them into ep means a stereonet's eigvec story, a sweep's regression fit, and an Uncertain's covariance can all live in one program.

`@gcu/line` is the GCU-stack linear algebra library: NumPy-shaped ndarrays, broadcasting, BLAS-1 + decomps (qr / svd / cholesky / eigSym / eigSym3) + solvers (solve, lstsq, pinv), ~90 KB raw, zero deps, pure JS. It exists alongside ep in the auditable repo (`../auditable/ext/line/`) and is already battle-tested by adder cells. We vendor it under `ext/line/`, mirror the bearing.js integration pattern, and expose a numbat-side surface that wraps its operations.

## Non-goals

- **Not a full ndarray system.** Phase 1 covers 2-D matrices + 1-D vectors only. N-D tensors stay deferred until a real ep program needs them. Block-model storage (SPEC §10) is a separate value type, not a matrix subclass.
- **Not dimension-mixed matrices.** A stiffness matrix where each row has a different dim (force / length / moment / …) is out. Phase 1 matrices carry a single dim shared by every element — fine for stress tensors (all Pa), orientation matrices (dimensionless), covariance matrices (X² for column X), but not for compound block-stiffness shapes. The `with_dim` escape hatch in Phase 2+ opens that door.
- **Not GPU / wasm offload.** line is pure JS and ep stays pure JS. Block-model-scale workloads (millions of elements) are SPEC §10's worker-offload story, not line's.
- **Not symbolic.** No `solve(Ax + B = C, x)`-style symbolic algebra — line is numeric.
- **Not sparse.** Dense `Float64Array` storage only. Sparse matrices are out of scope.
- **Not auto-broadcasting on `*`.** Element-wise `A * B` requires same-shape operands in v1. Numbat's operator overload doesn't carry the broadcasting policy line itself does (right-aligned axes, size-1 broadcasts); rather than half-implementing it, v1 routes broadcasting through explicit functions (`broadcast_mul(A, b)` if needed) and keeps `*` strict.

## Design summary

A new `Matrix` value type — a tagged subclass of `Quantity` paralleling `Uncertain` and `Swept`. Carries the canonical `Float64Array` of values, the shape `[rows, cols]`, the shared `dim` for every element, and an optional `disp` tag. Element-wise arithmetic propagates through Quantity dispatch (same pattern Uncertain/Swept already use); matrix-specific operations (matmul, eig, solve, …) live as BUILTIN_PROCs that wrap line's API.

Like bearing.js, line is opaque-IIFE-wrapped in the build so its internal helper names (`mean`, `norm`, `eye`, …) don't collide with numbat-js's. Only a single `line` namespace is hoisted to flat scope.

The five single-point-of-extension layers (mirroring SPEC-UNCERTAINTY's pattern):

1. **`Matrix` value type** — subclass of `Quantity`, tagged `__matrix: true`.
2. **Quantity arithmetic** — element-wise dispatch arms for `Matrix + Matrix`, `Matrix * Scalar`, `Scalar * Matrix`, etc.
3. **BUILTIN_PROC entries** — `matrix`, `eye`, `transpose`, `matmul`, `solve`, `eigsym`, … wrap line ops.
4. **Typechecker schemes** — register Matrix-shaped signatures in `BUILTIN_PROC_SCHEMES`.
5. **Render path** — chip thumbnails for small matrices (e.g., 3×3 → render as bracketed text); large matrices show a shape summary (`Matrix<5×5, Length>`).

## Extensibility hooks

### 1. Matrix value type — single-dim, shape-aware

```js
class Matrix extends Quantity {
  constructor(data: Float64Array, shape: [number, number], dim, disp = null) {
    super(meanOf(data), dim, disp);
    this.data    = data;      // canonical-value Float64Array, row-major
    this.shape   = shape;
    this.__matrix = true;
  }
}
```

`super.value` is the mean (so naked Matrix in an arithmetic context with a scalar still "has a value" — same trick Uncertain uses). Shape is fixed at construction; reshaping returns a new Matrix.

### 2. Arithmetic dispatch — Quantity-side commute arms

Mirrors the existing Uncertain/Swept guard pattern in `quantity.js`. `Quantity.add(Matrix)` commutes to `Matrix.add(Quantity)`, broadcasting the scalar across the matrix.

`Matrix.mul(Matrix)`: element-wise (not matmul). Element-wise on same-shape operands; throws on shape mismatch (no auto-broadcasting in v1). Dim is `dimMul(thisDim, otherDim)` — so `(stress matrix) * (compliance matrix)` produces a strain matrix with the right dim.

`Matrix.mul(Quantity_scalar)`: scalar broadcast; dim is `dimMul(thisDim, scalarDim)`.

`Matrix.mul(Uncertain)` and `Matrix.mul(Swept)`: rejected in v1 with a clear error message (matrix × sample-bearing combines a 2-D ndarray with a sample sequence, which needs the 3-D-tensor or per-element-sample policy nailed down). Lifted in a later phase.

### 3. BUILTIN_PROC entries — the host surface

See § "API surface — Phase 1" below.

### 4. Typechecker schemes

Schemes register against `BUILTIN_PROC_SCHEMES`. The Matrix type is opaque to the typechecker — a fresh TVar with constraint that arithmetic preserves it. Decompositions return `__struct`-tagged plain objects (same shape uncertainty's percentile-collapse uses), with a tagged-struct scheme for the result.

### 5. Render path

A new chip-thumbnail render for Matrix:
- **Small (≤4×4)**: render as bracketed compact text (`[1, 2; 3, 4]` style), with auto-scaled units.
- **Larger**: shape summary like `Matrix<10×10, Pressure>`. Tap-to-expand the chip opens a full modal showing the matrix as a heatmap (color-ramped abs-value, like a covariance plot).

Tap-and-hold or long-press to copy as a Numbat literal (`matrix([[1, 2], [3, 4]])`).

## Vendor setup

Mirror bearing.js exactly:

```
ext/
  line/
    src/                    ← copied from ../auditable/ext/line/src/
    dist/line.js            ← bundled via ext/line/build.js (one ES module)
    LICENSE
    README.md
```

`build.js` (the ep top-level one) adds line to the vendor list:

```js
{ dist: 'ext/line/dist/line.js',
  wrap: 'const __line = (function(){ /* CONTENT */ return EXPORTS; })();\nconst line = __line;',
  opaque: true }
```

The IIFE returns an `EXPORTS` object bundling every line function. The IIFE wrap is critical: line's internal `mean`, `norm`, `eye`, `linspace` all collide with numbat-js's own names. Only `line` is exposed to flat scope; everything else is reached as `line.matmul`, `line.eigSym3`, etc.

The ep top-level `build.js` already handles "rebuild the vendored dep automatically" via the bearing.js + numbat-js patterns; line slots into the same machinery.

## API surface — Phase 1

### Creation

| Name | Signature | Notes |
|---|---|---|
| `matrix` | `matrix(rows: List<List<D>>) -> Matrix<D>` | From nested list. Validates rectangularity. Every element must share dim. |
| `eye_matrix` | `eye_matrix(n: Scalar) -> Matrix<Scalar>` | n×n identity. Dimensionless. |
| `zeros_matrix` | `zeros_matrix(rows: Scalar, cols: Scalar) -> Matrix<Scalar>` | r×c of 0s. |
| `ones_matrix` | `ones_matrix(rows: Scalar, cols: Scalar) -> Matrix<Scalar>` | r×c of 1s. |
| `diag_matrix` | `diag_matrix(values: List<D>) -> Matrix<D>` | n×n diagonal matrix from a vector. |
| `transpose` | `transpose(M: Matrix<D>) -> Matrix<D>` | 2-axis transpose. |

The `_matrix` suffix on creation names is deliberate — `eye` / `zeros` / `ones` already exist or are reserved on the list side (`zeros(n)` returns `List<Scalar>` today). Keeping namespace clean lets list-shaped and matrix-shaped versions coexist.

### Accessors

| Name | Signature | Notes |
|---|---|---|
| `shape` | `shape(M: Matrix<D>) -> List<Scalar>` | `[rows, cols]`. |
| `nrows` | `nrows(M: Matrix<D>) -> Scalar` | Row count. |
| `ncols` | `ncols(M: Matrix<D>) -> Scalar` | Column count. |
| `row` | `row(M: Matrix<D>, i: Scalar) -> List<D>` | 1-based or 0-based — TBD in open questions. |
| `col` | `col(M: Matrix<D>, j: Scalar) -> List<D>` | Same. |
| `entry` | `entry(M: Matrix<D>, i: Scalar, j: Scalar) -> D` | Single-element lookup. |
| `to_list` | `to_list(M: Matrix<D>) -> List<List<D>>` | Round-trip back to nested list. |

### Element-wise arithmetic

Inherited from Quantity overloads — no new functions needed. `A + B`, `A - B`, `A * B`, `A / B` all work element-wise (same-shape operands). `A * 2 m` and `2 m * A` broadcast a scalar. Shape mismatch throws.

### Matrix operations

| Name | Signature | Notes |
|---|---|---|
| `matmul` | `matmul(A: Matrix<X>, B: Matrix<Y>) -> Matrix<X*Y>` | 2-D × 2-D. Dim multiplies. |
| `inv` | `inv(M: Matrix<D>) -> Matrix<1/D>` | Matrix inverse. Closed-form fast path for 2×2/3×3/4×4. |
| `det` | `det(M: Matrix<D>) -> D^n` | Determinant. Dim is `D^n` where `n = nrows`. |
| `trace` | `trace(M: Matrix<D>) -> D` | Sum of diagonal. |
| `solve` | `solve(A: Matrix<X>, b: List<Y>) -> List<Y/X>` | Linear system Ax = b. LU + partial pivoting. |
| `dot_vec` | `dot_vec(a: List<X>, b: List<Y>) -> X*Y` | 1-D vector dot product. (Numbat already has `dot` reserved or close — `dot_vec` avoids collision.) |
| `cross` | `cross(a: List<X>, b: List<Y>) -> List<X*Y>` | 3-D cross product. |

### Decompositions

All return `__struct`-tagged plain objects. Numbat-side field access via `.values`, `.vectors`, etc.

| Name | Signature | Notes |
|---|---|---|
| `eigsym` | `eigsym(M: Matrix<D>) -> EigSym<D>` | N×N symmetric eigendecomposition (Jacobi). Returns `{values: List<D>, vectors: Matrix<Scalar>}`. Eigvecs are unit-normalized (dimensionless). |
| `eigsym3` | `eigsym3(M: Matrix<D>) -> EigSym<D>` | 3×3 fast path (Cardano). Same return shape. |
| `qr` | `qr(M: Matrix<D>) -> QR<D>` | Returns `{Q: Matrix<Scalar>, R: Matrix<D>}`. |
| `svd` | `svd(M: Matrix<D>) -> SVD<D>` | Returns `{U: Matrix<Scalar>, s: List<D>, V: Matrix<Scalar>}`. |
| `cholesky` | `cholesky(M: Matrix<D>) -> Matrix<sqrt(D)>` | Lower triangular L. Dim is sqrt of input dim — fails loudly if dim doesn't have an integer-fractional sqrt (a Pa-matrix Cholesky-decomposes into a sqrt(Pa)-matrix, which is acceptable for the cov-matrix use case where input is X² for column X). |

The struct names (`EigSym`, `QR`, `SVD`) are declared via `_host.registerModule('linalg::functions', ...)` from `evaluator.js`, matching the pattern uncertainty::functions / sweep::functions use today.

### Norms

| Name | Signature | Notes |
|---|---|---|
| `vec_norm` | `vec_norm(v: List<D>, ord?: Scalar) -> D` | L1/L2/L∞/p-norm. Defaults to L2. |
| `mat_norm` | `mat_norm(M: Matrix<D>, ord?: String) -> D` | Frobenius / nuclear / induced-1 / -∞. Defaults to Frobenius. |

### Reductions (extended)

The existing reductions auto-promote to handle Matrix by flattening:

| Name | Behavior on Matrix |
|---|---|
| `sum(M)` | Sum of all elements. |
| `mean(M)` | Mean of all elements. |
| `max(M)`, `min(M)` | Max / min of all elements. |
| `stdev(M)` | Sample stdev over all elements. |

Reductions with `axis` are deferred to Phase 2 (line supports them, but ep's reduction-with-axis API isn't designed yet).

### Total Phase 1 surface: 22 builtin names + 3 struct types.

## API surface — Phase 2+ (deferred)

- **N-D arrays.** Phase 1 is 2-D matrices + 1-D vectors via `List<D>`. N-D requires a separate value class or a generalized Matrix.
- **`pinv`, `lstsq`, `matrix_rank`, `matrix_power`.** Linear-system robustness extensions; useful but not the first ones reached for.
- **`solve_triangular`, `solveCholesky`.** Specialized solvers.
- **`outer`, `kron`, `diag_extract`.** Outer / Kronecker products; diag-of-matrix (`diag` on a matrix returns its diagonal, currently shadowed by diag_matrix).
- **Slicing.** `M[1:5, :]`-style slicing requires a Numbat-side range/slice syntax or a `slice_matrix(M, ranges)` function. Deferred.
- **Reductions with axis.** `sum(M, axis=0)`, `mean(M, axis=1)`, etc. line supports it; ep's reduction signature doesn't carry an `axis` keyword.
- **Element-wise broadcasting** (`*` between Matrix and 1-D Vector).
- **Sample-bearing matrices.** Matrix × Uncertain combinations (an Uncertain stress tensor — uncertainty on each component). Needs the 3-D sample tensor design.
- **Block-model matrices.** Once the block-model value type from SPEC-DATASETS lands, a Matrix-backed dense block model is the natural compute target.

## Type system

Matrix is an opaque type to the typechecker — a fresh TVar in each scheme. Element-wise arithmetic preserves the type. Matrix-specific ops have signatures like:

```js
function schemeMatmul() {
  // <D1, D2>(Matrix<D1>, Matrix<D2>) -> Matrix<D1*D2>
  const d1 = freshTDimVar();
  const d2 = freshTDimVar();
  return generalize(
    tFn([tMatrix(d1), tMatrix(d2)], tMatrix(tDim_mul(d1, d2))),
    [], [d1, d2]
  );
}
```

This requires a new `TMatrix` constructor in the type AST. Alternative: skip the formal Matrix type and use `TVar` everywhere (matches how Plot is treated today — typed as an opaque polymorphic value). The TVar route is much less work for v1; the cost is that Matrix-vs-non-Matrix can't be statically rejected. Same tradeoff Plot already accepts. Recommended for Phase 1; promote to first-class `TMatrix` only if real programs reveal a need.

Decomposition return-shapes (`EigSym`, `QR`, `SVD`) are declared as Numbat structs in `linalg::functions`, so field access (`.values`, `.vectors`) is statically typed.

## Examples

### Stress tensor principal axes

```ep
sigma = matrix([
  [10,  2,  0],
  [ 2,  8,  1],
  [ 0,  1,  6],
]) * 1 MPa

# Principal stresses (descending) + directions
e = eigsym3(sigma)
sigma_1 = entry(e.values, 0)     # ≈ 11.4 MPa
sigma_2 = entry(e.values, 1)     # ≈  7.4 MPa
sigma_3 = entry(e.values, 2)     # ≈  5.2 MPa

# Principal-axis directions as a stereonet
sigma_1_dir = col(e.vectors, 0)  # [x, y, z]
```

### Best-fit plane through a point cloud

```ep
# Points in 3-D (e.g. measured outcrop)
points = matrix([
  [1.0, 0.2, 0.05],
  [0.0, 1.0, 0.10],
  # …
])

# Best-fit plane normal = smallest-eigval eigvec of (Xᵀ X)
cov = matmul(transpose(points), points)
e = eigsym3(cov)
n_hat = col(e.vectors, 2)   # smallest-eigval direction
```

### Linear regression on a data series

```ep
# Fit y = a·x + b
xs = [1, 2, 3, 4, 5]
ys = [2.1, 3.9, 6.1, 8.0, 10.2]

# Build the design matrix [x, 1] per row
A_rows = map(fn (x) = [x, 1], xs)
A = matrix(A_rows)

# Solve the normal equations
AtA  = matmul(transpose(A), A)
Aty  = matmul(transpose(A), matrix(map(fn (y) = [y], ys)))
beta = solve(AtA, col(Aty, 0))

a = entry(beta, 0)   # ≈ 2.0
b = entry(beta, 1)   # ≈ 0.1
```

### Orientation matrix → mean direction (structural geology)

```ep
# Plunge/trend of a set of lineations
trends   = [240 deg, 245 deg, 250 deg, 255 deg]
plunges  = [25 deg,  28 deg,  22 deg,  30 deg]

# Convert to direction cosines (l, m, n)
# (a `direction_cosines(trends, plunges) -> List<List<Scalar>>` helper lives
#  in some structural-geology prelude module)
cosines = direction_cosines(trends, plunges)
T = matmul(transpose(matrix(cosines)), matrix(cosines))
e = eigsym3(T)

# Largest-eigval eigvec = mean direction
mean_dir = col(e.vectors, 0)
```

## Open questions

- **0-based vs 1-based indexing.** ep / numbat currently use 0-based for `element_at`; lists are 0-indexed everywhere. Matrix accessors (`row(M, i)`, `entry(M, i, j)`) should stay 0-based for consistency. The geology / engineering convention is often 1-based (matlab-style), so there's a UX tension. Stay 0-based.

- **Element-wise `*` vs matmul on `*`.** NumPy convention: `A * B` is element-wise, `A @ B` is matmul. ep follows. Numbat has no `@` operator and adding one would be an additive divergence. Function form (`matmul(A, B)`) it is.

- **`dot` vs `dot_vec`.** Numbat already has `dot` as an alias in some contexts? Check before claiming the name. If free, use `dot`. Otherwise `dot_vec` for 1-D and overloaded `matmul` for 2-D.

- **`eye(n)` vs `eye_matrix(n)`.** `eye` is the obvious name but collides with no current ep builtin; `eye_matrix` keeps namespace explicit. Suggest `eye` if free, fall back to `eye_matrix` otherwise.

- **`zeros(n)` vs `zeros_matrix(rows, cols)`.** `zeros(n)` returns `List<Scalar>` of length n in ep today. The Matrix version takes two args. Same name, different arity is fine — Numbat dispatch by arity is already used (`arange(start, stop)` vs `arange(start, stop, step)`).

- **Matrix display.** A 3×3 with values shows nicely as a chip thumbnail. A 100×100 doesn't. Heatmap rendering for large matrices needs a color-ramp design (signed values around 0? log-abs? clipped to percentile?). Defer specific rendering choices to implementation time.

- **`solve` result shape.** When `b` is a 1-D `List<D>`, `solve(A, b)` returns `List<D>`. When `b` is a 2-D `Matrix<D>` (multi-RHS), returns `Matrix<D>`. ep needs both paths, with the result shape mirroring `b`.

- **Decomposition struct field types.** For `eigsym(M: Matrix<D>) -> {values: List<D>, vectors: Matrix<Scalar>}`, the typechecker needs to know the field types depend on the input dim. Numbat structs are monomorphic — defining a `struct EigSym<D> { values: List<D>, vectors: Matrix<Scalar> }` requires generic structs. Workaround in v1: declare `EigSym` field-untyped (or as `Scalar` for now) and accept loose field types. Field-access still works at runtime.

- **Conformance with upstream Numbat.** Every name we introduce (`matrix`, `eigsym3`, `matmul`, …) is ep-original. Upstream Numbat has no linear algebra surface. Fails loudly upstream as "unknown identifier" — matches the additive-divergence rule.

## Phase 1 scope checklist

- Vendor `@gcu/line` under `ext/line/` (mirror bearing.js setup: source under `src/`, bundled `dist/line.js`, opaque-IIFE in `build.js`).
- New `Matrix` value class in `ext/numbat/src/quantity.js`, extending `Quantity` with `data: Float64Array` + `shape: [r, c]`.
- Quantity arithmetic guard arms for `__matrix` in `add` / `sub` / `mul` / `div` (same shape uncertainty/swept guards use today).
- 22 BUILTIN_PROC entries in `ext/numbat/src/load.js` wrapping line ops.
- Typecheck schemes for each in `ext/numbat/src/typecheck/integration.js` (Matrix-as-TVar approach; no `TMatrix` constructor in v1).
- `linalg::functions` numbat-module signatures registered from `ep/src/js/evaluator.js`.
- Chip thumbnail render for Matrix in `src/js/render.js` (small: bracketed text; large: shape summary).
- Docs entries in `src/js/docs.js` + new "Linear algebra (ep extension)" group.
- Test coverage at `ext/numbat/test/matrix.test.js` (creation, element-wise arith, matmul, solve, eigsym3, edge cases for shape mismatch / non-square / singular).

## Status

Phase 1 designed (this document). Implementation pending. The natural first vertical slice: `Matrix` value type + `matrix()` constructor + `transpose` + `matmul` + `eigsym3` + chip thumbnail. Once that runs end-to-end (e.g., a 3×3 stress tensor program that prints its principal stresses), fan out to the remaining ops + decompositions.
