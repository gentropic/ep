// Examples panel — full-screen slide-in opened from the drawer's
// "examples" entry. Replaced the old inline drawer list (which always
// occupied vertical space) with an on-demand sub-page; structurally
// reuses settings-panel CSS for visual consistency.
//
// Tap an example → load it via examples.js and dismiss both panels.

import { getExamples, loadExample } from './examples.js';

const epPanel    = document.getElementById('examplesPanel');
const epOpenBtn  = document.getElementById('openExamplesBtn');
const epBackBtn  = document.getElementById('examplesBackBtn');
const epListEl   = document.getElementById('examplesList');

export function openExamples() {
  if (!epPanel) return;
  renderExamplesList();
  epPanel.classList.add('on');
  epPanel.setAttribute('aria-hidden', 'false');
}

export function closeExamples() {
  if (!epPanel) return;
  epPanel.classList.remove('on');
  epPanel.setAttribute('aria-hidden', 'true');
}

function renderExamplesList() {
  if (!epListEl) return;
  epListEl.innerHTML = '';
  for (const ex of getExamples()) {
    const row = document.createElement('div');
    row.className = 'settings-row examples-row';
    row.style.cursor = 'pointer';
    const info = document.createElement('div');
    info.className = 'settings-row-label';
    const nameEl = document.createElement('div');
    nameEl.textContent = ex.name;
    info.appendChild(nameEl);
    if (ex.desc) {
      const descEl = document.createElement('div');
      descEl.className = 'settings-row-hint';
      descEl.textContent = ex.desc;
      info.appendChild(descEl);
    }
    row.appendChild(info);
    row.addEventListener('click', () => {
      loadExample(ex);
      closeExamples();
      window.dispatchEvent(new CustomEvent('ep:close-drawer'));
    });
    epListEl.appendChild(row);
  }
}

if (epOpenBtn) {
  epOpenBtn.addEventListener('click', () => {
    // Close the drawer first so the panel slide-in is the only visible
    // sub-surface (otherwise the drawer would be visible behind it).
    window.dispatchEvent(new CustomEvent('ep:close-drawer'));
    openExamples();
  });
}
if (epBackBtn) epBackBtn.addEventListener('click', closeExamples);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && epPanel && epPanel.classList.contains('on')) closeExamples();
});
