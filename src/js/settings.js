// User-level settings panel — full-screen slide-in opened from the drawer
// foot. Holds knobs that aren't part of any individual program: display
// precision, drawer sort order, tutorial replay, and a danger-zone reset.
//
// Settings persist via getSetting/setSetting in storage.js (one localStorage
// blob at "ep:settings"). On boot, applySettings() reads the stored values
// and applies them to the running app (currently just sig digits — sort is
// read on demand by drawer.js, tutorial is one-shot).

import { getSetting, setSetting } from './storage.js';
import { setFmtSigDigits } from './units.js';
import { renderChips, renderResults } from './render.js';
import { epConfirm } from './dialogs.js';
import { startTutorial, resetTutorial } from './tutorial.js';

const SIG_OPTIONS  = [3, 4, 5, 6];
const SORT_OPTIONS = [
  { key: 'recent', label: 'recent' },
  { key: 'alpha',  label: 'a → z'  },
];

const panel             = document.getElementById('settingsPanel');
const openBtn           = document.getElementById('openSettingsBtn');
const backBtn           = document.getElementById('settingsBackBtn');
const sigDigitsControl  = document.getElementById('sigDigitsControl');
const sortControl       = document.getElementById('settingsSortControl');
const replayTutBtn      = document.getElementById('settingsReplayTutBtn');
const resetBtn          = document.getElementById('settingsResetBtn');

export function openSettings() {
  if (!panel) return;
  renderControls();
  panel.classList.add('on');
  panel.setAttribute('aria-hidden', 'false');
}

export function closeSettings() {
  if (!panel) return;
  panel.classList.remove('on');
  panel.setAttribute('aria-hidden', 'true');
}

// Read settings out of storage and apply them to runtime state. Called once
// from main.js on boot; safe to re-call after a reset.
export function applySettings() {
  const sig = getSetting('sigDigits', 4);
  setFmtSigDigits(sig);
}

function renderControls() {
  const sigOpts = SIG_OPTIONS.map(n => ({ key: n, label: String(n) }));
  renderPillRow(sigDigitsControl, sigOpts, getSetting('sigDigits', 4), v => {
    setSetting('sigDigits', v);
    setFmtSigDigits(v);
    // Format-only change — no re-evaluate needed, just redraw chips + results.
    renderChips();
    renderResults();
    renderControls();
  });

  renderPillRow(sortControl, SORT_OPTIONS, getSetting('sort', 'recent'), v => {
    setSetting('sort', v);
    // drawer.js listens for ep:storage-changed to re-render the list.
    window.dispatchEvent(new CustomEvent('ep:storage-changed'));
    // Sync the inline drawer sort label, if it's been mounted.
    const btn = document.getElementById('drawerSortBtn');
    if (btn) btn.textContent = v;
    renderControls();
  });
}

// Renders a row of {key,label} pill buttons; calls onChange(key) when one
// other than the currently-active key is clicked.
function renderPillRow(container, options, activeKey, onChange) {
  if (!container) return;
  container.innerHTML = '';
  for (const opt of options) {
    const b = document.createElement('button');
    b.className = 'settings-pill' + (opt.key === activeKey ? ' active' : '');
    b.textContent = opt.label;
    b.addEventListener('click', () => { if (opt.key !== activeKey) onChange(opt.key); });
    container.appendChild(b);
  }
}

if (openBtn) {
  openBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('ep:close-drawer'));
    openSettings();
  });
}
if (backBtn) backBtn.addEventListener('click', closeSettings);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && panel && panel.classList.contains('on')) closeSettings();
});

if (replayTutBtn) {
  replayTutBtn.addEventListener('click', () => {
    closeSettings();
    resetTutorial();
    setTimeout(startTutorial, 200);
  });
}

if (resetBtn) {
  resetBtn.addEventListener('click', async () => {
    const ok = await epConfirm({
      title: 'Reset all data?',
      message: 'This deletes every saved program, the current draft, your settings, and the tutorial-seen flag. The page will reload. This cannot be undone.',
      okLabel: 'Reset',
      danger: true,
    });
    if (!ok) return;
    try {
      // Wipe everything ep wrote, but leave unrelated keys alone.
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('ep:')) localStorage.removeItem(k);
      }
    } catch {}
    location.reload();
  });
}
