// Export dialog: package the current program as .ep source or self-cloning .html.
// The .html path reads its own outerHTML and swaps the INITIAL_STATE block via
// the STATE markers — preserving this contract is critical to the round-trip.

import { state } from './state.js';
import { currentProgramName } from './storage.js';

const scrim         = document.getElementById('scrim');
const exportBtn     = document.getElementById('exportBtn');
const cancelBtn     = document.getElementById('cancelBtn');
const dlEpBtn       = document.getElementById('dlEpBtn');
const dlHtmlBtn     = document.getElementById('dlHtmlBtn');
const copySrcBtn    = document.getElementById('copySrcBtn');
const exportSrcEl   = document.getElementById('exportSrc');
const exportNameEl  = document.getElementById('exportName');

export function serializeProgram() {
  return state.body.map(r => r.src).join('\n');
}

exportBtn.addEventListener('click', () => {
  exportSrcEl.textContent = serializeProgram();
  exportNameEl.value = currentProgramName || 'program';
  scrim.classList.add('on');
});
cancelBtn.addEventListener('click', () => scrim.classList.remove('on'));
scrim.addEventListener('click', e => { if (e.target === scrim) scrim.classList.remove('on'); });

dlEpBtn.addEventListener('click', () => {
  const text = serializeProgram();
  const name = (exportNameEl.value || 'program') + '.ep';
  downloadFile(text, name, 'text/plain');
  scrim.classList.remove('on');
});

dlHtmlBtn.addEventListener('click', () => {
  const html = document.documentElement.outerHTML;
  const newState = {
    body: state.body.map(r => ({src: r.src})),
    ui:   {...state.ui, formView: true, showSource: false},
  };
  const stateJs = 'const INITIAL_STATE = ' + JSON.stringify(newState, null, 2) + ';';
  const newHtml = html.replace(
    /\/\* MARKER:STATE_START \*\/[\s\S]*?\/\* MARKER:STATE_END \*\//,
    `/* MARKER:STATE_START */\n${stateJs}\n/* MARKER:STATE_END */`
  );
  const name = (exportNameEl.value || 'program') + '.html';
  downloadFile('<!DOCTYPE html>\n' + newHtml, name, 'text/html');
  scrim.classList.remove('on');
});

copySrcBtn.addEventListener('click', async () => {
  const text = serializeProgram();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    const prev = copySrcBtn.textContent;
    copySrcBtn.textContent = 'copied';
    setTimeout(() => { copySrcBtn.textContent = prev; }, 1200);
  } catch {
    const prev = copySrcBtn.textContent;
    copySrcBtn.textContent = 'err';
    setTimeout(() => { copySrcBtn.textContent = prev; }, 1200);
  }
});

function downloadFile(text, name, type) {
  const blob = new Blob([text], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
