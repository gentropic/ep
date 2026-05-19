// Shared menu + long-press plumbing. No deps on state / storage / DOM
// elements that only exist in the editor build — so the viewer artifact
// can pull this in without dragging the rest of ep's editor surface along.
//
// Used by:
//   - ctxmenu.js  (per-program context menu in the drawer)
//   - scenarios.js (per-scenario rename / delete)
//   - drawer.js   (long-press on saved-program rows)
//   - render.js   (copy-as menu on output chips, gutter unit picker)
//
// Submenu model: items with `submenu: [...]` spawn a child menu BESIDE
// the parent (not at cursor, not replacing it). The parent stays open.
// On hover-capable devices, hovering the parent item opens the submenu
// after a short delay; on touch, only tap opens it. Clicking a leaf
// item in any depth closes the whole stack. Clicking outside any menu
// closes the whole stack.

const openMenuStack = [];
const HOVER_CAPABLE = window.matchMedia && window.matchMedia('(hover: hover)').matches;
const SUBMENU_HOVER_DELAY = 150;  // ms

export function closeMenu() {
  while (openMenuStack.length) openMenuStack.pop().remove();
}

function closeMenuLevel(fromIdx) {
  while (openMenuStack.length > fromIdx) openMenuStack.pop().remove();
}

window.addEventListener('click', e => {
  if (openMenuStack.length === 0) return;
  for (const m of openMenuStack) {
    if (m.contains(e.target)) return;
  }
  closeMenu();
});
// Scroll on anything OUTSIDE the open menus closes the stack. Scrolling
// INSIDE a menu (when the list overflows max-height) must NOT close it,
// which the naive `closeMenu` listener would do because scroll events
// bubble to window via capture.
window.addEventListener('scroll', e => {
  if (openMenuStack.length === 0) return;
  for (const m of openMenuStack) {
    if (m === e.target || m.contains(e.target)) return;
  }
  closeMenu();
}, true);
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

// Position the menu so it stays within the viewport; flips above the
// anchor point if it would clip the bottom, snaps inside on the right.
export function positionMenu(menu, x, y, opts = {}) {
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = opts.alignRight ? x - mw : x;
  let top  = y;
  if (left + mw > vw - 8) left = vw - mw - 8;
  if (left < 8) left = 8;
  if (top + mh > vh - 8) top = y - mh - 8;
  if (top < 8) top = 8;
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';
}

// Position a submenu next to its parent button: right side preferred,
// flips to the left if it would clip the viewport's right edge. Top
// aligns with the parent button so the connection reads visually.
function positionSubmenu(menu, parentBtn) {
  const r = parentBtn.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = r.right + 2;
  let top  = r.top - 2;
  if (left + mw > vw - 8) left = r.left - mw - 2;  // flip to left of parent
  if (left < 8) left = 8;
  if (top + mh > vh - 8) top = vh - mh - 8;
  if (top < 8) top = 8;
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';
}

function buildMenu(items, opts) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'ctx-menu-item' + (item.danger ? ' danger' : '');
    b.textContent = item.label;

    if (item.submenu) {
      // Submenu item — opens a child menu beside this button on click
      // (or hover, on desktop). Parent menu stays open. The ` ▸` glyph
      // signals there's a deeper level.
      const arrow = document.createElement('span');
      arrow.className = 'ctx-menu-item-arrow';
      arrow.textContent = '▸';
      b.appendChild(arrow);

      const openMySubmenu = () => {
        const myLevel = openMenuStack.indexOf(menu);
        if (myLevel < 0) return;
        // If a different submenu was already open at deeper levels,
        // close it first so only one chain stays expanded at a time.
        closeMenuLevel(myLevel + 1);
        const sub = buildMenu(item.submenu, opts);
        document.body.appendChild(sub);
        openMenuStack.push(sub);
        positionSubmenu(sub, b);
      };

      b.addEventListener('click', e => {
        e.stopPropagation();
        openMySubmenu();
      });

      if (HOVER_CAPABLE) {
        let hoverTimer = null;
        b.addEventListener('mouseenter', () => {
          if (hoverTimer) clearTimeout(hoverTimer);
          hoverTimer = setTimeout(openMySubmenu, SUBMENU_HOVER_DELAY);
        });
        b.addEventListener('mouseleave', () => {
          if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        });
      }
    } else {
      // Leaf item — hover closes any sibling submenu at deeper levels,
      // so moving the mouse from a submenu back into the parent's
      // sibling items doesn't leave a stale child menu floating.
      if (HOVER_CAPABLE) {
        b.addEventListener('mouseenter', () => {
          const myLevel = openMenuStack.indexOf(menu);
          if (myLevel >= 0) closeMenuLevel(myLevel + 1);
        });
      }
      b.addEventListener('click', e => {
        e.stopPropagation();
        closeMenu();
        item.action();
      });
    }
    menu.appendChild(b);
  }

  return menu;
}

// Build and mount a ctx-menu with the given items. items: [{label, action,
// danger?} | {separator: true} | {label, submenu: [...]}]. Returns the menu
// element so callers that want fancier markup can decorate before display.
export function showMenu(items, x, y, opts = {}) {
  closeMenu();
  const menu = buildMenu(items, opts);
  document.body.appendChild(menu);
  openMenuStack.push(menu);
  positionMenu(menu, x, y, opts);
  return menu;
}

// Fires fn(x, y) after ~500 ms of sustained press without significant
// movement. Works for touch (primary), mouse (desktop fallback), and
// contextmenu (right-click).
export function attachLongPress(el, fn) {
  let timer = null;
  let startX = 0, startY = 0;
  const cancelOnce = e => { e.stopPropagation(); e.preventDefault(); };

  const start = (x, y) => {
    startX = x; startY = y;
    timer = setTimeout(() => {
      // Suppress the click event that follows the touch release so a
      // long-press doesn't double-fire.
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
  const end = () => { if (timer) { clearTimeout(timer); timer = null; } };

  el.addEventListener('touchstart', e => { const t = e.touches[0]; start(t.clientX, t.clientY); }, {passive: true});
  el.addEventListener('touchmove',  e => { const t = e.touches[0]; move(t.clientX, t.clientY); }, {passive: true});
  el.addEventListener('touchend',    end);
  el.addEventListener('touchcancel', end);

  el.addEventListener('mousedown', e => { if (e.button === 0) start(e.clientX, e.clientY); });
  el.addEventListener('mousemove', e => move(e.clientX, e.clientY));
  el.addEventListener('mouseup',    end);
  el.addEventListener('mouseleave', end);

  el.addEventListener('contextmenu', e => { e.preventDefault(); fn(e.clientX, e.clientY); });
}
