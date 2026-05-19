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

const DESKTOP_MIN_WIDTH = 1024;

function currentBand() {
  return (window.innerWidth >= DESKTOP_MIN_WIDTH) ? 'desktop' : 'mobile';
}

let _lastBand = null;

function applyViewport() {
  const band = currentBand();
  if (band === _lastBand) return;
  _lastBand = band;
  document.documentElement.setAttribute('data-viewport', band);
  window.dispatchEvent(new CustomEvent('ep:viewport-changed', { detail: { band } }));
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
