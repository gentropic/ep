import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseAnno, evaluate } from '../src/js/evaluator.js';

const bodyOf = (lines) => lines.map(src => ({src}));

const approx = (a, b, eps = 1e-6) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

// ── classify ──────────────────────────────────────────────────────

test('classify: empty lines and comments', () => {
  assert.deepEqual(classify(''),         {kind: 'empty'});
  assert.deepEqual(classify('   '),      {kind: 'empty'});
  assert.deepEqual(classify('# hi'),     {kind: 'comment'});
  assert.deepEqual(classify('-- also'),  {kind: 'comment'});
});

test('classify: decorator with no args', () => {
  assert.deepEqual(classify('@input'),  {kind: 'decorator', name: 'input', args: []});
  assert.deepEqual(classify('@output'), {kind: 'decorator', name: 'output', args: []});
  // whitespace tolerated
  assert.deepEqual(classify('  @input  '), {kind: 'decorator', name: 'input', args: []});
});

test('classify: decorator with single unit arg', () => {
  assert.deepEqual(classify('@output(kg)'),
    {kind: 'decorator', name: 'output', args: ['kg']});
  assert.deepEqual(classify('@output( m^3 )'),
    {kind: 'decorator', name: 'output', args: ['m^3']});
});

test('classify: decorator with multiple args (options list)', () => {
  assert.deepEqual(classify('@options(granite, basalt, sandstone)'),
    {kind: 'decorator', name: 'options', args: ['granite', 'basalt', 'sandstone']});
  // empty trailing arg is dropped
  assert.deepEqual(classify('@options(a, b, )'),
    {kind: 'decorator', name: 'options', args: ['a', 'b']});
});

test('evaluate: multi-line @options decorator (args span lines)', () => {
  const r = evaluate(bodyOf([
    '@input',
    '@options(',
    '  granite, basalt,',
    '  sandstone, limestone',
    ')',
    'rock_type = granite',
  ]));
  assert.equal(r.params.length, 1);
  assert.equal(r.params[0].name, 'rock_type');
  assert.deepEqual(r.params[0].options, ['granite', 'basalt', 'sandstone', 'limestone']);
  assert.equal(r.params[0].error, null);
});

test('evaluate: multi-line expression body (paren continuation)', () => {
  const r = evaluate(bodyOf([
    '@output(kg)',
    'mass = sample_mass(',
    '  NQ_core,',
    '  5 m,',
    '  2.7 g/cm3,',
    ')',
  ]));
  assert.equal(r.outputs.length, 1);
  assert.equal(r.outputs[0].name, 'mass');
  assert.equal(r.outputs[0].unit, 'kg');
  assert.equal(r.rows[1].error, null);          // owner row is the `mass = ...` line
  assert.equal(r.scope.mass.dim.mass, 1);       // mass dimension
});

test('classify: binding with and without annotation', () => {
  assert.deepEqual(classify('x = 5'),
    {kind: 'binding', name: 'x', anno: null, expr: '5', options: null});
  assert.deepEqual(classify('density : Density = 2.7 g/cm3'),
    {kind: 'binding', name: 'density', anno: 'Density', expr: '2.7 g/cm3', options: null});
  assert.deepEqual(classify('v : Length / Time = 60 km / 1 h'),
    {kind: 'binding', name: 'v', anno: 'Length / Time', expr: '60 km / 1 h', options: null});
});

test('classify: binding with trailing options annotation', () => {
  assert.deepEqual(classify('material = steel  # options: steel, aluminum, copper'),
    {kind: 'binding', name: 'material', anno: null, expr: 'steel',
     options: ['steel', 'aluminum', 'copper']});
  assert.deepEqual(classify('core = NQ_core -- options: NQ_core, HQ_core'),
    {kind: 'binding', name: 'core', anno: null, expr: 'NQ_core',
     options: ['NQ_core', 'HQ_core']});
});

test('classify: naked expression', () => {
  assert.deepEqual(classify('2 + 3'), {kind: 'expr', expr: '2 + 3'});
});

// ── parseAnno ─────────────────────────────────────────────────────

test('parseAnno: simple named dimensions', () => {
  assert.deepEqual(parseAnno('Mass'),   {mass: 1});
  assert.deepEqual(parseAnno('Length'), {length: 1});
  assert.deepEqual(parseAnno('Scalar'), {});
});

test('parseAnno: compound via * and /', () => {
  assert.deepEqual(parseAnno('Mass / Volume'), {mass: 1, length: -3});
  assert.deepEqual(parseAnno('Length / Time'), {length: 1, time: -1});
});

test('parseAnno: integer exponent', () => {
  assert.deepEqual(parseAnno('Length ^ 2'), {length: 2});
  assert.deepEqual(parseAnno('Length ^ -1'), {length: -1});
});

test('parseAnno: unknown dimension throws', () => {
  assert.throws(() => parseAnno('Unicorn'), /unknown dimension/);
});

// ── evaluate ──────────────────────────────────────────────────────

test('evaluate: empty body returns empty results', () => {
  const r = evaluate([]);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.params, []);
  assert.deepEqual(r.outputs, []);
  assert.deepEqual(r.scope, {});
  assert.equal(r.blockComplete, false);
  assert.deepEqual(r.blocks, []);
});

test('evaluate: simple binding lands in scope and row.result', () => {
  const r = evaluate(bodyOf(['x = 5 m']));
  assert.equal(r.rows[0].kind, 'binding');
  assert.equal(r.rows[0].name, 'x');
  assert.equal(r.rows[0].result.v, 5);
  assert.deepEqual(r.rows[0].result.d, {length: 1});
  assert.equal(r.scope.x.v, 5);
});

test('evaluate: ore_body program end-to-end (decorator form)', () => {
  const body = bodyOf([
    '@input',
    'length = 200 m',
    '@input',
    'width = 50 m',
    '@input',
    'thickness = 8 m',
    '@input',
    'density : Density = 2.7 g/cm3',
    '@input',
    'grade = 1_800 ppb',
    'volume   = length * width * thickness',
    '@output',
    'tonnage  = volume * density',
    '@output',
    'metal    = tonnage * grade',
    '@output(ozt)',
    'metal_oz = metal',
  ]);
  const r = evaluate(body);

  // Inputs collected from @input decorators
  assert.deepEqual(r.params.map(p => p.name), ['length', 'width', 'thickness', 'density', 'grade']);

  // No row-level errors
  for (const row of r.rows) assert.equal(row.error, null);

  // Canonical values
  assert.equal(r.scope.volume.v, 80000);                // m³
  assert.deepEqual(r.scope.volume.d, {length: 3});
  assert.ok(approx(r.scope.tonnage.v, 2.16e11));        // g (canonical mass)
  assert.deepEqual(r.scope.tonnage.d, {mass: 1});
  assert.ok(approx(r.scope.metal.v, 388800));           // g

  // Outputs collected from @output decorators (unit from arg)
  assert.deepEqual(r.outputs, [
    { name: 'tonnage',  unit: null },
    { name: 'metal',    unit: null },
    { name: 'metal_oz', unit: 'ozt' },
  ]);
});

test('evaluate: dim mismatch surfaces as row error, downstream still tries', () => {
  const r = evaluate(bodyOf([
    'a = 1 m + 1 kg',     // error
    'b = 2 + 3',           // independent; should still evaluate
  ]));
  // Typecheck now drives error messages — "dimension mismatch in '+':
  // expected Length, got Mass". Runtime's older "can't add" message is
  // still produced internally but replaced when typecheck agrees.
  assert.match(r.rows[0].error, /dimension mismatch|can't add/);
  assert.equal(r.rows[0].result, null);
  assert.equal(r.rows[1].error, null);
  assert.equal(r.rows[1].result.v, 5);
});

test('evaluate: annotation mismatch is reported with both sides', () => {
  const r = evaluate(bodyOf([
    'density : Density = 2.7 g',   // annotated Density, got Mass
  ]));
  // Typecheck-driven message resolves the dim alias from env.dims:
  //   "dimension mismatch: expected Density, got Mass"
  // Runtime fallback would say "annotated Density but got [mass]".
  assert.match(r.rows[0].error, /Density/);
  assert.match(r.rows[0].error, /Mass|mass/);
  // binding still attempted; scope should NOT contain density (post-failure)
  assert.equal(r.scope.density, undefined);
});

test('evaluate: undefined identifier in body line', () => {
  const r = evaluate(bodyOf(['y = unknown_thing + 1']));
  assert.match(r.rows[0].error, /unknown identifier: unknown_thing/);
});

test('evaluate: @output decorator collects binding (with optional unit)', () => {
  const r = evaluate(bodyOf([
    'x = 5',
    '@output',
    'y = x * 2',
    '@output(kg)',
    'z = 317 g',
  ]));
  assert.deepEqual(r.outputs, [
    { name: 'y', unit: null },
    { name: 'z', unit: 'kg' },
  ]);
  assert.equal(r.scope.y.v, 10);
});

test('evaluate: @input + @output on same binding shows up as both', () => {
  const r = evaluate(bodyOf([
    '@input',
    '@output(km)',
    'distance = 1500 m',
  ]));
  assert.deepEqual(r.params.map(p => p.name), ['distance']);
  assert.deepEqual(r.outputs, [{ name: 'distance', unit: 'km' }]);
});

test('evaluate: param binding with annotation respected', () => {
  const r = evaluate(bodyOf([
    '@input',
    'density : Density = 2.7 g/cm3',
  ]));
  assert.equal(r.rows[1].error, null);
  assert.deepEqual(r.params[0].anno, 'Density');
});

test('evaluate: @options decorator with bare-label values skips evaluation', () => {
  const r = evaluate(bodyOf([
    '@input',
    '@options(granite, basalt, sandstone)',
    'rock_type = granite',
  ]));
  assert.equal(r.params.length, 1);
  assert.equal(r.params[0].name, 'rock_type');
  assert.deepEqual(r.params[0].options, ['granite', 'basalt', 'sandstone']);
  assert.equal(r.params[0].error, null);
  assert.equal(r.params[0].result, null);
});

test('evaluate: comments between decorator and binding are tolerated', () => {
  const r = evaluate(bodyOf([
    '@input',
    '# a clarifying comment',
    '',
    'x = 7',
  ]));
  assert.deepEqual(r.params.map(p => p.name), ['x']);
  assert.equal(r.scope.x.v, 7);
});

test('evaluate: malformed @input binding recovers so chip stays alive', () => {
  const r = evaluate(bodyOf([
    '@input',
    'x = ',     // user mid-edit
  ]));
  assert.equal(r.params.length, 1);
  assert.equal(r.params[0].name, 'x');
  assert.match(r.params[0].error, /empty expression/);
});

// ── extended classify: let / fn / dimension / unit ────────────────

test('classify: let keyword is an alias for bare binding', () => {
  assert.deepEqual(classify('let x = 5'),
    {kind: 'binding', name: 'x', anno: null, expr: '5', options: null});
  assert.deepEqual(classify('let density : Density = 2.7 g/cm3'),
    {kind: 'binding', name: 'density', anno: 'Density', expr: '2.7 g/cm3', options: null});
});

test('classify: fn declaration', () => {
  const c = classify('fn dbl(x) = 2 * x');
  assert.equal(c.kind, 'fn-decl');
  assert.equal(c.name, 'dbl');
  assert.equal(c.src, 'fn dbl(x) = 2 * x');
});

test('classify: dimension declaration', () => {
  const c = classify('dimension Frequency = 1 / Time');
  assert.equal(c.kind, 'dim-decl');
  assert.equal(c.name, 'Frequency');
});

test('classify: unit declaration', () => {
  const c = classify('unit hertz: Frequency = 1 / second');
  assert.equal(c.kind, 'unit-decl');
  assert.equal(c.name, 'hertz');
});

test('evaluate: let-bound binding lands in scope like a bare binding', () => {
  const r = evaluate(bodyOf(['let x = 5 m']));
  assert.equal(r.rows[0].error, null);
  assert.equal(r.scope.x.value, 5);
  assert.deepEqual(r.scope.x.dim, {length: 1});
});

test('evaluate: fn declaration + subsequent call', () => {
  const r = evaluate(bodyOf([
    'fn dbl(x) = 2 * x',
    'y = dbl(7)',
  ]));
  assert.equal(r.rows[0].error, null);
  assert.equal(r.rows[1].error, null);
  assert.equal(r.scope.y.value, 14);
});

test('evaluate: if/then/else inside a binding RHS', () => {
  const r = evaluate(bodyOf([
    'a = if 3 > 2 then 10 else 20',
    'b = if 3 < 2 then 10 else 20',
  ]));
  assert.equal(r.rows[0].error, null);
  assert.equal(r.scope.a.value, 10);
  assert.equal(r.scope.b.value, 20);
});

test('evaluate: fn with where clauses', () => {
  const r = evaluate(bodyOf([
    'fn area_of_disk(r) = pi_local * r^2 where pi_local = 3.14159',
    'a = area_of_disk(10)',
  ]));
  assert.equal(r.rows[0].error, null);
  assert.equal(r.rows[1].error, null);
  assert.ok(approx(r.scope.a.value, 314.159, 1e-3));
});

test('evaluate: error in fn body surfaces on that row only', () => {
  const r = evaluate(bodyOf([
    'fn bad(x) = 1 m + 1 kg',   // dim mismatch is a CALL-time error in numbat-js
    'good = 5 + 3',
  ]));
  // bad's parse succeeds; the dim error only fires when bad() is invoked.
  assert.equal(r.rows[0].error, null);
  assert.equal(r.rows[1].error, null);
  assert.equal(r.scope.good.value, 8);
});

test('evaluate: unit declaration registers a callable unit', () => {
  const r = evaluate(bodyOf([
    'dimension Frequency = 1 / Time',
    'unit hertz: Frequency = 1 / second',
    'f = 100 hertz',
  ]));
  assert.equal(r.rows[0].error, null);
  assert.equal(r.rows[1].error, null);
  assert.equal(r.rows[2].error, null);
  assert.equal(r.scope.f.value, 100);
  assert.deepEqual(r.scope.f.dim, {time: -1});
});

test('evaluate: `unit thing` auto-generates a Thing dimension', () => {
  const r = evaluate(bodyOf([
    'unit thing',
    'let x: Thing = 3 thing',
    'x',
  ]));
  for (const row of r.rows) assert.equal(row.error, null);
  assert.equal(r.rows[2].result.value, 3);
});

test('evaluate: multi-line if/then/else in fn body', () => {
  const r = evaluate(bodyOf([
    'fn bump(x: Scalar) -> Scalar =',
    '  if x >= 0',
    '    then 1',
    '    else 0',
    'bump(5)',
    'bump(-3)',
  ]));
  for (const row of r.rows) assert.equal(row.error, null);
  assert.equal(r.rows[4].result.value, 1);
  assert.equal(r.rows[5].result.value, 0);
});

test('evaluate: assert_eq tolerates float noise from unit conversion', () => {
  const r = evaluate(bodyOf(['assert_eq(12 in, 1 ft)']));
  assert.equal(r.rows[0].error, null);
});

test('evaluate: assert_eq still fails on a real difference', () => {
  const r = evaluate(bodyOf(['assert_eq(1 m, 2 m)']));
  assert.match(r.rows[0].error, /assert_eq failed/);
});

test('evaluate: type() builtin returns dimension name', () => {
  const r = evaluate(bodyOf([
    'type(2 m/s)',
    'type(5 kg)',
    'type(42)',
  ]));
  for (const row of r.rows) assert.equal(row.error, null);
  assert.match(r.rows[0].result, /Length.*Time\^-1/);
  assert.equal(r.rows[1].result, 'Mass');
  assert.equal(r.rows[2].result, 'Scalar');
});

test('evaluate: @input followed by fn decl — decorator is consumed but fn still loads', () => {
  // @input on a non-binding line is essentially ignored (no chip is made
  // for an fn decl); the fn itself still loads normally.
  const r = evaluate(bodyOf([
    '@input',
    'fn dbl(x) = 2 * x',
    'y = dbl(5)',
  ]));
  assert.equal(r.params.length, 0);
  assert.equal(r.scope.y.v, 10);
});

test('evaluate: minute unit works in bare position (regression: `min` proc shadowed the unit)', () => {
  const r = evaluate(bodyOf([
    'speed = 3 km / 4 min -> km/h',
    'pause = 2 min + 30 s',
    'lo = min(3 m, 2 m)',
  ]));
  for (const row of r.rows) assert.equal(row.error, null, row.error);
  assert.ok(approx(r.rows[0].result.value, 12.5));       // 45 km/h in m/s
  assert.ok(approx(r.rows[1].result.value, 150));
  assert.ok(approx(r.rows[2].result.value, 2));
});

test('evaluate: a function in arithmetic is a named error, never a raw TypeError', () => {
  // The typechecker usually catches this first ("expected dimension type,
  // got (D²) -> D"); when it doesn't, the runtime guard in numbat-js names
  // the operand. Either way the gutter must never show the engine's
  // "Cannot convert undefined or null to object".
  const r = evaluate(bodyOf([
    'a = 4 sqrt',
    'b = 3 m + 2 s',
  ]));
  assert.ok(r.rows[0].error, 'expected an error on `4 sqrt`');
  assert.doesNotMatch(r.rows[0].error, /internal error|Cannot convert/);
  assert.match(r.rows[1].error, /dimension mismatch|can't add/);
});

test('@sensor: a live reading replaces the literal; the literal fixes dim and display unit', () => {
  const body = bodyOf([
    '@sensor(pressure)',
    'p = 1013.25 hPa',
    'h = (1 - (p / 1013.25 hPa)^(1/5.255)) * 44330 m',
  ]);
  const cold = evaluate(body);
  assert.equal(cold.rows[1].error, null, cold.rows[1].error);
  assert.equal(cold.params.length, 1);
  assert.deepEqual(cold.params[0].sensor, { source: 'pressure', rateHz: 10, avgS: 0, hold: false });
  assert.ok(approx(cold.rows[2].result.value, 0));            // at sea-level pressure, no altitude
  // 1000 hPa canonical: hPa = 100 Pa; Pa canonical in gram units = 1000 (kg→g) → 1e5 per hPa
  const hPa = cold.rows[1].result.value / 1013.25;
  const live = new Map([['p', { value: 1000 * hPa }]]);
  const warm = evaluate(body, { live });
  assert.equal(warm.rows[1].error, null);
  assert.ok(approx(warm.rows[1].result.value, 1000 * hPa));
  assert.equal(warm.rows[1].result.__sensor, 'p');
  assert.ok(warm.rows[2].result.value > 100);                 // ~110 m above sea level
});

test('@sensor: dimension mismatch and unknown source are row errors', () => {
  const r = evaluate(bodyOf(['@sensor(pressure)', 'x = 3 m']));
  assert.match(r.rows[1].error, /reads \[.*\] \(hPa\), but the default is/);
  const u = evaluate(bodyOf(['@sensor(nope)', 'x = 3 m']));
  assert.match(u.rows[1].error, /unknown source 'nope'/);
});

test('record(): the trailing series of a sensor binding through the host hook', () => {
  const body = bodyOf(['@sensor(heading)', 'az = 0 deg', 'trace = record(az, 60 s)', 'n = len(trace)']);
  const r = evaluate(body, {
    live: new Map([['az', { value: 1.0 }]]),
    recordSource: (name, win) => (name === 'az' && win === 60) ? [0.1, 0.2, 0.3] : [],
  });
  for (const row of r.rows) assert.equal(row.error, null, row.error);
  assert.equal(r.rows[3].result.value, 3);
  const off = evaluate(body);   // no readings, no hook → empty series, no error
  assert.equal(off.rows[3].result.value, 0);
});

test('a list literal keeps each element\'s written unit for display', () => {
  const r = evaluate(bodyOf(['dd_log = [89.39 deg, 90 deg]', 'z = [1 km, 200 m]', 'e = []', 'mix = [1 m, len("ab")]']));
  for (const row of r.rows) assert.equal(row.error, null, row.error);
  assert.deepEqual(r.rows[0].result.map(q => q.disp && q.disp.name), ['deg', 'deg']);
  assert.ok(Math.abs(r.rows[0].result[0].value - 89.39 * Math.PI / 180) < 1e-12);
  assert.deepEqual(r.rows[1].result.map(q => q.disp && q.disp.name), ['km', 'm']);
  assert.deepEqual(r.rows[2].result, []);
  assert.equal(r.rows[3].result[0].disp.name, 'm');
});
