// Entry point. Boots from storage (or seeds the demo if first-run), runs the
// initial evaluate + render pass, then wires global keyboard shortcuts.

import { evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { applyInitialUI } from './view.js';
import { bootProgramFromStorage, saveCurrentProgram, scheduleAutosave, newProgram } from './storage.js';
import { openDrawer, closeDrawer } from './drawer.js';
import './accessory.js';
import './export.js';
import './io.js';
import './dialogs.js';
import './ctxmenu.js';

const restored = bootProgramFromStorage();
evaluateAll();
renderChips();
renderBody();
renderResults();
applyInitialUI();
if (!restored) {
  saveCurrentProgram({force: true});
} else {
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
}

// ── Keyboard shortcuts (§2.1) ─────────────────────────────────
// Single window-level keydown listener. Only fires for modifier combinations
// (Cmd/Ctrl + key) plus Esc; plain typing keys pass through to inputs.
window.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'n')                { e.preventDefault(); newProgram(); closeDrawer(); return; }
  if (k === 'o')                { e.preventDefault(); document.getElementById('fileInput').click(); return; }
  if (k === 's')                { e.preventDefault(); saveCurrentProgram(); scheduleAutosave(); return; }
  if (k === 'e')                { e.preventDefault(); document.getElementById('exportBtn').click(); return; }
  if (k === 'p' || k === 'k')   { e.preventDefault(); openDrawer({focusSearch: true}); return; }
});
