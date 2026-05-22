// Load / Import — file picker (driven from the drawer) and drag-and-drop.
// Both feed loadProgramText, which replaces state.body, evaluates, renders,
// and creates a fresh autosaved storage slot named from the filename.

import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { setCurrentProgramName, uniqueProgramName, saveCurrentProgram } from './storage.js';
import { attachFromText } from './attach-dialog.js';

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
  // A dropped .csv opens the attach dialog (preview + parse config)
  // rather than replacing the program.
  if (/\.csv$/i.test(file.name || '')) {
    try {
      const text = await file.text();
      attachFromText(text, file.name.replace(/\.csv$/i, '').trim() || 'data');
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
