// One-shot probe: run every built-in example through ep's evaluator
// and report any row errors or empty outputs. Not a regular test — runs
// the EXAMPLES table from src/js/examples.js (no UI), surfaces the
// per-row error string and the outputs panel content as the user would
// see them.

import { createRequire } from 'node:module';
if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../ext/temporal/temporal-polyfill.min.js');
}
globalThis.INITIAL_STATE = { name: 'probe', body: [], ui: {} };

const { evaluate } = await import('../src/js/evaluator.js');

// Import the EXAMPLES table. Since examples.js imports state/storage/etc
// (which expect a DOM), we just read the file and eval the EXAMPLES
// literal — same trick the corpus-probe uses.
import { readFileSync } from 'node:fs';
const src = readFileSync('src/js/examples.js', 'utf8');
const m = src.match(/const EXAMPLES = (\[[\s\S]*?\n\]);/);
if (!m) { console.error('failed to extract EXAMPLES'); process.exit(1); }
const EXAMPLES = eval(m[1]);

for (const ex of EXAMPLES) {
  console.log('\n=== ' + ex.slug + ' (' + ex.name + ') ===');
  const lines = ex.body.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  const body = lines.map(src => ({ src }));
  const r = evaluate(body);
  console.log('  outputs:', r.outputs.map(o => o.unit ? `${o.name}:${o.unit}` : o.name).join(', ') || '(none)');
  console.log('  params: ', r.params.map(p => p.name).join(', ') || '(none)');
  const errs = r.rows
    .map((row, i) => row.error ? `    row ${i}: ${row.error}` : null)
    .filter(Boolean);
  if (errs.length) {
    console.log('  ERRORS:');
    for (const e of errs) console.log(e);
  } else {
    console.log('  no errors');
  }
}
