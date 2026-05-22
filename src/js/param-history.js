// §7.1 — recent values per @input param.
//
// Editor-only glue. render.js builds the chips and must stay storage-free
// (it ships in the read-only viewer bundle too), so it only fires events;
// this module owns the storage side and the recall menu. Three events:
//
//   ep:param-committed      {name, value}  — a chip value was committed
//   ep:param-history-request {name, x, y}  — chip label long-pressed
//   ep:param-set            {name, value}  — user picked a recent value
//
// recordParamHistory / getParamHistory persist to the program's store
// record (storage.js); the menu reuses the shared showMenu (menu.js).

import { recordParamHistory, getParamHistory } from './storage.js';
import { showMenu } from './menu.js';

// A committed chip value (change event — blur / Enter / drag-release,
// not every keystroke) — append it to this param's recent-values list.
window.addEventListener('ep:param-committed', (e) => {
  const d = e.detail || {};
  recordParamHistory(d.name, d.value);
});

// Long-press / right-click on a chip label — show its recent values.
window.addEventListener('ep:param-history-request', (e) => {
  const d = e.detail || {};
  const hist = getParamHistory(d.name);
  if (!hist.length) {
    showMenu([{ label: 'no recent values yet', action: () => {} }], d.x, d.y);
    return;
  }
  const items = hist.map(v => ({
    label: v,
    action: () => window.dispatchEvent(
      new CustomEvent('ep:param-set', { detail: { name: d.name, value: v } })),
  }));
  showMenu(items, d.x, d.y);
});
