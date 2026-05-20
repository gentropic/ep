// CSV data assets — the host side of numbat-js's load_csv builtin.
//
// numbat-js owns no files: its load_csv proc forwards to a resolver
// this module registers via setCsvResolver. The resolver maps an asset
// name to a parsed Dataset, reading the embedded CSV text from
// state.assets. Parsing is cached by asset-object identity — attachCsv
// always writes a fresh asset object, so a re-attach invalidates the
// cache for free, while slider-drag re-evaluations reuse the parse.
//
// Phase 1 (eager datasets, SPEC-DATASETS): embedded assets only — the
// CSV text rides along in the program record and travels with .html
// exports. File references / FSAA handles are a later enhancement.

import { state } from './state.js';
import { parseCsv, detectCsvConfig, Quantity, setCsvResolver } from '../../ext/numbat/dist/numbat.js';
import { resolveUnitExpression } from './evaluator.js';

// name → { assetRef, dataset } — assetRef is the state.assets[name]
// object the cached Dataset was parsed from. Identity mismatch (a
// re-attach) forces a re-parse.
const parseCache = new Map();

// Adapter for parseCsv's resolveUnit hook: ep resolves a unit string
// through resolveUnitExpression ({dim, mul}); parseCsv wants a Quantity
// whose value is the multiplier. A header unit that doesn't resolve is
// treated as unitless rather than failing the whole load.
function resolveUnit(unitText) {
  try {
    const spec = resolveUnitExpression(unitText);
    return new Quantity(spec.mul, spec.dim);
  } catch {
    return new Quantity(1, {});
  }
}

function csvResolver(name) {
  const asset = state.assets && state.assets[name];
  if (!asset || typeof asset.text !== 'string') return null;
  const cached = parseCache.get(name);
  if (cached && cached.assetRef === asset) return cached.dataset;
  const dataset = parseCsv(asset.text, asset.config || {}, { resolveUnit });
  parseCache.set(name, { assetRef: asset, dataset });
  return dataset;
}

// Registered once on module load — load_csv is a global hook, not a
// per-evaluation sink.
setCsvResolver(csvResolver);

// Embed a CSV under `name`. Auto-detects the parse config now (the
// attach-time config dialog is a later enhancement); stores
// { text, config } as a fresh object so the resolver cache invalidates.
export function attachCsv(name, text) {
  const config = detectCsvConfig(text);
  if (!state.assets) state.assets = {};
  state.assets[name] = { text, config };
}
