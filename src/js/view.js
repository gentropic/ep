// Panel collapse, form-view toggle, show-source toggle, initial UI hydration,
// and the pocket-mode chrome (SPEC-pocket §3.1 / §3.3).

import { state } from './state.js';
import { isPocket } from './viewport.js';
import { isTutorialDone, markTutorialDone } from './tutorial.js';
import { newProgram } from './storage.js';

const app           = document.getElementById('app');
const paramsPanel   = document.getElementById('paramsPanel');
const outputsPanel  = document.getElementById('outputsPanel');
const formBtn       = document.getElementById('formBtn');
const showSourceBtn = document.getElementById('showSourceBtn');
const bodyHost      = document.getElementById('body');
const pocketExportBtn = document.getElementById('exportBtn');

// Panel collapse — click the header to collapse/expand.
document.querySelectorAll('.panel-hdr').forEach(h => {
  h.addEventListener('click', () => {
    const p = h.parentElement;
    p.classList.toggle('collapsed');
    if (p.id === 'paramsPanel')  state.ui.paramsCollapsed  = p.classList.contains('collapsed');
    if (p.id === 'outputsPanel') state.ui.outputsCollapsed = p.classList.contains('collapsed');
  });
});

// Form-view toggle: switches between editor view and form view.
formBtn.addEventListener('click', () => {
  state.ui.formView = !state.ui.formView;
  state.ui.showSource = false;
  applyFormView();
});
showSourceBtn.addEventListener('click', () => {
  state.ui.showSource = !state.ui.showSource;
  applyFormView();
});

export function applyFormView() {
  app.classList.toggle('form',       state.ui.formView);
  app.classList.toggle('body-shown', state.ui.formView && state.ui.showSource);
  formBtn.classList.toggle('on', state.ui.formView);
  // Pocket shows this button only in form view, as the way back.
  formBtn.textContent = state.ui.formView ? (isPocket() ? 'edit' : 'editor') : 'form';
  showSourceBtn.textContent = state.ui.showSource
    ? 'hide calculation ▴'
    : 'show calculation ▾';
  applyPocketChrome();
}

// ── Pocket chrome ─────────────────────────────────────────────────
// The phone layout is mostly CSS keyed off html[data-pocket]; the two
// things CSS can't do live here: the export button's label (export IS
// "make this a form" on a phone — SPEC-pocket §3.6) and the first-run
// hint line that replaces the desktop tutorial overlay (§3.3). The hint
// is one sentence above the sheet with a dismiss button; dismissing it
// marks the tutorial done so neither surface pesters again.
let pocketHintEl = null;

function ensurePocketHint() {
  if (pocketHintEl) return pocketHintEl;
  const el = document.createElement('div');
  el.className = 'pocket-hint';
  el.innerHTML =
    '<span class="pocket-hint-star" aria-hidden="true">✦</span>' +
    '<span class="pocket-hint-text"><b>A calculator you write.</b> Touch a number.</span>' +
    '<button class="pocket-hint-empty">Empty sheet</button>' +
    '<button class="pocket-hint-x" aria-label="dismiss hint">✕</button>';
  const done = () => { if (!pocketHintEl) return; el.remove(); pocketHintEl = null; markTutorialDone(); };
  el.querySelector('.pocket-hint-x').addEventListener('click', done);
  // The first edit is proof the user got it: typing in the editor or a
  // chip dismisses the hint on its own (after boot has settled, so the
  // initial render's own input events don't count).
  setTimeout(() => { bodyHost.addEventListener('input', done, { once: true }); }, 800);
  // The other first-run exit: skip the worked example and start clean.
  el.querySelector('.pocket-hint-empty').addEventListener('click', () => { done(); newProgram(); });
  bodyHost.parentElement.insertBefore(el, bodyHost);
  pocketHintEl = el;
  return el;
}

export function applyPocketChrome() {
  const pocket = isPocket();
  if (pocketExportBtn) pocketExportBtn.textContent = pocket ? 'Make form' : 'export';
  const wantHint = pocket && !state.ui.formView && !isTutorialDone();
  if (wantHint) ensurePocketHint();
  else if (pocketHintEl) { pocketHintEl.remove(); pocketHintEl = null; }
}

window.addEventListener('ep:pocket-changed', applyPocketChrome);

// In pocket mode the outputs panel is a fixed strip above the keyboard
// row; publish its height as --ep-outs-h so the editor's bottom padding
// keeps the last lines clear of it. Zero outside pocket mode.
if (typeof ResizeObserver !== 'undefined' && outputsPanel) {
  const publish = () => {
    const h = isPocket() && !outputsPanel.classList.contains('empty') ? outputsPanel.offsetHeight : 0;
    document.documentElement.style.setProperty('--ep-outs-h', h + 'px');
  };
  new ResizeObserver(publish).observe(outputsPanel);
  window.addEventListener('ep:pocket-changed', publish);
  publish();
}

export function applyInitialUI() {
  if (state.ui.paramsCollapsed)  paramsPanel.classList.add('collapsed');
  if (state.ui.outputsCollapsed) outputsPanel.classList.add('collapsed');
  if (state.ui.formView)         applyFormView();
  applyPocketChrome();
}
