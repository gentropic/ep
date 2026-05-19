// Documentation table for built-in names — functions, procs, decorators,
// keywords, constants. Surfaced in the editor's autocomplete (via the
// `info` field on each option) and, when wired, in hover tooltips and
// signature help. Hand-curated; the vendored .nbt modules also ship
// `@description` / `@example` decorators on their fns, but harvesting
// those at runtime is a separate task. For now, ep keeps a curated
// list of the names users actually reach for.
//
// Format: each entry has { signature, description, example? }. The
// signature line is shown verbatim — match Numbat's `fn name(arg: T) -> R`
// shape so users learn the type-annotation grammar by osmosis.
//
// Add new entries when ep gains a builtin. Forgetting to document a
// new name doesn't break anything — autocomplete just shows the name
// without docs.

export const DOCS = {
  // ── Numeric — single-arg ──────────────────────────────────────────
  abs:   { signature: 'abs<D>(x: D) -> D', description: 'Absolute value. Dim-preserving.', example: 'abs(-3 m) = 3 m' },
  sqrt:  { signature: 'sqrt<D>(x: D^2) -> D', description: 'Square root. Returns half the dim of the input.', example: 'sqrt(16 m^2) = 4 m' },
  cbrt:  { signature: 'cbrt<D>(x: D^3) -> D', description: 'Cube root. Returns one third of the dim of the input.', example: 'cbrt(27 m^3) = 3 m' },
  sqr:   { signature: 'sqr<D>(x: D) -> D^2', description: 'Square. Equivalent to x * x.', example: 'sqr(4 m) = 16 m²' },
  round: { signature: 'round(x: Scalar) -> Scalar', description: 'Round to nearest integer.', example: 'round(3.7) = 4' },
  floor: { signature: 'floor(x: Scalar) -> Scalar', description: 'Round down to integer.', example: 'floor(3.7) = 3' },
  ceil:  { signature: 'ceil(x: Scalar) -> Scalar', description: 'Round up to integer.', example: 'ceil(3.2) = 4' },
  trunc: { signature: 'trunc(x: Scalar) -> Scalar', description: 'Truncate toward zero.', example: 'trunc(-3.7) = -3' },
  fract: { signature: 'fract(x: Scalar) -> Scalar', description: 'Fractional part. fract(x) = x - trunc(x).', example: 'fract(3.7) = 0.7' },
  exp:   { signature: 'exp(x: Scalar) -> Scalar', description: 'e^x — natural exponential.', example: 'exp(1) = e ≈ 2.718' },
  ln:    { signature: 'ln(x: Scalar) -> Scalar', description: 'Natural logarithm (base e).', example: 'ln(e) = 1' },
  log:   { signature: 'log(x: Scalar) -> Scalar', description: 'Natural logarithm. Alias for ln.', example: 'log(e) = 1' },
  log10: { signature: 'log10(x: Scalar) -> Scalar', description: 'Base-10 logarithm.', example: 'log10(1000) = 3' },
  log2:  { signature: 'log2(x: Scalar) -> Scalar', description: 'Base-2 logarithm.', example: 'log2(8) = 3' },
  sin:   { signature: 'sin(x: Scalar) -> Scalar', description: 'Sine. Argument in radians (Angle is dimensionless in Numbat).', example: 'sin(pi / 2) = 1' },
  cos:   { signature: 'cos(x: Scalar) -> Scalar', description: 'Cosine. Argument in radians.', example: 'cos(0) = 1' },
  tan:   { signature: 'tan(x: Scalar) -> Scalar', description: 'Tangent. Argument in radians.', example: 'tan(pi / 4) = 1' },
  asin:  { signature: 'asin(x: Scalar) -> Scalar', description: 'Inverse sine. Returns radians.', example: 'asin(1) = pi / 2' },
  acos:  { signature: 'acos(x: Scalar) -> Scalar', description: 'Inverse cosine. Returns radians.', example: 'acos(0) = pi / 2' },
  atan:  { signature: 'atan(x: Scalar) -> Scalar', description: 'Inverse tangent. Returns radians.', example: 'atan(1) = pi / 4' },
  sinh:  { signature: 'sinh(x: Scalar) -> Scalar', description: 'Hyperbolic sine.' },
  cosh:  { signature: 'cosh(x: Scalar) -> Scalar', description: 'Hyperbolic cosine.' },
  tanh:  { signature: 'tanh(x: Scalar) -> Scalar', description: 'Hyperbolic tangent.' },

  // ── Numeric — multi-arg procs ────────────────────────────────────
  max: { signature: 'max<D>(a: D, b: D) -> D', description: 'Larger of two values. Args must share the dim.', example: 'max(3 m, 5 m) = 5 m' },
  min: { signature: 'min<D>(a: D, b: D) -> D', description: 'Smaller of two values. Args must share the dim.', example: 'min(3 m, 5 m) = 3 m' },
  mod: { signature: 'mod<D>(a: D, b: D) -> D', description: 'Remainder of a / b. Args must share the dim.', example: 'mod(7, 3) = 1' },
  random: { signature: 'random() -> Scalar', description: 'Uniform random sample on [0, 1).', example: 'random() * 100  → e.g. 42.7' },
  type:   { signature: 'type<T>(x: T) -> String', description: 'Type description for debugging. Returns a human-readable string.', example: 'type(3 m) = "Length"' },

  // ── List ops — constructors ───────────────────────────────────────
  range:       { signature: 'range(start: Scalar, end: Scalar) -> List<Scalar>', description: 'Integers from start to end, BOTH inclusive. Step 1 only — see arange for float or non-1 steps.', example: 'range(1, 5) = [1, 2, 3, 4, 5]' },
  arange:      { signature: 'arange(start: D, stop: D [, step: D]) -> List<D>', description: 'Numpy-style range. Stop EXCLUSIVE. Step optional (default 1). Supports negative step and unit-bearing args.', example: 'arange(0, 1, 0.25) = [0, 0.25, 0.5, 0.75]' },
  linspace:    { signature: 'linspace(start: D, end: D, n: Scalar) -> List<D>', description: 'n evenly-spaced points from start to end, BOTH inclusive. Unit-preserving.', example: 'linspace(0 m, 10 m, 5) = [0 m, 2.5 m, 5 m, 7.5 m, 10 m]' },
  zeros:       { signature: 'zeros(n: Scalar) -> List<Scalar>', description: 'n zeros. Dimensionless — multiply by a unit if needed.', example: 'zeros(3) = [0, 0, 0]' },
  ones:        { signature: 'ones(n: Scalar) -> List<Scalar>', description: 'n ones. Dimensionless — multiply by a unit if needed.', example: 'ones(3) * 100 g = [100 g, 100 g, 100 g]' },
  random_list: { signature: 'random_list(n: Scalar) -> List<Scalar>', description: 'n uniform random samples on [0, 1).', example: 'random_list(5)  → e.g. [0.42, 0.71, 0.03, 0.88, 0.55]' },

  // ── List ops — transformations ───────────────────────────────────
  map:    { signature: 'map<A, B>(f: Fn[(A) -> B], xs: List<A>) -> List<B>', description: 'Apply f to each element. With ep\'s broadcasting and auto-mapped builtins, often unnecessary — try `xs * 2` or `sin(xs)` first.', example: 'map(x => x * 2, [1, 2, 3]) = [2, 4, 6]' },
  map2:   { signature: 'map2<A, B, C>(f: Fn[(A, B) -> C], a: A, xs: List<B>) -> List<C>', description: 'Element-wise binary map with a scalar or paired-list second argument.', example: 'map2((a, b) => a * b, [1, 2, 3], [10, 20, 30]) = [10, 40, 90]' },
  filter: { signature: 'filter<A>(p: Fn[(A) -> Bool], xs: List<A>) -> List<A>', description: 'Keep elements where p returns true.', example: 'filter(x => x > 0, [-2, -1, 0, 1, 2]) = [1, 2]' },
  foldl:  { signature: 'foldl<A, B>(f: Fn[(A, B) -> A], init: A, xs: List<B>) -> A', description: 'Left fold. Threads an accumulator through xs.', example: 'foldl((a, x) => a + x, 0, [1, 2, 3, 4]) = 10' },
  concat: { signature: 'concat<A>(xs: List<A>, ys: List<A>) -> List<A>', description: 'Append two lists.', example: 'concat([1, 2], [3, 4]) = [1, 2, 3, 4]' },
  take:   { signature: 'take<A>(n: Scalar, xs: List<A>) -> List<A>', description: 'First n elements.', example: 'take(3, [1, 2, 3, 4, 5]) = [1, 2, 3]' },
  drop:   { signature: 'drop<A>(n: Scalar, xs: List<A>) -> List<A>', description: 'All elements after the first n.', example: 'drop(2, [1, 2, 3, 4, 5]) = [3, 4, 5]' },
  reverse:    { signature: 'reverse<A>(xs: List<A>) -> List<A>', description: 'Reverse element order.', example: 'reverse([1, 2, 3]) = [3, 2, 1]' },
  element_at: { signature: 'element_at<A>(i: Scalar, xs: List<A>) -> A', description: 'Get the i-th element (0-indexed).', example: 'element_at(1, [10, 20, 30]) = 20' },

  // ── List ops — primitives ────────────────────────────────────────
  head:     { signature: 'head<A>(xs: List<A>) -> A', description: 'First element. Errors on an empty list.', example: 'head([10, 20, 30]) = 10' },
  tail:     { signature: 'tail<A>(xs: List<A>) -> List<A>', description: 'All but the first element.', example: 'tail([10, 20, 30]) = [20, 30]' },
  cons:     { signature: 'cons<A>(x: A, xs: List<A>) -> List<A>', description: 'Prepend x to xs.', example: 'cons(0, [1, 2, 3]) = [0, 1, 2, 3]' },
  cons_end: { signature: 'cons_end<A>(x: A, xs: List<A>) -> List<A>', description: 'Append x to xs.', example: 'cons_end(4, [1, 2, 3]) = [1, 2, 3, 4]' },
  len:      { signature: 'len<A>(xs: List<A>) -> Scalar', description: 'Number of elements.', example: 'len([1, 2, 3, 4]) = 4' },
  is_empty: { signature: 'is_empty<A>(xs: List<A>) -> Bool', description: 'True if the list has zero elements.', example: 'is_empty([]) = true' },

  // ── Plots ─────────────────────────────────────────────────────────
  plot:      { signature: 'plot(xs: List<X>, ys: List<Y> [, xlabel: String, ylabel: String, title: String])', description: 'Line chart of (x, y) pairs. Trailing strings are optional axis labels and a title.', example: 'plot(xs, sin(xs), "x", "sin(x)", "Sine wave")' },
  scatter:   { signature: 'scatter(xs: List<X>, ys: List<Y> [, xlabel, ylabel, title])', description: 'Scatter plot of (x, y) pairs.' },
  bar_chart: { signature: 'bar_chart(values: List<V> [, xlabel, ylabel, title])', description: 'Bar chart, one bar per value. Named `bar_chart` (not `bar`) to avoid clashing with the `bar` pressure unit.' },
  hist:      { signature: 'hist(values: List<V> [, xlabel, ylabel, title])', description: 'Histogram. Bin count auto-set to ceil(sqrt(N)), capped at 50.' },

  // ── Strings ───────────────────────────────────────────────────────
  hex:        { signature: 'hex(x: Scalar) -> String', description: 'Hexadecimal representation.', example: 'hex(255) = "0xff"' },
  bin:        { signature: 'bin(x: Scalar) -> String', description: 'Binary representation.', example: 'bin(10) = "0b1010"' },
  oct:        { signature: 'oct(x: Scalar) -> String', description: 'Octal representation.', example: 'oct(8) = "0o10"' },
  base:       { signature: 'base(b: Scalar, x: Scalar) -> String', description: 'Representation in base b (2 ≤ b ≤ 16).', example: 'base(16, 255) = "ff"' },
  chr:        { signature: 'chr(n: Scalar) -> String', description: 'Single-char string from a Unicode code point.', example: 'chr(65) = "A"' },
  ord:        { signature: 'ord(s: String) -> Scalar', description: 'Code point of the first character.', example: 'ord("A") = 65' },
  str_length: { signature: 'str_length(s: String) -> Scalar', description: 'Number of characters in the string.' },
  str_eq:     { signature: 'str_eq(a: String, b: String) -> Bool', description: 'String equality (use `==` instead in most cases).' },
  str_slice:  { signature: 'str_slice(start: Scalar, end: Scalar, s: String) -> String', description: 'Substring [start, end).' },
  str_append: { signature: 'str_append(a: String, b: String) -> String', description: 'Concatenate two strings.' },
  lowercase:  { signature: 'lowercase(s: String) -> String', description: 'Convert to lowercase.' },
  uppercase:  { signature: 'uppercase(s: String) -> String', description: 'Convert to uppercase.' },

  // ── I/O + assertions ──────────────────────────────────────────────
  print:     { signature: 'print<T>(x: T) -> Scalar', description: 'Emit a value to the host\'s output sink. In ep, surfaces as an inline info block below the line.' },
  println:   { signature: 'println<T>(x: T) -> Scalar', description: 'Alias for print.' },
  assert:    { signature: 'assert(b: Bool) -> Scalar', description: 'Errors if the argument is false. Used in tests.' },
  assert_eq: { signature: 'assert_eq<T>(a: T, b: T [, tolerance: T]) -> Scalar', description: 'Asserts a == b within optional tolerance.' },
  error:     { signature: 'error<T>(msg: String) -> T', description: 'Throws an error with the given message. Diverges — return type is polymorphic.' },

  // ── ep prelude ────────────────────────────────────────────────────
  cylinder_volume: { signature: 'cylinder_volume(diameter, length) -> Volume', description: 'Cylindrical sample volume. π/4 · d² · l.', example: 'cylinder_volume(NQ_core, 5 m)' },
  sample_mass:     { signature: 'sample_mass(diameter, length, density) -> Mass', description: 'Mass of a cylindrical sample. cylinder_volume · density.', example: 'sample_mass(NQ_core, 5 m, 2.7 g/cm3)' },

  // ── Decorators ────────────────────────────────────────────────────
  '@input':   { signature: '@input', description: 'Marks the next binding as a user-editable input. Renders as a chip in the top panel.' },
  '@output':  { signature: '@output[(unit)]', description: 'Marks the next binding as a result. Optional unit override forces the chip to display in that unit.', example: '@output(kg)\nmass = volume * density' },
  '@options': { signature: '@options(a, b, c, ...)', description: 'Renders the chip as a dropdown. The binding value should be one of the listed labels.', example: '@options(granite, basalt, sandstone)\nrock = granite' },
  '@range':   { signature: '@range(min, max [, step])', description: 'Renders a numeric chip as a slider. Step is optional. Unit of the binding is preserved as you drag.', example: '@range(0, 500)\nlength = 200 m' },

  // ── Constants ─────────────────────────────────────────────────────
  pi:  { signature: 'pi : Scalar', description: 'π ≈ 3.14159…' },
  tau: { signature: 'tau : Scalar', description: '2π ≈ 6.28318… (one full turn).' },
  e:   { signature: 'e : Scalar', description: 'Euler\'s number ≈ 2.71828…' },
  NaN: { signature: 'NaN : Scalar', description: 'Not-a-Number sentinel.' },
  inf: { signature: 'inf : Scalar', description: 'Positive infinity.' },

  // ── Keywords ──────────────────────────────────────────────────────
  let:  { signature: 'let name [: Type] = expr', description: 'Bind a name to a value. The `let` keyword is optional in ep.' },
  fn:   { signature: 'fn name(params) [-> ReturnType] = body', description: 'Define a function. Parameters and return type can be annotated.' },
  if:   { signature: 'if cond then a else b', description: 'Conditional expression. Both branches must produce the same type.' },
  where: { signature: 'fn ... = body where helper = expr', description: 'Local helper bindings within a function body.' },
  to:   { signature: 'expr to UnitName', description: 'Convert to a different unit (same dim). Alias for `->`.' },
  per:  { signature: 'A per B', description: 'Unit division. `meters per second` is `m/s`.' },
  dimension: { signature: 'dimension Name = expr', description: 'Declare a derived dimension. Rarely needed — ep ships the common ones.' },
  unit:      { signature: 'unit name [: Dim] = expr', description: 'Declare a derived unit.' },
  struct:    { signature: 'struct Name { field: Type, ... }', description: 'Declare a record type.' },
  use:       { signature: 'use module::path', description: 'Load a vendored Numbat module (core::lists, math::statistics, etc.).' },
};

// Render a doc entry as a multi-line plain-text panel — CM6\'s
// autocomplete `info` field takes either a string or a Node-returning
// function. We use the string form for portability across themes.
export function renderDocInfo(name) {
  const d = DOCS[name];
  if (!d) return null;
  let s = d.signature;
  if (d.description) s += '\n\n' + d.description;
  if (d.example)     s += '\n\nexample:  ' + d.example;
  return s;
}
