// ep service worker — cache-first + stale-while-revalidate.
//
// Goal: ep loads instantly even on a flaky connection. The whole app is
// a single ~1.5 MB HTML file; cache it on install, serve it from cache
// on every navigation, and in the background fetch a fresh copy. If the
// fresh copy's bytes differ from the cached copy, broadcast an update
// signal to the live page; the page shows a "reload to apply" toast.
//
// Versioning: we don't try to compute a build hash. The cache name is
// fixed; bytes comparison detects updates. On a `skipWaiting` install
// path we just take over the next time the user reloads.
//
// Settings interaction: ep can ask this worker to (a) skip the
// background refresh ("auto-check off") or (b) explicitly run one now.
// Messages on `navigator.serviceWorker.controller.postMessage(...)`.

const CACHE = 'ep-shell-v1';
const SHELL = [
  './',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
];

let _autoCheck = true;     // toggled by main thread via message

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
                       .catch(() => { /* offline at install — best-effort */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Only intercept same-origin GETs — leave cross-origin alone.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(handle(req));
});

async function handle(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });

  if (cached) {
    // Cache hit — serve immediately. Background refresh runs in parallel
    // unless the user has turned off auto-check.
    if (_autoCheck) revalidate(req, cache, cached);
    return cached;
  }

  // Cache miss — go to network, store the result.
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (e) {
    // Last-ditch: maybe there's a cached navigation that fits.
    const navFallback = await cache.match('./');
    if (navFallback) return navFallback;
    throw e;
  }
}

// Re-fetch from network, compare bytes against the cached copy, replace
// the cache and notify clients if different. Errors are swallowed —
// background refresh failing should never break the user's session.
async function revalidate(req, cache, cached) {
  try {
    const fresh = await fetch(req, { cache: 'no-store' });
    if (!fresh || !fresh.ok) return;
    const a = await cached.clone().arrayBuffer();
    const b = await fresh.clone().arrayBuffer();
    await cache.put(req, fresh.clone());
    if (!bytesEqual(a, b)) {
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'ep:update-available', url: req.url });
      }
    }
  } catch { /* offline / failed refresh — ignore */ }
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a), vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

// Message protocol with the main thread.
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'ep:set-auto-check') {
    _autoCheck = !!msg.value;
    return;
  }
  if (msg.type === 'ep:check-now') {
    // Run a revalidation against the navigation root and reply with
    // the timestamp so the UI can show "last checked".
    caches.open(CACHE).then(async (cache) => {
      const root = new Request(new URL('./', self.location.href).toString());
      const cached = await cache.match(root, { ignoreSearch: true });
      if (cached) await revalidate(root, cache, cached);
      else { try { const r = await fetch(root); if (r.ok) await cache.put(root, r.clone()); } catch {} }
      event.source && event.source.postMessage({
        type: 'ep:check-complete', at: Date.now(),
      });
    });
    return;
  }
});
