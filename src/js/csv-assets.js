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

// Adapter for parseCsv's resolveUnit hook — turns a header unit string
// into a Quantity (value = multiplier, dim). parseCsv inspects the dim
// to decide whether to apply the unit (dimensioned) or treat it as
// documentation (dimensionless ratio). An unresolvable unit reads as
// dimensionless, so the column stays a plain-number column.
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

// Embed a CSV under `name` with a parse config. The attach dialog
// produces the config (delimiter, decimal, per-column overrides, …);
// callers without one fall back to auto-detection. Stored as a fresh
// { text, config } object so the resolver's identity cache invalidates.
export function attachCsv(name, text, config) {
  if (!state.assets) state.assets = {};
  state.assets[name] = { text, config: config || detectCsvConfig(text) };
}

// Parse for the attach dialog's live preview. Shares the resolveUnit
// adapter — and thus the exact parse path — with the load_csv resolver,
// so the preview matches what the program will actually see.
export function parseCsvPreview(text, config) {
  return parseCsv(text, config || {}, { resolveUnit });
}

// Remove an attached CSV (assets-list "remove").
export function removeAsset(name) {
  if (state.assets) delete state.assets[name];
  parseCache.delete(name);
}

// Move an attached CSV's record to a new name. Does NOT rewrite the
// program's `load_csv("old")` calls — the caller handles that.
export function renameAsset(oldName, newName) {
  if (!state.assets || !state.assets[oldName]) return false;
  if (oldName === newName || state.assets[newName]) return false;
  state.assets[newName] = state.assets[oldName];
  delete state.assets[oldName];
  parseCache.delete(oldName);
  parseCache.delete(newName);
  return true;
}

// The resolved (cached) Dataset for an attached CSV, or null — the full
// columnar table. Used by the dataset viewer.
export function getDataset(name) {
  return csvResolver(name);
}

// Summary for the assets list — row count, column count, byte size.
// Goes through the cached resolver, so it's free after the first parse.
export function assetInfo(name) {
  const a = state.assets && state.assets[name];
  if (!a) return null;
  let rows = 0, cols = 0;
  try {
    const ds = csvResolver(name);
    if (ds) { rows = ds.length; cols = ds.columns.size; }
  } catch { /* parse failure — report zeroes */ }
  return { rows, cols, bytes: (a.text || '').length };
}
