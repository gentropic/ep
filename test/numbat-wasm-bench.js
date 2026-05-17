// Benchmark — ep's numbat-js port vs the upstream Rust-WASM build.
//
// Not part of `npm test` (timings drift). Run explicitly:
//
//     sh ext/numbat-upstream/fetch.sh    # one-time
//     node test/numbat-wasm-bench.js
//
// Skips with a hint if the WASM artifact is missing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(HERE, '..', 'ext', 'numbat-upstream', 'numbat_wasm_bg.wasm');
const HARNESS_PATH = join(HERE, '..', 'ext', 'numbat-upstream', 'numbat_wasm.js');

if (!existsSync(WASM_PATH) || !existsSync(HARNESS_PATH)) {
  console.error('skip: ext/numbat-upstream/ not populated — run sh ext/numbat-upstream/fetch.sh');
  process.exit(0);
}

if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../ext/temporal/temporal-polyfill.min.js');
}
globalThis.INITIAL_STATE = { name: 'bench', body: [], ui: {} };

const { evaluate } = await import('../src/js/evaluator.js');
const upstream = await import(pathToFileURL(HARNESS_PATH).href);
await upstream.default({ module_or_path: readFileSync(WASM_PATH) });

const PROGRAMS = [
  { label: 'arith',         src: '1 + 2 * 3 - 4 / 5' },
  { label: 'unit-add',      src: '1 m + 2 cm' },
  { label: 'convert',       src: '1 m + 2 cm -> mm' },
  { label: 'derived-conv',  src: '100 km/h -> m/s' },
  { label: 'sqrt',          src: 'sqrt(144)' },
  { label: 'pow',           src: '2^20' },
  { label: 'sin',           src: 'sin(pi / 4)' },
  { label: 'fn-decl+call',  src: 'fn sq(x: Scalar) -> Scalar = x * x\nsq(7)' },
  { label: 'fact(10)',      src: 'fn fact(n: Scalar) -> Scalar = if n < 2 then 1 else n * fact(n-1)\nfact(10)' },
  { label: 'fact(15)',      src: 'fn fact(n: Scalar) -> Scalar = if n < 2 then 1 else n * fact(n-1)\nfact(15)' },
  { label: 'mixed-decl',    src: 'let g = 9.81 m/s^2\nlet t = 3 s\n0.5 * g * t^2' },
];

const ITER = 200;
const WARMUP = 10;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function timeIt(fn) {
  for (let i = 0; i < WARMUP; i++) fn();
  const samples = new Array(ITER);
  for (let i = 0; i < ITER; i++) {
    const t0 = performance.now();
    fn();
    samples[i] = performance.now() - t0;
  }
  return { median: median(samples), min: Math.min(...samples) };
}

function fmtMs(x) {
  if (x >= 10)  return x.toFixed(1) + ' ms';
  if (x >= 1)   return x.toFixed(2) + ' ms';
  if (x >= 0.1) return x.toFixed(3) + ' ms';
  return (x * 1000).toFixed(1) + ' µs';
}

const wasmInst = upstream.Numbat.new(true, false, upstream.FormatType.JqueryTerminal);

console.log(`\nep numbat-js  vs  upstream numbat-wasm  (${ITER} iter, median)\n`);
console.log('program          ep              wasm            ep / wasm');
console.log('-'.repeat(64));

const rows = [];
for (const { label, src } of PROGRAMS) {
  const epBody = src.split('\n').map(s => ({ src: s }));
  const ep   = timeIt(() => evaluate(epBody));
  const wasm = timeIt(() => wasmInst.interpret(src));
  const ratio = ep.median / wasm.median;
  rows.push({ label, ep, wasm, ratio });
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  console.log(
    pad(label, 16) +
    pad(fmtMs(ep.median),   16) +
    pad(fmtMs(wasm.median), 16) +
    (ratio < 1 ? `${ratio.toFixed(2)}x  (ep wins)` : `${ratio.toFixed(2)}x  (wasm wins)`),
  );
}

const epMed   = median(rows.map(r => r.ep.median));
const wasmMed = median(rows.map(r => r.wasm.median));
console.log('-'.repeat(64));
console.log(`median across programs: ep ${fmtMs(epMed)}, wasm ${fmtMs(wasmMed)} (${(epMed/wasmMed).toFixed(2)}x)`);
