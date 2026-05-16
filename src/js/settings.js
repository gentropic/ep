// User-level settings panel — full-screen slide-in opened from the drawer
// foot. Holds knobs that aren't part of any individual program: theme,
// display precision, panel/accessory visibility, drawer sort, default
// new-file template, tutorial replay, and a danger-zone reset.
//
// Settings persist via getSetting/setSetting in storage.js (one localStorage
// blob at "ep:settings"). On boot, applySettings() reads the stored values
// and applies them to the running app.

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
const THEME_OPTIONS = [
  { key: 'auto',  label: 'auto'  },
  { key: 'light', label: 'light' },
  { key: 'dark',  label: 'dark'  },
];
const ON_OFF = [
  { key: 'on',  label: 'on'  },
  { key: 'off', label: 'off' },
];

// Default template used when the user creates a new program. Kept here so
// the textbox in settings can present it as a known starting point (a
// "Reset to default" affordance), and so storage.js's newProgram() can
// fall back to it when no user template is stored.
export const DEFAULT_NEW_FILE_TEMPLATE = [
  '# new program',
  '',
  '@params {',
  '  x = 1',
  '}',
  '',
  'y = x * 2',
  '',
  '@outputs { y }',
].join('\n');

const panel             = document.getElementById('settingsPanel');
const openBtn           = document.getElementById('openSettingsBtn');
const backBtn           = document.getElementById('settingsBackBtn');
const themeControl      = document.getElementById('themeControl');
const sigDigitsControl  = document.getElementById('sigDigitsControl');
const accessoryControl  = document.getElementById('accessoryControl');
const autoHideControl   = document.getElementById('autoHideControl');
const sortControl       = document.getElementById('settingsSortControl');
const templateInput     = document.getElementById('templateInput');
const templateResetBtn  = document.getElementById('templateResetBtn');
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
  setFmtSigDigits(getSetting('sigDigits', 4));
  applyTheme(getSetting('theme', 'auto'));
  applyAccessoryVisibility(getSetting('showAccessory', true));
  applyEmptyPanelHiding(getSetting('autoHideEmpty', true));
}

// Theme application — mirror auditable's [data-theme] pattern. 'auto'
// follows the OS preference and watches matchMedia for live changes; the
// inline first-paint script in template.html sets the initial value so
// there's no FOUC.
let _themeMql = null;
let _themeMqlHandler = null;
export function applyTheme(pref) {
  if (_themeMql && _themeMqlHandler) {
    _themeMql.removeEventListener('change', _themeMqlHandler);
    _themeMql = null;
    _themeMqlHandler = null;
  }
  const root = document.documentElement;
  if (pref === 'auto') {
    _themeMql = window.matchMedia('(prefers-color-scheme: dark)');
    _themeMqlHandler = (e) => root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    _themeMql.addEventListener('change', _themeMqlHandler);
    root.setAttribute('data-theme', _themeMql.matches ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', pref === 'dark' ? 'dark' : 'light');
  }
}

export function applyAccessoryVisibility(show) {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.toggle('no-accessory', !show);
}

export function applyEmptyPanelHiding(enabled) {
  // CSS class on app: when set, empty-state classes on the panels take
  // effect. render.js updates those classes after each evaluate, so we
  // just trigger a re-render here to pick up the change.
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.toggle('auto-hide-empty', !!enabled);
  renderChips();
  renderResults();
}

function renderControls() {
  renderPillRow(themeControl, THEME_OPTIONS, getSetting('theme', 'auto'), v => {
    setSetting('theme', v);
    applyTheme(v);
    renderControls();
  });

  const sigOpts = SIG_OPTIONS.map(n => ({ key: n, label: String(n) }));
  renderPillRow(sigDigitsControl, sigOpts, getSetting('sigDigits', 4), v => {
    setSetting('sigDigits', v);
    setFmtSigDigits(v);
    // Format-only change — no re-evaluate needed, just redraw chips + results.
    renderChips();
    renderResults();
    renderControls();
  });

  renderPillRow(accessoryControl, ON_OFF,
    getSetting('showAccessory', true) ? 'on' : 'off', v => {
      const on = v === 'on';
      setSetting('showAccessory', on);
      applyAccessoryVisibility(on);
      renderControls();
    });

  renderPillRow(autoHideControl, ON_OFF,
    getSetting('autoHideEmpty', true) ? 'on' : 'off', v => {
      const on = v === 'on';
      setSetting('autoHideEmpty', on);
      applyEmptyPanelHiding(on);
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

  if (templateInput) {
    templateInput.value = getSetting('newFileTemplate', DEFAULT_NEW_FILE_TEMPLATE);
  }
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

// New-file template — persist on blur so we don't write on every keystroke.
if (templateInput) {
  templateInput.addEventListener('blur', () => {
    const v = templateInput.value;
    if (v === DEFAULT_NEW_FILE_TEMPLATE || v.trim() === '') {
      // Storing the default is wasteful; clear the setting so future
      // tweaks to DEFAULT_NEW_FILE_TEMPLATE flow through.
      setSetting('newFileTemplate', '');
    } else {
      setSetting('newFileTemplate', v);
    }
  });
}
if (templateResetBtn) {
  templateResetBtn.addEventListener('click', () => {
    if (templateInput) templateInput.value = DEFAULT_NEW_FILE_TEMPLATE;
    setSetting('newFileTemplate', '');
  });
}

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
