// Announce ep's presence to the GCU hyper inspector by writing a
// gcu:tool:ep marker to localStorage on each boot. The convention is
// documented in the hyper repo's SPEC.md — hyper reads all gcu:tool:*
// keys on its origin to attribute storage entries (caches / IDB / LS /
// SWs) to the tools that own them.
//
// Tools that don't announce themselves still appear in hyper via
// heuristic fallback (IDB name match, LS prefix match), so this is a
// nicety that improves the inspector UX rather than a hard requirement.
//
// EP_VERSION is auto-derived at build time from git: build.js replaces
// the __EP_VERSION__ string literal below with `YYYY-MM-DD (sha[+dirty])`.
// In dev (when loading via dev.html with no build step), the placeholder
// survives and the runtime check below collapses it to 'dev'.

const _EP_VERSION_RAW = '__EP_VERSION__';
const EP_VERSION = _EP_VERSION_RAW.includes('__EP_VERSION__') ? 'dev' : _EP_VERSION_RAW;

const INSTALLED_AT_KEY = 'ep:installedAt';
const ANNOUNCE_KEY     = 'gcu:tool:ep';

function epAnnounce() {
  try {
    let installedAt = Number(localStorage.getItem(INSTALLED_AT_KEY));
    if (!installedAt || !Number.isFinite(installedAt)) {
      installedAt = Date.now();
      localStorage.setItem(INSTALLED_AT_KEY, String(installedAt));
    }
    localStorage.setItem(ANNOUNCE_KEY, JSON.stringify({
      name: 'ep',
      displayName: 'ep',
      version: EP_VERSION,
      installedAt,
      lastBootedAt: Date.now(),
      storageKeys: {
        idb: ['ep'],
        localStoragePrefix: 'ep:',
        cacheNames: ['ep-shell-v1'],
        swScopes: ['/ep/'],  // expected scope when deployed at gentropic.org/ep/
      },
      links: {
        homepage: 'https://gentropic.org/ep/',
        repo: 'https://github.com/gentropic/ep',
      },
    }));
  } catch {
    // localStorage unavailable (private mode quota, file:// quirk, etc.) —
    // silently skip. hyper's heuristic fallback still finds us by IDB
    // name + LS prefix.
  }
}

epAnnounce();
