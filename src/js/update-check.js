// Update detection + reload toast. Pairs with sw.js's cache-first /
// stale-while-revalidate logic: when the SW notices the shell bytes
// changed, it postMessages 'ep:update-available' to all clients; we
// surface a small toast offering Reload.
//
// Settings glue:
//   getSetting('autoCheckUpdates', true) — sent to the SW on boot;
//     when false the SW skips the background revalidation but the
//     "check now" path still works.
//   localStorage['ep:updateLastCheck'] — millisecond timestamp of the
//     most recent check completion (auto or manual). Read by the
//     settings panel.

import { getSetting } from './storage.js';

const toastEl = document.getElementById('updateToast');
const toastReloadBtn = document.getElementById('updateToastReload');
const toastDismissBtn = document.getElementById('updateToastDismiss');

export function showUpdateToast() {
  if (!toastEl) return;
  toastEl.classList.add('on');
}

export function hideUpdateToast() {
  if (!toastEl) return;
  toastEl.classList.remove('on');
}

// Ask the active SW to run a refresh now. The SW replies with
// ep:check-complete carrying a timestamp; we record it. If a new
// version is detected it'll already have posted ep:update-available
// before this completes.
export function checkForUpdateNow() {
  return new Promise((resolve) => {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => {
      if (e.data && e.data.type === 'ep:check-complete') {
        try { localStorage.setItem('ep:updateLastCheck', String(e.data.at)); } catch {}
        resolve(e.data.at);
      }
    };
    navigator.serviceWorker.controller.postMessage(
      { type: 'ep:check-now' },
      [channel.port2],
    );
    // Safety timeout — don't hang forever if the SW doesn't reply.
    setTimeout(() => resolve(null), 8000);
  });
}

export function getLastUpdateCheck() {
  try {
    const raw = localStorage.getItem('ep:updateLastCheck');
    return raw ? parseInt(raw, 10) : null;
  } catch { return null; }
}

// Push the current auto-check setting to the worker. Called on boot
// and whenever the setting toggles.
export function syncAutoCheckSetting() {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.controller.postMessage({
    type: 'ep:set-auto-check',
    value: getSetting('autoCheckUpdates', true),
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'ep:update-available') {
      // Record check time even when auto-detected (the SW just refreshed).
      try { localStorage.setItem('ep:updateLastCheck', String(Date.now())); } catch {}
      showUpdateToast();
    }
  });
  // Wait until a controller is in place (first install can race), then
  // sync the auto-check preference once.
  if (navigator.serviceWorker.controller) {
    syncAutoCheckSetting();
  } else {
    navigator.serviceWorker.addEventListener('controllerchange', syncAutoCheckSetting, { once: true });
  }
}

if (toastReloadBtn) {
  toastReloadBtn.addEventListener('click', () => {
    location.reload();
  });
}
if (toastDismissBtn) {
  toastDismissBtn.addEventListener('click', hideUpdateToast);
}
