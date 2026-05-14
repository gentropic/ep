import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/tokenize.js';
import { parse } from '../src/parse.js';

const parseSrc = (src) => parse(tokenize(src));

// ── use statements ────────────────────────────────────────────────

test('use: single segment', () => {
  const m = parseSrc('use prelude');
  assert.equal(m.decls.length, 1);
  assert.deepEqual(m.decls[0], { type: 'UseStmt', path: ['prelude'], decorators: [] });
});

test('use: dotted path with ::', () => {
  const m = parseSrc('use core::dimensions');
  assert.deepEqual(m.decls[0].path, ['core', 'dimensions']);
});

test('use: deeper path', () => {
  const m = parseSrc('use a::b::c::d');
  assert.deepEqual(m.decls[0].path, ['a', 'b', 'c', 'd']);
});

// ── dimension declarations ────────────────────────────────────────

test('dimension: base (no =)', () => {
  const m = parseSrc('dimension Length');
  assert.deepEqual(m.decls[0], { type: 'DimensionDecl', name: 'Length', expr: null, decorators: [] });
});

test('dimension: derived from arithmetic', () => {
  const m = parseSrc('dimension Velocity = Length / Time');
  const d = m.decls[0];
  assert.equal(d.type, 'DimensionDecl');
  assert.equal(d.name, 'Velocity');
  assert.deepEqual(d.expr, {
    type: 'Binary', op: '/',
    left:  { type: 'Ident', name: 'Length', span: d.expr.left.span },
    right: { type: 'Ident', name: 'Time',   span: d.expr.right.span },
  });
});

test('dimension: Angle = 1 (scalar dimension)', () => {
  const m = parseSrc('dimension Angle = 1');
  assert.deepEqual(m.decls[0].expr, { type: 'Num', value: 1, raw: '1' });
});

test('dimension: exponent', () => {
  const m = parseSrc('dimension Area = Length^2');
  const e = m.decls[0].expr;
  assert.equal(e.type, 'Binary');
  assert.equal(e.op, '^');
  assert.equal(e.left.name, 'Length');
  assert.equal(e.right.value, 2);
});

// ── unit declarations ─────────────────────────────────────────────

test('unit: base form `unit metre: Length`', () => {
  const m = parseSrc('unit metre: Length');
  const d = m.decls[0];
  assert.equal(d.type, 'UnitDecl');
  assert.equal(d.name, 'metre');
  assert.equal(d.dim.name, 'Length');
  assert.equal(d.expr, null);
});

test('unit: with value expression', () => {
  const m = parseSrc('unit hertz: Frequency = 1 / second');
  const d = m.decls[0];
  assert.equal(d.dim.name, 'Frequency');
  assert.equal(d.expr.op, '/');
  assert.equal(d.expr.left.value, 1);
  assert.equal(d.expr.right.name, 'second');
});

test('unit: no dim, just value', () => {
  const m = parseSrc('unit hundred = 100');
  assert.equal(m.decls[0].dim, null);
  assert.equal(m.decls[0].expr.value, 100);
});

test('unit: complex SI expression (kilogram meter / second^2)', () => {
  const m = parseSrc('unit newton: Force = kilogram meter / second^2');
  const e = m.decls[0].expr;
  // (kilogram * meter) / (second ^ 2)
  assert.equal(e.op, '/');
  assert.equal(e.left.op, '*');
  assert.equal(e.left.left.name, 'kilogram');
  assert.equal(e.left.right.name, 'meter');
  assert.equal(e.right.op, '^');
  assert.equal(e.right.left.name, 'second');
  assert.equal(e.right.right.value, 2);
});

// ── let declarations ──────────────────────────────────────────────

test('let: simple value', () => {
  const m = parseSrc('let n = 4');
  assert.equal(m.decls[0].type, 'LetDecl');
  assert.equal(m.decls[0].name, 'n');
  assert.equal(m.decls[0].expr.value, 4);
});

test('let: with dimension annotation', () => {
  const m = parseSrc('let v: Velocity = 2 m / s');
  const d = m.decls[0];
  assert.equal(d.dim.name, 'Velocity');
  // RHS: (2 * m) / s
  assert.equal(d.expr.op, '/');
});

test('let: π = 3.14...', () => {
  const m = parseSrc('let π = 3.14159');
  assert.equal(m.decls[0].name, 'π');
  assert.equal(m.decls[0].expr.value, 3.14159);
});

test('let: implicit mul (2 π)', () => {
  const m = parseSrc('let τ = 2 π');
  const e = m.decls[0].expr;
  assert.equal(e.op, '*');
  assert.equal(e.left.value, 2);
  assert.equal(e.right.name, 'π');
});

// ── decorators ────────────────────────────────────────────────────

test('decorator: no-arg (@metric_prefixes)', () => {
  const m = parseSrc(`@metric_prefixes
unit metre: Length`);
  const d = m.decls[0];
  assert.equal(d.decorators.length, 1);
  assert.equal(d.decorators[0].name, 'metric_prefixes');
  assert.deepEqual(d.decorators[0].args, []);
});

test('decorator: string arg (@name)', () => {
  const m = parseSrc(`@name("Metre")
unit metre: Length`);
  const dec = m.decls[0].decorators[0];
  assert.equal(dec.name, 'name');
  assert.deepEqual(dec.args, [{ type: 'StrArg', value: 'Metre' }]);
});

test('decorator: @aliases with name + modifier', () => {
  const m = parseSrc(`@aliases(metres, meter, meters, m: short)
unit metre: Length`);
  const args = m.decls[0].decorators[0].args;
  assert.equal(args.length, 4);
  assert.deepEqual(args[0], { type: 'NameArg', name: 'metres', modifier: null });
  assert.deepEqual(args[3], { type: 'NameArg', name: 'm',      modifier: 'short' });
});

test('decorator: stacks multiple on one declaration', () => {
  const m = parseSrc(`@name("Metre")
@url("https://example.com")
@metric_prefixes
@aliases(m: short)
unit metre: Length`);
  const decs = m.decls[0].decorators.map(d => d.name);
  assert.deepEqual(decs, ['name', 'url', 'metric_prefixes', 'aliases']);
});

// ── conversion (->) ───────────────────────────────────────────────

test('conversion: simple', () => {
  const m = parseSrc('let x = 30 km -> mph');
  const e = m.decls[0].expr;
  // (30 * km) -> mph
  assert.equal(e.op, '->');
  assert.equal(e.right.name, 'mph');
});

test('conversion: `to` synonym', () => {
  const m = parseSrc('let x = 3 km to m');
  assert.equal(m.decls[0].expr.op, '->');
});

// ── precedence & associativity ────────────────────────────────────

test('precedence: * before +', () => {
  const m = parseSrc('let x = 1 + 2 * 3');
  const e = m.decls[0].expr;
  // 1 + (2 * 3)
  assert.equal(e.op, '+');
  assert.equal(e.left.value, 1);
  assert.equal(e.right.op, '*');
});

test('precedence: implicit mul tighter than explicit /', () => {
  const m = parseSrc('let x = a b / c');
  const e = m.decls[0].expr;
  // (a b) / c
  assert.equal(e.op, '/');
  assert.equal(e.left.op, '*');
});

test('associativity: ^ right-associative', () => {
  const m = parseSrc('let x = 2^3^2');
  const e = m.decls[0].expr;
  // 2 ^ (3 ^ 2) = 2 ^ 9
  assert.equal(e.op, '^');
  assert.equal(e.left.value, 2);
  assert.equal(e.right.op, '^');
  assert.equal(e.right.left.value, 3);
  assert.equal(e.right.right.value, 2);
});

test('parens group correctly', () => {
  const m = parseSrc('let x = (1 + 2) * 3');
  const e = m.decls[0].expr;
  assert.equal(e.op, '*');
  assert.equal(e.left.type, 'Paren');
});

test('unary minus', () => {
  const m = parseSrc('let x = -5');
  const e = m.decls[0].expr;
  assert.equal(e.type, 'Unary');
  assert.equal(e.op, '-');
  assert.equal(e.expr.value, 5);
});

// ── multi-decl modules ────────────────────────────────────────────

test('multiple declarations', () => {
  const m = parseSrc(`use core::dimensions
dimension Foo = Length
unit bar: Foo = 5 meter`);
  assert.equal(m.decls.length, 3);
  assert.equal(m.decls[0].type, 'UseStmt');
  assert.equal(m.decls[1].type, 'DimensionDecl');
  assert.equal(m.decls[2].type, 'UnitDecl');
});

// ── error reporting ──────────────────────────────────────────────

test('error: unsupported keyword (fn) is rejected with span', () => {
  assert.throws(
    () => parseSrc('fn foo() = 1'),
    /unsupported keyword 'fn'/,
  );
});

test('error: missing identifier after dimension', () => {
  assert.throws(() => parseSrc('dimension = 1'), /expected dimension name/);
});

test('error: unterminated paren', () => {
  assert.throws(() => parseSrc('let x = (1 + 2'), /expected '\)'/);
});

// ── upstream sample integration ──────────────────────────────────

test('parses a full upstream-style unit declaration', () => {
  const src = `@name("Metre")
@url("https://en.wikipedia.org/wiki/Metre")
@metric_prefixes
@aliases(metres, meter, meters, m: short)
unit metre: Length`;
  const m = parseSrc(src);
  assert.equal(m.decls.length, 1);
  const d = m.decls[0];
  assert.equal(d.type, 'UnitDecl');
  assert.equal(d.name, 'metre');
  assert.equal(d.dim.name, 'Length');
  assert.equal(d.decorators.length, 4);
});

test('parses partsperx-style unit (number-only RHS)', () => {
  const src = `@aliases(ppm)
unit partspermillion = 1e-06`;
  const m = parseSrc(src);
  const d = m.decls[0];
  assert.equal(d.name, 'partspermillion');
  assert.equal(d.dim, null);
  assert.equal(d.expr.value, 1e-6);
});
