// Full-dataset viewer — a virtualized table modal, opened from the
// assets list's "view…" action. Only the visible row window is in the
// DOM; a spacer row sizes the scrollbar to the true row count, so a
// 10^5-row table scrolls without exploding the DOM. The Dataset itself
// is already resident (eager Phase 1 columnar arrays) — the viewer
// reads it in place, never copies.
//
// Cells are read through dsvCellAt() — a Phase-1 O(1) columnar lookup.
// SPEC-DATASETS §9: Phase 2 streaming must keep this seam working (an
// async/windowed read with a "loading…" placeholder), not assume
// synchronous random access. Editor-only — not in the viewer bundle.

import { getDataset } from './csv-assets.js';
import { fmtNum } from './units.js';

const dsvScrim    = document.getElementById('datasetViewerScrim');
const dsvTitleEl  = document.getElementById('dsvTitle');
const dsvScrollEl = document.getElementById('dsvScroll');
const dsvCloseBtn = document.getElementById('dsvCloseBtn');

const DSV_BUFFER = 6;   // extra rows rendered above/below the viewport

let dsvDs = null;       // current Dataset (referenced, never copied)
let dsvCols = [];       // [ [name, columnArray], … ]
let dsvTbody = null;
let dsvRowH = 22;       // measured row height (px)
let dsvRafPending = false;
let dsvLastFrom = -1, dsvLastTo = -1;

// Phase-1 cell accessor — O(1) into the resident columnar array.
function dsvCellAt(rowIdx, colArr) {
  return colArr[rowIdx];
}

function dsvCellText(v) {
  if (v == null) return '';
  if (typeof v === 'string')  return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object' && typeof v.value === 'number') {
    if (Number.isNaN(v.value)) return '—';
    return fmtNum(v.disp ? v.value / v.disp.mul : v.value);
  }
  return String(v);
}

function dsvClose() {
  dsvScrim.classList.remove('on');
  dsvDs = null;
  dsvCols = [];
  dsvTbody = null;
}

// A full-width zero-content row that reserves `heightPx` of scroll space.
function dsvMakeSpacer(heightPx) {
  const tr = document.createElement('tr');
  tr.className = 'dsv-spacer';
  const td = document.createElement('td');
  td.colSpan = dsvCols.length + 1;
  td.style.height = heightPx + 'px';
  tr.appendChild(td);
  return tr;
}

// Replace the tbody with: a top spacer, rows [from, to), a bottom spacer.
function dsvRenderWindow(from, to) {
  const total = dsvDs.length;
  const frag = document.createDocumentFragment();
  if (from > 0) frag.appendChild(dsvMakeSpacer(from * dsvRowH));
  for (let r = from; r < to; r++) {
    const tr = document.createElement('tr');
    tr.className = 'dsv-row';
    const num = document.createElement('td');
    num.className = 'dsv-rownum';
    num.textContent = String(r + 1);
    tr.appendChild(num);
    for (const [, arr] of dsvCols) {
      const td = document.createElement('td');
      td.textContent = dsvCellText(dsvCellAt(r, arr));
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  if (to < total) frag.appendChild(dsvMakeSpacer((total - to) * dsvRowH));
  dsvTbody.innerHTML = '';
  dsvTbody.appendChild(frag);
  dsvLastFrom = from;
  dsvLastTo = to;
}

// Recompute the visible window from the scroll position.
function dsvRender() {
  if (!dsvDs || !dsvTbody) return;
  const total = dsvDs.length;
  const start   = Math.floor(dsvScrollEl.scrollTop / dsvRowH);
  const visible = Math.ceil(dsvScrollEl.clientHeight / dsvRowH);
  const from = Math.max(0, start - DSV_BUFFER);
  const to   = Math.min(total, start + visible + DSV_BUFFER);
  if (from === dsvLastFrom && to === dsvLastTo) return;
  dsvRenderWindow(from, to);
}

function dsvBuildTable() {
  dsvScrollEl.scrollTop = 0;
  const table = document.createElement('table');
  table.className = 'dsv-table';

  // Header — a row-number column, then one per data column.
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'dsv-rownum';
  corner.textContent = '#';
  corner.style.width = '64px';
  htr.appendChild(corner);
  for (const [cname] of dsvCols) {
    const th = document.createElement('th');
    th.textContent = cname;
    th.style.width = '130px';
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  dsvTbody = document.createElement('tbody');
  table.appendChild(dsvTbody);
  dsvScrollEl.innerHTML = '';
  dsvScrollEl.appendChild(table);

  // First pass: render a small window, measure a real row's height, then
  // do the proper virtual render with the measured height.
  dsvLastFrom = dsvLastTo = -1;
  dsvRenderWindow(0, Math.min(dsvDs.length, 40));
  const sample = dsvTbody.querySelector('tr.dsv-row');
  if (sample && sample.offsetHeight) dsvRowH = sample.offsetHeight;
  dsvLastFrom = dsvLastTo = -1;
  dsvRender();
}

export function showDatasetViewer(name) {
  const ds = getDataset(name);
  if (!ds || !ds.__dataset) return;
  dsvDs = ds;
  dsvCols = [...ds.columns.entries()];
  dsvTitleEl.textContent = `${name} · ${ds.length} × ${dsvCols.length}`;
  dsvScrim.classList.add('on');
  dsvBuildTable();
}

// ── wiring ────────────────────────────────────────────────────────

dsvScrollEl.addEventListener('scroll', () => {
  if (dsvRafPending) return;
  dsvRafPending = true;
  requestAnimationFrame(() => { dsvRafPending = false; dsvRender(); });
});
dsvCloseBtn.addEventListener('click', dsvClose);
dsvScrim.addEventListener('click', (e) => { if (e.target === dsvScrim) dsvClose(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && dsvScrim.classList.contains('on')) {
    e.preventDefault();
    dsvClose();
  }
});
