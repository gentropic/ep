// Program persistence and autosave.
//
// Schema:
//   localStorage["ep:programs"] = { [name]: {
//     body: string[],
//     updatedAt: ms,
//     scenarios?: { [scenarioName]: { [paramName]: valueSrc } },
//     activeScenario?: string,
//   } }
//   localStorage["ep:current"]  = name
//   localStorage["ep:draft"]    = {                          // optional
//     name: string,                                          // intended slug if saved
//     body: string[],
//     ui:   { scenarios, activeScenario, collapsedBlocks },
//     ts:   ms,
//   }
// The draft slot holds the current ephemeral program (example load or
// "+ new program" that hasn't been explicitly saved). It survives reload
// so the user doesn't lose work, but never appears in the saved-programs
// list — that only happens when the user explicitly commits.
//
// readStore() and writeStore() are the only two functions to swap if the
// backend moves to a future VFS abstraction; the schema can stay the same.

import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';

const STORE_KEY    = 'ep:programs';
const CURRENT_KEY  = 'ep:current';
const DRAFT_KEY    = 'ep:draft';
const SETTINGS_KEY = 'ep:settings';

export let currentProgramName = 'ore_body';
let saveStatusTimer = null;
let autosaveTimer   = null;

const hdrFileEl       = document.getElementById('hdrFile');
const saveStatusEl    = document.getElementById('saveStatus');
const saveEphemeralBtn = document.getElementById('saveEphemeralBtn');

// Updates the header UI to reflect whether the current program is ephemeral
// (not yet committed to storage). Shows an amber "save" button + a dot on
// the filename when ephemeral.
export function applyEphemeralUI() {
  if (hdrFileEl) hdrFileEl.classList.toggle('ephemeral', !!state._ephemeral);
  if (saveEphemeralBtn) saveEphemeralBtn.style.display = state._ephemeral ? '' : 'none';
}

if (saveEphemeralBtn) {
  saveEphemeralBtn.addEventListener('click', () => saveCurrentProgram());
}

// render.js fires ep:params-changed after any chip / body edit. We listen
// here (rather than have render.js call scheduleAutosave directly) so
// render.js stays decoupled from storage — the viewer can reuse render.js
// without pulling in the autosave / drawer / persistence layer.
window.addEventListener('ep:params-changed', () => scheduleAutosave());

export function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function writeStore(store) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
  catch (e) { console.warn('localStorage write failed:', e); }
}

// Draft persistence for ephemeral state — the user's in-flight unsaved
// program. Cleared on explicit save or switch to a saved program.
export function writeDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      name: currentProgramName,
      body: state.body.map(r => r.src),
      ui:   {
        scenarios:       state.ui.scenarios       || {},
        activeScenario:  state.ui.activeScenario  || null,
        collapsedBlocks: state.ui.collapsedBlocks || [],
      },
      ts: Date.now(),
    }));
  } catch (e) { console.warn('localStorage write (draft) failed:', e); }
}

export function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// User-level settings, distinct from per-program state. Stored as
// localStorage["ep:settings"] = { sort, … }. Lives next to the programs
// store; small enough that we just read+write the whole blob each time.
export function getSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed[key] === undefined ? fallback : parsed[key];
  } catch { return fallback; }
}

export function setSetting(key, value) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    parsed[key] = value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed));
  } catch (e) { console.warn('localStorage write (settings) failed:', e); }
}

// Pin / unpin a program — drawer renders pinned programs first regardless
// of the current sort order. Flag lives on the per-program record.
export function isPinned(name) {
  const store = readStore();
  return !!(store[name] && store[name].pinned);
}

export function togglePinned(name) {
  const store = readStore();
  if (!store[name]) return;
  store[name].pinned = !store[name].pinned;
  writeStore(store);
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
}

export function uniqueProgramName(base) {
  const store = readStore();
  if (!store[base]) return base;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${base}_${i}`;
    if (!store[candidate]) return candidate;
  }
  return base + '_' + Date.now();
}

export function setCurrentProgramName(name, persist = true) {
  currentProgramName = name;
  if (hdrFileEl) hdrFileEl.textContent = name;
  if (persist) {
    try { localStorage.setItem(CURRENT_KEY, name); } catch {}
  }
}

export function showSaveStatus(status) {
  if (!saveStatusEl) return;
  saveStatusEl.classList.remove('saving', 'saved');
  if (status === 'saving')      { saveStatusEl.textContent = 'saving'; saveStatusEl.classList.add('saving'); }
  else if (status === 'saved')  { saveStatusEl.textContent = 'saved';  saveStatusEl.classList.add('saved'); }
  else                          { saveStatusEl.textContent = ''; }
}

export function scheduleAutosave() {
  if (state._ephemeral) {
    // Ephemeral programs don't enter the saved list but DO persist to a
    // draft slot so the user's work survives reloads. The header save button
    // (or Cmd+S) commits the draft to a real saved program.
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => writeDraft(), 400);
    return;
  }
  showSaveStatus('saving');
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveCurrentProgram(), 400);
}

export function saveCurrentProgram(opts = {}) {
  const store = readStore();
  // Merge: preserve fields that aren't part of state (e.g. `pinned`) so
  // autosave doesn't strip them.
  const prior = store[currentProgramName] || {};
  store[currentProgramName] = {
    ...prior,
    body: state.body.map(r => r.src),
    updatedAt: Date.now(),
    scenarios: state.ui.scenarios || {},
    activeScenario: state.ui.activeScenario || null,
  };
  writeStore(store);
  // Keep ep:current in sync — covers the case where an ephemeral example
  // load (which doesn't persist the name) gets promoted to a real saved
  // program by the user's first explicit save.
  try { localStorage.setItem(CURRENT_KEY, currentProgramName); } catch {}
  // Explicit save commits the program — no longer ephemeral.
  state._ephemeral = false;
  applyEphemeralUI();
  // The draft, if any, has been promoted to a real saved record.
  clearDraft();
  showSaveStatus('saved');
  if (saveStatusTimer) clearTimeout(saveStatusTimer);
  saveStatusTimer = setTimeout(() => showSaveStatus(''), 1500);
  if (opts.force) {
    // Force a drawer rerender so newly-created programs appear immediately.
    // Listeners hook into this event rather than us importing the drawer.
    window.dispatchEvent(new CustomEvent('ep:storage-changed'));
  }
}

export function loadProgramByName(name) {
  const store = readStore();
  const prog = store[name];
  if (!prog) return false;
  // Switching to a saved program discards any in-flight ephemeral draft.
  clearDraft();
  state.body = (prog.body || []).map(src => ({src}));
  state.ui.collapsedBlocks = [];
  state.ui.scenarios       = prog.scenarios || {};
  state.ui.activeScenario  = prog.activeScenario || null;
  state._ephemeral         = false;
  setCurrentProgramName(name);
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  applyEphemeralUI();
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
  return true;
}

// Default body used when no user-customised newFileTemplate is stored.
// Mirrored in settings.js (DEFAULT_NEW_FILE_TEMPLATE) — change one, change
// the other. Kept here as an array so we don't import settings.js (which
// would create a cycle: settings → storage → render → … → settings).
const DEFAULT_NEW_PROGRAM_BODY = [
  '# new program',
  '',
  '@params {',
  '  x = 1',
  '}',
  '',
  'y = x * 2',
  '',
  '@outputs { y }',
];

export function newProgram() {
  const name = uniqueProgramName('untitled');
  const useTemplate = getSetting('useTemplate', true);
  let lines;
  if (!useTemplate) {
    lines = [''];                                 // blank slate
  } else {
    const tmpl = getSetting('newFileTemplate', '');
    lines = tmpl ? tmpl.split('\n') : DEFAULT_NEW_PROGRAM_BODY;
  }
  state.body = lines.map(src => ({src}));
  state.ui.collapsedBlocks = [];
  state.ui.scenarios       = {};
  state.ui.activeScenario  = null;
  state._ephemeral         = true;     // ephemeral until first explicit save
  setCurrentProgramName(name, false);
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  applyEphemeralUI();
  writeDraft();
}

// First non-blank `#` or `--` comment line — used as program description in
// the drawer item. Strips the leading marker for display.
export function programDescription(bodyLines) {
  for (const line of bodyLines || []) {
    const t = (line || '').trim();
    if (!t) continue;
    if (t.startsWith('#'))  return t.replace(/^#+\s*/, '').trim();
    if (t.startsWith('--')) return t.replace(/^--+\s*/, '').trim();
    return null;  // first non-blank line isn't a comment
  }
  return null;
}

export function formatAgo(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60_000)        return 'just now';
  if (d < 3_600_000)     return Math.floor(d /     60_000) + 'm ago';
  if (d < 86_400_000)    return Math.floor(d /  3_600_000) + 'h ago';
  return Math.floor(d / 86_400_000) + 'd ago';
}

// Boot: restore the previously-current program if it's in storage. Returns
// `true` if we restored something, `false` if nothing was found (in which
// case main.js seeds the demo program).
export function bootProgramFromStorage() {
  // Draft takes precedence — the user was mid-edit on an ephemeral program,
  // so coming back should restore that state (still ephemeral, still not in
  // the saved list).
  const draft = readDraft();
  if (draft && Array.isArray(draft.body)) {
    state.body = draft.body.map(src => ({src}));
    if (draft.ui) {
      state.ui.scenarios       = draft.ui.scenarios       || {};
      state.ui.activeScenario  = draft.ui.activeScenario  || null;
      state.ui.collapsedBlocks = draft.ui.collapsedBlocks || [];
    }
    state._ephemeral = true;
    setCurrentProgramName(draft.name || 'untitled', false);
    return true;
  }

  let stored = null;
  try { stored = localStorage.getItem(CURRENT_KEY); } catch {}
  const store = readStore();
  if (stored && store[stored]) {
    const prog = store[stored];
    state.body = (prog.body || []).map(src => ({src}));
    state.ui.collapsedBlocks = [];
    state.ui.scenarios       = prog.scenarios || {};
    state.ui.activeScenario  = prog.activeScenario || null;
    state._ephemeral         = false;
    setCurrentProgramName(stored, false);
    return true;
  }
  setCurrentProgramName('ore_body', false);
  return false;
}
