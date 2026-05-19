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
