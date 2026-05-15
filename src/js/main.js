// Entry point. Boots from storage (or adopts a shared program from ?p=, or
// seeds the demo if first-run), runs the initial evaluate + render pass, then
// wires global keyboard shortcuts.

import { evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { applyInitialUI } from './view.js';
import { bootProgramFromStorage, saveCurrentProgram, scheduleAutosave, newProgram } from './storage.js';
import { openDrawer, closeDrawer } from './drawer.js';
import { hasShareParam, consumeShareParam, adoptSharedProgram } from './share.js';
import './accessory.js';
import './export.js';
import './io.js';
import './dialogs.js';
import './ctxmenu.js';

function defaultBoot() {
  const restored = bootProgramFromStorage();
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  if (!restored) {
    saveCurrentProgram({force: true});
  } else {
    window.dispatchEvent(new CustomEvent('ep:storage-changed'));
  }
}

if (hasShareParam()) {
  // Async branch: decode the shared program before running the rest of boot.
  // Defaults to the normal boot if decode fails.
  consumeShareParam().then(text => {
    if (text) adoptSharedProgram(text);
    else      defaultBoot();
    applyInitialUI();
  });
} else {
  defaultBoot();
  applyInitialUI();
}

// ── Keyboard shortcuts (§2.1) ─────────────────────────────────
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
