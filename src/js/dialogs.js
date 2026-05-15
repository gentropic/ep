// In-app modal dialogs that replace native confirm()/prompt(), which are
// blocked in some PWA/artifact hosting contexts and silently return null.
// Both helpers return promises that resolve with the user's choice.

import { closeMenu } from './menu.js';

const modalScrim      = document.getElementById('modalScrim');
const modalTitle      = document.getElementById('modalTitle');
const modalMsg        = document.getElementById('modalMsg');
const modalInputRow   = document.getElementById('modalInputRow');
const modalInputLabel = document.getElementById('modalInputLabel');
const modalInput      = document.getElementById('modalInput');
const modalError      = document.getElementById('modalError');
const modalCancelBtn  = document.getElementById('modalCancelBtn');
const modalOkBtn      = document.getElementById('modalOkBtn');

let modalResolve = null;

function closeModal(result) {
  modalScrim.classList.remove('on');
  const resolver = modalResolve;
  modalResolve = null;
  if (resolver) resolver(result);
}

modalCancelBtn.addEventListener('click', () => closeModal(null));
modalOkBtn.addEventListener('click', () => {
  if (modalInputRow.style.display !== 'none') closeModal(modalInput.value);
  else                                         closeModal(true);
});
modalScrim.addEventListener('click', e => {
  if (e.target === modalScrim) closeModal(null);
});
modalInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); modalOkBtn.click(); }
  if (e.key === 'Escape') { e.preventDefault(); closeModal(null); }
});

export function epConfirm(opts) {
  closeMenu();
  modalTitle.textContent = opts.title || 'Confirm';
  modalMsg.textContent   = opts.message || '';
  modalInputRow.style.display = 'none';
  modalError.style.display    = 'none';
  modalOkBtn.textContent = opts.okLabel || 'OK';
  if (opts.danger) {
    modalOkBtn.classList.remove('primary');
    modalOkBtn.classList.add('danger');
  } else {
    modalOkBtn.classList.add('primary');
    modalOkBtn.classList.remove('danger');
  }
  modalCancelBtn.textContent = 'Cancel';
  modalScrim.classList.add('on');
  return new Promise(resolve => { modalResolve = resolve; });
}

export function epPrompt(opts) {
  closeMenu();
  modalTitle.textContent = opts.title || 'Input';
  modalMsg.textContent   = opts.message || '';
  modalInputRow.style.display = '';
  modalInputLabel.textContent = opts.label || 'value';
  modalInput.value = opts.value || '';
  modalError.style.display = 'none';
  modalOkBtn.textContent = opts.okLabel || 'OK';
  modalOkBtn.classList.add('primary');
  modalOkBtn.classList.remove('danger');
  modalCancelBtn.textContent = 'Cancel';
  modalScrim.classList.add('on');
  setTimeout(() => { modalInput.focus(); modalInput.select(); }, 30);
  return new Promise(resolve => { modalResolve = resolve; });
}
