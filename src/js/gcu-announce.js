// Announce ep's presence to the GCU hyper inspector by writing a
// gcu:tool:ep marker (+ optional gcu:log:ep boot timeline) to
// localStorage on each boot. The convention is documented in the
// hyper repo's SPEC.md — hyper reads all gcu:tool:* and gcu:log:*
// keys on its origin to attribute storage entries (caches / IDB / LS /
// SWs) to the tools that own them and surface a basic recovery
// timeline.
//
// User-facing disclosure: README.md § "What ep writes to your browser".
// User toggle: Settings → GCU integration → "discoverable by hyper".
// When disabled, both writes are skipped and any prior entries are
// removed (the settings handler does the removal).
//
// Nothing leaves the browser — these are local-only LS entries that
// only same-origin GCU tools (specifically, hyper) can read.
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

// Check the opt-out setting once. Settings live under 'ep:settings' in
// localStorage; we read the raw key directly to avoid a circular import
// on storage.js (this module runs as a side effect from main.js's import
// before settings module wiring). Default ON — most users want hyper
// to be able to find ep when something goes wrong.
function gcuShareEnabled() {
  try {
    const raw = localStorage.getItem('ep:settings');
    if (!raw) return true;  // no settings yet => default
    const s = JSON.parse(raw);
    return s.gcuShare !== false;  // explicit `false` opts out
  } catch {
    return true;
  }
}

if (gcuShareEnabled()) {
  epAnnounce();
}

// gcu:log — small bounded ring of diagnostic events that hyper surfaces
// in each tool's show-details section. Capped at 50 entries × 500 bytes
// per entry (~25 KB total). Append-and-trim; oldest entries fall off.
// Spec: hyper/SPEC.md § "The `gcu:log` diagnostic convention".
//
// DO NOT log user content, PII, secrets, or large payloads — these
// breadcrumbs end up in hyper's exports and should read like a
// public bug-report timeline.
function gcuLog(name, type, data = {}) {
  try {
    const key = `gcu:log:${name}`;
    let entries = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '{"entries":[]}');
      entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {}
    const entry = { t: Date.now(), type, ...data };
    if (JSON.stringify(entry).length > 500) return;  // refuse oversize
    entries.push(entry);
    if (entries.length > 50) entries = entries.slice(-50);
    localStorage.setItem(key, JSON.stringify({ schema: 1, entries }));
  } catch {
    // localStorage unavailable — silently skip.
  }
}

if (gcuShareEnabled()) {
  gcuLog('ep', 'boot', { v: EP_VERSION });
}
