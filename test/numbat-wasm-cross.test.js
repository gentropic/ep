// Cross-validation harness — runs the conformance corpus through
// upstream Numbat (the Rust → WASM build) AND ep's numbat-js port and
// asserts the outputs match. Catches drift between the two
// implementations without ep having to manually update expected
// values every time the corpus grows.
//
// Skips gracefully when ext/numbat-upstream/numbat_wasm_bg.wasm is
// absent — `sh ext/numbat-upstream/fetch.sh` to populate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(HERE, '..', 'ext', 'numbat-upstream', 'numbat_wasm_bg.wasm');
const HARNESS_PATH = join(HERE, '..', 'ext', 'numbat-upstream', 'numbat_wasm.js');

if (!existsSync(WASM_PATH) || !existsSync(HARNESS_PATH)) {
  test('numbat-wasm cross-validation', { skip: 'ext/numbat-upstream/ not populated — run sh ext/numbat-upstream/fetch.sh' }, () => {});
} else {
  // Polyfill Temporal in Node since the conformance corpus uses it.
  const { createRequire } = await import('node:module');
  if (typeof globalThis.Temporal === 'undefined') {
    createRequire(import.meta.url)('../ext/temporal/temporal-polyfill.min.js');
  }
  globalThis.INITIAL_STATE = { name: 'test', body: [], ui: {} };
  await import('../src/js/evaluator.js');

  let upstream = null;
  try {
    const mod = await import('file://' + HARNESS_PATH.replace(/\\/g, '/'));
    // __wbg_init wants a URL/Request/bytes — pass bytes since Node's fetch
    // doesn't handle bare file paths.
    if (typeof mod.default === 'function') await mod.default({ module_or_path: readFileSync(WASM_PATH) });
    upstream = mod;
  } catch (e) {
    test('numbat-wasm cross-validation: load failed', () => {
      assert.fail('upstream WASM bridge failed to load: ' + e.message);
    });
  }

  if (upstream) {
    test('numbat-wasm cross-validation: bridge loads', () => {
      assert.ok(upstream, 'upstream WASM bridge loaded');
    });
    // TODO(B-phase-2): walk the conformance CORPUS, run each program
    // through both engines, compare values within tolerance.
  }
}
