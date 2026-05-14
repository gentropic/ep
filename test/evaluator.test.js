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

test('classify: @params and block-close', () => {
  assert.deepEqual(classify('@params {'),  {kind: 'params-open'});
  assert.deepEqual(classify('}'),          {kind: 'block-close'});
  // whitespace tolerated
  assert.deepEqual(classify('  @params { '), {kind: 'params-open'});
});

test('classify: @outputs parses comma-separated name list', () => {
  const c = classify('@outputs { tonnage, metal, metal_oz }');
  assert.equal(c.kind, 'outputs');
  assert.deepEqual(c.names, ['tonnage', 'metal', 'metal_oz']);
});

test('classify: binding with and without annotation', () => {
  assert.deepEqual(classify('x = 5'),
    {kind: 'binding', name: 'x', anno: null, expr: '5'});
  assert.deepEqual(classify('density : Density = 2.7 g/cm3'),
    {kind: 'binding', name: 'density', anno: 'Density', expr: '2.7 g/cm3'});
  assert.deepEqual(classify('v : Length / Time = 60 km / 1 h'),
    {kind: 'binding', name: 'v', anno: 'Length / Time', expr: '60 km / 1 h'});
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

test('evaluate: ore_body program end-to-end', () => {
  const body = bodyOf([
    '@params {',
    '  length            = 200 m',
    '  width             = 50 m',
    '  thickness         = 8 m',
    '  density : Density = 2.7 g/cm3',
    '  grade             = 1_800 ppb',
    '}',
    'volume   = length * width * thickness',
    'tonnage  = volume * density',
    'metal    = tonnage * grade',
    'metal_oz = metal -> ozt',
    '@outputs { tonnage, metal, metal_oz }',
  ]);
  const r = evaluate(body);

  // Params block recognized
  assert.equal(r.blockComplete, true);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].count, 5);
  assert.deepEqual(r.params.map(p => p.name), ['length', 'width', 'thickness', 'density', 'grade']);

  // No row-level errors
  for (const row of r.rows) assert.equal(row.error, null);

  // Canonical values
  assert.equal(r.scope.volume.v, 80000);                // m³
  assert.deepEqual(r.scope.volume.d, {length: 3});
  assert.ok(approx(r.scope.tonnage.v, 2.16e11));        // g (canonical mass)
  assert.deepEqual(r.scope.tonnage.d, {mass: 1});
  assert.ok(approx(r.scope.metal.v, 388800));           // g
  assert.equal(r.scope.metal_oz.disp, 'ozt');           // -> tag honored
  assert.equal(r.scope.metal_oz.v, r.scope.metal.v);    // canonical preserved through ->

  // Outputs collected
  assert.deepEqual(r.outputs, ['tonnage', 'metal', 'metal_oz']);
});

test('evaluate: dim mismatch surfaces as row error, downstream still tries', () => {
  const r = evaluate(bodyOf([
    'a = 1 m + 1 kg',     // error
    'b = 2 + 3',           // independent; should still evaluate
  ]));
  assert.match(r.rows[0].error, /can't add/);
  assert.equal(r.rows[0].result, null);
  assert.equal(r.rows[1].error, null);
  assert.equal(r.rows[1].result.v, 5);
});

test('evaluate: annotation mismatch is reported with both sides', () => {
  const r = evaluate(bodyOf([
    'density : Density = 2.7 g',   // annotated Density, got Mass
  ]));
  assert.match(r.rows[0].error, /annotated Density.*\[mass\]/);
  // binding still attempted; scope should NOT contain density (post-failure)
  assert.equal(r.scope.density, undefined);
});

test('evaluate: undefined identifier in body line', () => {
  const r = evaluate(bodyOf(['y = unknown_thing + 1']));
  assert.match(r.rows[0].error, /undefined: unknown_thing/);
});

test('evaluate: @outputs collects names even when bindings missing', () => {
  const r = evaluate(bodyOf([
    'x = 5',
    '@outputs { x, missing_binding }',
  ]));
  assert.deepEqual(r.outputs, ['x', 'missing_binding']);
  assert.equal(r.scope.x.v, 5);
  assert.equal(r.scope.missing_binding, undefined);  // caller decides how to render
});

test('evaluate: @params block recognized only with matching close brace', () => {
  // Missing closing `}` — the block is incomplete, body should evaluate without param scoping
  const r = evaluate(bodyOf([
    '@params {',
    '  x = 5',
    'y = x + 1',  // should fail: x isn't in scope without a complete block
  ]));
  assert.equal(r.blockComplete, false);
  assert.deepEqual(r.params, []);
});

test('evaluate: non-binding line inside @params is flagged', () => {
  const r = evaluate(bodyOf([
    '@params {',
    '  2 + 2',           // bad: expressions not allowed in @params
    '}',
  ]));
  assert.match(r.rows[1].error, /expected `name = expr` inside @params/);
});

test('evaluate: param binding with annotation respected', () => {
  const r = evaluate(bodyOf([
    '@params {',
    '  density : Density = 2.7 g/cm3',
    '}',
  ]));
  assert.equal(r.rows[1].error, null);
  assert.deepEqual(r.params[0].anno, 'Density');
});
