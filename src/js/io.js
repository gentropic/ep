// Load / Import — file picker (driven from the drawer) and drag-and-drop.
// Both feed loadProgramText, which replaces state.body, evaluates, renders,
// and creates a fresh autosaved storage slot named from the filename.

import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { setCurrentProgramName, uniqueProgramName, saveCurrentProgram } from './storage.js';
import { attachCsv } from './csv-assets.js';

const fileInput   = document.getElementById('fileInput');
const dropOverlay = document.getElementById('dropOverlay');

export function loadProgramText(text, sourceName, opts = {}) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  state.body = lines.map(src => ({src}));
  state.ui.collapsedBlocks = [];
  // A .ep file is plain source — it carries no data assets. Drop any
  // assets from the program being replaced.
  state.assets = {};
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  if (sourceName && !opts.fromStorage) {
    const baseName = sourceName.replace(/\.[^.]+$/, '') || sourceName;
    const uniqueName = uniqueProgramName(baseName);
    setCurrentProgramName(uniqueName);
    saveCurrentProgram({force: true});
  }
}

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    loadProgramText(text, file.name);
  } catch (err) {
    console.error('Failed to read file:', err);
  } finally {
    fileInput.value = '';
  }
});

// Drag-and-drop on the whole window
let dragDepth = 0;
function hasFiles(e) {
  if (!e.dataTransfer) return false;
  const types = e.dataTransfer.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
}
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add('on');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.classList.remove('on');
  }
});
// Attach a dropped CSV as an embedded data asset (Phase 1 datasets).
// The asset name is the filename minus `.csv`; a `load_csv(...)` binding
// is appended to the program if one doesn't already reference it, so
// the drop produces something visible the user can immediately compute
// against.
function attachCsvFile(filename, text) {
  const assetName = (filename.replace(/\.csv$/i, '').trim() || 'data').replace(/"/g, '');
  attachCsv(assetName, text);
  const ref = `load_csv("${assetName}")`;
  if (!state.body.some(r => r.src.includes(ref))) {
    // Binding name: a valid identifier derived from the asset name.
    const bindName = assetName.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'data';
    if (state.body.length && state.body[state.body.length - 1].src.trim() !== '') {
      state.body.push({ src: '' });
    }
    state.body.push({ src: `${bindName} = ${ref}` });
  }
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  // Persist the new asset + body line — a programmatic state.body change
  // doesn't go through CM6's update listener, so autosave needs a nudge.
  window.dispatchEvent(new CustomEvent('ep:params-changed'));
}

// Registered in the CAPTURE phase: a file drop reaches `window` before
// it descends to the CodeMirror editor. stopPropagation() then keeps
// CM6's own drop handler from also firing — otherwise CM6 would insert
// the dropped file's raw text into the body (a CSV would dump all its
// rows into the editor). Non-file drags (text selection drag inside
// the editor) pass straight through.
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  dragDepth = 0;
  dropOverlay.classList.remove('on');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  // A dropped .csv attaches as a data asset rather than replacing the
  // program.
  if (/\.csv$/i.test(file.name || '')) {
    try {
      attachCsvFile(file.name, await file.text());
    } catch (err) {
      console.error('Failed to read dropped CSV:', err);
    }
    return;
  }
  if (file.name && !/\.(ep|txt)$/i.test(file.name) && !file.type.startsWith('text/')) {
    console.warn('File extension is not .ep — attempting to load anyway');
  }
  try {
    const text = await file.text();
    loadProgramText(text, file.name);
  } catch (err) {
    console.error('Failed to read dropped file:', err);
  }
}, true);   // capture phase — intercept before CM6's editor drop handler
