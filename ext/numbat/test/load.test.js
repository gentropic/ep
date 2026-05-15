import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';
import { DimRegistry } from '../src/dimensions.js';
import { UnitRegistry } from '../src/units.js';
import { tokenize } from '../src/tokenize.js';
import { parse } from '../src/parse.js';
import { evalDimExpr, evalValueExpr, loadModule, makeEnv } from '../src/load.js';
import { Quantity } from '../src/quantity.js';

// ── helpers ──────────────────────────────────────────────────────

const buildEnv = () => {
  const dims = new DimRegistry();
  const units = new UnitRegistry();
  const values = new Map();
  return makeEnv({ dims, units, values });
};

const dimExpr = (src, env) => evalDimExpr(parse(tokenize(`dimension Tmp = ${src}`)).decls[0].exprs[0], env);
const valueExpr = (src, env) => evalValueExpr(parse(tokenize(`let tmp = ${src}`)).decls[0].expr, env);

// ── evalDimExpr ──────────────────────────────────────────────────

test('evalDimExpr: identifier resolves via DimRegistry', () => {
  const env = buildEnv();
  env.dims.defineBase('Length');
  assert.deepEqual(dimExpr('Length', env), { length: 1 });
});

test('evalDimExpr: arithmetic on dimensions', () => {
  const env = buildEnv();
  env.dims.defineBase('Length');
  env.dims.defineBase('Time');
  assert.deepEqual(dimExpr('Length / Time', env), { length: 1, time: -1 });
  assert.deepEqual(dimExpr('Length * Time', env), { length: 1, time: 1 });
  assert.deepEqual(dimExpr('Length^3', env), { length: 3 });
  assert.deepEqual(dimExpr('Length / Time^2', env), { length: 1, time: -2 });
});

test('evalDimExpr: 1 means dimensionless', () => {
  const env = buildEnv();
  assert.deepEqual(dimExpr('1', env), {});
});

test('evalDimExpr: parens', () => {
  const env = buildEnv();
  env.dims.defineBase('Length');
  env.dims.defineBase('Time');
  assert.deepEqual(dimExpr('(Length / Time)^2', env), { length: 2, time: -2 });
});

test('evalDimExpr: unknown dimension throws', () => {
  const env = buildEnv();
  assert.throws(() => dimExpr('Unknown', env), /unknown dimension/);
});

test('evalDimExpr: rejects + and - operators', () => {
  const env = buildEnv();
  env.dims.defineBase('Length');
  assert.throws(() => dimExpr('Length + Length', env), /not allowed in dimension expression/);
});

// ── evalValueExpr ────────────────────────────────────────────────

test('evalValueExpr: number literal → dimensionless Quantity', () => {
  const env = buildEnv();
  const q = valueExpr('42', env);
  assert.equal(q.value, 42);
  assert.deepEqual(q.dim, {});
});

test('evalValueExpr: unit reference looked up via registry', () => {
  const env = buildEnv();
  env.units.define('meter', { dim: {length: 1}, shortAliases: ['m'] });
  const q = valueExpr('m', env);
  assert.equal(q.value, 1);
  assert.deepEqual(q.dim, {length: 1});
});

test('evalValueExpr: implicit multiplication', () => {
  const env = buildEnv();
  env.units.define('meter', { dim: {length: 1}, shortAliases: ['m'] });
  const q = valueExpr('5 m', env);
  assert.equal(q.value, 5);
  assert.deepEqual(q.dim, {length: 1});
});

test('evalValueExpr: compound expression (kilogram meter / second^2)', () => {
  const env = buildEnv();
  env.units.define('gram',   { dim: {mass: 1},   shortAliases: ['g'],  prefixSet: 'metric' });
  env.units.define('meter',  { dim: {length: 1}, shortAliases: ['m'],  prefixSet: 'metric' });
  env.units.define('second', { dim: {time: 1},   shortAliases: ['s'],  prefixSet: 'metric' });
  const q = valueExpr('kilogram meter / second^2', env);
  assert.equal(q.value, 1000);  // canonical: 1 kg = 1000 g, so newton mul = 1000
  assert.deepEqual(q.dim, {mass: 1, length: 1, time: -2});
});

test('evalValueExpr: parens and unary minus', () => {
  const env = buildEnv();
  assert.equal(valueExpr('(1 + 2) * 3', env).value, 9);
  assert.equal(valueExpr('-5', env).value, -5);
});

test('evalValueExpr: unknown identifier throws', () => {
  const env = buildEnv();
  assert.throws(() => valueExpr('mystery', env), /unknown identifier/);
});

// ── -> conversion in value expressions (v0.3) ────────────────────

test('evalValueExpr: -> sets disp on a quantity', () => {
  const env = buildEnv();
  env.units.define('meter', { dim: {length: 1}, shortAliases: ['m'], prefixSet: 'metric' });
  const q = valueExpr('3 km -> m', env);
  assert.equal(q.value, 3000);    // canonical unchanged
  assert.deepEqual(q.dim, {length: 1});
  assert.equal(q.disp, 'm');
});

test('evalValueExpr: -> unwraps parens around target', () => {
  const env = buildEnv();
  env.units.define('meter', { dim: {length: 1}, shortAliases: ['m'], prefixSet: 'metric' });
  const q = valueExpr('3 km -> (m)', env);
  assert.equal(q.disp, 'm');
});

test('evalValueExpr: -> dim mismatch throws', () => {
  const env = buildEnv();
  env.units.define('meter', { dim: {length: 1}, shortAliases: ['m'] });
  env.units.define('gram',  { dim: {mass: 1},   shortAliases: ['g'] });
  assert.throws(() => valueExpr('3 meter -> gram', env), /can't convert/);
});

test('evalValueExpr: -> unknown target unit throws', () => {
  const env = buildEnv();
  env.units.define('meter', { dim: {length: 1}, shortAliases: ['m'] });
  assert.throws(() => valueExpr('3 meter -> furlong', env), /unknown unit/);
});

test('evalValueExpr: -> compound target (v0.4): verifies dim, drops disp', () => {
  const env = buildEnv();
  env.units.define('meter',  { dim: {length: 1}, shortAliases: ['m'], prefixSet: 'metric' });
  env.units.define('second', { dim: {time: 1},   shortAliases: ['s'], prefixSet: 'metric' });
  const q = valueExpr('3 km / s -> m / s', env);
  // Canonical: 3 km/s = 3000 m/s; dim verified as same; disp tag dropped.
  assert.equal(q.value, 3000);
  assert.deepEqual(q.dim, { length: 1, time: -1 });
  assert.equal(q.disp, null);
});

test('evalValueExpr: -> compound target dim mismatch throws', () => {
  const env = buildEnv();
  env.units.define('meter',  { dim: {length: 1}, shortAliases: ['m'], prefixSet: 'metric' });
  env.units.define('second', { dim: {time: 1},   shortAliases: ['s'], prefixSet: 'metric' });
  assert.throws(() => valueExpr('3 km / s -> m * s', env), /-> dim mismatch/);
});

test('evalValueExpr: `to` keyword works the same as ->', () => {
  const env = buildEnv();
  env.units.define('meter', { dim: {length: 1}, shortAliases: ['m'], prefixSet: 'metric' });
  const q = valueExpr('3 km to m', env);
  assert.equal(q.disp, 'm');
  assert.equal(q.value, 3000);
});

// ── loadModule: dimensions ───────────────────────────────────────

test('load: base dimension declaration', () => {
  const env = buildEnv();
  const ast = parse(tokenize('dimension Length'));
  loadModule(ast, env);
  assert.deepEqual(env.dims.resolve('Length'), { length: 1 });
});

test('load: derived dimension', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    dimension Length
    dimension Time
    dimension Velocity = Length / Time
  `)), env);
  assert.deepEqual(env.dims.resolve('Velocity'), { length: 1, time: -1 });
});

test('load: dimension with multi-= alternate definitions verifies equivalence', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    dimension Length
    dimension Time
    dimension Mass
    dimension Velocity = Length / Time
    dimension Acceleration = Length / Time^2
    dimension Momentum = Mass * Velocity
    dimension Force = Mass * Acceleration = Momentum / Time
  `)), env);
  assert.deepEqual(env.dims.resolve('Force'), { mass: 1, length: 1, time: -2 });
});

test('load: dimension multi-= disagreement throws', () => {
  const env = buildEnv();
  assert.throws(
    () => loadModule(parse(tokenize(`
      dimension Length
      dimension Time
      dimension Bad = Length = Time
    `)), env),
    /alternate definition .* disagrees/,
  );
});

test('load: dimension Angle = 1 → empty dim', () => {
  const env = buildEnv();
  loadModule(parse(tokenize('dimension Angle = 1')), env);
  assert.deepEqual(env.dims.resolve('Angle'), {});
});

// ── loadModule: units ────────────────────────────────────────────

test('load: base unit (canonical, mul=1)', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    dimension Length
    unit metre: Length
  `)), env);
  const u = env.units.resolve('metre');
  assert.equal(u.mul, 1);
  assert.deepEqual(u.dim, { length: 1 });
});

test('load: unit with metric prefixes via decorator', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    dimension Length
    @metric_prefixes
    @aliases(metres, meter, meters, m: short)
    unit metre: Length
  `)), env);
  // Canonical and all long aliases (no prefix)
  assert.equal(env.units.resolve('metre').mul,  1);
  assert.equal(env.units.resolve('metres').mul, 1);
  assert.equal(env.units.resolve('meter').mul,  1);
  assert.equal(env.units.resolve('meters').mul, 1);
  // Short alias gets prefixed
  assert.equal(env.units.resolve('km').mul,         1e3);
  assert.equal(env.units.resolve('mm').mul,         1e-3);
  assert.equal(env.units.resolve('kilometre').mul,  1e3);
  // Long aliases do NOT get prefixed
  assert.equal(env.units.resolve('kmeter'), null);
  assert.equal(env.units.resolve('kmetres'), null);
});

test('load: derived unit with value expression', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    dimension Length
    dimension Time
    dimension Frequency = 1 / Time
    @aliases(s: short)
    unit second: Time
    @aliases(Hz: short)
    unit hertz: Frequency = 1 / second
  `)), env);
  const hz = env.units.resolve('hertz');
  assert.equal(hz.mul, 1);
  assert.deepEqual(hz.dim, { time: -1 });
});

test('load: unit defined as scalar (no dim annotation)', () => {
  const env = buildEnv();
  // No dim annotation; mul comes from RHS, dim inferred as dimensionless
  loadModule(parse(tokenize('unit ppm = 1e-6')), env);
  const u = env.units.resolve('ppm');
  assert.equal(u.mul, 1e-6);
  assert.deepEqual(u.dim, {});
});

test('load: unit with dimension mismatch on annotation throws', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    dimension Length
    dimension Mass
    @aliases(m: short)
    unit metre: Length
  `)), env);
  assert.throws(
    () => loadModule(parse(tokenize(`
      @aliases(badunit)
      unit oops: Mass = 5 metre
    `)), env),
    /dimension mismatch/,
  );
});

// ── loadModule: lets ─────────────────────────────────────────────

test('load: let binding resolvable in subsequent expressions', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    let n = 4
    let m = 2 n
  `)), env);
  assert.equal(env.values.get('n').value, 4);
  assert.equal(env.values.get('m').value, 8);
});

test('load: let with dimension annotation', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    let height: Length = 1.8 m
  `)), env);
  const h = env.values.get('height');
  assert.equal(h.value, 1.8);
  assert.deepEqual(h.dim, { length: 1 });
});

test('load: let dimension annotation mismatch throws', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    dimension Length
    dimension Mass
    @aliases(m: short)
    unit metre: Length
  `)), env);
  assert.throws(
    () => loadModule(parse(tokenize('let bad: Mass = 5 metre')), env),
    /dimension/,
  );
});

// ── decorators ───────────────────────────────────────────────────

test('decorator: @name sets human-readable name (stored as info, not lookup)', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    dimension Length
    @name("Metre")
    @aliases(m: short)
    unit metre: Length
  `)), env);
  // Lookup still works via canonical and short
  assert.equal(env.units.resolve('metre').mul, 1);
  assert.equal(env.units.resolve('m').mul, 1);
});

test('decorator: @description / @example / @url / @elide silently ignored', () => {
  const env = buildEnv();
  loadModule(parse(tokenize(`
    dimension Length
    @description("Length unit")
    @example("1 m")
    @url("https://example.com")
    @aliases(m: short)
    unit metre: Length
  `)), env);
  assert.equal(env.units.resolve('metre').mul, 1);
});

// ── Numbat class integration ─────────────────────────────────────

test('Numbat.loadSource: integrates dimensions and units', () => {
  const n = new Numbat();
  n.loadSource(`
    dimension Currency
    @aliases(USD: short)
    unit dollar: Currency
  `, 'test-input');
  assert.equal(n.hasUnit('dollar'), true);
  assert.equal(n.hasUnit('USD'), true);
  const usd = n.q(5, 'USD');
  assert.equal(usd.value, 5);
});

test('Numbat.registerModule + use: loads registered module', () => {
  const n = new Numbat();
  n.registerModule('foo::bar', `
    dimension MyDim
    @aliases(MD: short)
    unit mydim: MyDim
  `);
  n.use('foo::bar');
  assert.equal(n.hasUnit('mydim'), true);
});

test('Numbat.use: idempotent', () => {
  const n = new Numbat();
  let calls = 0;
  n.registerModule('foo', `dimension X${calls++}`);   // capture once
  n.use('foo');
  n.use('foo');   // second call: no-op
  // No throw means idempotent. Verifying state:
  assert.equal(n.loaded.has('foo'), true);
});

test('Numbat.use: nested via `use` statement in source', () => {
  const n = new Numbat();
  n.registerModule('base', `
    dimension Length
    @aliases(m: short)
    unit metre: Length
  `);
  n.registerModule('top', `
    use base
    unit foot = 0.3048 metre
  `);
  n.use('top');
  // Both modules' definitions are present
  assert.equal(n.hasUnit('metre'), true);
  assert.equal(n.hasUnit('foot'), true);
  const f = n.q(1, 'foot');
  assert.equal(f.value, 0.3048);
});

test('Numbat.use: missing module throws', () => {
  const n = new Numbat();
  assert.throws(() => n.use('nonexistent::module'), /module not registered/);
});

// ── error reporting ─────────────────────────────────────────────

test('error message includes module name and decl', () => {
  const n = new Numbat();
  n.registerModule('demo', `
    dimension Length
    unit badunit: Unknown
  `);
  assert.throws(() => n.use('demo'), /demo: badunit/);
});
