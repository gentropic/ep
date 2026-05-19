// Hamburger drawer — open/close, swipe-to-close, program list rendering.
// Open is hamburger-only (no swipe-open) to avoid conflicting with Android's
// system back gesture.

import { readStore, currentProgramName, loadProgramByName, newProgram, programDescription, formatAgo, getSetting, setSetting, listSnapshots, restoreSnapshot, pinSnapshot, deleteSnapshot, takeSnapshot } from './storage.js';
import { openProgramMenu } from './ctxmenu.js';
import { attachLongPress, closeMenu, showMenu } from './menu.js';
import { isDesktop } from './viewport.js';
import { epConfirm, epPrompt } from './dialogs.js';

const menuBtn        = document.getElementById('menuBtn');
const drawer         = document.getElementById('drawer');
const drawerScrim    = document.getElementById('drawerScrim');
const drawerCloseBtn = document.getElementById('drawerCloseBtn');
const drawerTitleEl  = document.getElementById('drawerTitle');
const drawerListEl   = document.getElementById('drawerList');
const drawerSearchEl = document.getElementById('drawerSearch');
const drawerSortBtn  = document.getElementById('drawerSortBtn');
const newProgBtn     = document.getElementById('newProgBtn');
const openFileBtn    = document.getElementById('openFileBtn');
const drawerFileInput = document.getElementById('fileInput');
const drawerModeProgramsBtn = document.getElementById('drawerModeProgramsBtn');
const drawerModeHistoryBtn  = document.getElementById('drawerModeHistoryBtn');
const drawerHistoryListEl   = document.getElementById('drawerHistoryList');
const drawerHistoryHdrEl    = document.getElementById('drawerHistoryHdr');
const drawerSnapshotNowBtn  = document.getElementById('drawerSnapshotNowBtn');

let searchFilter = '';
let drawerMode = 'programs';   // 'programs' | 'history'

// Show/hide the program-mode sections vs history-mode sections, update
// the title + active tab. Doesn't re-render — caller fires renderDrawer
// (or renderHistory) afterwards. Exported so ctxmenu's "history" action
// can flip the drawer in persistent mode.
export function setDrawerMode(mode) {
  drawerMode = (mode === 'history') ? 'history' : 'programs';
  for (const el of document.querySelectorAll('.drawer-mode-programs')) {
    el.style.display = drawerMode === 'programs' ? '' : 'none';
  }
  for (const el of document.querySelectorAll('.drawer-mode-history')) {
    el.style.display = drawerMode === 'history' ? '' : 'none';
  }
  if (drawerModeProgramsBtn) {
    drawerModeProgramsBtn.classList.toggle('active', drawerMode === 'programs');
    drawerModeProgramsBtn.setAttribute('aria-selected', drawerMode === 'programs');
  }
  if (drawerModeHistoryBtn) {
    drawerModeHistoryBtn.classList.toggle('active', drawerMode === 'history');
    drawerModeHistoryBtn.setAttribute('aria-selected', drawerMode === 'history');
  }
  if (drawerTitleEl) {
    drawerTitleEl.textContent = drawerMode === 'history'
      ? `ep · history${currentProgramName ? ' · ' + currentProgramName : ''}`
      : 'ep · programs';
  }
  if (drawerMode === 'history') renderHistoryList();
  else                          renderDrawerList();
}

// Desktop persistent-drawer mode: when the viewport is desktop AND the
// user hasn't opted out via Settings, the drawer is a sidebar that stays
// open. closeDrawer becomes a no-op, the scrim is hidden, and the app
// content shifts right (CSS handles the layout via the `persistent`
// class on the drawer). The hamburger close button is still wired up
// to closeDrawer; in persistent mode the close button itself is hidden
// via CSS rather than being made functional-but-overridden.
function persistentMode() {
  return isDesktop() && getSetting('desktopDrawer', true);
}

function applyPersistentClass() {
  // ep-drawer-persistent lives on <html> (not body) so the head script
  // can set it before first paint to avoid a slide-in animation on every
  // refresh. drawer.js keeps it in sync at runtime; CSS rules use it
  // as a descendant selector so both <html> and <body> placements work.
  if (persistentMode()) {
    drawer.classList.add('persistent');
    document.documentElement.classList.add('ep-drawer-persistent');
  } else {
    drawer.classList.remove('persistent');
    document.documentElement.classList.remove('ep-drawer-persistent');
  }
  updateDrawerInert();
}

// The drawer is rendered off-screen with transform: translateX(-100%) when
// closed in mobile/modal mode — visually hidden but still in tab order.
// Setting `inert` on the whole drawer removes its descendants from the
// focus/tab tree, so Tab from the header doesn't blow past the editor
// into invisible drawer buttons. Re-enabled whenever the drawer is
// actually visible (open as modal OR persistent sidebar).
function updateDrawerInert() {
  const visible = persistentMode() || drawer.classList.contains('on');
  if (visible) drawer.removeAttribute('inert');
  else drawer.setAttribute('inert', '');
}

export function openDrawer({focusSearch = false} = {}) {
  drawer.classList.add('on');
  drawerScrim.classList.add('on');
  updateDrawerInert();
  renderDrawerList();
  if (focusSearch && drawerSearchEl) setTimeout(() => drawerSearchEl.focus(), 30);
}

export function closeDrawer() {
  // In persistent mode, the drawer stays open; user can still interact
  // with elements inside it (search, list, settings) but the standard
  // close paths (scrim click, Esc, action-clicks-that-also-close) become
  // no-ops. The drawer is a permanent part of the layout, not a modal.
  if (persistentMode()) return;
  drawer.classList.remove('on');
  drawerScrim.classList.remove('on');
  updateDrawerInert();
  closeMenu();
}

menuBtn.addEventListener('click', () => openDrawer());
drawerCloseBtn.addEventListener('click', closeDrawer);
drawerScrim.addEventListener('click', closeDrawer);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && drawer.classList.contains('on')) closeDrawer();
});
window.addEventListener('ep:close-drawer', closeDrawer);
// Re-render whichever list is currently visible when storage changes
// underneath us (another tab saved, a snapshot was taken/restored, etc).
window.addEventListener('ep:storage-changed', () => {
  if (drawerMode === 'history') renderHistoryList();
  else                          renderDrawerList();
});

// snapshots.js dispatches this when the user opens "history" for a
// program while the persistent drawer is active. Load that program if
// it's not current, then flip the drawer to history mode.
window.addEventListener('ep:open-snapshots-in-drawer', e => {
  const name = e.detail && e.detail.name;
  if (name && name !== currentProgramName) loadProgramByName(name);
  setDrawerMode('history');
});

if (drawerModeProgramsBtn) {
  drawerModeProgramsBtn.addEventListener('click', () => setDrawerMode('programs'));
}
if (drawerModeHistoryBtn) {
  drawerModeHistoryBtn.addEventListener('click', () => setDrawerMode('history'));
}
if (drawerSnapshotNowBtn) {
  drawerSnapshotNowBtn.addEventListener('click', async () => {
    const name = currentProgramName;
    if (!name) return;
    const label = await epPrompt({
      title: 'Take snapshot',
      label: 'label (optional)',
      value: '',
      okLabel: 'Snapshot',
    });
    if (label === null) return;
    takeSnapshot(name, (label || '').trim() || null);
    renderHistoryList();
  });
}

// Snapshot list rendering. Reuses the same row shape as the slide-in
// snapshots panel (label-or-"auto" + pin glyph + meta line + restore/
// pin/delete actions) so users see consistent UI regardless of which
// surface they reach snapshots from.
function renderHistoryList() {
  if (!drawerHistoryListEl) return;
  const name = currentProgramName;
  drawerHistoryListEl.innerHTML = '';
  if (!name) {
    const empty = document.createElement('div');
    empty.className = 'settings-row-hint';
    empty.style.padding = '14px';
    empty.textContent = 'No program loaded.';
    drawerHistoryListEl.appendChild(empty);
    if (drawerHistoryHdrEl) drawerHistoryHdrEl.textContent = 'snapshots';
    return;
  }
  const snaps = listSnapshots(name);
  if (drawerHistoryHdrEl) {
    drawerHistoryHdrEl.textContent = snaps.length
      ? `${snaps.length} snapshot${snaps.length === 1 ? '' : 's'}`
      : 'no snapshots yet';
  }
  if (!snaps.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-row-hint';
    empty.style.padding = '14px';
    empty.textContent = 'Take one with "snapshot now…" above, or wait — ep auto-snapshots each program the first time you load it in a session.';
    drawerHistoryListEl.appendChild(empty);
    return;
  }
  for (const snap of snaps) {
    drawerHistoryListEl.appendChild(renderSnapshotRow(name, snap));
  }
}

function renderSnapshotRow(programName, snap) {
  const row = document.createElement('div');
  row.className = 'drawer-item snapshot-row';

  const info = document.createElement('div');
  info.className = 'drawer-item-info';

  const headline = document.createElement('div');
  headline.className = 'drawer-item-name';
  if (snap.label) {
    const lbl = document.createElement('span');
    lbl.className = 'snapshot-label';
    lbl.textContent = snap.label;
    headline.appendChild(lbl);
  } else {
    const auto = document.createElement('span');
    auto.className = 'snapshot-auto';
    auto.textContent = 'auto';
    headline.appendChild(auto);
  }
  if (snap.pinned) {
    const pin = document.createElement('span');
    pin.className = 'snapshot-pin-glyph';
    pin.textContent = '◆';
    pin.title = 'pinned (never auto-purged)';
    headline.appendChild(pin);
  }
  info.appendChild(headline);

  const meta = document.createElement('div');
  meta.className = 'drawer-item-meta';
  const lineCount = snap.body.length;
  meta.textContent = `${formatAgo(snap.takenAt)} · ${lineCount} line${lineCount === 1 ? '' : 's'}`;
  info.appendChild(meta);

  // Actions live behind a ⋯ menu instead of three inline buttons. Avoids
  // misclicks on destructive operations (restore replaces the program;
  // delete removes the snapshot), and matches the per-program row
  // pattern. Long-press / right-click on the row anywhere opens the
  // same menu, mirroring the program-row interaction.
  const actions = document.createElement('div');
  actions.className = 'drawer-item-actions';
  const ellipsis = document.createElement('button');
  ellipsis.className = 'drawer-item-menu-btn';
  ellipsis.textContent = '⋯';
  ellipsis.setAttribute('aria-label', 'snapshot actions');
  ellipsis.addEventListener('click', e => {
    e.stopPropagation();
    const rect = ellipsis.getBoundingClientRect();
    openSnapshotMenu(programName, snap, rect.right, rect.bottom + 4, { alignRight: true });
  });
  actions.appendChild(ellipsis);

  attachLongPress(row, (x, y) => openSnapshotMenu(programName, snap, x, y));

  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

function openSnapshotMenu(programName, snap, x, y, opts = {}) {
  showMenu([
    { label: 'restore', action: async () => {
      const ok = await epConfirm({
        title: 'Restore snapshot?',
        message: snap.label
          ? `Replace the current program with the snapshot "${snap.label}"? Your current state will be saved as a "before restore" snapshot first.`
          : `Replace the current program with this snapshot? Your current state will be saved as a "before restore" snapshot first.`,
        okLabel: 'Restore',
      });
      if (!ok) return;
      restoreSnapshot(programName, snap.id);
      renderHistoryList();
    } },
    { label: snap.pinned ? 'unpin' : 'pin', action: () => {
      pinSnapshot(programName, snap.id, !snap.pinned);
      renderHistoryList();
    } },
    { separator: true },
    { label: 'delete', danger: true, action: async () => {
      const ok = await epConfirm({
        title: 'Delete snapshot?',
        message: snap.label
          ? `Delete the snapshot "${snap.label}"? This can't be undone.`
          : `Delete this snapshot? This can't be undone.`,
        okLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      deleteSnapshot(programName, snap.id);
      renderHistoryList();
    } },
  ], x, y, opts);
}

// React to viewport-band changes (window resized across the 1024 boundary,
// or device orientation flipped). Also fired by the setting toggle in
// settings.js when the user changes the desktopDrawer preference.
function reapplyPersistentMode() {
  applyPersistentClass();
  if (persistentMode()) {
    // Auto-open in persistent mode so the sidebar is visible from boot.
    if (!drawer.classList.contains('on')) openDrawer();
  }
}
window.addEventListener('ep:viewport-changed', reapplyPersistentMode);
window.addEventListener('ep:desktop-drawer-setting-changed', reapplyPersistentMode);
// Run once at module load so initial paint shows the right layout.
reapplyPersistentMode();

newProgBtn.addEventListener('click', () => { newProgram(); closeDrawer(); });
openFileBtn.addEventListener('click', () => { drawerFileInput.click(); closeDrawer(); });

const drawerFormatBtn = document.getElementById('drawerFormatBtn');
if (drawerFormatBtn) {
  drawerFormatBtn.addEventListener('click', () => {
    // Late import dodges a module init order issue — drawer.js is loaded
    // before format-cmd.js by the build, but at runtime everything's in
    // flat scope so the call resolves fine.
    if (typeof formatCurrentProgram === 'function') formatCurrentProgram();
    closeDrawer();
  });
}

if (drawerSearchEl) {
  drawerSearchEl.addEventListener('input', () => {
    searchFilter = drawerSearchEl.value.trim().toLowerCase();
    renderDrawerList();
  });
}

// Drawer sort — 'recent' (default, by updatedAt desc) or 'alpha' (by name).
// Pinned programs always render first regardless of sort.
function currentSort() { return getSetting('sort', 'recent'); }
function updateSortBtn() {
  if (drawerSortBtn) drawerSortBtn.textContent = currentSort();
}
if (drawerSortBtn) {
  updateSortBtn();
  drawerSortBtn.addEventListener('click', () => {
    setSetting('sort', currentSort() === 'recent' ? 'alpha' : 'recent');
    updateSortBtn();
    renderDrawerList();
  });
}

// ── Swipe-left to close ───────────────────────────────────────
// Only fires when drawer is open and touch starts inside it. Doesn't conflict
// with Android's edge back-gesture because the start zone is the drawer body.
const CLOSE_CLAIM_PX       = 10;   // movement needed before claiming the gesture
const CLOSE_PROGRESS_BAR   = 0.5;  // below this open-fraction on release → snap closed
const CLOSE_VELOCITY_PX_MS = 0.5;  // OR moved leftward this fast → snap closed

let dragActive = false;
let dragClaimed = false;
let startX = 0, startY = 0, startT = 0;
let lastX = 0, lastT = 0;
let drawerW = 0;

function setProgress(p) {
  p = Math.max(0, Math.min(1, p));
  drawer.style.transform = `translateX(${(p - 1) * 100}%)`;
  drawerScrim.style.opacity = String(p);
  drawerScrim.style.pointerEvents = p > 0 ? 'auto' : 'none';
}
function clearInline() {
  drawer.style.transform = '';
  drawerScrim.style.opacity = '';
  drawerScrim.style.pointerEvents = '';
}

drawer.addEventListener('touchstart', e => {
  if (!drawer.classList.contains('on')) return;
  if (e.touches.length !== 1) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  dragActive = true;
  dragClaimed = false;
  const t = e.touches[0];
  startX = lastX = t.clientX;
  startY = t.clientY;
  startT = lastT = performance.now();
  drawerW = drawer.offsetWidth || 320;
}, {passive: true});

drawer.addEventListener('touchmove', e => {
  if (!dragActive) return;
  const t = e.touches[0];
  const dx = t.clientX - startX;
  const dy = t.clientY - startY;

  if (!dragClaimed) {
    if (Math.abs(dx) < CLOSE_CLAIM_PX && Math.abs(dy) < CLOSE_CLAIM_PX) return;
    if (Math.abs(dy) > Math.abs(dx)) { dragActive = false; return; }
    if (dx >= 0)                      { dragActive = false; return; }
    dragClaimed = true;
    drawer.classList.add('dragging');
    drawerScrim.classList.add('dragging');
  }

  if (e.cancelable) e.preventDefault();
  setProgress(1 + (dx / drawerW));
  lastX = t.clientX;
  lastT = performance.now();
}, {passive: false});

function endDrag() {
  if (!dragActive) return;
  const claimed = dragClaimed;
  dragActive = false;
  dragClaimed = false;
  drawer.classList.remove('dragging');
  drawerScrim.classList.remove('dragging');
  if (!claimed) return;

  const totalDx = lastX - startX;
  const totalDt = Math.max(1, lastT - startT);
  const velocity = totalDx / totalDt;
  const finalProgress = 1 + (totalDx / drawerW);

  clearInline();
  if (finalProgress < CLOSE_PROGRESS_BAR || velocity < -CLOSE_VELOCITY_PX_MS) {
    closeDrawer();
  } else {
    drawer.classList.add('on');
  }
}
drawer.addEventListener('touchend',    endDrag);
drawer.addEventListener('touchcancel', endDrag);

// ── List render ───────────────────────────────────────────────
// Examples are no longer rendered inline in the drawer — they moved to
// the on-demand examples panel (examples-panel.js). The drawer now only
// renders the saved-programs list below.

export function renderDrawerList() {
  if (!drawerListEl) return;
  const store = readStore();
  const sort = currentSort();
  const cmpRecent = (a, b) => (store[b].updatedAt || 0) - (store[a].updatedAt || 0);
  const cmpAlpha  = (a, b) => a.localeCompare(b);
  const baseCmp = sort === 'alpha' ? cmpAlpha : cmpRecent;
  // Pinned first, then everything else by the chosen sort.
  let names = Object.keys(store).sort((a, b) => {
    const pa = !!store[a].pinned, pb = !!store[b].pinned;
    if (pa !== pb) return pa ? -1 : 1;
    return baseCmp(a, b);
  });
  if (searchFilter) names = names.filter(n => n.toLowerCase().includes(searchFilter));
  drawerListEl.innerHTML = '';
  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'drawer-list-empty';
    empty.textContent = searchFilter ? 'no matches' : 'no saved programs yet';
    drawerListEl.appendChild(empty);
    return;
  }
  for (const name of names) {
    const prog = store[name];
    const item = document.createElement('div');
    item.className = 'drawer-item' + (name === currentProgramName ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'drawer-item-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'drawer-item-name';
    if (prog.pinned) {
      const pin = document.createElement('span');
      pin.className = 'drawer-item-pin';
      pin.textContent = '◆';
      pin.title = 'pinned';
      nameEl.appendChild(pin);
      nameEl.appendChild(document.createTextNode(' ' + name));
    } else {
      nameEl.textContent = name;
    }
    info.appendChild(nameEl);

    const desc = programDescription(prog.body);
    if (desc) {
      const descEl = document.createElement('div');
      descEl.className = 'drawer-item-desc';
      descEl.textContent = desc;
      info.appendChild(descEl);
    }

    const meta = document.createElement('div');
    meta.className = 'drawer-item-meta';
    const lineCount = (prog.body || []).length;
    meta.textContent = `${lineCount} line${lineCount === 1 ? '' : 's'} · ${formatAgo(prog.updatedAt)}`;
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'drawer-item-actions';
    const ellipsis = document.createElement('button');
    ellipsis.className = 'drawer-item-menu-btn';
    ellipsis.textContent = '⋯';
    ellipsis.setAttribute('aria-label', 'program actions');
    ellipsis.addEventListener('click', e => {
      e.stopPropagation();
      const rect = ellipsis.getBoundingClientRect();
      openProgramMenu(name, rect.right, rect.bottom + 4, {alignRight: true});
    });
    actions.appendChild(ellipsis);

    // Hover preview — desktop affordance, no effect on touch. The first
    // few non-blank lines of the program land as the item's title, so
    // pausing the cursor over the row surfaces what's actually inside
    // without having to switch to it. Capped at ~6 lines / 400 chars to
    // keep the native tooltip readable.
    const previewLines = (prog.body || [])
      .map(r => (r && r.src) || '')
      .filter(s => s.trim())
      .slice(0, 6);
    if (previewLines.length) {
      let preview = previewLines.join('\n');
      if (preview.length > 400) preview = preview.slice(0, 397) + '…';
      const extra = (prog.body || []).filter(r => r && r.src && r.src.trim()).length - previewLines.length;
      if (extra > 0) preview += `\n… +${extra} more lines`;
      item.title = preview;
    }

    item.appendChild(info);
    item.appendChild(actions);

    // Keyboard accessibility: each row is reachable via Tab (tabindex=0)
    // and activates on Enter/Space — same effect as a mouse click. The
    // ⋯ button stays its own focusable element for the per-program menu.
    // role="button" cues screen readers that this div behaves like one.
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        item.click();
      }
    });

    item.addEventListener('click', () => {
      if (name !== currentProgramName) loadProgramByName(name);
      closeDrawer();
    });

    attachLongPress(item, (px, py) => openProgramMenu(name, px, py, {alignRight: false}));

    drawerListEl.appendChild(item);
  }
}
