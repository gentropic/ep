// Glue between the typechecker and the runtime (load.js).
//
// `buildTypeEnv(runtimeEnv)` walks a freshly-constructed runtime env
// (dims registry, units registry, value table) and produces a parallel
// typed env. Hand-rolled schemes for the BUILTIN_FNS handle math
// primitives that aren't defined via vendored .nbt sources.
//
// `typecheckModule(ast, runtimeEnv)` runs the full pipeline (check →
// solve) and returns `{ subst, errors, env: typeEnv }`. Calling it
// before loadModule(ast, runtimeEnv) lets the runtime skip dim checks
// the typechecker already proved — and surfaces dim mismatches at
// parse/check time instead of at first-execution-of-the-bad-branch.

import { tDim, tBool, tString, tFn, tList, tStruct, tVar, tDimVar, tScheme, freshTVar, freshTDimVar, freeVars, dimExprFromMap, dimExprFromVar, dimExprPow, T_SCALAR } from './types.js';
import { ratOf } from './rat.js';
import { generalize } from './scheme.js';
import { makeTypeEnv, typeEnvBindValue, typeEnvBindDim, typeEnvBindFn, typeEnvBindStruct } from './env.js';
import { checkModule, checkDecl, evalTypeAnno } from './check.js';
import { solve } from './solve.js';
import { applyType, makeSubst } from './subst.js';
import { makeConstraintSet } from './constraints.js';
import { buildDimAliases } from './errors.js';

// ── Hand-rolled schemes for BUILTIN_FNS ───────────────────────────
//
// These mirror the upstream-Numbat-style declarations:
//   sqrt: <D>(D^2) -> D
//   abs:  <D>(D)   -> D
//   sin:  (Scalar) -> Scalar
// (Angle is represented as Scalar in our runtime, so sin accepts Scalar.)
//
// We build each scheme fresh so the dim-var ids stay unique. The
// generalize() call packages them as proper ∀-bound schemes.

function schemeUnaryPreserveDim() {
  const d = freshTDimVar();
  const td = tDim(dimExprFromVar(d));
  return generalize(tFn([td], td), [], [d]);
}

function schemeUnaryScalarToScalar() {
  return generalize(tFn([T_SCALAR], T_SCALAR), [], []);
}

function schemeRoot(n) {
  // sqrt: <D>(D^n) -> D
  const d = freshTDimVar();
  const dimExp = dimExprPow(dimExprFromVar(d), ratOf(n));
  return generalize(tFn([tDim(dimExp)], tDim(dimExprFromVar(d))), [], [d]);
}

// Schemes for the most-used BUILTIN_PROCS. The runtime procs are
// variadic in some cases (assert_eq is 2-or-3 args); we register a
// fixed-arity scheme here that matches the canonical form. Variadic
// proc typing is tracked as a follow-up.
function schemeAssertEq() {
  // <T>(T, T, T?) -> Scalar — third arg is optional tolerance.
  const t = freshTVar();
  return generalize(tFn([t, t, t], T_SCALAR, { optional: 1 }), [t], []);
}
function schemeAssertBool() {
  return generalize(tFn([tBool()], T_SCALAR), [], []);
}
function schemePolyUnary() {
  // <T>(T) -> Scalar — for print, println
  const t = freshTVar();
  return generalize(tFn([t], T_SCALAR), [t], []);
}
function schemeErrorString() {
  // error<T>(String) -> T — diverging, so return is fully polymorphic
  const t = freshTVar();
  return generalize(tFn([tString()], t), [t], []);
}

// Arithmetic-on-dim procs (mod, max, min) — return type matches the
// shared dim of all args. Variadic for max/min isn't worth tracking
// in our 2-arg-min scheme: we represent them as 2-arg with no optional
// slot here, and users calling with more args get a spurious error.
// Tracked alongside #103 if it becomes important.
function schemeBinaryPreserveDim() {
  // <D: Dim>(D, D) -> D
  const d = freshTDimVar();
  const td = tDim(dimExprFromVar(d));
  return generalize(tFn([td, td], td), [], [d]);
}
function schemeTypeOf() {
  // <T>(T) -> String — runtime returns a textual description of the type
  const t = freshTVar();
  return generalize(tFn([t], tString()), [t], []);
}
function schemeStrFn1() { return generalize(tFn([tString()], tString()), [], []); }
function schemeStrEq()  { return generalize(tFn([tString(), tString()], tBool()), [], []); }
function schemeStrLen() { return generalize(tFn([tString()], T_SCALAR), [], []); }
function schemeStrAppend() { return generalize(tFn([tString(), tString()], tString()), [], []); }
function schemeStrSlice() {
  // str_slice(start: Scalar, end: Scalar, s: String) -> String
  return generalize(tFn([T_SCALAR, T_SCALAR, tString()], tString()), [], []);
}
function schemeChr() { return generalize(tFn([T_SCALAR], tString()), [], []); }
function schemeOrd() { return generalize(tFn([tString()], T_SCALAR), [], []); }
function schemeRandom() { return generalize(tFn([], T_SCALAR), [], []); }

// List ops (subset of core::lists). Registered here so user programs
// can call them without `use core::lists` lifting through the runtime.
function schemeHead() {
  // <T>(List<T>) -> T
  const t = freshTVar();
  return generalize(tFn([tList(t)], t), [t], []);
}
function schemeTail() {
  // <T>(List<T>) -> List<T>
  const t = freshTVar();
  return generalize(tFn([tList(t)], tList(t)), [t], []);
}
function schemeCons() {
  // <T>(T, List<T>) -> List<T>
  const t = freshTVar();
  return generalize(tFn([t, tList(t)], tList(t)), [t], []);
}
function schemeLen() {
  // <T>(List<T>) -> Scalar
  const t = freshTVar();
  return generalize(tFn([tList(t)], T_SCALAR), [t], []);
}

const BUILTIN_PROC_SCHEMES = {
  // Assertions + I/O
  assert:     schemeAssertBool,
  assert_eq:  schemeAssertEq,
  print:      schemePolyUnary,
  println:    schemePolyUnary,
  error:      schemeErrorString,
  // List ops
  head:       schemeHead,
  tail:       schemeTail,
  cons:       schemeCons,
  cons_end:   schemeCons,
  len:        schemeLen,
  // Arithmetic
  mod:        schemeBinaryPreserveDim,
  max:        schemeBinaryPreserveDim,
  min:        schemeBinaryPreserveDim,
  random:     schemeRandom,
  // Reflection
  type:       schemeTypeOf,
  // String ops
  str_length: schemeStrLen,
  str_eq:     schemeStrEq,
  str_slice:  schemeStrSlice,
  str_append: schemeStrAppend,
  chr:        schemeChr,
  ord:        schemeOrd,
  lowercase:  schemeStrFn1,
  uppercase:  schemeStrFn1,
  // Plot output procs. Each emits to the host's _plotSink and returns
  // the void sentinel (Scalar). plot/scatter take two lists; bar/hist
  // take one. Type vars are unrestricted dims so calling with e.g.
  // List<Length> + List<Mass> typechecks cleanly — the host doesn't
  // care about the axes' physical dims.
  plot:       schemePlot2,
  scatter:    schemePlot2,
  bar_chart:  schemePlot1,  // NOT `bar` — conflicts with the `bar` pressure unit
  hist:       schemePlot1,
  // Layered-plot fluent builders (SPEC-LAYERED-PLOTS). Each adder threads
  // the Plot value as the first arg and returns the same shape — typed
  // here as a polymorphic P so chains typecheck without a first-class
  // Plot type.
  line_plot:     schemePlotEmpty,
  scatter_plot:  schemePlotEmpty,
  bar_plot:      schemePlotEmpty,
  histogram:     schemePlotEmpty,
  stereonet:     schemePlotEmpty,
  with_line:     schemeWithXyLayer,
  with_scatter:  schemeWithXyLayer,
  with_band:     schemeWithBandLayer,
  with_bars:     schemeWithValuesLayer,
  with_bins:     schemeWithValuesLayer,
  with_planes:   schemeWithStereonetLayer,
  with_lines:    schemeWithStereonetLayer,
  with_poles:    schemeWithStereonetLayer,
  with_title:    schemeWithLabel,
  with_xlabel:   schemeWithLabel,
  with_ylabel:   schemeWithLabel,
  with_color:    schemeWithColor,
  with_width:    schemeWithScalarStyle,
  with_dash:     schemeWithDash,
  with_alpha:    schemeWithScalarStyle,
  with_marker_size: schemeWithScalarStyle,
  show:          schemeShow,
  stereonet_planes: schemeShortcutStereonet,
  stereonet_lines:  schemeShortcutStereonet,
  // Iterative list ops — schemes mirror the script-level signatures in
  // core::lists. ep deletes the recursive user-fn defs after loading
  // the module so these native versions win dispatch; the schemes here
  // keep typecheck happy.
  range:      schemeRange,
  map:        schemeMap,
  map2:       schemeMap2,
  filter:     schemeFilter,
  foldl:      schemeFoldl,
  concat:     schemeConcat,
  take:       schemeListSlice,
  drop:       schemeListSlice,
  reverse:    schemeReverse,
  element_at: schemeElementAt,
  any:        schemeMaskReduceBool,
  all:        schemeMaskReduceBool,
  count:      schemeMaskReduceScalar,
  dataset:    schemeDataset,
  load_csv:   schemeLoadCsv,
  schema:     schemePolyUnary,   // (Dataset) -> Scalar (void); prints the listing
  maximum:    schemeListReduceDim,
  minimum:    schemeListReduceDim,
  median:     schemeListReduceDim,
  sum:        schemeListReduceDim,
  mean:       schemeListReduceDim,
  stdev:      schemeListReduceDim,
  random_list: schemeRandomList,
  zeros:    schemeZerosOnes,
  ones:     schemeZerosOnes,
  linspace: schemeLinspace,
  arange:   schemeArange,
};

function schemeMaskReduceBool() {
  // (List<Bool>) -> Bool — any / all
  return generalize(tFn([tList(tBool())], tBool()), [], []);
}
function schemeMaskReduceScalar() {
  // (List<Bool>) -> Scalar — count
  return generalize(tFn([tList(tBool())], T_SCALAR), [], []);
}
function schemeDataset() {
  // <A>(List<A>) -> List<A> — loose. A Dataset is conceptually a list
  // of rows; the runtime columnarizes it. Column access on the result
  // isn't statically verified (the schema is runtime-only) — the
  // "drop tc errors when runtime succeeds" policy covers it.
  const a = freshTVar();
  return generalize(tFn([tList(a)], tList(a)), [a], []);
}
function schemeLoadCsv() {
  // <A>(String) -> List<A> — loose. The Dataset's columns/schema are
  // runtime-only (the file is read at eval), so the result is typed as
  // an opaque list of rows; column access falls to the runtime.
  const a = freshTVar();
  return generalize(tFn([tString()], tList(a)), [a], []);
}
function schemeListReduceDim() {
  // <D>(List<D>) -> D — maximum / minimum / median. Native shadows of
  // the recursive math::statistics defs; the scheme keeps the
  // typechecker happy after evaluator.js deletes the .nbt versions.
  const a = freshTVar();
  return generalize(tFn([tList(a)], a), [a], []);
}

function schemeRandomList() {
  // (Scalar) -> List<Scalar>  — n random samples in [0, 1)
  return generalize(tFn([T_SCALAR], tList(T_SCALAR)), [], []);
}
function schemeZerosOnes() {
  // (Scalar) -> List<Scalar>  — same shape for both
  return generalize(tFn([T_SCALAR], tList(T_SCALAR)), [], []);
}
function schemeLinspace() {
  // <D: Dim>(D, D, Scalar) -> List<D>  — preserves unit-bearing dim
  const d = freshTVar();
  return generalize(tFn([d, d, T_SCALAR], tList(d)), [d], []);
}
function schemeArange() {
  // <D: Dim>(D, D, D?) -> List<D>  — third arg (step) optional, same dim
  const d = freshTVar();
  return generalize(tFn([d, d, d], tList(d), { optional: 1 }), [d], []);
}

function schemeRange() {
  // (Scalar, Scalar) -> List<Scalar>
  return generalize(tFn([T_SCALAR, T_SCALAR], tList(T_SCALAR)), [], []);
}
function schemeMap() {
  // <A, B>(Fn[(A) -> B], List<A>) -> List<B>
  const a = freshTVar();
  const b = freshTVar();
  return generalize(tFn([tFn([a], b), tList(a)], tList(b)), [a, b], []);
}
function schemeMap2() {
  // <A, B, C>(Fn[(A, B) -> C], A, List<B>) -> List<C>  — simpler shape
  // than upstream allows (upstream accepts `other: A | List<A>`), but
  // covers the common case. Scheme is the strict shape; permissive
  // runtime handles the list-of-other variant too.
  const a = freshTVar();
  const b = freshTVar();
  const c = freshTVar();
  return generalize(tFn([tFn([a, b], c), a, tList(b)], tList(c)), [a, b, c], []);
}
function schemeFilter() {
  // <A, F>(F, List<A>) -> List<A>
  //
  // First arg is intentionally unconstrained. The runtime accepts EITHER
  // a predicate function `(A) -> Bool` OR a Bool mask `List<Bool>` of the
  // same length as xs. Encoding "function OR list" as a single HM scheme
  // isn't expressible — relaxing F to a TVar lets both forms typecheck
  // cleanly and pushes shape-checking to the runtime, where the error
  // message ("mask length 2 doesn't match list length 3") is also more
  // useful than the typechecker's "cannot unify (...) -> Bool with
  // List<Bool>". Net tradeoff: lose typecheck rejection of nonsense like
  // filter(5, xs); keep both useful forms.
  const a = freshTVar();
  const f = freshTVar();
  return generalize(tFn([f, tList(a)], tList(a)), [a, f], []);
}
function schemeFoldl() {
  // <A, B>(Fn[(A, B) -> A], A, List<B>) -> A
  const a = freshTVar();
  const b = freshTVar();
  return generalize(tFn([tFn([a, b], a), a, tList(b)], a), [a, b], []);
}
function schemeConcat() {
  // <A>(List<A>, List<A>) -> List<A>
  const a = freshTVar();
  return generalize(tFn([tList(a), tList(a)], tList(a)), [a], []);
}
function schemeListSlice() {
  // <A>(Scalar, List<A>) -> List<A>  — for take / drop
  const a = freshTVar();
  return generalize(tFn([T_SCALAR, tList(a)], tList(a)), [a], []);
}
function schemeReverse() {
  // <A>(List<A>) -> List<A>
  const a = freshTVar();
  return generalize(tFn([tList(a)], tList(a)), [a], []);
}
function schemeElementAt() {
  // <A>(Scalar, List<A>) -> A
  const a = freshTVar();
  return generalize(tFn([T_SCALAR, tList(a)], a), [a], []);
}

function schemePlot2() {
  // <X, Y>(List<X>, List<Y>, String?, String?, String?) -> Scalar
  // — plot/scatter. Trailing strings (xlabel, ylabel, title) are
  // all optional; runtime proc handles any of 2..5 args.
  const x = freshTVar();
  const y = freshTVar();
  return generalize(
    tFn([tList(x), tList(y), tString(), tString(), tString()], T_SCALAR, { optional: 3 }),
    [x, y], []
  );
}
function schemePlot1() {
  // <V>(List<V>, String?, String?, String?) -> Scalar  — bar_chart/hist.
  // Trailing strings: xlabel/ylabel/title in that order.
  const v = freshTVar();
  return generalize(
    tFn([tList(v), tString(), tString(), tString()], T_SCALAR, { optional: 3 }),
    [v], []
  );
}
// Layered-plot schemes (SPEC-LAYERED-PLOTS). The Plot value is a
// tagged plain object the typechecker has no first-class type for —
// so each scheme uses a fresh TVar `P` that flows through the chain.
// Adders accept any P and return the same P, so `line_plot() |>
// with_line(...) |> with_title("…")` typechecks cleanly. Permissive
// on data args (TVar instead of List<TVar>) so single-Quantity
// stereonet calls and Uncertain-as-input bar/hist calls don't fail
// typecheck before the runtime gets a chance.
function schemePlotEmpty() {
  // () -> P  — line_plot / scatter_plot / bar_plot / histogram / stereonet
  const p = freshTVar();
  return generalize(tFn([], p), [p], []);
}
function schemeWithXyLayer() {
  // <P, X, Y>(P, List<X>, List<Y>, String?) -> P  — with_line / with_scatter
  const p = freshTVar();
  const x = freshTVar();
  const y = freshTVar();
  return generalize(
    tFn([p, tList(x), tList(y), tString()], p, { optional: 1 }),
    [p, x, y], []
  );
}
function schemeWithBandLayer() {
  // <P, X, Y>(P, List<X>, List<Y>, List<Y>, String?) -> P  — with_band.
  // lo and hi share Y so `percentile(ys, 5)` and `percentile(ys, 95)`
  // unify with the same y dim.
  const p = freshTVar();
  const x = freshTVar();
  const y = freshTVar();
  return generalize(
    tFn([p, tList(x), tList(y), tList(y), tString()], p, { optional: 1 }),
    [p, x, y], []
  );
}
function schemeWithValuesLayer() {
  // <P, V>(P, V, String?) -> P  — with_bars / with_bins. Values arg is
  // a TVar (not List<V>) so the Uncertain → samples shortcut typechecks.
  const p = freshTVar();
  const v = freshTVar();
  return generalize(
    tFn([p, v, tString()], p, { optional: 1 }),
    [p, v], []
  );
}
function schemeWithStereonetLayer() {
  // <P, A, B>(P, A, B, String?) -> P  — with_planes / with_lines / with_poles.
  // Permissive on the angle args so both single-Quantity and List<Angle>
  // calls pass.
  const p = freshTVar();
  const a = freshTVar();
  const b = freshTVar();
  return generalize(
    tFn([p, a, b, tString()], p, { optional: 1 }),
    [p, a, b], []
  );
}
function schemeWithLabel() {
  // <P>(P, String) -> P  — with_title / with_xlabel / with_ylabel
  const p = freshTVar();
  return generalize(tFn([p, tString()], p), [p], []);
}
function schemeShow() {
  // <P>(P) -> Scalar
  const p = freshTVar();
  return generalize(tFn([p], T_SCALAR), [p], []);
}
function schemeShortcutStereonet() {
  // <A, B>(A, B, String?) -> P  — stereonet_planes / stereonet_lines.
  // Returns a Plot; the result type is a fresh TVar so the value can
  // chain through `with_title` etc.
  const a = freshTVar();
  const b = freshTVar();
  const p = freshTVar();
  return generalize(
    tFn([a, b, tString()], p, { optional: 1 }),
    [a, b, p], []
  );
}
// Per-layer style adders — each takes the plot + one styling value
// and returns the same plot type. Color is a String; width / alpha /
// marker_size are Scalars; dash is a List<Scalar>.
function schemeWithColor() {
  const p = freshTVar();
  return generalize(tFn([p, tString()], p), [p], []);
}
function schemeWithScalarStyle() {
  const p = freshTVar();
  return generalize(tFn([p, T_SCALAR], p), [p], []);
}
function schemeWithDash() {
  const p = freshTVar();
  return generalize(tFn([p, tList(T_SCALAR)], p), [p], []);
}

const BUILTIN_FN_SCHEMES = {
  // Dim-preserving
  abs:   schemeUnaryPreserveDim,
  floor: schemeUnaryPreserveDim,
  ceil:  schemeUnaryPreserveDim,
  round: schemeUnaryPreserveDim,

  // Root extractors (handle even/cube exponents)
  sqrt:  () => schemeRoot(2),
  cbrt:  () => schemeRoot(3),

  // Trig + log + exp: dimensionless in and out
  sin:   schemeUnaryScalarToScalar,
  cos:   schemeUnaryScalarToScalar,
  tan:   schemeUnaryScalarToScalar,
  asin:  schemeUnaryScalarToScalar,
  acos:  schemeUnaryScalarToScalar,
  atan:  schemeUnaryScalarToScalar,
  log:   schemeUnaryScalarToScalar,
  log10: schemeUnaryScalarToScalar,
  log2:  schemeUnaryScalarToScalar,
  ln:    schemeUnaryScalarToScalar,
  exp:   schemeUnaryScalarToScalar,
  sinh:  schemeUnaryScalarToScalar,
  cosh:  schemeUnaryScalarToScalar,
  tanh:  schemeUnaryScalarToScalar,
  asinh: schemeUnaryScalarToScalar,
  acosh: schemeUnaryScalarToScalar,
  atanh: schemeUnaryScalarToScalar,

  // Factorial: scalar in, scalar out (Factorial node has its own infer
  // rule but `n!` invocations route through Call('factorial', [n]) too).
  factorial: schemeUnaryScalarToScalar,
};

// ── Building the typed env ────────────────────────────────────────

export function buildTypeEnv(runtimeEnv) {
  const tcEnv = makeTypeEnv();

  // Accepts either the makeEnv-shaped object (env.units is the unit
  // registry) OR a Numbat host instance directly (host.registry is the
  // unit registry). Normalize.
  const unitRegistry = runtimeEnv.units || runtimeEnv.registry || null;

  // Dims: copy the public name → DimMap mapping.
  if (runtimeEnv.dims?.list) {
    for (const { name, dim } of runtimeEnv.dims.list()) {
      typeEnvBindDim(tcEnv, name, dim);
    }
  }

  // Units: every unit lookup-name becomes a typed value `TDim(unit.dim)`.
  // We iterate the private map directly — it's the only exhaustive source
  // (the public list() filters out inputOnly entries, which we DO want
  // for typechecking).
  if (unitRegistry?._units) {
    for (const [name, entry] of unitRegistry._units) {
      if (!tcEnv.values.has(name)) {
        typeEnvBindValue(tcEnv, name, tDim(dimExprFromMap(entry.dim)));
      }
    }
  }

  // Constants and let-bindings already in the runtime values table.
  if (runtimeEnv.values) {
    for (const [name, val] of runtimeEnv.values) {
      if (tcEnv.values.has(name)) continue;
      if (val && typeof val === 'object' && 'dim' in val && 'value' in val) {
        // Quantity-shaped — register as a TDim.
        typeEnvBindValue(tcEnv, name, tDim(dimExprFromMap(val.dim)));
      }
      // Skip fn-typed values; they're handled below via env.fns.
    }
  }

  // Lift user structs — those declared via earlier loadModule passes
  // are stored in runtimeEnv.structs as { name, generics, fields }.
  // Convert each into a TScheme(TStruct) so type annotations referencing
  // these structs resolve.
  if (runtimeEnv.structs) {
    for (const [name, rec] of runtimeEnv.structs) {
      if (!tcEnv.structs.has(name)) {
        typeEnvBindStruct(tcEnv, name, structRecordToScheme(rec, tcEnv));
      }
    }
  }

  // Lift user fns. Runtime stores { generics, params, body, returnType, ... }.
  // We build a TScheme directly without re-running body inference —
  // hosts that want body validation should re-run checkModule.
  if (runtimeEnv.fns) {
    for (const [name, rec] of runtimeEnv.fns) {
      if (!tcEnv.fns.has(name)) {
        typeEnvBindFn(tcEnv, name, fnRecordToScheme(rec, tcEnv));
      }
    }
  }

  // BUILTINs: math primitives get hand-rolled schemes so user code can
  // call sqrt/sin/etc. and typecheck cleanly. Last so user-declared fns
  // and structs take priority (a user's `fn sin` overrides the BUILTIN).
  for (const [name, mkScheme] of Object.entries(BUILTIN_FN_SCHEMES)) {
    if (!tcEnv.fns.has(name)) typeEnvBindFn(tcEnv, name, mkScheme());
  }
  // BUILTIN_PROCS too — same priority order, last so user decls win.
  for (const [name, mkScheme] of Object.entries(BUILTIN_PROC_SCHEMES)) {
    if (!tcEnv.fns.has(name)) typeEnvBindFn(tcEnv, name, mkScheme());
  }

  return tcEnv;
}

// ── Lifting helpers ───────────────────────────────────────────────

// Verify that each declared generic param still has an independent free
// var after solving. Returns an error record if two binders collapsed
// onto the same var, or null if all binders remain independent (or were
// resolved to concrete types — that's allowed; just means the user's
// `<A, B>` annotation was redundant).
function checkBindersStillIndependent(binders, subst, decl) {
  const seenTVarIds = new Map();    // id → binder name
  const seenDimVarIds = new Map();
  for (const b of binders) {
    const probe = b.kind === 'T'
      ? applyType({ kind: 'TVar', id: b.var.id }, subst)
      : applyType({ kind: 'TDim', dim: { base: {}, vars: { [b.var.id]: { n: 1, d: 1 } } } }, subst);
    // Concrete result (no free vars): binder was constrained to a
    // specific type. That's fine — the scheme just won't include it.
    const fv = freeVars(probe);
    const ids = [...fv.tvars, ...fv.dimVars];
    if (ids.length === 0) continue;
    if (ids.length > 1) continue;   // multi-var resolution; OK
    // Single-var resolution: must not collide with another binder.
    for (const id of fv.tvars) {
      if (seenTVarIds.has(id)) {
        return {
          message: `type parameters '${seenTVarIds.get(id)}' and '${b.name}' were unified — the signature claimed independence that the body doesn't deliver`,
          span: decl.span,
        };
      }
      seenTVarIds.set(id, b.name);
    }
    for (const id of fv.dimVars) {
      if (seenDimVarIds.has(id)) {
        return {
          message: `type parameters '${seenDimVarIds.get(id)}' and '${b.name}' were unified — the signature claimed independence that the body doesn't deliver`,
          span: decl.span,
        };
      }
      seenDimVarIds.set(id, b.name);
    }
  }
  return null;
}

function liftGenerics(declGenerics) {
  // Returns { generics: Map<name, {kind,var}>, binders: [{kind,var,name}] }.
  // Used by fn and struct record lifters in declaration order.
  const generics = new Map();
  const binders  = [];
  for (const g of declGenerics || []) {
    if (g.kind === 'Dim') {
      const tdv = freshTDimVar();
      generics.set(g.name, { kind: 'D', var: tdv });
      binders.push({ kind: 'D', var: tdv, name: g.name });
    } else {
      // 'Type' (default) or anything else → unrestricted TVar.
      const tv = freshTVar();
      generics.set(g.name, { kind: 'T', var: tv });
      binders.push({ kind: 'T', var: tv, name: g.name });
    }
  }
  return { generics, binders };
}

function fnRecordToScheme(rec, tcEnv) {
  const { generics, binders } = liftGenerics(rec.generics);
  const ctx = { cs: makeConstraintSet(), generics };
  const paramTypes = (rec.params || []).map(p =>
    p.typeExpr ? evalTypeAnno(p.typeExpr, tcEnv, ctx) : freshTVar(),
  );
  const returnType = rec.returnType
    ? evalTypeAnno(rec.returnType, tcEnv, ctx)
    : freshTVar();
  const tvars   = binders.filter(b => b.kind === 'T').map(b => b.var);
  const dimVars = binders.filter(b => b.kind === 'D').map(b => b.var);
  const order   = binders.map(b => b.kind);
  return tScheme(tvars, dimVars, tFn(paramTypes, returnType), { binderOrder: order });
}

function structRecordToScheme(rec, tcEnv) {
  const { generics, binders } = liftGenerics(rec.generics);
  const ctx = { cs: makeConstraintSet(), generics };
  const fields = {};
  for (const f of rec.fields || []) {
    fields[f.name] = evalTypeAnno(f.type, tcEnv, ctx);
  }
  const tvars   = binders.filter(b => b.kind === 'T').map(b => b.var);
  const dimVars = binders.filter(b => b.kind === 'D').map(b => b.var);
  const order   = binders.map(b => b.kind);
  return tScheme(tvars, dimVars, tStruct(rec.name, fields), { binderOrder: order });
}

// Typecheck a single parsed statement against a persistent typed env.
// Errors are returned (not thrown). The typed env is updated in place
// — subsequent calls see this decl's bindings. Used by ep's evaluator
// to interleave typecheck with per-statement runtime eval.
export function typecheckStatement(ast, tcEnv) {
  const errors = [];
  const dimAliases = buildDimAliases(tcEnv);
  for (const decl of ast.decls) {
    const ctx = { cs: makeConstraintSet(), errors: [], generics: new Map() };
    try {
      checkDecl(decl, tcEnv, ctx);
    } catch (e) {
      errors.push({ message: e.message, span: e.span || null });
      continue;
    }
    if (ctx.errors.length) {
      errors.push(...ctx.errors);
      continue;
    }
    const { subst, errors: solveErrs } = solve(ctx.cs, { dimAliases });
    errors.push(...solveErrs);
    if (solveErrs.length) continue;
    finalizeDecl(decl, tcEnv, subst, errors);
  }
  return errors;
}

// One-shot: parse + check + solve + generalize, return diagnostics.
// Hosts that want to opt into typechecking call this before loadModule.
//
// Solves PER-DECL so each later decl sees earlier fns as fully-
// generalized schemes (proper HM let-generalization). Without this,
// `fn f(x) = x` would infer (α) -> α with α unbound — and the first
// call site would pin α to a concrete type, breaking polymorphic use.
export function typecheckModule(ast, runtimeEnv) {
  const env = buildTypeEnv(runtimeEnv);
  const dimAliases = buildDimAliases(env);
  const errors = [];
  const allSubst = makeSubst();
  for (const decl of ast.decls) {
    const ctx = { cs: makeConstraintSet(), errors: [], generics: new Map() };
    try {
      checkDecl(decl, env, ctx);
    } catch (e) {
      errors.push({ message: e.message, span: e.span || null });
      continue;
    }
    if (ctx.errors.length) {
      errors.push(...ctx.errors);
      continue;
    }
    const { subst, errors: solveErrs } = solve(ctx.cs, { dimAliases });
    errors.push(...solveErrs);
    if (solveErrs.length) continue;
    // Merge into the running subst — useful for hosts that want to
    // inspect resolved types after the whole module.
    for (const [k, v] of subst.tvars)   allSubst.tvars.set(k, v);
    for (const [k, v] of subst.dimVars) allSubst.dimVars.set(k, v);
    finalizeDecl(decl, env, subst, errors);
  }
  return { env, subst: allSubst, errors };
}

// After per-decl solve, apply the substitution to anything this decl
// added to the env and generalize fn schemes.
function finalizeDecl(decl, env, subst, errors) {
  if (decl.type === 'FnDecl') {
    const scheme = env.fns.get(decl.name);
    if (!scheme || scheme.kind !== 'TScheme') return;
    const resolvedBody = applyType(scheme.body, subst);

    // Free-var consistency check: if the user wrote `fn f<A, B>(...)`,
    // each original binder should resolve to a distinct free variable
    // in the body (either still a TVar or a TDim<single dim-var>).
    // If two original binders end up sharing the same resolved var,
    // the signature claimed independence the body didn't deliver —
    // upstream rejects, so we do too. See #101.
    const originals = scheme.binders ?? [];
    const consistencyErr = checkBindersStillIndependent(originals, subst, decl);
    if (consistencyErr) {
      errors.push(consistencyErr);
      // Still install a scheme so subsequent decls can reference the fn.
    }

    // Re-derive binders purely from free vars in the resolved body —
    // this is the textbook HM "generalize" step. Original binders that
    // got constrained to concrete types drop out (their vars no longer
    // appear free). Original binders that stayed free are preserved.
    // Type-kinded generics that got promoted to TDim<$d> via dim-
    // arithmetic constraints get their $d in the body as a free dim-var,
    // so the scheme correctly reflects the inferred Dim restriction.
    const fv = freeVars(resolvedBody);
    const newT = [...fv.tvars].map(id => tVar(id));
    const newD = [...fv.dimVars].map(id => tDimVar(id));
    env.fns.set(decl.name, tScheme(newT, newD, resolvedBody));
  } else if (decl.type === 'LetDecl' || decl.type === 'UnitDecl') {
    const t = env.values.get(decl.name);
    if (t) env.values.set(decl.name, applyType(t, subst));
  } else if (decl.type === 'StructDecl') {
    const s = env.structs.get(decl.name);
    if (s && s.kind === 'TScheme') {
      // Same re-derivation for structs: free vars in the resolved body
      // are the binders. Preserves binder ORDER via binderOrder so
      // application sites (Wrapper<A>) bind positionally.
      const resolvedBody = applyType(s.body, subst);
      // We need to preserve the declaration order of the original
      // binders that survived (haven't been resolved to something
      // concrete). Walk s.binders, keep those whose var is still free
      // in resolved body.
      const fv = freeVars(resolvedBody);
      const survivingBinders = s.binders.filter(b =>
        b.kind === 'T' ? fv.tvars.has(b.var.id) : fv.dimVars.has(b.var.id),
      );
      const survT = survivingBinders.filter(b => b.kind === 'T').map(b => b.var);
      const survD = survivingBinders.filter(b => b.kind === 'D').map(b => b.var);
      const order = survivingBinders.map(b => b.kind);
      env.structs.set(decl.name, tScheme(survT, survD, resolvedBody, { binderOrder: order }));
    }
  }
}
