// Entry point for the viewer build. The viewer artifact is a purpose-built
// HTML file produced by ep's `.html` export — it loads one program and
// presents its chips + computed outputs, with no editor / drawer / export
// machinery. State arrives baked into INITIAL_STATE via the same STATE
// markers ep uses for self-cloning.

import { evaluateAll } from './state.js';
import { renderChips, renderResults } from './render.js';

evaluateAll();
renderChips();
renderResults();

// Header filename comes from the exported program's name. INITIAL_STATE.name
// is set by export.js when serializing the viewer artifact.
const hdrFileEl = document.getElementById('hdrFile');
if (hdrFileEl && typeof INITIAL_STATE !== 'undefined' && INITIAL_STATE.name) {
  hdrFileEl.textContent = INITIAL_STATE.name;
  document.title = `${INITIAL_STATE.name} — ep`;
}
