// Thin UI wrapper around the pure formatter — formats the program
// currently in state.body and pushes the result back through the
// standard re-evaluate + re-render pipeline. Lives separately from
// formatter.js so the pure formatter stays importable from Node tests
// (without dragging state.js / render.js — which reach for DOM globals
// — into the test runtime).

import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { formatEpBody } from './formatter.js';
import { getSetting } from './storage.js';

export function formatCurrentProgram() {
  const current = state.body.map(r => r.src).join('\n');
  const width = getSetting('formatWidth', 40);
  const formatted = formatEpBody(current, { width });
  if (formatted === current || formatted === current + '\n') return;
  const lines = formatted.replace(/\n$/, '').split('\n');
  state.body = lines.map(src => ({src}));
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  // Storage's autosave listener picks this up.
  window.dispatchEvent(new CustomEvent('ep:params-changed'));
}
