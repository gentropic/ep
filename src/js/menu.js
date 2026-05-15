// Shared menu + long-press plumbing. No deps on state / storage / DOM
// elements that only exist in the editor build — so the viewer artifact
// can pull this in without dragging the rest of ep's editor surface along.
//
// Used by:
//   - ctxmenu.js  (per-program context menu in the drawer)
//   - scenarios.js (per-scenario rename / delete)
//   - drawer.js   (long-press on saved-program rows)
//   - render.js   (copy-as menu on output chips)

let openMenuEl = null;

export function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

window.addEventListener('click', e => {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
});
window.addEventListener('scroll', closeMenu, true);
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

// Build and mount a ctx-menu with the given items. items: [{label, action,
// danger?} | {separator: true}]. Returns the menu element so callers that
// want fancier markup can decorate before display.
export function showMenu(items, x, y, opts = {}) {
  closeMenu();
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
    b.addEventListener('click', e => {
      e.stopPropagation();
      closeMenu();
      item.action();
    });
    menu.appendChild(b);
  }

  document.body.appendChild(menu);
  openMenuEl = menu;
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
