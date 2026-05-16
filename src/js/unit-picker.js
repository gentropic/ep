// Unit-picker bottom upSheet — opened from the accessory bar's "⋯ units"
// button. Categorised grid (Length / Mass / Time / Energy / …) plus a
// search box. Tap a unit pill to insert " <unit>" at the cursor of the
// most recently focused editor / chip input.
//
// Mobile-first: bottom upSheet that slides up over the keyboard area,
// reachable with one thumb. On desktop the same upSheet sits centred at
// the bottom — works fine without being a separate codepath.

import { getUnitsByCategory } from './evaluator.js';
import { insertAtCursor } from './accessory.js';

const upSheet    = document.getElementById('unitSheet');
const upScrim    = document.getElementById('unitSheetScrim');
const upCloseBtn = document.getElementById('unitSheetCloseBtn');
const upSearchEl = document.getElementById('unitSheetSearch');
const upBodyEl   = document.getElementById('unitSheetBody');

let _allCategories = null;
let _filter = '';

export function openUnitPicker() {
  if (!upSheet) return;
  if (!_allCategories) _allCategories = getUnitsByCategory();
  _filter = '';
  if (upSearchEl) upSearchEl.value = '';
  render();
  upSheet.classList.add('on');
  if (upScrim) upScrim.classList.add('on');
  // Don't auto-focus the search input on mobile — opening the keyboard
  // immediately would push the upSheet up and feel jumpy. Desktop users
  // can click in if they want to type-filter.
}

export function closeUnitPicker() {
  if (!upSheet) return;
  upSheet.classList.remove('on');
  if (upScrim) upScrim.classList.remove('on');
}

function render() {
  if (!upBodyEl) return;
  upBodyEl.innerHTML = '';
  const q = _filter.toLowerCase().trim();
  for (const { category, units } of _allCategories) {
    const matched = q
      ? units.filter(u => u.name.toLowerCase().includes(q) || (u.fullName || '').toLowerCase().includes(q))
      : units;
    if (!matched.length) continue;
    const section = document.createElement('div');
    section.className = 'unit-picker-section';
    const hdr = document.createElement('div');
    hdr.className = 'unit-picker-section-hdr';
    hdr.textContent = category.toLowerCase();
    section.appendChild(hdr);
    const grid = document.createElement('div');
    grid.className = 'unit-picker-grid';
    for (const u of matched) {
      const b = document.createElement('button');
      b.className = 'unit-picker-pill';
      b.textContent = u.name;
      if (u.fullName && u.fullName !== u.name) b.title = u.fullName;
      // mousedown.preventDefault keeps focus on the editor / chip so
      // insertAtCursor can reach state._lastFocused.
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', () => {
        insertAtCursor(' ' + u.name);
        // Keep open so users can chain insertions (e.g., picking a unit
        // and then a different one in the next expression). Close button
        // / upScrim / Esc dismiss.
      });
      grid.appendChild(b);
    }
    section.appendChild(grid);
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
