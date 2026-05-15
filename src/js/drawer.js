// Hamburger drawer — open/close, swipe-to-close, program list rendering.
// Open is hamburger-only (no swipe-open) to avoid conflicting with Android's
// system back gesture.

import { readStore, currentProgramName, loadProgramByName, newProgram, programDescription, formatAgo } from './storage.js';
import { openProgramMenu, attachLongPress, closeCtxMenu } from './ctxmenu.js';
import { startTutorial, resetTutorial } from './tutorial.js';

const menuBtn        = document.getElementById('menuBtn');
const drawer         = document.getElementById('drawer');
const drawerScrim    = document.getElementById('drawerScrim');
const drawerCloseBtn = document.getElementById('drawerCloseBtn');
const drawerListEl   = document.getElementById('drawerList');
const drawerSearchEl = document.getElementById('drawerSearch');
const newProgBtn     = document.getElementById('newProgBtn');
const openFileBtn    = document.getElementById('openFileBtn');
const drawerFileInput = document.getElementById('fileInput');

let searchFilter = '';

export function openDrawer({focusSearch = false} = {}) {
  drawer.classList.add('on');
  drawerScrim.classList.add('on');
  renderDrawerList();
  if (focusSearch && drawerSearchEl) setTimeout(() => drawerSearchEl.focus(), 30);
}

export function closeDrawer() {
  drawer.classList.remove('on');
  drawerScrim.classList.remove('on');
  closeCtxMenu();
}

menuBtn.addEventListener('click', () => openDrawer());
drawerCloseBtn.addEventListener('click', closeDrawer);
drawerScrim.addEventListener('click', closeDrawer);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && drawer.classList.contains('on')) closeDrawer();
});
window.addEventListener('ep:close-drawer', closeDrawer);
window.addEventListener('ep:storage-changed', renderDrawerList);

newProgBtn.addEventListener('click', () => { newProgram(); closeDrawer(); });
openFileBtn.addEventListener('click', () => { drawerFileInput.click(); closeDrawer(); });

const replayTutorialBtn = document.getElementById('replayTutorialBtn');
if (replayTutorialBtn) {
  replayTutorialBtn.addEventListener('click', () => {
    closeDrawer();
    resetTutorial();
    setTimeout(startTutorial, 200);
  });
}

if (drawerSearchEl) {
  drawerSearchEl.addEventListener('input', () => {
    searchFilter = drawerSearchEl.value.trim().toLowerCase();
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
export function renderDrawerList() {
  if (!drawerListEl) return;
  const store = readStore();
  let names = Object.keys(store).sort((a, b) =>
    (store[b].updatedAt || 0) - (store[a].updatedAt || 0)
  );
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
    nameEl.textContent = name;
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

    item.appendChild(info);
    item.appendChild(actions);

    item.addEventListener('click', () => {
      if (name !== currentProgramName) loadProgramByName(name);
      closeDrawer();
    });

    attachLongPress(item, (px, py) => openProgramMenu(name, px, py, {alignRight: false}));

    drawerListEl.appendChild(item);
  }
}
