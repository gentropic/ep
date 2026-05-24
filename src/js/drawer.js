// Hamburger drawer — open/close, swipe-to-close, program list rendering.
// Open is hamburger-only (no swipe-open) to avoid conflicting with Android's
// system back gesture.

import { readStore, currentProgramName, loadProgramByName, newProgram, programDescription, formatAgo, getSetting, setSetting, listSnapshots, restoreSnapshot, pinSnapshot, deleteSnapshot, takeSnapshot } from './storage.js';
import { openProgramMenu } from './ctxmenu.js';
import { attachLongPress, closeMenu, showMenu } from './menu.js';
import { isDesktop } from './viewport.js';
import { epConfirm, epPrompt } from './dialogs.js';
import { DOCS, DOC_GROUPS } from './docs.js';
import { GUIDES, renderMarkdown } from './guides.js';
import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults, insertUseStatement } from './render.js';
import { VENDORED_MODULES } from '../../ext/numbat/dist/numbat.js';
import { removeAsset, renameAsset, assetInfo, attachCsv } from './csv-assets.js';
import { pickCsvAndAttach, showAttachDialog } from './attach-dialog.js';
import { showDatasetViewer } from './dataset-viewer.js';

const menuBtn        = document.getElementById('menuBtn');
const drawer         = document.getElementById('drawer');
const drawerScrim    = document.getElementById('drawerScrim');
const drawerCloseBtn = document.getElementById('drawerCloseBtn');
const drawerTitleEl  = document.getElementById('drawerTitle');
const drawerListEl   = document.getElementById('drawerList');
const drawerSearchEl = document.getElementById('drawerSearch');
const drawerSortBtn  = document.getElementById('drawerSortBtn');
const newProgBtn     = document.getElementById('newProgBtn');
const openFileBtn    = document.getElementById('openFileBtn');
const drawerFileInput = document.getElementById('fileInput');
const drawerModeProgramsBtn = document.getElementById('drawerModeProgramsBtn');
const drawerModeHistoryBtn  = document.getElementById('drawerModeHistoryBtn');
const drawerModeDocsBtn     = document.getElementById('drawerModeDocsBtn');
const drawerModeDataBtn     = document.getElementById('drawerModeDataBtn');
const drawerHistoryListEl   = document.getElementById('drawerHistoryList');
const drawerHistoryHdrEl    = document.getElementById('drawerHistoryHdr');
const drawerSnapshotNowBtn  = document.getElementById('drawerSnapshotNowBtn');
const drawerDocsSearchEl    = document.getElementById('drawerDocsSearch');
const drawerDocsListEl      = document.getElementById('drawerDocsList');
const drawerAssetsListEl    = document.getElementById('drawerAssetsList');
const attachCsvBtn          = document.getElementById('attachCsvBtn');

let searchFilter = '';
let docsSearchFilter = '';
let drawerOpenGuide = null;    // slug of currently-expanded guide, or null
let drawerMode = 'programs';   // 'programs' | 'history' | 'docs'

// Show/hide the program-mode sections vs history-mode sections, update
// the title + active tab. Doesn't re-render — caller fires renderDrawer
// (or renderHistory) afterwards. Exported so ctxmenu's "history" action
// can flip the drawer in persistent mode.
export function setDrawerMode(mode) {
  drawerMode = ['history', 'docs', 'data'].includes(mode) ? mode : 'programs';
  for (const m of ['programs', 'history', 'docs', 'data']) {
    for (const el of document.querySelectorAll('.drawer-mode-' + m)) {
      el.style.display = drawerMode === m ? '' : 'none';
    }
  }
  for (const [btn, m] of [
    [drawerModeProgramsBtn, 'programs'],
    [drawerModeHistoryBtn,  'history'],
    [drawerModeDocsBtn,     'docs'],
    [drawerModeDataBtn,     'data'],
  ]) {
    if (!btn) continue;
    btn.classList.toggle('active', drawerMode === m);
    btn.setAttribute('aria-selected', drawerMode === m);
  }
  if (drawerTitleEl) {
    drawerTitleEl.textContent =
        drawerMode === 'history' ? `ep · history${currentProgramName ? ' · ' + currentProgramName : ''}`
      : drawerMode === 'docs'    ? 'ep · docs'
      : drawerMode === 'data'    ? 'ep · data'
      :                            'ep · programs';
  }
  if      (drawerMode === 'history') renderHistoryList();
  else if (drawerMode === 'docs')    renderDocsList();
  else if (drawerMode === 'data')    renderAssetsList();
  else                                renderDrawerList();
}

// Desktop persistent-drawer mode: when the viewport is desktop AND the
// user hasn't opted out via Settings, the drawer is a sidebar that stays
// open. closeDrawer becomes a no-op, the scrim is hidden, and the app
// content shifts right (CSS handles the layout via the `persistent`
// class on the drawer). The hamburger close button is still wired up
// to closeDrawer; in persistent mode the close button itself is hidden
// via CSS rather than being made functional-but-overridden.
function persistentMode() {
  return isDesktop() && getSetting('desktopDrawer', true);
}

function applyPersistentClass() {
  // ep-drawer-persistent lives on <html> (not body) so the head script
  // can set it before first paint to avoid a slide-in animation on every
  // refresh. drawer.js keeps it in sync at runtime; CSS rules use it
  // as a descendant selector so both <html> and <body> placements work.
  if (persistentMode()) {
    drawer.classList.add('persistent');
    document.documentElement.classList.add('ep-drawer-persistent');
  } else {
    drawer.classList.remove('persistent');
    document.documentElement.classList.remove('ep-drawer-persistent');
  }
  updateDrawerInert();
}

// The drawer is rendered off-screen with transform: translateX(-100%) when
// closed in mobile/modal mode — visually hidden but still in tab order.
// Setting `inert` on the whole drawer removes its descendants from the
// focus/tab tree, so Tab from the header doesn't blow past the editor
// into invisible drawer buttons. Re-enabled whenever the drawer is
// actually visible (open as modal OR persistent sidebar).
function updateDrawerInert() {
  const visible = persistentMode() || drawer.classList.contains('on');
  if (visible) drawer.removeAttribute('inert');
  else drawer.setAttribute('inert', '');
}

export function openDrawer({focusSearch = false} = {}) {
  drawer.classList.add('on');
  drawerScrim.classList.add('on');
  updateDrawerInert();
  renderDrawerList();
  if (focusSearch && drawerSearchEl) setTimeout(() => drawerSearchEl.focus(), 30);
}

export function closeDrawer() {
  // In persistent mode, the drawer stays open; user can still interact
  // with elements inside it (search, list, settings) but the standard
  // close paths (scrim click, Esc, action-clicks-that-also-close) become
  // no-ops. The drawer is a permanent part of the layout, not a modal.
  if (persistentMode()) return;
  drawer.classList.remove('on');
  drawerScrim.classList.remove('on');
  updateDrawerInert();
  closeMenu();
}

menuBtn.addEventListener('click', () => openDrawer());
drawerCloseBtn.addEventListener('click', closeDrawer);
drawerScrim.addEventListener('click', closeDrawer);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && drawer.classList.contains('on')) closeDrawer();
});
window.addEventListener('ep:close-drawer', closeDrawer);
// Re-render whichever list is currently visible when storage changes
// underneath us (another tab saved, a snapshot was taken/restored, etc).
window.addEventListener('ep:storage-changed', () => {
  if      (drawerMode === 'history') renderHistoryList();
  else if (drawerMode === 'data')    renderAssetsList();
  else                               renderDrawerList();
});

// snapshots.js dispatches this when the user opens "history" for a
// program while the persistent drawer is active. Load that program if
// it's not current, then flip the drawer to history mode.
window.addEventListener('ep:open-snapshots-in-drawer', e => {
  const name = e.detail && e.detail.name;
  if (name && name !== currentProgramName) loadProgramByName(name);
  setDrawerMode('history');
});

if (drawerModeProgramsBtn) {
  drawerModeProgramsBtn.addEventListener('click', () => setDrawerMode('programs'));
}
if (drawerModeHistoryBtn) {
  drawerModeHistoryBtn.addEventListener('click', () => setDrawerMode('history'));
}
if (drawerModeDocsBtn) {
  drawerModeDocsBtn.addEventListener('click', () => setDrawerMode('docs'));
}
if (drawerModeDataBtn) {
  drawerModeDataBtn.addEventListener('click', () => setDrawerMode('data'));
}
if (attachCsvBtn) {
  attachCsvBtn.addEventListener('click', () => pickCsvAndAttach());
}
if (drawerDocsSearchEl) {
  drawerDocsSearchEl.addEventListener('input', e => {
    docsSearchFilter = (e.target.value || '').toLowerCase();
    // Searching pops the user back to the index — they want to see
    // matches across all guides, not within whichever one happened to
    // be open.
    drawerOpenGuide = null;
    renderDocsList();
  });
}
if (drawerSnapshotNowBtn) {
  drawerSnapshotNowBtn.addEventListener('click', async () => {
    const name = currentProgramName;
    if (!name) return;
    const label = await epPrompt({
      title: 'Take snapshot',
      label: 'label (optional)',
      value: '',
      okLabel: 'Snapshot',
    });
    if (label === null) return;
    takeSnapshot(name, (label || '').trim() || null);
    renderHistoryList();
  });
}

// Docs list rendering. Top: navigable list of guide pages (or the
// currently-expanded guide body). Below: function reference grouped by
// category, filtered by docsSearchFilter. Both sections respect the
// same search input so users can filter prose AND symbols together.
function renderDocsList() {
  if (!drawerDocsListEl) return;
  drawerDocsListEl.innerHTML = '';
  const q = docsSearchFilter;

  // ── Guides section ─────────────────────────────────────────────
  // When a guide is opened (drawerOpenGuide is set), render just its
  // body with a back link. Otherwise show the navigable index.
  if (Array.isArray(GUIDES) && GUIDES.length) {
    const guidesHdr = document.createElement('div');
    guidesHdr.className = 'drawer-docs-grouphdr';
    guidesHdr.textContent = 'Guides';
    drawerDocsListEl.appendChild(guidesHdr);

    if (drawerOpenGuide) {
      const idx = GUIDES.findIndex(x => x.slug === drawerOpenGuide);
      const g = idx >= 0 ? GUIDES[idx] : null;
      if (g) {
        const back = document.createElement('a');
        back.className = 'drawer-docs-back';
        back.href = '#';
        back.textContent = '← all guides';
        back.addEventListener('click', e => {
          e.preventDefault();
          drawerOpenGuide = null;
          renderDocsList();
        });
        drawerDocsListEl.appendChild(back);
        const body = document.createElement('div');
        body.className = 'guide-body';
        for (const node of renderMarkdown(g.body)) body.appendChild(node);
        drawerDocsListEl.appendChild(body);
        // Prev/next nav — shown only when there's an adjacent guide.
        // Wraps neither end; reaching the edge just hides that side
        // (rather than jumping to the opposite end, which would
        // surprise users who don't realize they wrapped).
        const prev = idx > 0 ? GUIDES[idx - 1] : null;
        const next = idx < GUIDES.length - 1 ? GUIDES[idx + 1] : null;
        if (prev || next) {
          const nav = document.createElement('div');
          nav.className = 'drawer-guide-nav';
          const makeLink = (g2, label, side) => {
            const a = document.createElement('a');
            a.className = 'drawer-guide-nav-link drawer-guide-nav-' + side;
            a.href = '#';
            const arrow = document.createElement('span');
            arrow.className = 'drawer-guide-nav-arrow';
            arrow.textContent = side === 'prev' ? '←' : '→';
            const meta = document.createElement('div');
            meta.className = 'drawer-guide-nav-meta';
            const lbl = document.createElement('div');
            lbl.className = 'drawer-guide-nav-label';
            lbl.textContent = label;
            const ttl = document.createElement('div');
            ttl.className = 'drawer-guide-nav-title';
            ttl.textContent = g2.title;
            meta.appendChild(lbl);
            meta.appendChild(ttl);
            // For 'prev' the arrow is on the left of the meta; for
            // 'next' it's on the right. CSS handles ordering via
            // flex-direction; here we just append both in a stable
            // order.
            if (side === 'prev') { a.appendChild(arrow); a.appendChild(meta); }
            else                  { a.appendChild(meta);  a.appendChild(arrow); }
            a.addEventListener('click', e => {
              e.preventDefault();
              drawerOpenGuide = g2.slug;
              renderDocsList();
              // Scroll back to the top so the user starts at the heading.
              if (drawerDocsListEl.parentElement) drawerDocsListEl.parentElement.scrollTop = 0;
            });
            return a;
          };
          // Left slot: prev (or blank spacer so right slot stays right-aligned).
          if (prev) nav.appendChild(makeLink(prev, 'previous', 'prev'));
          else      nav.appendChild(document.createElement('div'));
          if (next) nav.appendChild(makeLink(next, 'next', 'next'));
          else      nav.appendChild(document.createElement('div'));
          drawerDocsListEl.appendChild(nav);
        }
      }
    } else {
      // Index. Filter by search query (title + summary substring).
      const matches = (g) => {
        if (!q) return true;
        return g.title.toLowerCase().includes(q) ||
               (g.summary || '').toLowerCase().includes(q) ||
               (g.body || '').toLowerCase().includes(q);
      };
      const visible = GUIDES.filter(matches);
      if (!visible.length && q) {
        const empty = document.createElement('div');
        empty.className = 'drawer-docs-empty';
        empty.textContent = `no guides match "${q}"`;
        drawerDocsListEl.appendChild(empty);
      } else {
        for (const g of visible) {
          const row = document.createElement('div');
          row.className = 'drawer-guide-row';
          const title = document.createElement('div');
          title.className = 'drawer-guide-title';
          title.textContent = g.title;
          row.appendChild(title);
          if (g.summary) {
            const sum = document.createElement('div');
            sum.className = 'drawer-guide-summary';
            sum.textContent = g.summary;
            row.appendChild(sum);
          }
          row.addEventListener('click', () => {
            drawerOpenGuide = g.slug;
            renderDocsList();
            // Scroll the panel back to the top so the user starts reading
            // from the heading, not wherever the guide-row sat.
            if (drawerDocsListEl.parentElement) drawerDocsListEl.parentElement.scrollTop = 0;
          });
          drawerDocsListEl.appendChild(row);
        }
      }
    }
  }

  // ── Function reference section ─────────────────────────────────
  // Skip when a single guide is opened — the user came in to read prose,
  // not browse symbols. The "← all guides" link brings them back.
  if (drawerOpenGuide) return;

  // ── Modules section ────────────────────────────────────────────
  // List every vendored numbat module path; click inserts
  // `use module::path` at the top of the editor. Grouped by the
  // top-level namespace (`units::*`, `math::*`, etc.) for browsability.
  // Respects the same search filter as the rest of the docs panel.
  if (VENDORED_MODULES && typeof VENDORED_MODULES === 'object') {
    const allPaths = Object.keys(VENDORED_MODULES).filter(p => !q || p.toLowerCase().includes(q));
    if (allPaths.length) {
      const modHdr = document.createElement('div');
      modHdr.className = 'drawer-docs-grouphdr';
      modHdr.style.marginTop = '12px';
      modHdr.textContent = 'Modules';
      drawerDocsListEl.appendChild(modHdr);

      // Group by top-level namespace (the part before the first `::`).
      const byNs = new Map();
      for (const p of allPaths.sort()) {
        const ns = p.split('::')[0];
        if (!byNs.has(ns)) byNs.set(ns, []);
        byNs.get(ns).push(p);
      }
      for (const [ns, paths] of byNs) {
        const subHdr = document.createElement('div');
        subHdr.className = 'drawer-docs-grouphdr drawer-docs-grouphdr-sub';
        subHdr.textContent = ns + '::';
        drawerDocsListEl.appendChild(subHdr);
        for (const path of paths) {
          drawerDocsListEl.appendChild(buildModuleItem(path));
        }
      }
    }
  }

  const refHdr = document.createElement('div');
  refHdr.className = 'drawer-docs-grouphdr';
  refHdr.style.marginTop = '12px';
  refHdr.textContent = 'Function reference';
  drawerDocsListEl.appendChild(refHdr);
  const matches = (name) => {
    if (!q) return true;
    if (name.toLowerCase().includes(q)) return true;
    const d = DOCS[name];
    if (!d) return false;
    if (d.description && d.description.toLowerCase().includes(q)) return true;
    if (d.signature   && d.signature.toLowerCase().includes(q))   return true;
    return false;
  };
  // Track which names belong to a known group so unlisted ones can be
  // surfaced in an "Other" bucket at the bottom — keeps doc additions
  // discoverable even before they've been grouped.
  const grouped = new Set();
  let anyVisible = false;
  for (const group of DOC_GROUPS) {
    const visible = group.names.filter(n => DOCS[n] && matches(n));
    for (const n of group.names) grouped.add(n);
    if (!visible.length) continue;
    anyVisible = true;
    const hdr = document.createElement('div');
    hdr.className = 'drawer-docs-grouphdr';
    hdr.textContent = group.label;
    drawerDocsListEl.appendChild(hdr);
    for (const n of visible) drawerDocsListEl.appendChild(buildDocItem(n));
  }
  // Sweep any DOCS entries not in DOC_GROUPS into an "Other" tail bucket.
  const extras = Object.keys(DOCS).filter(n => !grouped.has(n) && matches(n));
  if (extras.length) {
    anyVisible = true;
    const hdr = document.createElement('div');
    hdr.className = 'drawer-docs-grouphdr';
    hdr.textContent = 'Other';
    drawerDocsListEl.appendChild(hdr);
    for (const n of extras.sort()) drawerDocsListEl.appendChild(buildDocItem(n));
  }
  if (!anyVisible) {
    const empty = document.createElement('div');
    empty.className = 'drawer-docs-empty';
    empty.textContent = q ? `no docs match "${q}"` : 'no docs available';
    drawerDocsListEl.appendChild(empty);
  }
}

// Lightweight extractor: walks a .nbt source and pulls out the
// declarations the user would care about — units, functions,
// dimensions, structs. Misses some compound shapes (e.g. units with
// multi-line annotations) but covers the common case for browsing
// purposes. Not a parser; just regexes on stripped lines.
function extractModuleSymbols(source) {
  if (!source || typeof source !== 'string') return [];
  const out = [];
  const seen = new Set();
  const push = (kind, name) => {
    const key = kind + ':' + name;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name });
  };
  const unitRe   = /^unit\s+([A-Za-z_][\w]*)/;
  const fnRe     = /^fn\s+([A-Za-z_][\w]*)/;
  const dimRe    = /^dimension\s+([A-Za-z_][\w]*)/;
  const structRe = /^struct\s+([A-Za-z_][\w]*)/;
  // Strip the line of leading whitespace + a leading decorator block so
  // `@metric_prefixes unit foo: …` still matches. Decorators that own
  // their own line are handled by the per-line walk skipping them.
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '').replace(/^(?:@\w+(?:\([^)]*\))?\s*)+/, '');
    let m;
    if      ((m = unitRe.exec(line)))    push('unit',   m[1]);
    else if ((m = fnRe.exec(line)))      push('fn',     m[1]);
    else if ((m = dimRe.exec(line)))     push('dim',    m[1]);
    else if ((m = structRe.exec(line)))  push('struct', m[1]);
  }
  return out;
}

// Module row — caret on the left toggles an expansion body showing
// the module's exported symbols. Clicking the body of the row
// (anywhere outside the caret) inserts `use module::path` at the top
// of the editor and closes the drawer on mobile.
function buildModuleItem(path) {
  const row = document.createElement('div');
  row.className = 'drawer-docs-row drawer-docs-row-module';

  const headEl = document.createElement('div');
  headEl.className = 'drawer-docs-mod-head';

  const caret = document.createElement('span');
  caret.className = 'drawer-docs-mod-caret';
  caret.textContent = '▶';
  caret.setAttribute('aria-label', 'expand');
  headEl.appendChild(caret);

  const body = document.createElement('div');
  body.className = 'drawer-docs-mod-body-text';
  const nameEl = document.createElement('div');
  nameEl.className = 'drawer-docs-name';
  nameEl.textContent = path;
  body.appendChild(nameEl);
  const sig = document.createElement('div');
  sig.className = 'drawer-docs-sig';
  sig.textContent = `use ${path}`;
  body.appendChild(sig);
  headEl.appendChild(body);

  row.appendChild(headEl);

  // Expansion body: lazy-built on first toggle. Symbol list grouped by
  // kind; each entry copies its name to the clipboard on click (same
  // gesture as the Function reference rows).
  let expansion = null;
  let expanded = false;
  const toggleExpansion = () => {
    if (!expansion) {
      expansion = document.createElement('div');
      expansion.className = 'drawer-docs-mod-symbols';
      const src = (typeof VENDORED_MODULES === 'object' && VENDORED_MODULES[path]) || '';
      const syms = extractModuleSymbols(src);
      if (!syms.length) {
        const empty = document.createElement('div');
        empty.className = 'drawer-docs-empty';
        empty.textContent = '(no top-level declarations)';
        expansion.appendChild(empty);
      } else {
        const byKind = { unit: [], fn: [], dim: [], struct: [] };
        for (const s of syms) (byKind[s.kind] || (byKind[s.kind] = [])).push(s.name);
        const labels = { unit: 'units', fn: 'functions', dim: 'dimensions', struct: 'structs' };
        for (const kind of ['dim', 'struct', 'unit', 'fn']) {
          const list = byKind[kind];
          if (!list || !list.length) continue;
          const hdr = document.createElement('div');
          hdr.className = 'drawer-docs-mod-kindhdr';
          hdr.textContent = `${labels[kind]} (${list.length})`;
          expansion.appendChild(hdr);
          const grid = document.createElement('div');
          grid.className = 'drawer-docs-mod-symgrid';
          for (const name of list) {
            const tag = document.createElement('span');
            tag.className = 'drawer-docs-mod-sym';
            tag.textContent = name;
            tag.addEventListener('click', (e) => {
              e.stopPropagation();
              try { navigator.clipboard && navigator.clipboard.writeText(name); } catch {}
              tag.classList.add('drawer-docs-row-flash');
              setTimeout(() => tag.classList.remove('drawer-docs-row-flash'), 400);
            });
            grid.appendChild(tag);
          }
          expansion.appendChild(grid);
        }
      }
      row.appendChild(expansion);
    }
    expanded = !expanded;
    expansion.style.display = expanded ? '' : 'none';
    caret.textContent = expanded ? '▼' : '▶';
    caret.setAttribute('aria-label', expanded ? 'collapse' : 'expand');
  };

  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExpansion();
  });

  // Click anywhere else on the row inserts the use statement.
  body.addEventListener('click', () => {
    insertUseStatement(path);
    row.classList.add('drawer-docs-row-flash');
    setTimeout(() => row.classList.remove('drawer-docs-row-flash'), 400);
    if (!isDesktop()) closeDrawer();
  });

  return row;
}

function buildDocItem(name) {
  const d = DOCS[name];
  const row = document.createElement('div');
  row.className = 'drawer-docs-row';
  const nameEl = document.createElement('div');
  nameEl.className = 'drawer-docs-name';
  nameEl.textContent = name;
  row.appendChild(nameEl);
  if (d.signature) {
    const sig = document.createElement('div');
    sig.className = 'drawer-docs-sig';
    sig.textContent = d.signature;
    row.appendChild(sig);
  }
  if (d.description) {
    const desc = document.createElement('div');
    desc.className = 'drawer-docs-desc';
    desc.textContent = d.description;
    row.appendChild(desc);
  }
  if (d.example) {
    const ex = document.createElement('div');
    ex.className = 'drawer-docs-ex';
    ex.textContent = d.example;
    row.appendChild(ex);
  }
  // Click → copy the name to clipboard (silent best-effort; if the
  // clipboard API is unavailable, just brief-flash the row instead).
  row.addEventListener('click', () => {
    const copyName = name.replace(/^@/, '@'); // keep decorators intact
    try { navigator.clipboard && navigator.clipboard.writeText(copyName); } catch { /* ignore */ }
    row.classList.add('drawer-docs-row-flash');
    setTimeout(() => row.classList.remove('drawer-docs-row-flash'), 400);
  });
  return row;
}

// Snapshot list rendering. Reuses the same row shape as the slide-in
// snapshots panel (label-or-"auto" + pin glyph + meta line + restore/
// pin/delete actions) so users see consistent UI regardless of which
// surface they reach snapshots from.
function renderHistoryList() {
  if (!drawerHistoryListEl) return;
  const name = currentProgramName;
  drawerHistoryListEl.innerHTML = '';
  if (!name) {
    const empty = document.createElement('div');
    empty.className = 'settings-row-hint';
    empty.style.padding = '14px';
    empty.textContent = 'No program loaded.';
    drawerHistoryListEl.appendChild(empty);
    if (drawerHistoryHdrEl) drawerHistoryHdrEl.textContent = 'snapshots';
    return;
  }
  const snaps = listSnapshots(name);
  if (drawerHistoryHdrEl) {
    drawerHistoryHdrEl.textContent = snaps.length
      ? `${snaps.length} snapshot${snaps.length === 1 ? '' : 's'}`
      : 'no snapshots yet';
  }
  if (!snaps.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-row-hint';
    empty.style.padding = '14px';
    empty.textContent = 'Take one with "snapshot now…" above, or wait — ep auto-snapshots each program the first time you load it in a session.';
    drawerHistoryListEl.appendChild(empty);
    return;
  }
  for (const snap of snaps) {
    drawerHistoryListEl.appendChild(renderSnapshotRow(name, snap));
  }
}

function renderSnapshotRow(programName, snap) {
  const row = document.createElement('div');
  row.className = 'drawer-item snapshot-row';

  const info = document.createElement('div');
  info.className = 'drawer-item-info';

  const headline = document.createElement('div');
  headline.className = 'drawer-item-name';
  if (snap.label) {
    const lbl = document.createElement('span');
    lbl.className = 'snapshot-label';
    lbl.textContent = snap.label;
    headline.appendChild(lbl);
  } else {
    const auto = document.createElement('span');
    auto.className = 'snapshot-auto';
    auto.textContent = 'auto';
    headline.appendChild(auto);
  }
  if (snap.pinned) {
    const pin = document.createElement('span');
    pin.className = 'snapshot-pin-glyph';
    pin.textContent = '◆';
    pin.title = 'pinned (never auto-purged)';
    headline.appendChild(pin);
  }
  info.appendChild(headline);

  const meta = document.createElement('div');
  meta.className = 'drawer-item-meta';
  const lineCount = snap.body.length;
  meta.textContent = `${formatAgo(snap.takenAt)} · ${lineCount} line${lineCount === 1 ? '' : 's'}`;
  info.appendChild(meta);

  // Actions live behind a ⋯ menu instead of three inline buttons. Avoids
  // misclicks on destructive operations (restore replaces the program;
  // delete removes the snapshot), and matches the per-program row
  // pattern. Long-press / right-click on the row anywhere opens the
  // same menu, mirroring the program-row interaction.
  const actions = document.createElement('div');
  actions.className = 'drawer-item-actions';
  const ellipsis = document.createElement('button');
  ellipsis.className = 'drawer-item-menu-btn';
  ellipsis.textContent = '⋯';
  ellipsis.setAttribute('aria-label', 'snapshot actions');
  ellipsis.addEventListener('click', e => {
    e.stopPropagation();
    const rect = ellipsis.getBoundingClientRect();
    openSnapshotMenu(programName, snap, rect.right, rect.bottom + 4, { alignRight: true });
  });
  actions.appendChild(ellipsis);

  attachLongPress(row, (x, y) => openSnapshotMenu(programName, snap, x, y));

  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

function openSnapshotMenu(programName, snap, x, y, opts = {}) {
  showMenu([
    { label: 'restore', action: async () => {
      const ok = await epConfirm({
        title: 'Restore snapshot?',
        message: snap.label
          ? `Replace the current program with the snapshot "${snap.label}"? Your current state will be saved as a "before restore" snapshot first.`
          : `Replace the current program with this snapshot? Your current state will be saved as a "before restore" snapshot first.`,
        okLabel: 'Restore',
      });
      if (!ok) return;
      restoreSnapshot(programName, snap.id);
      renderHistoryList();
    } },
    { label: snap.pinned ? 'unpin' : 'pin', action: () => {
      pinSnapshot(programName, snap.id, !snap.pinned);
      renderHistoryList();
    } },
    { separator: true },
    { label: 'delete', danger: true, action: async () => {
      const ok = await epConfirm({
        title: 'Delete snapshot?',
        message: snap.label
          ? `Delete the snapshot "${snap.label}"? This can't be undone.`
          : `Delete this snapshot? This can't be undone.`,
        okLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      deleteSnapshot(programName, snap.id);
      renderHistoryList();
    } },
  ], x, y, opts);
}

// ── data mode: attached CSV assets ────────────────────────────────

function renderAssetsList() {
  if (!drawerAssetsListEl) return;
  drawerAssetsListEl.innerHTML = '';
  const names = state.assets ? Object.keys(state.assets).sort() : [];
  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'drawer-list-empty';
    empty.textContent = 'no data attached — drop a .csv or use "attach CSV…"';
    drawerAssetsListEl.appendChild(empty);
    return;
  }
  for (const name of names) {
    const info = assetInfo(name);
    const item = document.createElement('div');
    item.className = 'drawer-item';

    const infoEl = document.createElement('div');
    infoEl.className = 'drawer-item-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'drawer-item-name';
    nameEl.textContent = name;
    infoEl.appendChild(nameEl);
    const meta = document.createElement('div');
    meta.className = 'drawer-item-meta';
    meta.textContent = info
      ? `${info.rows} × ${info.cols} · ${(info.bytes / 1024).toFixed(1)} KB`
      : '';
    infoEl.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'drawer-item-actions';
    const ellipsis = document.createElement('button');
    ellipsis.className = 'drawer-item-menu-btn';
    ellipsis.textContent = '⋯';
    ellipsis.setAttribute('aria-label', 'data actions');
    ellipsis.addEventListener('click', e => {
      e.stopPropagation();
      const r = ellipsis.getBoundingClientRect();
      openAssetMenu(name, r.right, r.bottom + 4);
    });
    actions.appendChild(ellipsis);

    attachLongPress(item, (x, y) => openAssetMenu(name, x, y));
    item.appendChild(infoEl);
    item.appendChild(actions);
    drawerAssetsListEl.appendChild(item);
  }
}

function openAssetMenu(name, x, y) {
  showMenu([
    { label: 'view…',         action: () => showDatasetViewer(name) },
    { label: 're-configure…', action: () => reconfigureAsset(name) },
    { label: 'rename…',       action: () => renameAssetFlow(name) },
    { separator: true },
    { label: 'remove', danger: true, action: () => removeAssetFlow(name) },
  ], x, y, { alignRight: true });
}

async function reconfigureAsset(name) {
  const asset = state.assets && state.assets[name];
  if (!asset) return;
  const result = await showAttachDialog(asset.text, name, asset.config);
  if (!result) return;
  // Re-configure keeps the name (rename is its own action) — just swap
  // in the freshly-chosen parse config.
  attachCsv(name, asset.text, result.config);
  afterAssetChange();
}

async function renameAssetFlow(name) {
  const next = await epPrompt({
    title: 'Rename data asset', label: 'new name', value: name, okLabel: 'Rename',
  });
  if (next === null) return;
  const newName = (next || '').trim();
  if (!newName || newName === name) return;
  if (state.assets && state.assets[newName]) return;   // name already taken
  if (!renameAsset(name, newName)) return;
  // Follow the rename through the program's load_csv("…") calls.
  const oldRef = `load_csv("${name}")`;
  const newRef = `load_csv("${newName}")`;
  for (const row of state.body) {
    if (row.src.includes(oldRef)) row.src = row.src.split(oldRef).join(newRef);
  }
  afterAssetChange();
}

async function removeAssetFlow(name) {
  const ok = await epConfirm({
    title: 'Remove data asset?',
    message: `Remove "${name}"? Any load_csv("${name}") in the program will error until you re-attach.`,
    okLabel: 'Remove', danger: true,
  });
  if (!ok) return;
  removeAsset(name);
  afterAssetChange();
}

// Shared post-change refresh: re-evaluate (load_csv results changed),
// re-render the program, persist, and refresh the assets list.
function afterAssetChange() {
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  window.dispatchEvent(new CustomEvent('ep:params-changed'));
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
}

// React to viewport-band changes (window resized across the 1024 boundary,
// or device orientation flipped). Also fired by the setting toggle in
// settings.js when the user changes the desktopDrawer preference.
function reapplyPersistentMode() {
  applyPersistentClass();
  if (persistentMode()) {
    // Auto-open in persistent mode so the sidebar is visible from boot.
    if (!drawer.classList.contains('on')) openDrawer();
  }
}
window.addEventListener('ep:viewport-changed', reapplyPersistentMode);
window.addEventListener('ep:desktop-drawer-setting-changed', reapplyPersistentMode);
// Run once at module load so initial paint shows the right layout.
reapplyPersistentMode();

newProgBtn.addEventListener('click', () => { newProgram(); closeDrawer(); });
openFileBtn.addEventListener('click', () => { drawerFileInput.click(); closeDrawer(); });

const drawerFormatBtn = document.getElementById('drawerFormatBtn');
if (drawerFormatBtn) {
  drawerFormatBtn.addEventListener('click', () => {
    // Late import dodges a module init order issue — drawer.js is loaded
    // before format-cmd.js by the build, but at runtime everything's in
    // flat scope so the call resolves fine.
    if (typeof formatCurrentProgram === 'function') formatCurrentProgram();
    closeDrawer();
  });
}

if (drawerSearchEl) {
  drawerSearchEl.addEventListener('input', () => {
    searchFilter = drawerSearchEl.value.trim().toLowerCase();
    renderDrawerList();
  });
}

// Drawer sort — 'recent' (default, by updatedAt desc) or 'alpha' (by name).
// Pinned programs always render first regardless of sort.
function currentSort() { return getSetting('sort', 'recent'); }
function updateSortBtn() {
  if (drawerSortBtn) drawerSortBtn.textContent = currentSort();
}
if (drawerSortBtn) {
  updateSortBtn();
  drawerSortBtn.addEventListener('click', () => {
    setSetting('sort', currentSort() === 'recent' ? 'alpha' : 'recent');
    updateSortBtn();
    renderDrawerList();
  });
}

// ── Swipe-left to close ───────────────────────────────────────
// Only fires when drawer is open and touch starts inside it. Doesn't conflict
// with Android's edge back-gesture because the start zone is the drawer body.
const CLOSE_CLAIM_PX       = 10;   // movement needed before claiming the gesture
const CLOSE_PROGRESS_BAR   = 0.5;  // below this open-fraction on release → snap closed
const CLOSE_VELOCITY_PX_MS = 0.5;  // OR moved leftward this fast → snap closed

let dragActive = false;
let dragClaimed = false;
let startX = 0, startY = 0, startT = 0;
let lastX = 0, lastT = 0;
let drawerW = 0;

function setProgress(p) {
  p = Math.max(0, Math.min(1, p));
  drawer.style.transform = `translateX(${(p - 1) * 100}%)`;
  drawerScrim.style.opacity = String(p);
  drawerScrim.style.pointerEvents = p > 0 ? 'auto' : 'none';
}
function clearInline() {
  drawer.style.transform = '';
  drawerScrim.style.opacity = '';
  drawerScrim.style.pointerEvents = '';
}

drawer.addEventListener('touchstart', e => {
  if (!drawer.classList.contains('on')) return;
  if (e.touches.length !== 1) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  dragActive = true;
  dragClaimed = false;
  const t = e.touches[0];
  startX = lastX = t.clientX;
  startY = t.clientY;
  startT = lastT = performance.now();
  drawerW = drawer.offsetWidth || 320;
}, {passive: true});

drawer.addEventListener('touchmove', e => {
  if (!dragActive) return;
  const t = e.touches[0];
  const dx = t.clientX - startX;
  const dy = t.clientY - startY;

  if (!dragClaimed) {
    if (Math.abs(dx) < CLOSE_CLAIM_PX && Math.abs(dy) < CLOSE_CLAIM_PX) return;
    if (Math.abs(dy) > Math.abs(dx)) { dragActive = false; return; }
    if (dx >= 0)                      { dragActive = false; return; }
    dragClaimed = true;
    drawer.classList.add('dragging');
    drawerScrim.classList.add('dragging');
  }

  if (e.cancelable) e.preventDefault();
  setProgress(1 + (dx / drawerW));
  lastX = t.clientX;
  lastT = performance.now();
}, {passive: false});

function endDrag() {
  if (!dragActive) return;
  const claimed = dragClaimed;
  dragActive = false;
  dragClaimed = false;
  drawer.classList.remove('dragging');
  drawerScrim.classList.remove('dragging');
  if (!claimed) return;

  const totalDx = lastX - startX;
  const totalDt = Math.max(1, lastT - startT);
  const velocity = totalDx / totalDt;
  const finalProgress = 1 + (totalDx / drawerW);

  clearInline();
  if (finalProgress < CLOSE_PROGRESS_BAR || velocity < -CLOSE_VELOCITY_PX_MS) {
    closeDrawer();
  } else {
    drawer.classList.add('on');
  }
}
drawer.addEventListener('touchend',    endDrag);
drawer.addEventListener('touchcancel', endDrag);

// ── List render ───────────────────────────────────────────────
// Examples are no longer rendered inline in the drawer — they moved to
// the on-demand examples panel (examples-panel.js). The drawer now only
// renders the saved-programs list below.

export function renderDrawerList() {
  if (!drawerListEl) return;
  const store = readStore();
  const sort = currentSort();
  const cmpRecent = (a, b) => (store[b].updatedAt || 0) - (store[a].updatedAt || 0);
  const cmpAlpha  = (a, b) => a.localeCompare(b);
  const baseCmp = sort === 'alpha' ? cmpAlpha : cmpRecent;
  // Pinned first, then everything else by the chosen sort.
  let names = Object.keys(store).sort((a, b) => {
    const pa = !!store[a].pinned, pb = !!store[b].pinned;
    if (pa !== pb) return pa ? -1 : 1;
    return baseCmp(a, b);
  });
  if (searchFilter) names = names.filter(n => n.toLowerCase().includes(searchFilter));
  drawerListEl.innerHTML = '';
  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'drawer-list-empty';
    empty.textContent = searchFilter ? 'no matches' : 'no saved programs yet';
    drawerListEl.appendChild(empty);
    return;
  }
  for (const name of names) {
    const prog = store[name];
    const item = document.createElement('div');
    item.className = 'drawer-item' + (name === currentProgramName ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'drawer-item-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'drawer-item-name';
    if (prog.pinned) {
      const pin = document.createElement('span');
      pin.className = 'drawer-item-pin';
      pin.textContent = '◆';
      pin.title = 'pinned';
      nameEl.appendChild(pin);
      nameEl.appendChild(document.createTextNode(' ' + name));
    } else {
      nameEl.textContent = name;
    }
    info.appendChild(nameEl);

    const desc = programDescription(prog.body);
    if (desc) {
      const descEl = document.createElement('div');
      descEl.className = 'drawer-item-desc';
      descEl.textContent = desc;
      info.appendChild(descEl);
    }

    const meta = document.createElement('div');
    meta.className = 'drawer-item-meta';
    const lineCount = (prog.body || []).length;
    meta.textContent = `${lineCount} line${lineCount === 1 ? '' : 's'} · ${formatAgo(prog.updatedAt)}`;
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'drawer-item-actions';
    const ellipsis = document.createElement('button');
    ellipsis.className = 'drawer-item-menu-btn';
    ellipsis.textContent = '⋯';
    ellipsis.setAttribute('aria-label', 'program actions');
    ellipsis.addEventListener('click', e => {
      e.stopPropagation();
      const rect = ellipsis.getBoundingClientRect();
      openProgramMenu(name, rect.right, rect.bottom + 4, {alignRight: true});
    });
    actions.appendChild(ellipsis);

    // Hover preview — desktop affordance, no effect on touch. The first
    // few non-blank lines of the program land as the item's title, so
    // pausing the cursor over the row surfaces what's actually inside
    // without having to switch to it. Capped at ~6 lines / 400 chars to
    // keep the native tooltip readable.
    const previewLines = (prog.body || [])
      .map(r => (r && r.src) || '')
      .filter(s => s.trim())
      .slice(0, 6);
    if (previewLines.length) {
      let preview = previewLines.join('\n');
      if (preview.length > 400) preview = preview.slice(0, 397) + '…';
      const extra = (prog.body || []).filter(r => r && r.src && r.src.trim()).length - previewLines.length;
      if (extra > 0) preview += `\n… +${extra} more lines`;
      item.title = preview;
    }

    item.appendChild(info);
    item.appendChild(actions);

    // Keyboard accessibility: each row is reachable via Tab (tabindex=0)
    // and activates on Enter/Space — same effect as a mouse click. The
    // ⋯ button stays its own focusable element for the per-program menu.
    // role="button" cues screen readers that this div behaves like one.
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        item.click();
      }
    });

    item.addEventListener('click', () => {
      if (name !== currentProgramName) loadProgramByName(name);
      closeDrawer();
    });

    attachLongPress(item, (px, py) => openProgramMenu(name, px, py, {alignRight: false}));

    drawerListEl.appendChild(item);
  }
}
