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
import { pruneSnapshots } from './snapshot-retention.js';
import { idbGetAllPrograms, idbPutProgram, idbDeleteProgram, idbReplaceAllPrograms } from './idb.js';

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

// ── IDB-backed programs store with sync in-memory cache ──────────
// readStore() / writeStore() stay synchronous (call sites unchanged)
// by mirroring the IDB programs object store into an in-memory cache.
// Boot: bootStorage() awaits idbGetAllPrograms() and fills the cache
// once before anything reads. Writes update the cache synchronously
// and schedule async IDB persists in the background.
//
// Settings, draft, and current-program-pointer all stay in localStorage
// (small, sync, often-touched). Only the heavy bits (program bodies +
// snapshots) live in IDB.

const _programCache = new Map();   // name → record
let _storageReady = false;

// Awaitable for the boot path. main.js calls bootStorage() before its
// first defaultBoot() so reads have a populated cache.
export async function bootStorage() {
  if (_storageReady) return;
  try {
    // One-shot localStorage→IDB migration. Only runs while ep:programs
    // is still present in localStorage — once migrated, the LS key is
    // removed so the next boot skips the migration entirely.
    const lsRaw = localStorage.getItem(STORE_KEY);
    if (lsRaw) {
      try {
        const lsStore = JSON.parse(lsRaw) || {};
        const recs = Object.entries(lsStore).map(([name, rec]) => ({ name, ...rec }));
        if (recs.length) await idbReplaceAllPrograms(recs);
        localStorage.removeItem(STORE_KEY);
        console.log('ep: migrated', recs.length, 'programs from localStorage to IDB');
      } catch (e) {
        console.warn('ep: localStorage→IDB migration skipped:', e);
      }
    }
    const recs = await idbGetAllPrograms();
    _programCache.clear();
    for (const r of recs) _programCache.set(r.name, r);
  } catch (e) {
    console.warn('ep: IDB unavailable, programs will not persist:', e);
  }
  _storageReady = true;
}

// Read the entire program store as a plain object {name: record}.
// Synchronous: reads from the in-memory cache. Returns {} before boot.
export function readStore() {
  const out = {};
  for (const [name, rec] of _programCache) {
    // Caller code expects records without the .name field (legacy
    // shape — name was the object key). Strip it before returning.
    const { name: _n, ...rest } = rec;
    out[name] = rest;
  }
  return out;
}

// Replace the entire store (legacy API — callers rebuild the whole
// object and pass it in). Updates the cache + fires-and-forgets the
// IDB writes (rewriting all programs in one transaction).
export function writeStore(store) {
  const records = [];
  for (const [name, rec] of Object.entries(store)) {
    const withName = { name, ...rec };
    _programCache.set(name, withName);
    records.push(withName);
  }
  // Drop programs that were in the cache but aren't in the new store
  // (legacy callers express "delete X" by writing a store without X).
  for (const name of [..._programCache.keys()]) {
    if (!(name in store)) _programCache.delete(name);
  }
  idbReplaceAllPrograms(records).catch(e =>
    console.warn('ep: IDB write failed:', e));
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
        gutterUnits:     state.ui.gutterUnits     || {},
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

// ── Snapshots (§7.4) ─────────────────────────────────────────────
// Per-program version history. Stored inline on each program record
// (programs[name].snapshots = [{id, takenAt, label, pinned, body,
// scenarios, activeScenario, gutterUnits}]). Sorted newest-last.
//
// Triggers:
//   - Manual: takeSnapshot(name, label) via ctxmenu "snapshot now…"
//   - Session-first-load: storage.js takes a silent snapshot when a
//     program is loaded for the first time in the current page session
//   - Pre-restore: restoreSnapshot snapshots current state first so
//     "undo my restore" works
//
// Retention (pruneSnapshots): keep ALL from last 24h; keep last 20
// older than that; pinned + labeled snapshots never auto-purge.
//
// Backend: localStorage for now. SPEC §7.4 calls out the IDB migration
// trigger; quota concern doesn't bite at realistic snapshot counts
// (10 programs × 10 snaps × 1KB ≈ 100KB, well under 5MB localStorage).

// In-memory set of program names already auto-snapshotted this session.
// Resets on page reload, which is intentional — we want one auto-snap
// per page-load, not per program-switch.
const _autoSnappedThisSession = new Set();

function snapId() {
  return 'snap_' + Math.random().toString(36).slice(2, 8) + '_' + Date.now().toString(36);
}

// Capture the program's CURRENT in-store state (not state.body — which
// might be ahead of the last autosave). `label` is null for auto snaps.
export function takeSnapshot(name, label = null) {
  const store = readStore();
  const prog = store[name];
  if (!prog) return null;
  prog.snapshots = prog.snapshots || [];
  const snap = {
    id: snapId(),
    takenAt: Date.now(),
    label: label || null,
    pinned: !!label,                  // labeled snapshots auto-pin
    body: (prog.body || []).slice(),
    scenarios: JSON.parse(JSON.stringify(prog.scenarios || {})),
    activeScenario: prog.activeScenario || null,
    gutterUnits: JSON.parse(JSON.stringify(prog.gutterUnits || {})),
  };
  prog.snapshots.push(snap);
  prog.snapshots = pruneSnapshots(prog.snapshots);
  writeStore(store);
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
  return snap.id;
}

export function listSnapshots(name) {
  const store = readStore();
  const prog = store[name];
  if (!prog) return [];
  return (prog.snapshots || []).slice().sort((a, b) => b.takenAt - a.takenAt);
}

export function pinSnapshot(name, id, pinned) {
  const store = readStore();
  const prog = store[name];
  if (!prog || !prog.snapshots) return;
  const snap = prog.snapshots.find(s => s.id === id);
  if (!snap) return;
  snap.pinned = !!pinned;
  writeStore(store);
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
}

export function deleteSnapshot(name, id) {
  const store = readStore();
  const prog = store[name];
  if (!prog || !prog.snapshots) return;
  prog.snapshots = prog.snapshots.filter(s => s.id !== id);
  writeStore(store);
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
}

// Restore: snapshot current state first (so the restore is undoable),
// then replace the program record's body + scenarios + gutterUnits
// with the snapshot's. If the restored program is the current one,
// reload its body into the editor too.
export function restoreSnapshot(name, id) {
  const store = readStore();
  const prog = store[name];
  if (!prog || !prog.snapshots) return false;
  const snap = prog.snapshots.find(s => s.id === id);
  if (!snap) return false;
  // Pre-restore auto-snapshot, labeled so it's pinned automatically.
  takeSnapshot(name, 'before restore');
  // Re-read (takeSnapshot just wrote) and apply the restore.
  const store2 = readStore();
  const prog2 = store2[name];
  prog2.body = snap.body.slice();
  prog2.scenarios = JSON.parse(JSON.stringify(snap.scenarios || {}));
  prog2.activeScenario = snap.activeScenario || null;
  prog2.gutterUnits = JSON.parse(JSON.stringify(snap.gutterUnits || {}));
  prog2.updatedAt = Date.now();
  writeStore(store2);
  // If we restored the live program, reload it into the editor.
  if (name === currentProgramName) loadProgramByName(name);
  else window.dispatchEvent(new CustomEvent('ep:storage-changed'));
  return true;
}

// pruneSnapshots lives in snapshot-retention.js so it can be unit-tested
// from Node without dragging storage.js's DOM-touching imports. Imported
// at the top of this file; not re-exported (callers import direct).

// Called from loadProgramByName / bootProgramFromStorage to take one
// silent snapshot per program per page session. No-op if a snap was
// already taken this session, or if the program has no body to snapshot.
export function maybeAutoSnapshot(name) {
  if (_autoSnappedThisSession.has(name)) return;
  _autoSnappedThisSession.add(name);
  const store = readStore();
  const prog = store[name];
  if (!prog || !(prog.body || []).length) return;
  takeSnapshot(name, null);   // unlabeled = auto
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
    gutterUnits: state.ui.gutterUnits || {},
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
  state.ui.gutterUnits     = prog.gutterUnits || {};
  state._ephemeral         = false;
  setCurrentProgramName(name);
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  applyEphemeralUI();
  maybeAutoSnapshot(name);
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
  '@input',
  'x = 1',
  '',
  '@output',
  'y = x * 2',
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
      state.ui.gutterUnits     = draft.ui.gutterUnits     || {};
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
    state.ui.gutterUnits     = prog.gutterUnits || {};
    state._ephemeral         = false;
    setCurrentProgramName(stored, false);
    maybeAutoSnapshot(stored);
    return true;
  }
  setCurrentProgramName('ore_body', false);
  return false;
}
