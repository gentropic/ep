// Unit-picker bottom sheet — opened from the accessory bar's "units"
// button. Recent units first, then a categorised grid (Length / Mass /
// Time / …) plus a search box. Tap a unit pill to insert " <unit>" at the
// cursor of the most recently focused editor / chip input.
//
// Mobile-first: bottom sheet that slides up over the keyboard area,
// reachable with one thumb. On desktop the same sheet sits centred at
// the bottom — works fine without being a separate codepath.
//
// Long tail (SPEC-pocket §3.4): the DCDMA core sizes and Tyler/ASTM
// sieve meshes are ~40 Length entries that used to sit between "mi" and
// "Mass". They now live in one collapsed "drill core & sieve mesh" row
// per category, expanded on tap, and always searchable.

import { getUnitsByCategory } from './evaluator.js';
import { insertAtCursor } from './accessory.js';

const upSheet    = document.getElementById('unitSheet');
const upScrim    = document.getElementById('unitSheetScrim');
const upCloseBtn = document.getElementById('unitSheetCloseBtn');
const upSearchEl = document.getElementById('unitSheetSearch');
const upBodyEl   = document.getElementById('unitSheetBody');

const RECENT_UNITS_KEY = 'ep:recentUnits';
const RECENT_UNITS_MAX = 8;

let _allCategories = null;
let _filter = '';
let _longTailOpen = new Set();   // categories whose long-tail row is expanded

// Prefixed units stay in the main grid only when they are names people
// actually say — the registry's full BIPM expansion (Qm, dam, Mton, cyr,
// µton …) folds into the long tail. An explicit allowlist beats a prefix
// rule here: `k` is everyday on `m` and `W`, noise on `ton` and `yr`.
const EVERYDAY_PREFIXED = new Set([
  'mm', 'cm', 'km', 'µm', 'nm',
  'mg', 'µg', 'kg', 'ng',
  'mL', 'µL',
  'ms', 'µs', 'ns',
  'kJ', 'MJ', 'kcal', 'kWh',
  'mW', 'kW', 'MW', 'GW',
  'kPa', 'MPa', 'GPa', 'hPa', 'mbar',
  'kN', 'MN',
  'kHz', 'MHz', 'GHz',
  'kt', 'Mt',
  'mA', 'kV', 'mV', 'kΩ', 'MΩ',
  'mmol', 'kmol',
  'kB', 'MB', 'GB', 'TB', 'kiB', 'MiB', 'GiB',
  'ha', 'hL',
]);
const isMeshOrCore = (name) => /^mesh\d+/.test(name) || /_(core|hole)$/.test(name);
const isLongTail = (u) => isMeshOrCore(u.name) || (!!u.prefix && !EVERYDAY_PREFIXED.has(u.name.replace('μ', 'µ')));

function longTailLabel(tail) {
  const parts = [];
  if (tail.some(u => /_(core|hole)$/.test(u.name))) parts.push('drill core');
  if (tail.some(u => /^mesh\d+/.test(u.name)))      parts.push('sieve mesh');
  if (tail.some(u => u.prefix))                     parts.push('rare prefixes');
  return `${parts.join(' · ') || 'more'} (${tail.length})`;
}

function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_UNITS_KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
function pushRecent(name) {
  const next = [name, ...readRecent().filter(n => n !== name)].slice(0, RECENT_UNITS_MAX);
  try { localStorage.setItem(RECENT_UNITS_KEY, JSON.stringify(next)); } catch {}
}

export function openUnitPicker() {
  if (!upSheet) return;
  if (!_allCategories) _allCategories = getUnitsByCategory();
  _filter = '';
  if (upSearchEl) upSearchEl.value = '';
  render();
  upSheet.classList.add('on');
  if (upScrim) upScrim.classList.add('on');
  // The view yields (SPEC-pocket §3.1): publish the sheet's height so the
  // pocket layout can pad the editor and keep the cursor line visible
  // above the sheet while units are being picked. The transform doesn't
  // affect layout, so offsetHeight is right immediately.
  document.documentElement.style.setProperty('--ep-sheet-inset', upSheet.offsetHeight + 'px');
  // Don't auto-focus the search input on mobile — opening the keyboard
  // immediately would push the sheet up and feel jumpy. Desktop users
  // can click in if they want to type-filter.
}

export function closeUnitPicker() {
  if (!upSheet) return;
  upSheet.classList.remove('on');
  if (upScrim) upScrim.classList.remove('on');
  document.documentElement.style.setProperty('--ep-sheet-inset', '0px');
}

function makePill(u, extraClass = '') {
  const b = document.createElement('button');
  b.className = 'unit-picker-pill' + (extraClass ? ' ' + extraClass : '');
  b.textContent = u.name;
  if (u.fullName && u.fullName !== u.name) b.title = u.fullName;
  // Keep focus on the editor / chip so insertAtCursor can reach
  // state._lastFocused — mousedown for mouse, pointerdown for touch.
  b.addEventListener('mousedown',   e => e.preventDefault());
  b.addEventListener('pointerdown', e => e.preventDefault());
  b.addEventListener('click', () => {
    insertAtCursor(' ' + u.name);
    pushRecent(u.name);
    // Keep open so users can chain insertions (e.g., picking a unit
    // and then a different one in the next expression). Close button
    // / scrim / Esc dismiss.
  });
  return b;
}

function makeSection(title) {
  const section = document.createElement('div');
  section.className = 'unit-picker-section';
  const hdr = document.createElement('div');
  hdr.className = 'unit-picker-section-hdr';
  hdr.textContent = title;
  section.appendChild(hdr);
  const grid = document.createElement('div');
  grid.className = 'unit-picker-grid';
  section.appendChild(grid);
  return { section, grid };
}

function render() {
  if (!upBodyEl) return;
  upBodyEl.innerHTML = '';
  const q = _filter.toLowerCase().trim();

  // Recent — only when not searching, and only if there is any history.
  if (!q) {
    const recent = readRecent();
    if (recent.length) {
      const { section, grid } = makeSection('recent');
      for (const name of recent) grid.appendChild(makePill({ name }, 'recent'));
      upBodyEl.appendChild(section);
    }
  }

  for (const { category, units } of _allCategories) {
    const matched = q
      ? units.filter(u => u.name.toLowerCase().includes(q) || (u.fullName || '').toLowerCase().includes(q))
      : units;
    if (!matched.length) continue;
    const { section, grid } = makeSection(category.toLowerCase());
    // While searching, everything that matches shows inline. Otherwise
    // the long tail folds into one row.
    const everyday = q ? matched : matched.filter(u => !isLongTail(u));
    const longTail = q ? [] : matched.filter(u => isLongTail(u));
    for (const u of everyday) grid.appendChild(makePill(u));
    if (longTail.length) {
      const open = _longTailOpen.has(category);
      const toggle = document.createElement('button');
      toggle.className = 'unit-picker-pill unit-picker-more';
      toggle.textContent = (open ? '▾ ' : '▸ ') + longTailLabel(longTail);
      toggle.addEventListener('mousedown',   e => e.preventDefault());
      toggle.addEventListener('pointerdown', e => e.preventDefault());
      toggle.addEventListener('click', () => {
        if (open) _longTailOpen.delete(category); else _longTailOpen.add(category);
        render();
      });
      grid.appendChild(toggle);
      if (open) {
        const tail = document.createElement('div');
        tail.className = 'unit-picker-grid unit-picker-tail';
        for (const u of longTail) tail.appendChild(makePill(u));
        section.appendChild(tail);
      }
    }
    upBodyEl.appendChild(section);
  }
  if (!upBodyEl.children.length) {
    const empty = document.createElement('div');
    empty.className = 'unit-picker-empty';
    empty.textContent = q ? `no units match "${q}"` : 'no units available';
    upBodyEl.appendChild(empty);
  }
}

if (upSearchEl) {
  upSearchEl.addEventListener('input', () => {
    _filter = upSearchEl.value || '';
    render();
  });
}
if (upCloseBtn) upCloseBtn.addEventListener('click', closeUnitPicker);
if (upScrim)    upScrim.addEventListener('click', closeUnitPicker);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && upSheet && upSheet.classList.contains('on')) closeUnitPicker();
});
