// Entry point. Boots from storage (or adopts a shared program from ?p=, or
// seeds the demo if first-run), runs the initial evaluate + render pass, then
// wires global keyboard shortcuts.

import { evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { applyInitialUI } from './view.js';
import { bootStorage, bootProgramFromStorage, saveCurrentProgram, scheduleAutosave, newProgram, applyEphemeralUI } from './storage.js';
import { openDrawer, closeDrawer } from './drawer.js';
import { hasShareParam, consumeShareParam, adoptSharedProgram } from './share.js';
import { startTutorial, isTutorialDone } from './tutorial.js';
import { renderScenariosStrip } from './scenarios.js';
import './accessory.js';
import './export.js';
import './io.js';
import './dialogs.js';
import './ctxmenu.js';
import { applySettings } from './settings.js';
import { formatCurrentProgram } from './format-cmd.js';
import './gcu-announce.js';

function defaultBoot() {
  // Apply user settings BEFORE the first evaluate/render so sig digits
  // reflect the user's preference on the very first paint.
  applySettings();
  const restored = bootProgramFromStorage();
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  renderScenariosStrip();
  applyEphemeralUI();
  if (!restored) {
    saveCurrentProgram({force: true});
  } else {
    window.dispatchEvent(new CustomEvent('ep:storage-changed'));
  }
}

function maybeStartTutorial() {
  // Don't run the tutorial when arriving via a share URL — the user is
  // looking at someone else's calc, not exploring ep fresh.
  if (hasShareParam()) return;
  if (isTutorialDone()) return;
  setTimeout(startTutorial, 400);  // let the initial render settle
}

// Service worker registration — minimal stub, see sw.js for rationale.
// Registers from the page's path so a deploy at /ep/ uses /ep/sw.js. The
// .catch swallows the failure when ep is opened via file:// (no SW
// support) or from a host that doesn't serve sw.js.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// IDB load is async — wait for the cache to fill before any sync read
// of the programs store (drawer render, defaultBoot, etc.). Share-link
// adoption stays after the storage boot so the shared program ends up
// in the same store as everything else.
bootStorage().then(async () => {
  if (hasShareParam()) {
    const text = await consumeShareParam();
    if (text) adoptSharedProgram(text);
    else      defaultBoot();
  } else {
    defaultBoot();
  }
  applyInitialUI();
  maybeStartTutorial();
});

// ── Keyboard shortcuts (§2.1) ─────────────────────────────────
window.addEventListener('keydown', e => {
  // Shift+Alt+F is the Prettier convention — alt instead of mod so it
  // doesn't fight Cmd/Ctrl-bound editor shortcuts.
  if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    formatCurrentProgram();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'n')                { e.preventDefault(); newProgram(); closeDrawer(); return; }
  if (k === 'o')                { e.preventDefault(); document.getElementById('fileInput').click(); return; }
  if (k === 's')                { e.preventDefault(); saveCurrentProgram(); return; }
  if (k === 'e')                { e.preventDefault(); document.getElementById('exportBtn').click(); return; }
  if (k === 'p' || k === 'k')   { e.preventDefault(); openDrawer({focusSearch: true}); return; }
});
