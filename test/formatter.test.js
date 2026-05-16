// Formatter contract: whitespace normalization, decorator stacking,
// blank-line rules, line-width-aware function-call breaking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEpBody } from '../src/js/formatter.js';

test('format: idempotent on already-formatted input', () => {
  const src =
`@input
x = 5

@output
y = x * 2
`;
  assert.equal(formatEpBody(src), src);
  assert.equal(formatEpBody(formatEpBody(src)), formatEpBody(src));
});

test('format: collapses blank-line runs and trims trailing whitespace', () => {
  const src = '@input  \nx = 5  \n\n\n\n@output\ny = x * 2\n   \n   ';
  const out = formatEpBody(src);
  assert.ok(!out.includes('  \n'), 'trailing whitespace gone');
  assert.ok(!out.match(/\n\n\n/), 'no triple blank lines');
});

test('format: normalizes spacing around = in bindings', () => {
  const out = formatEpBody('x=5\ny =6\n');
  assert.ok(out.includes('x = 5'));
  assert.ok(out.includes('y = 6'));
});

test('format: decorators stack flush above their binding', () => {
  // Inserting blank lines between a decorator and its binding should
  // get collapsed (the decorator + binding are one statement).
  const src = '@input\n\n\nx = 5\n';
  const out = formatEpBody(src);
  assert.equal(out, '@input\nx = 5\n');
});

test('format: one blank line between top-level statements', () => {
  const src = '@input\nx = 5\n@input\ny = 6\n';
  const out = formatEpBody(src);
  assert.equal(out, '@input\nx = 5\n\n@input\ny = 6\n');
});

test('format: long function call breaks into one-arg-per-line', () => {
  const src = '@output(kg)\nmass = sample_mass(NQ_core, 5 m, 2.7 g/cm3)\n';
  const out = formatEpBody(src);
  // Single-line form is 52 chars — actually fits under 70, so should NOT break.
  // Make a longer one to force the break:
  const longSrc = 'mass = sample_mass(NQ_core_diameter_value, length_in_metres, density_g_per_cm3, rock_type)\n';
  const longOut = formatEpBody(longSrc);
  assert.ok(longOut.includes('\n  '), 'long call breaks into multi-line form');
  // Each arg on its own line, trailing comma per arg.
  assert.match(longOut, /\n {2}NQ_core_diameter_value,\n/);
  assert.match(longOut, /\n {2}length_in_metres,\n/);
  assert.match(longOut, /\n\)/);
});

test('format: short @options stays single-line', () => {
  const src = '@options(a, b, c)\nx = a\n';
  const out = formatEpBody(src);
  assert.ok(out.startsWith('@options(a, b, c)\n'));
});

test('format: long @options breaks into multi-line', () => {
  const src = '@options(granite, basalt, sandstone, limestone, dolomite, schist, gneiss)\nrock = granite\n';
  const out = formatEpBody(src);
  assert.ok(out.includes('@options(\n  granite,\n'));
});

test('format: trailing newline always present', () => {
  assert.ok(formatEpBody('x = 5').endsWith('\n'));
  assert.ok(formatEpBody('x = 5\n').endsWith('\n'));
  assert.ok(!formatEpBody('x = 5\n').endsWith('\n\n'));
});

test('format: ignores already-broken multi-line call (idempotent across)', () => {
  const src = '@output(kg)\nmass = sample_mass(\n  NQ_core,\n  5 m,\n  2.7 g/cm3,\n)\n';
  const out = formatEpBody(src);
  // Single-line form fits under 70 → formatter collapses it back. That's
  // the right behavior (canonical = single line if it fits).
  assert.ok(out.includes('mass = sample_mass(NQ_core, 5 m, 2.7 g/cm3)'));
});
