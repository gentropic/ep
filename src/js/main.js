// Entry point. Wires the modules that have setup-on-load side effects, then
// runs the initial evaluation and render pass.

import { evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { applyInitialUI } from './view.js';
import './accessory.js';
import './export.js';
import './io.js';

evaluateAll();
renderChips();
renderBody();
renderResults();
applyInitialUI();
