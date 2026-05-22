// The attach-CSV dialog (SPEC-DATASETS §3, §8). A dropped or picked
// `.csv` opens this modal: a live parsed-table preview, the auto-detected
// file-level parse config (delimiter / decimal / comment / skip / header)
// with manual overrides, and per-column rename + unit controls. On
// confirm the CSV is embedded as an asset and a `name = load_csv("name")`
// binding is added. Editor-only — not in the viewer bundle.

import { detectCsvConfig } from '../../ext/numbat/dist/numbat.js';
import { parseCsvPreview, attachCsv } from './csv-assets.js';
import { fmtNum } from './units.js';
import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';

const attachScrimEl     = document.getElementById('attachScrim');
const nameEl    = document.getElementById('attachName');
const delimEl   = document.getElementById('attachDelimiter');
const decimalEl = document.getElementById('attachDecimal');
const commentEl = document.getElementById('attachComment');
const skipEl    = document.getElementById('attachSkip');
const headerEl  = document.getElementById('attachHasHeader');
const previewEl = document.getElementById('attachPreview');
const okBtn     = document.getElementById('attachOkBtn');
const attachCancelBtn = document.getElementById('attachCancelBtn');

const PREVIEW_ROWS = 10;

let _text = '';
let _config = null;
let _resolve = null;
let _colWidths = [];   // per-column preview widths (px), index-keyed

// ── the modal ─────────────────────────────────────────────────────

// Show the dialog for `text`. Resolves {name, config} on Attach, null on
// Cancel. `existingConfig` (assets-list "re-configure") seeds the
// controls instead of auto-detecting.
export function showAttachDialog(text, suggestedName, existingConfig) {
  _text = text;
  _config = existingConfig
    ? { ...existingConfig, columns: { ...(existingConfig.columns || {}) } }
    : detectCsvConfig(text);
  if (!_config.columns) _config.columns = {};
  _colWidths = [];
  nameEl.value     = suggestedName || 'data';
  delimEl.value    = _config.delimiter;
  decimalEl.value  = _config.decimal;
  commentEl.value  = _config.commentChar || '';
  skipEl.value     = String(_config.skipRows || 0);
  headerEl.checked = _config.hasHeader !== false;
  rerender();
  attachScrimEl.classList.add('on');
  setTimeout(() => nameEl.focus(), 30);
  return new Promise(res => { _resolve = res; });
}

function close(result) {
  attachScrimEl.classList.remove('on');
  const r = _resolve;
  _resolve = null;
  if (r) r(result);
}

function readFileControls() {
  _config.delimiter   = delimEl.value || ',';
  _config.decimal     = decimalEl.value || '.';
  _config.commentChar = commentEl.value || null;
  _config.skipRows    = Math.max(0, parseInt(skipEl.value, 10) || 0);
  _config.hasHeader   = headerEl.checked;
}

// ── live preview ──────────────────────────────────────────────────

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string')  return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object' && typeof v.value === 'number') {
    if (Number.isNaN(v.value)) return '—';
    return fmtNum(v.disp ? v.value / v.disp.mul : v.value);
  }
  return String(v);
}

// Drag the right-edge handle of a header cell to resize that column.
// The width is remembered (index-keyed) so it survives a re-parse.
function startColResize(e, th, i) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = th.offsetWidth;
  const onMove = (ev) => {
    const w = Math.max(48, startW + (ev.clientX - startX));
    _colWidths[i] = w;
    th.style.width = w + 'px';
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function rerender() {
  let ds;
  try {
    ds = parseCsvPreview(_text, _config);
  } catch (e) {
    previewEl.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'attach-err';
    err.textContent = 'could not parse: ' + (e && e.message || e);
    previewEl.appendChild(err);
    return;
  }
  const cols = [...ds.columns.entries()];
  const table = document.createElement('table');

  // Header row — a name input + a unit input per column.
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  cols.forEach(([name, arr], i) => {
    const th = document.createElement('th');
    th.style.width = (_colWidths[i] || 130) + 'px';
    const nameInp = document.createElement('input');
    nameInp.className = 'attach-col-name';
    nameInp.value = name;
    nameInp.spellcheck = false;
    // A rename only relabels the column — no cell changes, no rerender.
    nameInp.addEventListener('change', () => {
      _config.columns[i] = { ..._config.columns[i], name: nameInp.value.trim() };
    });
    const unitInp = document.createElement('input');
    unitInp.className = 'attach-col-unit';
    unitInp.placeholder = 'unit';
    unitInp.spellcheck = false;
    const first = arr[0];
    unitInp.value = (first && first.disp && first.disp.name) || '';
    // A unit change re-folds the column's values — re-parse + re-render.
    unitInp.addEventListener('change', () => {
      _config.columns[i] = { ..._config.columns[i], unit: unitInp.value.trim() };
      rerender();
    });
    const grip = document.createElement('div');
    grip.className = 'attach-col-resize';
    grip.title = 'drag to resize column';
    grip.addEventListener('mousedown', (e) => startColResize(e, th, i));
    th.appendChild(nameInp);
    th.appendChild(unitInp);
    th.appendChild(grip);
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);

  // Body — first PREVIEW_ROWS rows.
  const tbody = document.createElement('tbody');
  const n = Math.min(ds.length, PREVIEW_ROWS);
  for (let ri = 0; ri < n; ri++) {
    const tr = document.createElement('tr');
    cols.forEach(([, arr]) => {
      const td = document.createElement('td');
      td.textContent = cellText(arr[ri]);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  previewEl.innerHTML = '';
  previewEl.appendChild(table);
  if (ds.length > PREVIEW_ROWS) {
    const more = document.createElement('div');
    more.className = 'attach-err';
    more.style.color = 'var(--sw-text-soft)';
    more.textContent = `… ${ds.length - PREVIEW_ROWS} more rows`;
    previewEl.appendChild(more);
  }
}

// ── wiring ────────────────────────────────────────────────────────

for (const el of [delimEl, decimalEl, headerEl, commentEl, skipEl]) {
  el.addEventListener('change', () => { readFileControls(); rerender(); });
}
attachCancelBtn.addEventListener('click', () => close(null));
okBtn.addEventListener('click', () => {
  readFileControls();
  close({ name: nameEl.value.trim() || 'data', config: _config });
});
attachScrimEl.addEventListener('click', (e) => { if (e.target === attachScrimEl) close(null); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && attachScrimEl.classList.contains('on')) {
    e.preventDefault();
    close(null);
  }
});

// ── entry points ──────────────────────────────────────────────────

// Show the dialog and, on confirm, embed the asset + add a
// `name = load_csv("name")` binding if the program doesn't have one.
export async function attachFromText(text, suggestedName) {
  const result = await showAttachDialog(text, suggestedName);
  if (!result) return;
  const { name, config } = result;
  attachCsv(name, text, config);
  const ref = `load_csv("${name}")`;
  if (!state.body.some(r => r.src.includes(ref))) {
    const bindName = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'data';
    state.body.push({ src: '' });
    state.body.push({ src: `${bindName} = ${ref}` });
  }
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  window.dispatchEvent(new CustomEvent('ep:params-changed'));
  window.dispatchEvent(new CustomEvent('ep:storage-changed'));
}

// File-picker entry point (mobile / when drag-drop isn't practical).
export function pickCsvAndAttach() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.csv,text/csv';
  inp.addEventListener('change', async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const text = await file.text();
    attachFromText(text, file.name.replace(/\.csv$/i, '').trim() || 'data');
  });
  inp.click();
}
