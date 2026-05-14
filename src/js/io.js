// Load / Import — file picker and drag-and-drop. Both feed loadProgramText.

import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';

const openBtn      = document.getElementById('openBtn');
const fileInput    = document.getElementById('fileInput');
const dropOverlay  = document.getElementById('dropOverlay');
const fileNameEl   = document.querySelector('.hdr-left .file');

export function loadProgramText(text, sourceName) {
  // Replace body with the parsed lines; preserve UI state (collapsed panels, etc.)
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // Trim trailing empty lines for cleanliness but keep one for new-row affordance
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  state.body = lines.map(src => ({src}));
  state.ui.collapsedBlocks = [];   // discard prior collapse state — references would be stale
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  if (sourceName) {
    // Strip extension for header display
    const baseName = sourceName.replace(/\.[^.]+$/, '');
    if (fileNameEl) fileNameEl.textContent = baseName || sourceName;
  }
}

openBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    loadProgramText(text, file.name);
  } catch (err) {
    console.error('Failed to read file:', err);
  } finally {
    // Reset so selecting the same file again still fires change
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
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove('on');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  // Accept .ep, .txt, or any text/plain; warn on obvious mismatches
  if (file.name && !/\.(ep|txt)$/i.test(file.name) && !file.type.startsWith('text/')) {
    console.warn('File extension is not .ep — attempting to load anyway');
  }
  try {
    const text = await file.text();
    loadProgramText(text, file.name);
  } catch (err) {
    console.error('Failed to read dropped file:', err);
  }
});
