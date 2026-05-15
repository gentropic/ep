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
//
// readStore() and writeStore() are the only two functions to swap if the
// backend moves to a future VFS abstraction; the schema can stay the same.

import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';

const STORE_KEY   = 'ep:programs';
const CURRENT_KEY = 'ep:current';

export let currentProgramName = 'ore_body';
let saveStatusTimer = null;
let autosaveTimer   = null;

const hdrFileEl    = document.getElementById('hdrFile');
const saveStatusEl = document.getElementById('saveStatus');

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
  showSaveStatus('saving');
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveCurrentProgram(), 400);
}

export function saveCurrentProgram(opts = {}) {
  const store = readStore();
  store[currentProgramName] = {
    body: state.body.map(r => r.src),
    updatedAt: Date.now(),
    scenarios: state.ui.scenarios || {},
    activeScenario: state.ui.activeScenario || null,
  };
  writeStore(store);
  // Keep ep:current in sync — covers the case where an ephemeral example
  // load (which doesn't persist the name) gets promoted to a real saved
  // program by the user's first edit.
  try { localStorage.setItem(CURRENT_KEY, currentProgramName); } catch {}
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
  state.body = (prog.body || []).map(src => ({src}));
  state.ui.collapsedBlocks = [];
  state.ui.scenarios       = prog.scenarios || {};
  state.ui.activeScenario  = prog.activeScenario || null;
  setCurrentProgramName(name);
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
  return true;
}

export function newProgram() {
  const name = uniqueProgramName('untitled');
  state.body = [
    {src: '# new program'},
    {src: ''},
    {src: '@params {'},
    {src: '  x = 1'},
    {src: '}'},
    {src: ''},
    {src: 'y = x * 2'},
    {src: ''},
    {src: '@outputs { y }'},
  ];
  state.ui.collapsedBlocks = [];
  state.ui.scenarios       = {};
  state.ui.activeScenario  = null;
  setCurrentProgramName(name);
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  saveCurrentProgram({force: true});
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
  let stored = null;
  try { stored = localStorage.getItem(CURRENT_KEY); } catch {}
  const store = readStore();
  if (stored && store[stored]) {
    const prog = store[stored];
    state.body = (prog.body || []).map(src => ({src}));
    state.ui.collapsedBlocks = [];
    state.ui.scenarios       = prog.scenarios || {};
    state.ui.activeScenario  = prog.activeScenario || null;
    setCurrentProgramName(stored, false);
    return true;
  }
  setCurrentProgramName('ore_body', false);
  return false;
}
