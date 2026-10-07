// Viewport breakpoint mechanism. Sets `data-viewport` on <html> based on
// window width; emits `ep:viewport-changed` whenever the band shifts. Both
// CSS (via attribute selectors) and JS modules (via the event) can read
// the same signal.
//
// Bands:
//   <  1024px → "mobile"   (default; mobile/tablet form factor)
//   >= 1024px → "desktop"  (small-laptop-and-up form factor)
//
// The breakpoint is intentionally inclusive of small laptops (13" MacBooks
// at 1280×800, iPads in landscape at 1024×768). It's the most-inclusive
// "big screen" threshold; tools that want to be more conservative can
// check innerWidth themselves.
//
// Pocket (SPEC-pocket §3): a second, tighter signal for the phone-first
// layout. `data-pocket="1"` on <html> at ≤ 720px, or whenever the page
// is opened with `?mobile=1` (so desktop smokes and screenshots can force
// it). Forcing pocket also forces the "mobile" band — the persistent
// desktop drawer makes no sense inside the phone layout.

const DESKTOP_MIN_WIDTH = 1024;
const POCKET_MAX_WIDTH  = 720;

function forcedPocket() {
  try { return new URLSearchParams(window.location.search).get('mobile') === '1'; }
  catch { return false; }
}

function currentBand() {
  if (forcedPocket()) return 'mobile';
  return (window.innerWidth >= DESKTOP_MIN_WIDTH) ? 'desktop' : 'mobile';
}

// Public helper: is the phone-first layout active?
export function isPocket() {
  return forcedPocket() || window.innerWidth <= POCKET_MAX_WIDTH;
}

let _lastBand = null;
let _lastPocket = null;

function applyViewport() {
  const band = currentBand();
  if (band !== _lastBand) {
    _lastBand = band;
    document.documentElement.setAttribute('data-viewport', band);
    window.dispatchEvent(new CustomEvent('ep:viewport-changed', { detail: { band } }));
  }
  const pocket = isPocket();
  if (pocket !== _lastPocket) {
    _lastPocket = pocket;
    if (pocket) document.documentElement.setAttribute('data-pocket', '1');
    else        document.documentElement.removeAttribute('data-pocket');
    window.dispatchEvent(new CustomEvent('ep:pocket-changed', { detail: { pocket } }));
  }
}

// Initial application (synchronous so the first render sees the correct
// attribute and any CSS keyed to it applies on first paint).
applyViewport();

// Re-check on resize. matchMedia + change event would be tighter, but
// resize fires plenty fast and we'd still want to recompute on
// orientation change which doesn't always fire a media-query change.
window.addEventListener('resize', applyViewport, { passive: true });
window.addEventListener('orientationchange', applyViewport);

// Public helper for modules that want a sync check (drawer, snapshot
// panel, etc.) without listening for the event themselves.
export function isDesktop() {
  return currentBand() === 'desktop';
}

// One input surface at a time (SPEC-pocket §3.1): when a sheet opens on
// the phone, drop focus so the system keyboard goes away. No-op outside
// pocket mode and when nothing focusable is active.
export function dismissKeyboard() {
  if (!isPocket()) return;
  const a = document.activeElement;
  if (a && a !== document.body && typeof a.blur === 'function') a.blur();
}

// ── Keyboard inset tracking (mobile) ────────────────────────────────
//
// On iOS Safari (and some Android setups), the virtual keyboard
// OVERLAYS the layout viewport — `position: fixed; bottom: 0` ends up
// behind the keyboard. The visualViewport API exposes the actual
// visible area, so we can compute the keyboard's height and surface
// it as a CSS variable.
//
// Formula: gap = window.innerHeight - visualViewport.height - offsetTop.
// - iOS (keyboard as overlay): innerHeight stays full, vv.height shrinks.
//   gap = keyboard height. CSS uses it to shift fixed elements up.
// - Android Chrome with `interactive-widget=resizes-content`: innerHeight
//   shrinks too; gap ≈ 0. The layout already moved, no further shift
//   needed. Same formula handles both cases cleanly.
// - Desktop without keyboard: gap is always 0. CSS rules can use the
//   variable with a safe `var(--ep-kbd-inset, 0)` fallback.
if (typeof window !== 'undefined' && window.visualViewport) {
  const vv = window.visualViewport;
  const updateKbdInset = () => {
    const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--ep-kbd-inset', gap + 'px');
  };
  vv.addEventListener('resize', updateKbdInset);
  vv.addEventListener('scroll', updateKbdInset);
  // Set the initial value so first paint has the right inset even
  // before any focus event.
  updateKbdInset();
}
