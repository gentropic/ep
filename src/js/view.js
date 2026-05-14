// Panel collapse, form-view toggle, show-source toggle, initial UI hydration.

import { state } from './state.js';

const app           = document.getElementById('app');
const paramsPanel   = document.getElementById('paramsPanel');
const outputsPanel  = document.getElementById('outputsPanel');
const formBtn       = document.getElementById('formBtn');
const showSourceBtn = document.getElementById('showSourceBtn');

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
  formBtn.textContent = state.ui.formView ? 'editor' : 'form';
  showSourceBtn.textContent = state.ui.showSource
    ? 'hide calculation ▴'
    : 'show calculation ▾';
}

export function applyInitialUI() {
  if (state.ui.paramsCollapsed)  paramsPanel.classList.add('collapsed');
  if (state.ui.outputsCollapsed) outputsPanel.classList.add('collapsed');
  if (state.ui.formView)         applyFormView();
}
