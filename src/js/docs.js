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
  filter: { signature: 'filter<A>(p: Fn[(A) -> Bool] | List<Bool>, xs: List<A>) -> List<A>', description: 'Keep elements where p returns true. First arg can be a predicate function OR a Bool mask the same length as xs (ep extension).', example: 'filter(x => x > 0, [-2, -1, 0, 1, 2]) = [1, 2]\nxs = [1, 5, 10]; filter(xs > 4, xs) = [5, 10]' },
  foldl:  { signature: 'foldl<A, B>(f: Fn[(A, B) -> A], init: A, xs: List<B>) -> A', description: 'Left fold. Threads an accumulator through xs.', example: 'foldl((a, x) => a + x, 0, [1, 2, 3, 4]) = 10' },
  concat: { signature: 'concat<A>(xs: List<A>, ys: List<A>) -> List<A>', description: 'Append two lists.', example: 'concat([1, 2], [3, 4]) = [1, 2, 3, 4]' },
  take:   { signature: 'take<A>(n: Scalar, xs: List<A>) -> List<A>', description: 'First n elements.', example: 'take(3, [1, 2, 3, 4, 5]) = [1, 2, 3]' },
  drop:   { signature: 'drop<A>(n: Scalar, xs: List<A>) -> List<A>', description: 'All elements after the first n.', example: 'drop(2, [1, 2, 3, 4, 5]) = [3, 4, 5]' },
  reverse:    { signature: 'reverse<A>(xs: List<A>) -> List<A>', description: 'Reverse element order.', example: 'reverse([1, 2, 3]) = [3, 2, 1]' },
  element_at: { signature: 'element_at<A>(i: Scalar, xs: List<A>) -> A', description: 'Get the i-th element (0-indexed).', example: 'element_at(1, [10, 20, 30]) = 20' },

  // ── Mask reductions (ep extension) ───────────────────────────────
  any:   { signature: 'any(mask: List<Bool>) -> Bool',   description: 'True if any element of the mask is true. Short-circuits on the first true.', example: 'any([1, 5, 10] > 7) = true' },
  all:   { signature: 'all(mask: List<Bool>) -> Bool',   description: 'True only if every element of the mask is true. Short-circuits on the first false.', example: 'all([1, 5, 10] > 0) = true' },
  count: { signature: 'count(mask: List<Bool>) -> Scalar', description: 'Number of true elements in the mask.', example: 'count([1, 5, 10, 15] > 7) = 2' },

  // ── List ops — primitives ────────────────────────────────────────
  head:     { signature: 'head<A>(xs: List<A>) -> A', description: 'First element. Errors on an empty list.', example: 'head([10, 20, 30]) = 10' },
  tail:     { signature: 'tail<A>(xs: List<A>) -> List<A>', description: 'All but the first element.', example: 'tail([10, 20, 30]) = [20, 30]' },
  cons:     { signature: 'cons<A>(x: A, xs: List<A>) -> List<A>', description: 'Prepend x to xs.', example: 'cons(0, [1, 2, 3]) = [0, 1, 2, 3]' },
  cons_end: { signature: 'cons_end<A>(x: A, xs: List<A>) -> List<A>', description: 'Append x to xs.', example: 'cons_end(4, [1, 2, 3]) = [1, 2, 3, 4]' },
  len:      { signature: 'len<A>(xs: List<A> | Dataset) -> Scalar', description: 'Number of elements in a list, or rows in a dataset.', example: 'len([1, 2, 3, 4]) = 4' },
  is_empty: { signature: 'is_empty<A>(xs: List<A>) -> Bool', description: 'True if the list has zero elements.', example: 'is_empty([]) = true' },

  // ── List reductions ───────────────────────────────────────────────
  sum:     { signature: 'sum<D>(xs: List<D>) -> D', description: 'Sum of a list of quantities. All elements share the dim.', example: 'sum([10 kg, 5 kg, 2 kg]) = 17 kg' },
  mean:    { signature: 'mean<D>(xs: List<D>) -> D', description: 'Arithmetic mean. Also accepts an `Uncertain<D>`, in which case it collapses the sample distribution to a regular Quantity. Errors on an empty list.', example: 'mean([2, 4, 9]) = 5\nmean(normal(10, 2)) ≈ 10' },
  variance:{ signature: 'variance<D>(xs: List<D>) -> D^2', description: 'Population variance.' },
  stdev:   { signature: 'stdev<D>(xs: List<D>) -> D', description: 'Population standard deviation (divides by N, not N−1). Also accepts an `Uncertain<D>` — collapses the sample distribution to a regular Quantity carrying its spread.', example: 'stdev([2, 4, 9])\nstdev(normal(10, 2)) ≈ 2' },
  maximum: { signature: 'maximum<D>(xs: List<D>) -> D', description: 'Largest element. Errors on an empty list.', example: 'maximum([3, 9, 1]) = 9' },
  minimum: { signature: 'minimum<D>(xs: List<D>) -> D', description: 'Smallest element. Errors on an empty list.', example: 'minimum([3, 9, 1]) = 1' },
  median:  { signature: 'median<D>(xs: List<D>) -> D', description: 'Middle value (averages the middle pair for even length).', example: 'median([5, 1, 3]) = 3' },

  // ── Line references (ep extension) ────────────────────────────────
  above: { signature: 'above : List', description: 'The numeric results of the lines above this one, back to the last blank line. Pair with a reduction — sum(above), mean(above), maximum(above). A blank line starts a fresh group.', example: 'sum(above)' },
  _:     { signature: '_   ·   _N   ·   ans', description: 'Line references. `_` is the previous line\'s result; `_N` is the result of line N (the gutter line number); `ans` is the last binding\'s result.', example: '_3 + _7' },

  // ── Datasets (ep extension) ───────────────────────────────────────
  load_csv: { signature: 'load_csv(name: String) -> Dataset', description: 'Load an attached CSV asset as a Dataset. Drag a .csv onto ep to attach it; the asset name is the filename without .csv.', example: 'model = load_csv("deposit")' },
  dataset:  { signature: 'dataset<R>(rows: List<R>) -> Dataset', description: 'Columnarize a list of struct records into a Dataset. Column access (d.field) is then O(1).', example: 'dataset([Row { grade: 2 }, Row { grade: 5 }])' },
  schema:   { signature: 'schema(d: Dataset)', description: 'Print the dataset\'s columns — each with its unit or type — plus the row/column counts. Shown in an info block below the line.', example: 'schema(model)' },

  // ── Uncertainty (ep extension) ───────────────────────────────────
  normal:      { signature: 'normal<D>(mu: D, sigma: D) -> D', description: 'Draw samples from a normal distribution with mean `mu` and standard deviation `sigma`. Subsequent arithmetic propagates the samples through automatically — nonlinear ops get the right shape because each sample is computed independently.', example: 'density = normal(2.7 g/cm³, 0.1 g/cm³)' },
  uniform:     { signature: 'uniform<D>(lo: D, hi: D) -> D', description: 'Draw samples from a uniform distribution on [lo, hi].', example: 'length = uniform(180 m, 220 m)' },
  lognormal:   { signature: 'lognormal<D>(mu: D, sigma: D) -> D', description: 'Draw samples from a lognormal distribution. `mu` and `sigma` are real-space mean and standard deviation; conversion to log-space happens internally. All samples are positive.', example: 'grade = lognormal(1.5 g/t, 0.4 g/t)' },
  triangular:  { signature: 'triangular<D>(lo: D, mode: D, hi: D) -> D', description: 'Draw samples from a triangular distribution with the given low, mode, and high points.', example: 'recovery = triangular(0.82, 0.91, 0.95)' },
  percentile:  { signature: 'percentile<D>(x: D, p: Scalar) -> D', description: 'Return the p-th percentile of an uncertain value (p in [0, 100]). Collapses to a regular Quantity. Linear interpolation between adjacent order statistics.', example: 'p95 = percentile(tonnage, 95)' },
  sweep:       { signature: 'sweep<D>(start: D, end: D, n: Scalar) -> D', description: 'Vary a value linearly between `start` and `end` across `n` samples. Returns a Swept value: subsequent arithmetic carries both the output samples and the input axis through, so the output chip can render Y(X) as an inline line plot. Deterministic sibling of `normal` / `uniform` — sensitivity sweep rather than uncertainty propagation.', example: 'length = sweep(180 m, 220 m, 41)' },
  samples:     { signature: 'samples<D>(x: D) -> List<D>', description: 'Materialize an uncertain value as a regular List<Quantity> — escape hatch for custom reductions, ad-hoc plotting, or exporting. The dim and display unit of each element matches the Uncertain.', example: 'xs = samples(tonnage)\nmean(xs)  # same as mean(tonnage)' },
  pdf:         { signature: 'pdf<D>(x: D [, xlabel, ylabel, title])', description: 'Plot the probability-density estimate (Gaussian KDE, Silverman bandwidth) of an uncertain value as a smooth curve inline.', example: 'pdf(tonnage, "tonnage", "density", "Resource estimate")' },
  cdf:         { signature: 'cdf<D>(x: D [, xlabel, ylabel, title])', description: 'Plot the empirical cumulative distribution of an uncertain value as a sorted-step curve inline. P(X ≤ x).', example: 'cdf(tonnage)' },

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
  str_prepend:  { signature: 'str_prepend(a: String, b: String) -> String', description: 'Concatenate with `a` prepended to `b` (i.e. b then a).', example: 'str_prepend("!", "Numbat") = "Numbat!"' },
  str_find:     { signature: 'str_find(needle: String, haystack: String) -> Scalar', description: 'Index of the first occurrence of `needle` in `haystack`, or -1 if not found.', example: 'str_find("bat", "Numbat") = 3' },
  str_contains: { signature: 'str_contains(needle: String, haystack: String) -> Bool', description: 'True if `haystack` contains `needle`.', example: 'str_contains("bat", "Numbat") = true' },
  str_replace:  { signature: 'str_replace(pattern: String, replacement: String, s: String) -> String', description: 'Replace every occurrence of `pattern` with `replacement`.', example: 'str_replace("a", "@", "banana") = "b@n@n@"' },
  str_repeat:   { signature: 'str_repeat(n: Scalar, s: String) -> String', description: 'Repeat `s` n times.', example: 'str_repeat(3, "ab") = "ababab"' },
  dec:        { signature: 'dec(x: Scalar) -> String', description: 'Decimal representation as a string.', example: 'dec(42) = "42"' },

  // ── Date / time ──────────────────────────────────────────────────
  now:                { signature: 'now() -> DateTime', description: "Current date and time, stamped with the host's local timezone.", example: 'now()' },
  datetime:           { signature: 'datetime(input: String) -> DateTime', description: 'Parse a date/time string. Accepts ISO with offsets, and named-zone forms like "2026-12-25 09:00:00 Europe/Berlin".', example: 'datetime("2026-12-25 09:00:00 Europe/Berlin")' },
  today:              { signature: 'today() -> DateTime', description: "Today at midnight in the host's local timezone. Also usable as a bare value: `today` (ep extension).", example: 'today() + 7 days' },
  date:               { signature: 'date(input: String) -> DateTime', description: 'Parse a date-only string. Time defaults to 00:00:00.', example: 'date("2026-12-25")' },
  time:               { signature: 'time(input: String) -> DateTime', description: 'Parse a time-only string. Date defaults to today.', example: 'time("21:00")' },
  format_datetime:    { signature: 'format_datetime(format: String, input: DateTime [, tz: String]) -> String', description: 'Format a DateTime via strftime-style tokens (%Y %m %d %H %M %S %z %Z %A %B %j). Optional third arg overrides the display timezone.', example: 'format_datetime("%Y-%m-%d %H:%M", now())' },
  get_local_timezone: { signature: 'get_local_timezone() -> String', description: 'IANA timezone identifier for the host (e.g. "America/Sao_Paulo").', example: 'get_local_timezone()' },
  tz:                 { signature: 'tz(name: String) -> Fn[(DateTime) -> DateTime]', description: "Build a timezone converter. Apply via the conversion operator: `dt -> tz(\"Asia/Tokyo\")` re-stamps a datetime's display zone while preserving the instant.", example: 'datetime("2026-05-17 12:00:00 UTC") -> tz("Asia/Tokyo")' },
  UTC:                { signature: 'UTC : Fn[(DateTime) -> DateTime]', description: 'Pre-bound converter to UTC.', example: 'now() -> UTC' },
  local:              { signature: 'local : Fn[(DateTime) -> DateTime]', description: "Pre-bound converter to the host's local timezone.", example: 'datetime("2026-05-17 12:00:00 UTC") -> local' },
  weekday:            { signature: 'weekday(dt: DateTime) -> String', description: 'Day of the week as a name (e.g. "Friday").', example: 'weekday(datetime("2026-12-25"))' },
  calendar_add:       { signature: 'calendar_add(dt: DateTime, span: Time) -> DateTime', description: 'Calendar-aware shift. A month lands on the same day-of-month; days are DST-aware; overflow constrains (Jan 31 + 1 month → Feb 28/29).', example: 'calendar_add(today(), 1 month)' },
  calendar_sub:       { signature: 'calendar_sub(dt: DateTime, span: Time) -> DateTime', description: 'Calendar-aware subtract. Equivalent to `calendar_add(dt, -span)`.', example: 'calendar_sub(today(), 1 year)' },
  has_unit:           { signature: 'has_unit(span: Time, target: Time) -> Bool', description: 'Whole-unit approximation — true when `span` is a whole multiple of `target`. Used by `calendar_add` to dispatch on days vs months vs years.', example: 'has_unit(2 months, months) = true' },

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
  where: { signature: 'collection where <bool-expr>   ·   fn ... = body where helper = expr', description: 'Two forms. Filter (ep extension): `dataset where grade > cutoff` keeps matching rows — the predicate sees the dataset\'s columns. On a plain list, `xs where xs > 5` filters by the mask. Fn-body form: local helper bindings within a function body.', example: 'ore = model where grade > 1 g/t' },
  to:   { signature: 'expr to UnitName', description: 'Convert to a different unit (same dim). Alias for `->`.' },
  per:  { signature: 'A per B', description: 'Unit division. `meters per second` is `m/s`.' },
  dimension: { signature: 'dimension Name = expr', description: 'Declare a derived dimension. Rarely needed — ep ships the common ones.' },
  unit:      { signature: 'unit name [: Dim] = expr', description: 'Declare a derived unit.' },
  struct:    { signature: 'struct Name { field: Type, ... }', description: 'Declare a record type.' },
  use:       { signature: 'use module::path', description: 'Load a vendored Numbat module (core::lists, math::statistics, etc.).' },
};

// Display-ordered grouping of DOCS for the in-app docs viewer (drawer's
// "docs" mode). Each group's `names` list mirrors the comment headers
// above — keep these in sync when adding new entries. Names not listed
// here land in a synthetic "Other" group at the bottom of the panel.
export const DOC_GROUPS = [
  { label: 'Numeric — single-arg', names: [
    'abs','sqrt','cbrt','sqr','round','floor','ceil','trunc','fract',
    'exp','ln','log','log10','log2',
    'sin','cos','tan','asin','acos','atan','sinh','cosh','tanh',
  ]},
  { label: 'Numeric — multi-arg', names: [
    'max','min','mod','random','type',
  ]},
  { label: 'List constructors', names: [
    'range','arange','linspace','zeros','ones','random_list',
  ]},
  { label: 'List transformations', names: [
    'map','map2','filter','foldl','concat','take','drop','reverse','element_at',
  ]},
  { label: 'Mask reductions (ep extension)', names: [
    'any','all','count',
  ]},
  { label: 'List primitives', names: [
    'head','tail','cons','cons_end','len','is_empty',
  ]},
  { label: 'List reductions', names: [
    'sum','mean','variance','stdev','maximum','minimum','median',
  ]},
  { label: 'Line references (ep extension)', names: [
    'above','_',
  ]},
  { label: 'Datasets (ep extension)', names: [
    'load_csv','dataset','schema',
  ]},
  { label: 'Date / time', names: [
    'now','datetime','today','date','time',
    'format_datetime','get_local_timezone',
    'tz','UTC','local',
    'weekday','calendar_add','calendar_sub','has_unit',
  ]},
  { label: 'Uncertainty (ep extension)', names: [
    'normal','uniform','lognormal','triangular',
    'percentile','samples','pdf','cdf',
  ]},
  { label: 'Sensitivity sweep (ep extension)', names: [
    'sweep',
  ]},
  { label: 'Plots', names: [
    'plot','scatter','bar_chart','hist',
  ]},
  { label: 'Strings', names: [
    'str_length','str_eq','str_slice','str_append','str_prepend',
    'str_find','str_contains','str_replace','str_repeat',
    'chr','ord','lowercase','uppercase',
    'hex','bin','oct','dec','base',
  ]},
  { label: 'I/O + assertions', names: [
    'print','println','assert','assert_eq','error',
  ]},
  { label: 'ep prelude', names: [
    'cylinder_volume','sample_mass',
  ]},
  { label: 'Decorators', names: [
    '@input','@output','@options','@range',
  ]},
  { label: 'Constants', names: [
    'pi','tau','e','NaN','inf',
  ]},
  { label: 'Keywords', names: [
    'let','fn','if','where','to','per','dimension','unit','struct','use',
  ]},
];

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

// Split a signature like "max<D>(a: D, b: D) -> D" into:
//   { prefix: "max<D>(", args: ["a: D", "b: D"], suffix: ") -> D" }
// Returns null if there's no parenthesized arg list (constants like `pi`,
// keywords, etc.). Splitting is depth-aware so nested generics like
// `List<T>` don't trip the comma scanner.
export function parseSignature(name) {
  const d = DOCS[name];
  if (!d) return null;
  const sig = d.signature;
  const open = sig.indexOf('(');
  if (open < 0) return null;
  // Find matching close paren — track angle/paren depth so we don't
  // mis-match on e.g. `(xs: List<T>, ys: List<T>) -> List<T>`.
  let depth = 1;
  let i = open + 1;
  while (i < sig.length && depth > 0) {
    const c = sig[i];
    if (c === '(' || c === '<') depth++;
    else if (c === ')' || c === '>') depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) return null;
  const inner = sig.slice(open + 1, i);
  // Split inner by commas at depth 0.
  const args = [];
  let buf = '';
  let d2 = 0;
  for (const c of inner) {
    if (c === '(' || c === '<') d2++;
    else if (c === ')' || c === '>') d2--;
    if (c === ',' && d2 === 0) { args.push(buf.trim()); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) args.push(buf.trim());
  return {
    prefix: sig.slice(0, open + 1),
    args,
    suffix: sig.slice(i),
    description: d.description || '',
  };
}
