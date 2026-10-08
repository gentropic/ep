// Swipe-to-dismiss for the pocket bottom sheets (SPEC-pocket §3.1). The
// drawer, the sub-page panels, the unit sheet and the export dialog all
// become bottom sheets under html[data-pocket]; this gives each one the
// gesture the drag handle promises: drag the header down, the sheet
// follows the finger, release past a threshold (or flick) to close.
// Outside pocket mode nothing is wired. Editor bundle only.

import { isPocket } from './viewport.js';
import { closeDrawer } from './drawer.js';
import { closeSettings } from './settings.js';
import { closeExamples } from './examples-panel.js';
import { closeSnapshots } from './snapshots.js';
import { closeUnitPicker } from './unit-picker.js';

const DISMISS_PX = 110;        // drag this far → close
const DISMISS_VELOCITY = 0.6;  // px/ms downward flick → close

function wireSwipeDismiss(sheet, handle, close) {
  if (!sheet || !handle) return;
  let y0 = 0, t0 = 0, lastY = 0, lastT = 0, dragging = false;
  handle.addEventListener('touchstart', e => {
    if (!isPocket() || e.touches.length !== 1) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'button') return;
    y0 = lastY = e.touches[0].clientY;
    t0 = lastT = performance.now();
    dragging = true;
    sheet.style.transition = 'none';
  }, { passive: true });
  handle.addEventListener('touchmove', e => {
    if (!dragging) return;
    const dy = Math.max(0, e.touches[0].clientY - y0);
    lastY = e.touches[0].clientY; lastT = performance.now();
    sheet.style.transform = `translateY(${dy}px)`;
    if (dy > 0 && e.cancelable) e.preventDefault();
  }, { passive: false });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    const dy = Math.max(0, lastY - y0);
    const v = dy / Math.max(1, lastT - t0);
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > DISMISS_PX || v > DISMISS_VELOCITY) close();
  };
  handle.addEventListener('touchend', end);
  handle.addEventListener('touchcancel', end);
}

const byId = (id) => document.getElementById(id);
const q = (sel, root = document) => root.querySelector(sel);

wireSwipeDismiss(byId('drawer'),         q('#drawer .drawer-hdr'),          closeDrawer);
wireSwipeDismiss(byId('settingsPanel'),  q('#settingsPanel .settings-hdr'), closeSettings);
wireSwipeDismiss(byId('examplesPanel'),  q('#examplesPanel .settings-hdr'), closeExamples);
wireSwipeDismiss(byId('snapshotsPanel'), q('#snapshotsPanel .settings-hdr'), closeSnapshots);
wireSwipeDismiss(byId('unitSheet'),      q('#unitSheet .unit-sheet-hdr'),   closeUnitPicker);
{
  const scrim = byId('scrim');
  const dialog = scrim && q('.dialog', scrim);
  wireSwipeDismiss(dialog, dialog && q('.dialog-hdr', dialog), () => scrim.classList.remove('on'));
}
