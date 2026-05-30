// @gcu/numbat — adder bridge: a Python-shaped, dimension-checked quantities
// library for auditable notebooks, powered by the numbat engine.
//
// Loaded via `load("@gcu/numbat/adder")` AFTER the engine (`load("@gcu/numbat")`),
// or auto-discovered for `from numbat import …` in `/// adder` cells.
//
// It's pint-shaped (Q, u) but a superset: it also surfaces numbat's uncertainty
// (Monte-Carlo-with-units), sensitivity sweeps, dimensional solvers, and
// time-series ops. The engine does all the dimensional math + throws on
// mismatch; this is a thin skin + adder dunders. See gentropic/cradle's
// CAPSULES.md sibling note isn't relevant here — this is the numbat side.

// Build the Python-shaped module from an already-loaded numbat engine
// namespace ({ Numbat, formatParts, setQuantityFormatter, … }). Exported so a
// node harness can construct + test it directly; the browser bridge below
// calls it with the engine from `_importCache`.
export function makeNumbat(engine) {
  const { Numbat, formatParts, formatNumber, setQuantityFormatter } = engine;

  // One engine instance, bootstrapped the way ep's evaluator host() is:
  // the v0.1 prelude's *curated* unit table (kept as-is — we deliberately do
  // NOT `use units::si/imperial/misc`, which would flood registry.list() with
  // every unit and make the formatter auto-scale 4 m → "2.19 fathom") plus the
  // vendored function modules + the uncertainty/sweep signatures + native
  // (stack-safe) list ops winning over the recursive .nbt defs.
  const _nb = new Numbat({ prelude: 'v0.1' });
  _nb.registerAllVendoredModules();
  for (const m of ['core::strings', 'core::lists', 'math::statistics', 'datetime::functions']) {
    try { _nb.use(m); } catch { /* best effort */ }
  }
  _nb.registerModule('uncertainty::functions', [
    'fn normal<D>(mu: D, sigma: D) -> D',
    'fn uniform<D>(lo: D, hi: D) -> D',
    'fn lognormal<D>(mu: D, sigma: D) -> D',
    'fn triangular<D>(lo: D, mode: D, hi: D) -> D',
    'fn percentile<D>(x: D, p: Scalar) -> D',
    'fn samples<D>(x: D) -> List<D>',
    '',
  ].join('\n'));
  try { _nb.use('uncertainty::functions'); } catch {}
  _nb.registerModule('sweep::functions', ['fn sweep<D>(start: D, end: D, n: Scalar) -> D', ''].join('\n'));
  try { _nb.use('sweep::functions'); } catch {}
  for (const n of ['range', 'map', 'map2', 'filter', 'foldl', 'concat', 'take',
                   'drop', 'reverse', 'element_at', 'maximum', 'minimum',
                   'median', 'sum', 'mean', 'stdev']) {
    _nb.fns.delete(n);
  }
  if (typeof setQuantityFormatter === 'function') {
    setQuantityFormatter((q) => formatParts(q, _nb.registry));
  }

  // ── engine invocation helpers ───────────────────────────────────────────
  let _n = 0;
  // Evaluate a numbat expression string ("5 m", "60 km/h -> m/s") → Quantity.
  const _eval = (expr) => {
    const k = '__q' + (_n++);
    _nb.loadSource(`let ${k} = ${expr}`, '<numbat>');
    return _nb.values.get(k);
  };
  // Unwrap an adapter Quantity / coerce a number into a numbat value.
  const _raw = (x) =>
    (x && x._nbq !== undefined) ? x._nbq
      : (typeof x === 'number' ? _eval(String(x)) : x);
  // Call an engine function by binding runtime args (Quantities / JS fns / lists)
  // as temp values, then source-calling — the only way to pass live values into
  // the evaluator. Returns the raw result value.
  const _call = (fnName, args) => {
    const names = args.map((a) => { const nm = '__a' + (_n++); _nb.values.set(nm, a); return nm; });
    const k = '__r' + (_n++);
    _nb.loadSource(`let ${k} = ${fnName}(${names.join(', ')})`, '<numbat>');
    return _nb.values.get(k);
  };

  const W = (nbq) => new Quantity(nbq);

  // The engine's mul/div don't carry a display unit (a product's unit is
  // ill-defined), so the formatter auto-scales the result — which turns
  // `2 * (5 m)` into "1 dam". But scaling by a *pure number* should preserve
  // the unit, so re-apply the dimension-bearing operand's disp in that case.
  const _scalar = (q) => !q || !q.dim || Object.keys(q.dim).length === 0;
  const _keepUnit = (res, base, other) => {
    if (res && res.disp == null && base && base.disp != null && _scalar(other)) res.disp = base.disp;
    return res;
  };

  // ── the Python-shaped quantity ──────────────────────────────────────────
  class Quantity {
    constructor(nbq) { this._nbq = nbq; }
    // arithmetic — every op delegates to the engine, which dimension-checks
    __add__(o)      { return W(this._nbq.add(_raw(o))); }   // throws on dim mismatch
    __sub__(o)      { return W(this._nbq.sub(_raw(o))); }
    __mul__(o)      { const r = _raw(o); return W(_keepUnit(this._nbq.mul(r), this._nbq, r)); }
    __truediv__(o)  { const r = _raw(o); return W(_keepUnit(this._nbq.div(r), this._nbq, r)); }
    __pow__(n)      { return W(this._nbq.pow((n && n._nbq !== undefined) ? n._nbq : n)); }
    __neg__()       { return W(this._nbq.neg()); }
    // reflected — for `2 * length`, `5 + length`, etc. add/mul are commutative,
    // so keep `this` (the dimensionful side) as the receiver: the engine
    // propagates the receiver's display unit, so `2 * (5 m)` reads "10 m", not
    // the unit-stripped auto-scale "1 dam".
    __radd__(l)     { return W(this._nbq.add(_raw(l))); }
    __rmul__(l)     { const r = _raw(l); return W(_keepUnit(this._nbq.mul(r), this._nbq, r)); }
    __rsub__(l)     { return W(_raw(l).sub(this._nbq)); }
    __rtruediv__(l) { return W(_raw(l).div(this._nbq)); }

    to(unit)        { return W(this._nbq.convertTo(unit, _nb.registry)); }
    get magnitude() { return this._nbq.value; }   // canonical (SI-base) value

    __repr__() {
      const p = formatParts(this._nbq, _nb.registry);
      const tail = p.unit ? ' ' + p.unit : '';
      // The display scale formatParts chose: canonical value per display unit.
      const meanNum = parseFloat(String(p.num).replace(/,/g, ''));
      const scale = meanNum ? this._nbq.value / meanNum : 1;
      if (this._nbq.__swept) {
        // A sweep is a range, not a point — show min … max, not the mean.
        const s = this._nbq.samples;
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < s.length; i++) { if (s[i] < lo) lo = s[i]; if (s[i] > hi) hi = s[i]; }
        return `${formatNumber(lo / scale)} … ${formatNumber(hi / scale)}${tail}`;
      }
      if (this._nbq.__uncertain) {
        // Render stdev at the same scale the mean was rendered at, so both
        // sides of the ± carry the one shared unit (otherwise stdev would
        // auto-scale independently — e.g. mean in g/cm³, stdev in kg/m³).
        const sd = _call('stdev', [this._nbq]);
        return `${p.num} ± ${formatNumber(sd.value / scale)}${tail}`;
      }
      return p.unit ? `${p.num} ${p.unit}` : p.num;
    }
    __str__() { return this.__repr__(); }
    _repr_html_() {
      const txt = this.__repr__();
      return `<span style="font-variant-numeric:tabular-nums">${txt}</span>`;
    }
  }

  // ── builders ────────────────────────────────────────────────────────────
  // Q(5, "m") · Q("5 m") · Q(5)            u("km/h") · u.meter · u.newton
  // Pin the requested unit as the display unit (the same disp tag `->` sets),
  // so "the unit you ask for is the unit you see" — a bare literal carries no
  // disp, which would auto-scale Q(10, "m") to "1 dam".
  const _tag = (q, unit) => { if (unit != null && q && q.disp == null) q.disp = String(unit); return q; };
  const Q = (v, unit) => W(_tag(_eval(unit === undefined ? String(v) : `${v} ${unit}`), unit));
  const u = new Proxy((name) => W(_tag(_eval(String(name)), name)),
    { get: (_t, name) => (typeof name === 'string' ? W(_tag(_eval(name), name)) : undefined) });

  // uncertainty (Monte-Carlo-with-units) + sweep — args are Quantity or number
  const _build = (name) => (...args) => W(_call(name, args.map(_raw)));
  const normal      = _build('normal');
  const uniform     = _build('uniform');
  const lognormal   = _build('lognormal');
  const triangular  = _build('triangular');
  const sweep       = _build('sweep');

  // collapses — a reduction of a dimensioned distribution keeps its unit, so
  // render the result in the SAME unit the source displays in. A plain disp
  // string won't help (compound-power units like g/cm³ don't resolve via
  // registry.resolve), so resolve the source's chosen unit to a {mul, name}
  // disp object — the form formatParts honors directly, no registry lookup.
  const _dispOf = (src) => {
    const fp = formatParts(src, _nb.registry);
    if (!fp.unit || !src.value) return null;
    const mul = src.value / parseFloat(String(fp.num).replace(/,/g, ''));
    return isFinite(mul) && mul !== 0 ? { mul, name: fp.unit } : null;
  };
  // Override any existing disp: the collapse BUILTINs stamp an unresolvable
  // string disp (e.g. "g/cm^3") on their result; replace it with the source's
  // resolved {mul, name} so every collapse renders in the one shared unit.
  const _wearDisp = (res, src) => { const d = src && _dispOf(src); if (res && d) res.disp = d; return res; };
  const mean        = (x) => { const r = _raw(x); return W(_wearDisp(_call('mean', [r]), r)); };
  const stdev       = (x) => { const r = _raw(x); return W(_wearDisp(_call('stdev', [r]), r)); };
  const percentile  = (x, p) => { const r = _raw(x); return W(_wearDisp(_call('percentile', [r, _raw(p)]), r)); };
  const samples     = (x) => { const r = _raw(x); return _call('samples', [r]).map((s) => W(_wearDisp(s, r))); };

  // solvers — wrap the user's adder fn so it receives + returns adapter
  // Quantities while the engine drives it with raw ones.
  const _wrapFn = (f) => (rawArg) => {
    const r = f(W(rawArg));
    return (r && r._nbq !== undefined) ? r._nbq : _raw(r);
  };
  const solve_for = (f, target, ...bounds) => W(_call('solve_for', [_wrapFn(f), _raw(target), ...bounds.map(_raw)]));
  const minimize  = (f, lo, hi) => W(_call('minimize', [_wrapFn(f), _raw(lo), _raw(hi)]));
  const maximize  = (f, lo, hi) => W(_call('maximize', [_wrapFn(f), _raw(lo), _raw(hi)]));

  // time-series (lists of Quantities)
  const _rawList = (xs) => xs.map(_raw);
  const diff   = (xs)    => _call('diff',   [_rawList(xs)]).map(W);
  const cumsum = (xs)    => _call('cumsum', [_rawList(xs)]).map(W);
  const roll   = (xs, w) => _call('roll',   [_rawList(xs), _raw(w)]).map((win) => win.map(W));

  return {
    Q, u, Quantity,
    normal, uniform, lognormal, triangular, sweep,
    mean, stdev, percentile, samples,
    solve_for, minimize, maximize,
    diff, cumsum, roll,
  };
}

// ── Works / adder bridge ───────────────────────────────────────────────────
// In the notebook context, resolve the engine and register the `numbat`
// namespace so `from numbat import Q, u, …` resolves. Mirrors carotte's bridge:
// prefer the already-cached engine, else dynamically import the bare specifier —
// the host's installed-module materializer scans this file for `@gcu/numbat`,
// materialises the engine first, and rewrites the specifier to the engine's
// blob URL, so the import resolves cleanly even in the adder-only (no JS
// preamble) notebook shape.
//
// Registered under the engine name `@gcu/numbat` (the engine itself is a plain
// library, never a registered extension, so the name is free) and with NO
// `requires` — a requires-check targets registered extensions, never a library
// in _importCache, so requiring `@gcu/numbat` can never pass and would throw the
// whole registration. Skipped under node (no `window`); the test harness imports
// `makeNumbat` directly.
if (typeof window !== 'undefined') {
  const engine = (window._importCache && window._importCache['@gcu/numbat'])
    ?? (await import('@gcu/numbat'));
  const numbat = makeNumbat(engine);
  const register = window.auditable && window.auditable.registerExtension;
  if (register) {
    register({
      name: '@gcu/numbat',
      version: '0.1.1',
      description: 'unit-aware, dimension-checked quantities for adder cells (pint-shaped, + uncertainty / sweeps / solvers)',
      exports: { numbat },
    });
  } else {
    (window._auditableExtensions = window._auditableExtensions || {}).numbat = numbat;
  }
}
