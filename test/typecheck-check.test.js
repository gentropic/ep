// Phase 2 of the typechecker: constraint generation walker.
//
// These exercise inferExpr + checkModule WITHOUT a solver. They assert
// that the right type is returned, and the right constraints land in the
// constraint set. Phase 3 (solver) will validate that the generated
// constraints actually resolve to the expected concrete types.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize } from '../ext/numbat/src/tokenize.js';
import { parse } from '../ext/numbat/src/parse.js';
import { resetTypeIds, tDim, tBool, tString, tFn, tList, tStruct, T_SCALAR, dimExprFromMap, dimExprEq, formatType } from '../ext/numbat/src/typecheck/types.js';
import { makeTypeEnv, typeEnvBindValue, typeEnvBindFn, typeEnvBindDim, typeEnvBindStruct } from '../ext/numbat/src/typecheck/env.js';
import { inferExpr, checkModule } from '../ext/numbat/src/typecheck/check.js';

// ── helpers ───────────────────────────────────────────────────────

function parseExpr(src) {
  const tokens = tokenize(src, '<test>');
  // Wrap in `let _ = …` so we get a clean parse and pull the expr back out.
  // Saves writing a separate parseExpr entry point.
  const wrapTokens = tokenize(`let _ = ${src}`, '<test>');
  const mod = parse(wrapTokens, '<test>');
  return mod.decls[0].expr;
}

function parseModule(src) {
  return parse(tokenize(src, '<test>'), '<test>');
}

function freshEnv() {
  const env = makeTypeEnv();
  // Common base dims for tests.
  typeEnvBindDim(env, 'Length', { length: 1 });
  typeEnvBindDim(env, 'Mass',   { mass: 1 });
  typeEnvBindDim(env, 'Time',   { time: 1 });
  // Common units as values (mirrors how phase-6 will lift the unit
  // registry into the typed env).
  typeEnvBindValue(env, 'm',  tDim(dimExprFromMap({ length: 1 })));
  typeEnvBindValue(env, 's',  tDim(dimExprFromMap({ time: 1 })));
  typeEnvBindValue(env, 'kg', tDim(dimExprFromMap({ mass: 1 })));
  typeEnvBindValue(env, 'pi', T_SCALAR);
  return env;
}

function ctxOf() { return { cs: { items: [] }, errors: [], generics: new Map() }; }

function infer(src) {
  resetTypeIds();
  const env = freshEnv();
  const ctx = ctxOf();
  const t = inferExpr(parseExpr(src), env, ctx);
  return { type: t, ctx, env };
}

function typeFormat(t) { return formatType(t); }

// ── Atoms ─────────────────────────────────────────────────────────

test('Num: scalar', () => {
  const { type, ctx } = infer('5');
  assert.equal(typeFormat(type), 'Scalar');
  assert.equal(ctx.cs.items.length, 0);
});

test('Bool literal', () => {
  const { type } = infer('true');
  assert.equal(typeFormat(type), 'Bool');
});

test('Str literal', () => {
  const { type } = infer('"hi"');
  assert.equal(typeFormat(type), 'String');
});

test('Ident: unit lookup gives TDim', () => {
  const { type } = infer('m');
  assert.equal(typeFormat(type), 'length');
});

test('Ident: unknown identifier throws', () => {
  assert.throws(() => infer('nonsense_thing'), /unknown identifier/);
});

// ── Arithmetic ────────────────────────────────────────────────────

test('Binary +: emits IsDType + Equal, returns left type', () => {
  const { type, ctx } = infer('1 m + 2 m');
  assert.equal(typeFormat(type), 'length');
  const kinds = ctx.cs.items.map(c => c.kind);
  assert.ok(kinds.includes('IsDType'));
  assert.ok(kinds.includes('Equal'));
});

test('Binary *: dim multiplication', () => {
  const { type } = infer('1 m * 2 s');
  assert.equal(typeFormat(type), 'length·time');
});

test('Binary /: dim division', () => {
  const { type } = infer('1 m / 2 s');
  assert.equal(typeFormat(type), 'length·time^-1');
});

test('Binary ^ with const exp: scales dim', () => {
  const { type } = infer('m^3');
  assert.equal(typeFormat(type), 'length^3');
});

test('Binary ^ with rational const exp: scales dim by rational', () => {
  const { type } = infer('m^(1/2)');
  assert.equal(typeFormat(type), 'length^1/2');
});

test('Binary ^ with non-const exp on scalars', () => {
  resetTypeIds();
  const env = freshEnv();
  typeEnvBindValue(env, 'n', T_SCALAR);
  const ctx = ctxOf();
  const t = inferExpr(parseExpr('2^n'), env, ctx);
  assert.equal(typeFormat(t), 'Scalar');
  // Two Equals: left=Scalar, right=Scalar.
  assert.equal(ctx.cs.items.filter(c => c.kind === 'Equal').length, 2);
});

test('Conversion -> with both sides defined', () => {
  resetTypeIds();
  const env = freshEnv();
  typeEnvBindValue(env, 'cm', tDim(dimExprFromMap({ length: 1 })));
  const ctx = ctxOf();
  const t = inferExpr(parseExpr('1 m -> cm'), env, ctx);
  assert.equal(typeFormat(t), 'length');
  assert.ok(ctx.cs.items.some(c => c.kind === 'Equal'));
});

test('Unary minus: returns same dim', () => {
  const { type } = infer('-m');
  assert.equal(typeFormat(type), 'length');
});

test('Unary !: requires Bool', () => {
  const { type, ctx } = infer('!true');
  assert.equal(typeFormat(type), 'Bool');
  // The Bool literal IS Bool, so the Equal(Bool, Bool) is trivial but
  // still emitted by the rule.
  assert.ok(ctx.cs.items.some(c => c.kind === 'Equal'));
});

test('Factorial: scalar in, scalar out', () => {
  const { type } = infer('5!');
  assert.equal(typeFormat(type), 'Scalar');
});

test('If: branches must unify, cond must be Bool', () => {
  resetTypeIds();
  const env = freshEnv();
  typeEnvBindValue(env, 'b', tBool());
  const ctx = ctxOf();
  const t = inferExpr(parseExpr('if b then 1 m else 2 m'), env, ctx);
  assert.equal(typeFormat(t), 'length');
  // Three equality constraints: cond-is-Bool, then=else, and the 2m
  // also gets the + style; if's rule emits two equals (cond+branches).
  assert.ok(ctx.cs.items.filter(c => c.kind === 'Equal').length >= 2);
});

// ── List ──────────────────────────────────────────────────────────

test('List with consistent elements: TList<elem>', () => {
  const { type } = infer('[1 m, 2 m, 3 m]');
  assert.equal(typeFormat(type), 'List<length>');
});

test('List with mixed elements: emits Equal constraints', () => {
  const { type, ctx } = infer('[1 m, 2 s]');
  // Returns TList<length> from the first elem; the mismatch with
  // second elem becomes a constraint for the solver to reject.
  assert.equal(typeFormat(type), 'List<length>');
  assert.ok(ctx.cs.items.some(c => c.kind === 'Equal'));
});

// ── Call ──────────────────────────────────────────────────────────

test('Call with bound fn: returns fn result type', () => {
  resetTypeIds();
  const env = freshEnv();
  // fn area(x: Length, y: Length) -> Length^2
  typeEnvBindFn(env, 'area', { kind: 'TScheme', tvars: [], dimVars: [],
    body: tFn([tDim(dimExprFromMap({length:1})), tDim(dimExprFromMap({length:1}))],
              tDim(dimExprFromMap({length:2}))) });
  const ctx = ctxOf();
  const t = inferExpr(parseExpr('area(2 m, 3 m)'), env, ctx);
  assert.equal(typeFormat(t), 'length^2');
  // Two Equal constraints, one per arg.
  assert.equal(ctx.cs.items.filter(c => c.kind === 'Equal').length, 2);
});

test('Call: arity mismatch throws', () => {
  resetTypeIds();
  const env = freshEnv();
  typeEnvBindFn(env, 'f', { kind: 'TScheme', tvars: [], dimVars: [],
    body: tFn([T_SCALAR], T_SCALAR) });
  const ctx = ctxOf();
  assert.throws(() => inferExpr(parseExpr('f(1, 2)'), env, ctx), /expected 1 args, got 2/);
});

test('Call: unknown function throws', () => {
  resetTypeIds();
  const env = freshEnv();
  const ctx = ctxOf();
  assert.throws(() => inferExpr(parseExpr('whatever(1)'), env, ctx), /unknown function/);
});

// ── Struct ────────────────────────────────────────────────────────

test('StructInit: returns struct type, emits field-Equals', () => {
  resetTypeIds();
  const env = freshEnv();
  const Pt = tStruct('Pt', { x: tDim(dimExprFromMap({length:1})), y: tDim(dimExprFromMap({length:1})) });
  typeEnvBindStruct(env, 'Pt', Pt);
  const ctx = ctxOf();
  const t = inferExpr(parseExpr('Pt { x: 1 m, y: 2 m }'), env, ctx);
  assert.equal(typeFormat(t), 'Pt');
  assert.equal(ctx.cs.items.filter(c => c.kind === 'Equal').length, 2);
});

test('StructInit: missing field throws', () => {
  resetTypeIds();
  const env = freshEnv();
  const Pt = tStruct('Pt', { x: T_SCALAR, y: T_SCALAR });
  typeEnvBindStruct(env, 'Pt', Pt);
  const ctx = ctxOf();
  assert.throws(() => inferExpr(parseExpr('Pt { x: 1 }'), env, ctx), /missing field 'y'/);
});

test('Field: returns the field type', () => {
  resetTypeIds();
  const env = freshEnv();
  const Pt = tStruct('Pt', { x: tDim(dimExprFromMap({length:1})), y: T_SCALAR });
  typeEnvBindStruct(env, 'Pt', Pt);
  typeEnvBindValue(env, 'p', Pt);
  const ctx = ctxOf();
  const t = inferExpr(parseExpr('p.x'), env, ctx);
  assert.equal(typeFormat(t), 'length');
});

test('Field: unknown field on known struct throws', () => {
  resetTypeIds();
  const env = freshEnv();
  const Pt = tStruct('Pt', { x: T_SCALAR });
  typeEnvBindStruct(env, 'Pt', Pt);
  typeEnvBindValue(env, 'p', Pt);
  const ctx = ctxOf();
  assert.throws(() => inferExpr(parseExpr('p.q'), env, ctx), /no field 'q'/);
});

// ── checkModule (top-level decls) ─────────────────────────────────

test('checkModule: LetDecl binds and infers', () => {
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule('let v = 60 m / 1 s');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 0);
  assert.equal(typeFormat(env.values.get('v')), 'length·time^-1');
});

test('checkModule: LetDecl with annotation emits Equal + binds annotation', () => {
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule('let v: Length / Time = 60 m / 1 s');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 0);
  // Annotation wins as the bound type.
  assert.equal(typeFormat(env.values.get('v')), 'length·time^-1');
  assert.ok(r.constraints.items.some(c => c.kind === 'Equal'));
});

test('checkModule: LetDecl annotation mismatch surfaces as a constraint', () => {
  // Annotated as Time but body is Length — type infers fine here, the
  // solver in phase 3 is what will reject.
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule('let bad: Time = 5 m');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 0);
  const eq = r.constraints.items.filter(c => c.kind === 'Equal');
  assert.ok(eq.length >= 1, 'expected at least one Equal constraint');
});

test('checkModule: FnDecl stores TScheme', () => {
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule('fn sq(x: Length) -> Length^2 = x * x');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 0);
  const scheme = env.fns.get('sq');
  assert.equal(scheme.kind, 'TScheme');
  assert.equal(scheme.body.kind, 'TFn');
  assert.equal(typeFormat(scheme.body.result), 'length^2');
});

test('checkModule: explicit-Dim generic uses TDimVars', () => {
  resetTypeIds();
  const env = freshEnv();
  // Explicit `: Dim` keeps the binder as TDimVar — required by the test.
  const ast = parseModule('fn id<D: Dim>(x: D) -> D = x');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 0);
  const scheme = env.fns.get('id');
  assert.equal(scheme.dimVars.length, 1);
  // Body should be (TDim<$D>) -> TDim<$D>
  assert.equal(scheme.body.params[0].kind, 'TDim');
  assert.equal(scheme.body.result.kind,    'TDim');
  const lvar = Object.keys(scheme.body.params[0].dim.vars)[0];
  const rvar = Object.keys(scheme.body.result.dim.vars)[0];
  assert.equal(lvar, rvar);
});

test('checkModule: unannotated generic stays as TVar binder pre-solve', () => {
  // Default `<D>` is now Type-kinded. checkModule generates constraints
  // but doesn't solve — so the scheme keeps TVar binders. typecheckModule
  // (in integration.js) is what solves + generalizes to dim-vars when
  // the generic gets promoted via dim arithmetic.
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule('fn id<D>(x: D) -> D = x');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 0);
  const scheme = env.fns.get('id');
  assert.equal(scheme.tvars.length, 1);
  assert.equal(scheme.body.params[0].kind, 'TVar');
  assert.equal(scheme.body.result.kind,    'TVar');
});

test('checkModule: multi-var compound generic (divide<A,B>) emits dim constraints', () => {
  // checkModule generates constraints; the dim-vars appear inside the
  // body's TDim expressions (return type's dim has two vars with
  // exponents +1, -1) and the constraints tie param TVars to those
  // dims. Post-solve generalization (in integration.typecheckModule)
  // converts those to scheme dim binders.
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule('fn divide<A, B>(a: A, b: B) -> A / B = a / b');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 0);
  const scheme = env.fns.get('divide');
  // Original binders are TVars (A, B were Type-kinded by default).
  assert.equal(scheme.tvars.length, 2);
  // Return type IS the A/B dim expression with two dim-vars +1, -1.
  const ret = scheme.body.result;
  assert.equal(ret.kind, 'TDim');
  const exps = Object.values(ret.dim.vars).map(r => r.n);
  assert.deepEqual(exps.sort(), [-1, 1]);
});

test('checkModule: DimensionDecl registers in env.dims', () => {
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule('dimension Foo');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(env.dims.get('Foo'), { foo: 1 });
});

test('checkModule: StructDecl registers struct as scheme', () => {
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule('struct Pair { x: Length, y: Mass }');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 0);
  const scheme = env.structs.get('Pair');
  assert.equal(scheme.kind, 'TScheme');
  assert.equal(scheme.dimVars.length, 0);   // non-generic
  assert.equal(scheme.body.kind, 'TStruct');
  assert.equal(typeFormat(scheme.body.fields.x), 'length');
  assert.equal(typeFormat(scheme.body.fields.y), 'mass');
});

test('checkModule: UnitDecl with dim annotation binds value type', () => {
  resetTypeIds();
  const env = freshEnv();
  const ast = parseModule('unit furlong: Length');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 0);
  assert.equal(typeFormat(env.values.get('furlong')), 'length');
});

test('checkModule: errors collected, not thrown', () => {
  resetTypeIds();
  const env = freshEnv();
  // First decl: bogus (unknown ident). Second decl: fine.
  const ast = parseModule('let bad = nonsense\nlet good = 5');
  const r = checkModule(ast, env);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /unknown identifier/);
  // Good binding still happened.
  assert.equal(typeFormat(env.values.get('good')), 'Scalar');
});
