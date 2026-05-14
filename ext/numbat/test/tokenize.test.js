import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, KEYWORDS } from '../src/tokenize.js';

const shape = toks => toks.map(t => {
  const out = { type: t.type };
  if ('op' in t) out.op = t.op;
  if ('name' in t) out.name = t.name;
  if ('value' in t) out.value = t.value;
  return out;
});

// ── basics ────────────────────────────────────────────────────────

test('empty input → no tokens', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('   \n\n\t  '), []);
});

test('comments stripped to EOL', () => {
  assert.deepEqual(shape(tokenize('# just a comment')), []);
  assert.deepEqual(shape(tokenize('5 # trailing comment')), [{ type: 'num', value: 5 }]);
  assert.deepEqual(shape(tokenize('### section header')), []);
});

test('integer, decimal, scientific notation, digit separators', () => {
  assert.equal(tokenize('42')[0].value, 42);
  assert.equal(tokenize('3.14')[0].value, 3.14);
  assert.equal(tokenize('1.5e-3')[0].value, 1.5e-3);
  assert.equal(tokenize('2E10')[0].value, 2e10);
  assert.equal(tokenize('1_800')[0].value, 1800);
  assert.equal(tokenize('12_345_678')[0].value, 12345678);
});

test('strings, including escapes', () => {
  assert.equal(tokenize('"hello"')[0].value, 'hello');
  assert.equal(tokenize('"a\\nb"')[0].value, 'a\nb');
  assert.equal(tokenize('"slash\\\\"')[0].value, 'slash\\');
});

test('unterminated string throws', () => {
  assert.throws(() => tokenize('"oops'), /unterminated string/);
});

// ── identifiers and keywords ──────────────────────────────────────

test('identifiers and keywords separated', () => {
  const toks = shape(tokenize('unit meter let'));
  assert.deepEqual(toks, [
    { type: 'kw', name: 'unit' },
    { type: 'id', name: 'meter' },
    { type: 'kw', name: 'let' },
  ]);
});

test('every reserved keyword tokenizes as kw', () => {
  for (const kw of KEYWORDS) {
    const t = tokenize(kw);
    assert.equal(t.length, 1, `expected single token for ${kw}`);
    assert.equal(t[0].type, 'kw');
    assert.equal(t[0].name, kw);
  }
});

test('underscores, digits inside identifiers', () => {
  assert.equal(tokenize('snake_case')[0].name, 'snake_case');
  assert.equal(tokenize('x42')[0].name, 'x42');
  assert.equal(tokenize('_leading')[0].name, '_leading');
});

test('unicode letters and symbols tokenize as identifiers', () => {
  // Greek letters used by math constants
  assert.equal(tokenize('π')[0].type, 'id');
  assert.equal(tokenize('π')[0].name, 'π');
  assert.equal(tokenize('τ')[0].type, 'id');
  assert.equal(tokenize('φ')[0].type, 'id');
  // Symbol-style aliases
  assert.equal(tokenize('%')[0].type, 'id');
  assert.equal(tokenize('%')[0].name, '%');
  assert.equal(tokenize('‰')[0].type, 'id');
  assert.equal(tokenize('°')[0].type, 'id');
});

// ── operators ─────────────────────────────────────────────────────

test('single-char operators', () => {
  assert.equal(tokenize('+')[0].op, '+');
  assert.equal(tokenize('*')[0].op, '*');
  assert.equal(tokenize('(')[0].op, '(');
  assert.equal(tokenize(',')[0].op, ',');
  assert.equal(tokenize(':')[0].op, ':');
});

test('multi-char operators recognized', () => {
  assert.equal(tokenize('->')[0].op, '->');
  assert.equal(tokenize('::')[0].op, '::');
  assert.equal(tokenize('|>')[0].op, '|>');
  assert.equal(tokenize('!=')[0].op, '!=');
  assert.equal(tokenize('<=')[0].op, '<=');
  assert.equal(tokenize('==')[0].op, '==');
  assert.equal(tokenize('&&')[0].op, '&&');
});

test('longest match preferred (`::` not `:` `:`)', () => {
  const toks = tokenize('a::b');
  assert.equal(toks.length, 3);
  assert.equal(toks[0].name, 'a');
  assert.equal(toks[1].op, '::');
  assert.equal(toks[2].name, 'b');
});

test('unicode operator aliases', () => {
  assert.equal(tokenize('→')[0].op, '->');
  assert.equal(tokenize('×')[0].op, '*');
  assert.equal(tokenize('÷')[0].op, '/');
  assert.equal(tokenize('−')[0].op, '-');
  assert.equal(tokenize('·')[0].op, '*');
});

test('unicode exponents emit `^` then number', () => {
  const t = tokenize('m²');
  assert.equal(t.length, 3);
  assert.equal(t[0].name, 'm');
  assert.equal(t[1].op, '^');
  assert.equal(t[2].value, 2);
});

// ── decorators ────────────────────────────────────────────────────

test('decorator emits dec token with name (args parsed later)', () => {
  const t = tokenize('@metric_prefixes');
  assert.equal(t.length, 1);
  assert.equal(t[0].type, 'dec');
  assert.equal(t[0].name, 'metric_prefixes');
});

test('decorator with parenthesized args produces separate tokens', () => {
  const t = shape(tokenize('@aliases(m: short)'));
  assert.deepEqual(t, [
    { type: 'dec', name: 'aliases' },
    { type: 'op', op: '(' },
    { type: 'id', name: 'm' },
    { type: 'op', op: ':' },
    { type: 'id', name: 'short' },
    { type: 'op', op: ')' },
  ]);
});

test('decorator with string arg', () => {
  const t = shape(tokenize('@name("Metre")'));
  assert.deepEqual(t, [
    { type: 'dec', name: 'name' },
    { type: 'op', op: '(' },
    { type: 'str', value: 'Metre' },
    { type: 'op', op: ')' },
  ]);
});

// ── upstream sample lines ─────────────────────────────────────────

test('upstream-style: full unit declaration tokenizes cleanly', () => {
  const src = `@name("Metre")
@metric_prefixes
@aliases(metres, meter, meters, m: short)
unit metre: Length`;
  const t = tokenize(src);
  // We just need it to not throw and produce a reasonable number of tokens.
  assert.ok(t.length > 10);
  // Last few tokens should be the unit declaration
  const tail = t.slice(-4);
  assert.equal(tail[0].name, 'unit');
  assert.equal(tail[1].name, 'metre');
  assert.equal(tail[2].op, ':');
  assert.equal(tail[3].name, 'Length');
});

test('upstream-style: dimension declaration with arithmetic', () => {
  const t = shape(tokenize('dimension Velocity = Length / Time'));
  assert.deepEqual(t, [
    { type: 'kw', name: 'dimension' },
    { type: 'id', name: 'Velocity' },
    { type: 'op', op: '=' },
    { type: 'id', name: 'Length' },
    { type: 'op', op: '/' },
    { type: 'id', name: 'Time' },
  ]);
});

test('upstream-style: module use statement', () => {
  const t = shape(tokenize('use core::dimensions'));
  assert.deepEqual(t, [
    { type: 'kw', name: 'use' },
    { type: 'id', name: 'core' },
    { type: 'op', op: '::' },
    { type: 'id', name: 'dimensions' },
  ]);
});

test('spans include line/col for error reporting', () => {
  const t = tokenize('foo\n  bar');
  assert.equal(t[0].span.line, 1);
  assert.equal(t[0].span.col, 1);
  assert.equal(t[1].span.line, 2);
  assert.equal(t[1].span.col, 3);
});
