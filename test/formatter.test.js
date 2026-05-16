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
  // Width target is 40 chars; this 91-char line forces the break.
  const longSrc = 'mass = sample_mass(NQ_core_diameter, length_in_m, density_gpcm3, rock_type)\n';
  const longOut = formatEpBody(longSrc);
  assert.ok(longOut.includes('\n  '), 'long call breaks into multi-line form');
  assert.match(longOut, /\n {2}NQ_core_diameter,\n/);
  assert.match(longOut, /\n {2}length_in_m,\n/);
  assert.match(longOut, /\n\)/);
});

test('format: short call below width stays single-line', () => {
  const src = '@output(kg)\nmass = sample_mass(a, b, c)\n';
  // `mass = sample_mass(a, b, c)` is 27 chars — well under 40.
  const out = formatEpBody(src);
  assert.ok(out.includes('mass = sample_mass(a, b, c)'));
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

test('format: already-broken short call collapses to single line', () => {
  const src = '@output(kg)\nmass = sample_mass(\n  a,\n  b,\n  c,\n)\n';
  const out = formatEpBody(src);
  // 27 chars on one line — fits under 40, formatter collapses.
  assert.ok(out.includes('mass = sample_mass(a, b, c)'));
});

test('format: already-broken long call stays broken', () => {
  const src = '@output(kg)\nmass = sample_mass(\n  NQ_core_diameter,\n  length_in_m,\n  density_gpcm3,\n)\n';
  const out = formatEpBody(src);
  // 60-ish chars on one line — exceeds 40, formatter keeps it broken.
  assert.match(out, /\n {2}NQ_core_diameter,\n/);
});

test('format: leading whole-line comments are preserved', () => {
  const src = '# describe what this does\n# in two lines\n@input\nx = 5\n';
  const out = formatEpBody(src);
  assert.ok(out.startsWith('# describe what this does\n# in two lines\n@input\nx = 5'));
});

test('format: trailing comment on a binding survives', () => {
  const src = '@input\nx = 5  # the magic number\n';
  const out = formatEpBody(src);
  assert.match(out, /^@input\nx = 5  # the magic number\n/);
});

test('format: comments between two statements stay where they were', () => {
  const src = '@input\nx = 5\n\n# transition comment\n\n@output\ny = x * 2\n';
  const out = formatEpBody(src);
  assert.match(out, /x = 5\n# transition comment\n\n@output/);
});

test('format: trailing comment at end of file is preserved', () => {
  const src = '@input\nx = 5\n\n# end-of-file remark\n';
  const out = formatEpBody(src);
  assert.ok(out.endsWith('# end-of-file remark\n'));
});

test('format: document with only comments is left alone', () => {
  const src = '# a stand-alone comment file\n# second line\n';
  const out = formatEpBody(src);
  assert.ok(out.includes('# a stand-alone comment file'));
  assert.ok(out.includes('# second line'));
});

test('format: long arithmetic wraps in parens and breaks at lowest-prec op', () => {
  const src = 'total = base_value + adjustment_factor * coefficient + extra_amount\n';
  const out = formatEpBody(src);
  // Lowest precedence is `+`; breaks should be at the two `+` positions.
  // `*` stays inline within its chain.
  assert.match(out, /total = \(\n {2}base_value\n {2}\+ adjustment_factor \* coefficient\n {2}\+ extra_amount\n\)/);
});

test('format: pure mult/div chain breaks at * and / when no + present', () => {
  const src = 'val = aaaaaaa * bbbbbbb / ccccccc * ddddddd\n';
  const out = formatEpBody(src);
  // No `+` here; lowest prec at top level is `*` / `/`.
  assert.match(out, /val = \(\n {2}aaaaaaa\n {2}\* bbbbbbb\n/);
});

test('format: unary minus is not treated as a break point', () => {
  const src = 'x = -5\n';
  const out = formatEpBody(src);
  assert.equal(out, 'x = -5\n');   // no wrap, no break
});

test('format: width option overrides default', () => {
  // At width 100, the long call (~91 chars on one line) should fit.
  const longSrc = 'mass = sample_mass(NQ_core_diameter, length_in_m, density_gpcm3, rock_type)\n';
  const wide = formatEpBody(longSrc, { width: 100 });
  assert.ok(!wide.includes('\n  '), 'no break at width 100');
  const tight = formatEpBody(longSrc, { width: 40 });
  assert.ok(tight.includes('\n  '), 'breaks at width 40');
});
