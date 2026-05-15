// Floating context menu plumbing + the long-press helper used to surface it.
//
// The drawer items use this for per-program actions (rename / duplicate /
// export / delete). Long-press on touch, right-click on desktop, or the `⋯`
// button all route through openProgramMenu().

import { epConfirm, epPrompt } from './dialogs.js';
import { readStore, writeStore, currentProgramName, setCurrentProgramName, loadProgramByName, newProgram, isPinned, togglePinned } from './storage.js';
import { saveCurrentAsNewScenario } from './scenarios.js';
import { showMenu } from './menu.js';
// attachLongPress + closeMenu live in menu.js; callers that need them import
// from there directly. ctxmenu.js focuses on the program-specific context
// menus.

export function openProgramMenu(name, x, y, opts = {}) {
  showMenu([
    { label: isPinned(name) ? 'unpin' : 'pin', action: () => togglePinned(name) },
    { label: 'rename',         action: () => renameProgram(name) },
    { label: 'duplicate',      action: () => duplicateProgram(name) },
    { label: 'save scenario…', action: () => {
      if (name !== currentProgramName) loadProgramByName(name);
      window.dispatchEvent(new CustomEvent('ep:close-drawer'));
      setTimeout(() => saveCurrentAsNewScenario(), 0);
    } },
    { label: 'export',         action: () => {
      if (name !== currentProgramName) loadProgramByName(name);
      window.dispatchEvent(new CustomEvent('ep:close-drawer'));
      setTimeout(() => document.getElementById('exportBtn').click(), 0);
    } },
    { separator: true },
    { label: 'delete',         action: () => deleteProgram(name), danger: true },
  ], x, y, opts);
}

async function renameProgram(oldName) {
  const proposed = await epPrompt({
    title: 'Rename program',
    label: 'name',
    value: oldName,
    okLabel: 'Rename',
  });
  if (proposed == null) return;
  const clean = String(proposed).trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!clean || clean === oldName) return;
  const store = readStore();
  if (store[clean]) {
    await epConfirm({
      title: 'Name in use',
      message: `A program named "${clean}" already exists. Choose a different name.`,
      okLabel: 'OK',
    });
    return;
  }
  if (store[oldName]) {
    store[clean] = store[oldName];
    delete store[oldName];
    writeStore(store);
  }
  if (currentProgramName === oldName) setCurrentProgramName(clean);
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
}

function duplicateProgram(name) {
  const store = readStore();
  const src = store[name];
  if (!src) return;
  let candidate = name + '_copy';
  let i = 2;
  while (store[candidate]) candidate = `${name}_copy_${i++}`;
  store[candidate] = { body: src.body.slice(), updatedAt: Date.now() };
  writeStore(store);
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
}

async function deleteProgram(name) {
  const ok = await epConfirm({
    title: 'Delete program?',
    message: `"${name}" will be removed. This can't be undone.`,
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const store = readStore();
  delete store[name];
  writeStore(store);
  if (currentProgramName === name) {
    const remaining = Object.keys(store);
    if (remaining.length) loadProgramByName(remaining[0]);
    else                  newProgram();
  } else {
    window.dispatchEvent(new CustomEvent('ep:storage-changed'));
  }
}

// attachLongPress now lives in menu.js and is re-exported above.
