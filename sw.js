// Minimal service worker for ep.
//
// Doesn't cache anything — ep ships as a single self-contained HTML
// file (~1.4 MB inlined) with no network dependencies, so there's
// nothing to pre-cache and nothing to runtime-cache. The browser's
// HTTP cache already handles serving index.html from disk on second
// load.
//
// We register one anyway because:
//   (a) Chromium-based browsers require an active SW with a `fetch`
//       handler before they'll show the install prompt;
//   (b) iOS Safari needs an SW to consider the page "fully PWA" for
//       some integrations;
//   (c) future-proofing — if we ever start fetching external resources
//       (gh:/gist:/etc loaders, telemetry, etc.) the SW can layer
//       offline behavior on top without re-pluming registration.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch handler. Present so Chrome counts the worker as
// "controlling fetches"; doing nothing means the browser uses its
// normal HTTP cache + network logic.
self.addEventListener('fetch', () => { /* network is fine */ });
