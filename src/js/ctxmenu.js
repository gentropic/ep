// Floating context menu plumbing + the long-press helper used to surface it.
//
// The drawer items use this for per-program actions (rename / duplicate /
// export / delete). Long-press on touch, right-click on desktop, or the `⋯`
// button all route through openProgramMenu().

import { epConfirm, epPrompt } from './dialogs.js';
import { readStore, writeStore, currentProgramName, setCurrentProgramName, loadProgramByName, newProgram } from './storage.js';

let openCtxMenuEl = null;

export function closeCtxMenu() {
  if (openCtxMenuEl) {
    openCtxMenuEl.remove();
    openCtxMenuEl = null;
  }
}

window.addEventListener('click', e => {
  if (openCtxMenuEl && !openCtxMenuEl.contains(e.target)) closeCtxMenu();
});
window.addEventListener('scroll', closeCtxMenu, true);
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtxMenu(); });

export function openProgramMenu(name, x, y, opts = {}) {
  closeCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';

  const mk = (label, fn, danger) => {
    const b = document.createElement('button');
    b.className = 'ctx-menu-item' + (danger ? ' danger' : '');
    b.textContent = label;
    b.addEventListener('click', e => {
      e.stopPropagation();
      closeCtxMenu();
      fn();
    });
    return b;
  };

  menu.appendChild(mk('rename',    () => renameProgram(name)));
  menu.appendChild(mk('duplicate', () => duplicateProgram(name)));
  menu.appendChild(mk('export',    () => {
    // Switch to the program first if needed, then open the export dialog.
    if (name !== currentProgramName) loadProgramByName(name);
    // Drawer close is the drawer module's concern; we just dispatch the click.
    window.dispatchEvent(new CustomEvent('ep:close-drawer'));
    setTimeout(() => document.getElementById('exportBtn').click(), 0);
  }));
  const sep = document.createElement('div');
  sep.className = 'ctx-menu-sep';
  menu.appendChild(sep);
  menu.appendChild(mk('delete', () => deleteProgram(name), true));

  document.body.appendChild(menu);
  openCtxMenuEl = menu;

  // Position after appending so we can measure
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = opts.alignRight ? x - mw : x;
  let top  = y;
  if (left + mw > vw - 8) left = vw - mw - 8;
  if (left < 8)           left = 8;
  if (top + mh > vh - 8)  top = y - mh - 8;
  if (top < 8)            top = 8;
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';
}

async function renameProgram(oldName) {
  const proposed = await epPrompt({
    title: 'Rename program',
    label: 'name',
    value: oldName,
    okLabel: 'Rename',
  });
  if (proposed == null) return;
  const clean = String(proposed).trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!clean || clean === oldName) return;
  const store = readStore();
  if (store[clean]) {
    await epConfirm({
      title: 'Name in use',
      message: `A program named "${clean}" already exists. Choose a different name.`,
      okLabel: 'OK',
    });
    return;
  }
  if (store[oldName]) {
    store[clean] = store[oldName];
    delete store[oldName];
    writeStore(store);
  }
  if (currentProgramName === oldName) setCurrentProgramName(clean);
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
}

function duplicateProgram(name) {
  const store = readStore();
  const src = store[name];
  if (!src) return;
  let candidate = name + '_copy';
  let i = 2;
  while (store[candidate]) candidate = `${name}_copy_${i++}`;
  store[candidate] = { body: src.body.slice(), updatedAt: Date.now() };
  writeStore(store);
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
}

async function deleteProgram(name) {
  const ok = await epConfirm({
    title: 'Delete program?',
    message: `"${name}" will be removed. This can't be undone.`,
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const store = readStore();
  delete store[name];
  writeStore(store);
  if (currentProgramName === name) {
    const remaining = Object.keys(store);
    if (remaining.length) loadProgramByName(remaining[0]);
    else                  newProgram();
  } else {
    window.dispatchEvent(new CustomEvent('ep:storage-changed'));
  }
}

// Fires fn(x, y) after ~500ms of sustained press without significant movement.
// Works for touch (primary), mouse (desktop fallback), and contextmenu (right-click).
export function attachLongPress(el, fn) {
  let timer = null;
  let startX = 0, startY = 0;

  const cancelOnce = e => { e.stopPropagation(); e.preventDefault(); };

  const start = (x, y) => {
    startX = x; startY = y;
    timer = setTimeout(() => {
      // Cancel the ensuing click on touch devices so long-press doesn't double-fire
      el.addEventListener('click', cancelOnce, {once: true, capture: true});
      fn(x, y);
    }, 500);
  };
  const move = (x, y) => {
    if (!timer) return;
    if (Math.abs(x - startX) > 8 || Math.abs(y - startY) > 8) {
      clearTimeout(timer); timer = null;
    }
  };
  const end = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  el.addEventListener('touchstart', e => {
    const t = e.touches[0];
    start(t.clientX, t.clientY);
  }, {passive: true});
  el.addEventListener('touchmove', e => {
    const t = e.touches[0];
    move(t.clientX, t.clientY);
  }, {passive: true});
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);

  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    start(e.clientX, e.clientY);
  });
  el.addEventListener('mousemove', e => move(e.clientX, e.clientY));
  el.addEventListener('mouseup',    end);
  el.addEventListener('mouseleave', end);

  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    fn(e.clientX, e.clientY);
  });
}
