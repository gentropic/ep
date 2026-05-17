// One-shot probe: typecheck the full conformance corpus, print pass/fail
// rates and the first 30 failures. NOT a regular test — run manually
// during typechecker development to see where the gaps are.
//
//   node test/typecheck-corpus-probe.js
//
// Reads the corpus by literally regex-parsing test/conformance.test.js
// (cheaper than refactoring the corpus into an importable module).

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../ext/temporal/temporal-polyfill.min.js');
}

globalThis.INITIAL_STATE = { name: 'probe', body: [], ui: {} };
const { evaluate, DIMENSION_OF } = await import('../src/js/evaluator.js');
evaluate([{ src: '1' }]);   // trigger host init

const numbat = await import('../ext/numbat/dist/numbat.js');
const { typecheckModule } = await import('../ext/numbat/src/typecheck/integration.js');

function buildEpHost() {
  const host = new numbat.Numbat({ prelude: 'v0.1' });
  host.values.set('pi',  new numbat.Quantity(Math.PI,     {}));
  host.values.set('tau', new numbat.Quantity(Math.PI * 2, {}));
  host.values.set('e',   new numbat.Quantity(Math.E,      {}));
  host.values.set('NaN', new numbat.Quantity(NaN,      {}));
  host.values.set('inf', new numbat.Quantity(Infinity, {}));
  for (const [name, dim] of Object.entries(DIMENSION_OF)) {
    host.dims.defineDerived(name, dim);
  }
  if (typeof numbat.VENDORED_MODULES === 'object') {
    for (const [path, source] of Object.entries(numbat.VENDORED_MODULES)) {
      host.registerModule(path, source);
    }
  }
  return host;
}

const src = readFileSync('test/conformance.test.js', 'utf8');
const RE = /\{\s*name:\s*'([^']+)',\s*source:\s*'((?:[^'\\]|\\.)*?)',/g;
const entries = [];
let m;
while ((m = RE.exec(src)) !== null) {
  entries.push({
    name: m[1],
    source: m[2].replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\'),
  });
}

const DECL_PREFIXES = ['let ', 'fn ', 'use ', 'dimension ', 'unit ', 'struct ', '#', '--'];
function isDecl(text) {
  const trim = text.trim();
  return DECL_PREFIXES.some(p => trim.startsWith(p));
}

let pass = 0, fail = 0, threw = 0;
const failures = [];
for (const e of entries) {
  try {
    const body = isDecl(e.source) ? e.source : `let __probe = ${e.source}`;
    const host = buildEpHost();
    const ast = numbat.parse(numbat.tokenize(body, '<corpus>'), '<corpus>');
    const r = typecheckModule(ast, host);
    if (r.errors.length === 0) {
      pass++;
    } else {
      fail++;
      failures.push(`${e.name}  —  ${r.errors[0].message.slice(0, 100)}`);
    }
  } catch (err) {
    threw++;
    failures.push(`${e.name}  [THROW]  ${err.message.split('\n')[0].slice(0, 100)}`);
  }
}

console.log(`corpus: ${entries.length} entries`);
console.log(`  pass:    ${pass} (${(pass*100/entries.length).toFixed(0)}%)`);
console.log(`  fail:    ${fail}`);
console.log(`  threw:   ${threw}`);
console.log(`\nfirst 30 failures:`);
for (const f of failures.slice(0, 30)) console.log(`  ${f}`);
