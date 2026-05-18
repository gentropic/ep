// Program state singleton + evaluateAll(): runs the pure evaluator and
// reconciles the result into `state`, preserving body-row and param object
// identity so the renderer's DOM references stay valid across re-evaluations.
//
// INITIAL_STATE is a free global, defined by the host HTML between STATE markers.

import { evaluate } from './evaluator.js';

export const state = JSON.parse(JSON.stringify(INITIAL_STATE));
state.params = [];   // bindings tagged with @input (or @options) decorators
state.outputs = [];  // bindings tagged with @output decorators
state._scope = {};
state._lastFocused = null;                       // last focused chip/row input (for accessory bar)
state.ui.collapsedBlocks = state.ui.collapsedBlocks || [];  // array of open bodyIdx (persistable)
state.ui.scenarios       = state.ui.scenarios || {};        // { scenarioName: { paramName: valueSrc } }
state.ui.activeScenario  = state.ui.activeScenario || null; // last-applied scenario name, or null
state.ui.gutterUnits     = state.ui.gutterUnits || {};      // { bindingName: unitName } — per-binding gutter display override (click the gutter to set)

// state._ephemeral: when true, autosave is disabled and the program isn't
// persisted to localStorage until the user explicitly saves (Cmd+S or the
// header save button). Set by example loads and "+ new program"; cleared by
// any explicit save. Not under state.ui because it shouldn't round-trip
// through .html / URL exports.
state._ephemeral = false;

export function evaluateAll() {
  const oldByName = new Map(state.params.map(p => [p.name, p]));
  const r = evaluate(state.body);

  // Reconcile body rows in place — the renderer holds direct refs (_resEl, _rowEl) on them.
  for (let i = 0; i < state.body.length; i++) {
    const dest = state.body[i];
    const src  = r.rows[i];
    dest.kind     = src.kind;
    dest.name     = src.name;
    dest.result   = src.result;
    dest.error    = src.error;
    dest.suspect  = src.suspect;
    dest.print    = src.print;
    dest.outputs  = src.outputs;
    dest.inParams = src.inParams;
  }

  // Reconcile params: reuse prior objects by name so chip-side data carriers are stable.
  const newParams = r.params.map(p => {
    const reused = oldByName.get(p.name);
    if (reused) {
      reused.valueSrc = p.valueSrc;
      reused.anno     = p.anno;
      reused.options  = p.options;
      reused.bodyIdx  = p.bodyIdx;
      reused.result   = p.result;
      reused.error    = p.error;
      return reused;
    }
    return p;
  });

  // Track structural change for chip rebuild decisions (currently informational).
  const oldNames = state.params.map(p => p.name);
  const newNames = newParams.map(p => p.name);
  state._paramsStructureChanged =
    newNames.length !== oldNames.length ||
    newNames.some((n, i) => n !== oldNames[i]);

  state.params         = newParams;
  state.outputs        = r.outputs;
  state._scope         = r.scope;
}
