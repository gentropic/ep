// Export dialog: package the current program as .ep source or self-cloning .html.
// The .html path reads its own outerHTML and swaps the INITIAL_STATE block via
// the STATE markers — preserving this contract is critical to the round-trip.

import { state } from './state.js';
import { currentProgramName, getSetting } from './storage.js';
import { generateShareUrl, generateShareUrlForQR, qrSvgFor } from './share.js';
import { isPocket, dismissKeyboard } from './viewport.js';
import { deliverFile, shellPresent } from './shell.js';
import { measurementsCsv } from './sensor-table.js';
import { resolveUnitExpression } from './evaluator.js';

const scrim         = document.getElementById('scrim');
const exportDlgTitle = document.getElementById('exportDlgTitle');
const shareFileBtn  = document.getElementById('shareFileBtn');
const exportInputsRow = document.getElementById('exportInputsRow');
const exportInputsEl  = document.getElementById('exportInputs');

// "Which @inputs to expose" (SPEC-pocket §3.6): one toggle per param,
// all on by default. Unticked inputs keep their baked value in the
// exported form and get no chip. Rebuilt on every open from state.params.
function renderExportInputs() {
  if (!exportInputsRow || !exportInputsEl) return;
  exportInputsEl.innerHTML = '';
  const params = state.params || [];
  exportInputsRow.style.display = params.length > 1 ? '' : 'none';
  for (const p of params) {
    const lbl = document.createElement('label');
    lbl.className = 'export-input-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.name = p.name;
    lbl.append(cb, document.createTextNode(' ' + p.name));
    exportInputsEl.append(lbl);
  }
}

// null when every input is exposed (the common case — keep the exported
// state minimal), else the list of names to show.
function exposedInputNames() {
  if (!exportInputsEl) return null;
  const boxes = [...exportInputsEl.querySelectorAll('input[type="checkbox"]')];
  if (!boxes.length || boxes.every(b => b.checked)) return null;
  return boxes.filter(b => b.checked).map(b => b.dataset.name);
}
const exportBtn     = document.getElementById('exportBtn');
const cancelBtn     = document.getElementById('cancelBtn');
const dlEpBtn       = document.getElementById('dlEpBtn');
const dlHtmlBtn     = document.getElementById('dlHtmlBtn');
const dlCsvBtn      = document.getElementById('dlCsvBtn');
const copySrcBtn    = document.getElementById('copySrcBtn');
const shareBtn      = document.getElementById('shareBtn');
const shareRow      = document.getElementById('shareRow');
const shareUrlEl    = document.getElementById('shareUrl');
const shareLenEl    = document.getElementById('shareLen');
const shareQrEl     = document.getElementById('shareQr');
const exportSrcEl   = document.getElementById('exportSrc');
const exportNameEl  = document.getElementById('exportName');
const exportIncludeEditLinkEl = document.getElementById('exportIncludeEditLink');

export function serializeProgram() {
  return state.body.map(r => r.src).join('\n');
}

// Can this browser hand a file to the system share sheet? (Android Chrome
// yes; desktop mostly no; WebView never — the lead-acid shell door is the
// R2 answer there.) Checked once; the Share button shows only when true.
function canShareFiles() {
  try {
    if (!navigator.canShare) return false;
    const probe = new File(['x'], 'probe.html', { type: 'text/html' });
    return navigator.canShare({ files: [probe] });
  } catch { return false; }
}
const _canShareFiles = canShareFiles();

exportBtn.addEventListener('click', () => {
  dismissKeyboard();
  exportSrcEl.textContent = serializeProgram();
  exportNameEl.value = currentProgramName || 'program';
  // Hide the share preview from any previous use — re-shows on link click
  shareRow.style.display = 'none';
  shareUrlEl.value = '';
  shareLenEl.textContent = '';
  shareQrEl.innerHTML = '';
  // On a phone the dialog is a bottom sheet and export IS "make this a
  // form" (SPEC-pocket §3.6) — say so.
  if (exportDlgTitle) exportDlgTitle.textContent = isPocket() ? 'Make this a form' : 'Export ep program';
  // Share the file itself: the Web Share API where it takes files, or the
  // shell's share sheet inside the instrument (SPEC-pocket §4.2).
  if (shareFileBtn) shareFileBtn.style.display = (_canShareFiles || shellPresent()) ? '' : 'none';
  if (dlCsvBtn) dlCsvBtn.style.display = measurementLogs().length ? '' : 'none';
  renderExportInputs();
  scrim.classList.add('on');
});

// The sheet's `<name>_log` lists (what "● measure" writes), in sheet
// order, as columns of display-unit numbers. Empty when the sheet has
// no logs — the button hides.
function measurementLogs() {
  const out = [];
  const scope = state._scope || {};
  for (const row of state.body || []) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*_log)\s*=/.exec(row.src || '');
    if (!m) continue;
    const list = scope[m[1]];
    if (!Array.isArray(list)) continue;
    const sig = Math.max(3, Math.min(10, getSetting('sigDigits', 4) | 0));
    let unit = '', mul = 1;
    const first = list.find(q => q && typeof q.value === 'number');
    const d = first && first.disp;
    if (d && typeof d === 'object') { mul = d.mul; unit = d.name; }
    else if (typeof d === 'string') { try { const s = resolveUnitExpression(d); mul = s.mul; unit = s.displayName; } catch { /* dimensionless */ } }
    const values = list.map(q => (q && typeof q.value === 'number') ? Number((q.value / mul).toPrecision(sig)) : (typeof q === 'string' ? q : null));
    out.push({ name: m[1], unit, values });
  }
  return out;
}

if (dlCsvBtn) {
  dlCsvBtn.addEventListener('click', async () => {
    const csv = measurementsCsv(measurementLogs());
    if (!csv) return;
    const name = (exportNameEl.value || 'program') + '-measurements.csv';
    try {
      // Inside the shell the share sheet is the point (send the day's
      // numbers on); on the web it's a download.
      const r = await deliverFile(name, csv, 'text/csv', { share: shellPresent() });
      if (r.via === 'shell') { flash(dlCsvBtn, 'saved to Downloads'); return; }
    } catch (e) { console.error('ep: .csv export failed:', e); flash(dlCsvBtn, 'failed'); return; }
    scrim.classList.remove('on');
  });
}
cancelBtn.addEventListener('click', () => scrim.classList.remove('on'));
scrim.addEventListener('click', e => { if (e.target === scrim) scrim.classList.remove('on'); });
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && scrim.classList.contains('on')) scrim.classList.remove('on');
});

// Flash a button label for a moment (the shell path has no download
// animation to tell the user something happened).
function flash(btn, label, ms = 1500) {
  const prev = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { btn.textContent = prev; }, ms);
}

dlEpBtn.addEventListener('click', async () => {
  const text = serializeProgram();
  const name = (exportNameEl.value || 'program') + '.ep';
  try {
    const r = await deliverFile(name, text, 'text/plain');
    if (r.via === 'shell') { flash(dlEpBtn, 'saved to Downloads'); return; }
  } catch (e) { console.error('ep: .ep export failed:', e); flash(dlEpBtn, 'failed'); return; }
  scrim.classList.remove('on');
});

// Build the exported form: the prebuilt viewer artifact (~280 KB) with
// its INITIAL_STATE block swapped for this program, instead of self-cloning
// the full editor (~1.3 MB). The viewer has no CM6, no drawer, no share —
// it just renders the chips and recomputes outputs. Source view is locked.
// Returns { html, name } or null when the viewer constant is unavailable.
function buildExportHtml() {
  if (typeof VIEWER_HTML !== 'string' || !VIEWER_HTML.includes('MARKER:STATE_START')) {
    console.error('ep: VIEWER_HTML constant is missing or malformed; aborting .html export.');
    return null;
  }
  const newState = {
    name: exportNameEl.value || currentProgramName || 'program',
    body: state.body.map(r => ({src: r.src})),
    ui:   {
      paramsCollapsed:  false,
      outputsCollapsed: false,
      formView:         true,
      showSource:       false,
      includeEditLink:  exportIncludeEditLinkEl ? exportIncludeEditLinkEl.checked : true,
      // The form shows numbers the way its author saw them.
      sigDigits:        getSetting('sigDigits', 4),
      ...(exposedInputNames() ? { exposedInputs: exposedInputNames() } : {}),
      scenarios:        state.ui.scenarios       || {},
      activeScenario:   state.ui.activeScenario  || null,
    },
    // Embedded CSV assets ride along so a load_csv() program is
    // self-contained in the exported form. (File-referenced assets,
    // when those land, won't travel — only embedded ones.)
    assets: state.assets || {},
  };
  const stateJs = 'const INITIAL_STATE = ' + JSON.stringify(newState, null, 2) + ';';
  const html = VIEWER_HTML.replace(
    /\/\* MARKER:STATE_START \*\/[\s\S]*?\/\* MARKER:STATE_END \*\//,
    `/* MARKER:STATE_START */\n${stateJs}\n/* MARKER:STATE_END */`
  );
  const name = (exportNameEl.value || 'program') + '.html';
  return { html, name };
}

dlHtmlBtn.addEventListener('click', async () => {
  const out = buildExportHtml();
  if (!out) return;
  try {
    const r = await deliverFile(out.name, out.html, 'text/html');
    if (r.via === 'shell') { flash(dlHtmlBtn, 'saved to Downloads'); return; }
  } catch (e) { console.error('ep: .html export failed:', e); flash(dlHtmlBtn, 'failed'); return; }
  scrim.classList.remove('on');
});

// Share the form itself (not a link) — the phone's natural "send this to
// someone" gesture. Inside the shell: publish to Downloads, then the
// system share sheet by reference. On the web: navigator.share with the
// file where that's supported.
if (shareFileBtn) {
  shareFileBtn.addEventListener('click', async () => {
    const out = buildExportHtml();
    if (!out) return;
    if (shellPresent()) {
      try { await deliverFile(out.name, out.html, 'text/html', { share: true }); scrim.classList.remove('on'); }
      catch (e) { console.error('ep: share failed:', e); flash(shareFileBtn, 'failed'); }
      return;
    }
    try {
      const file = new File([out.html], out.name, { type: 'text/html' });
      await navigator.share({ files: [file], title: out.name.replace(/\.html$/, '') });
      scrim.classList.remove('on');
    } catch (e) {
      // AbortError = user dismissed the sheet; anything else, fall back
      // to a plain download so the gesture still produces the file.
      if (!e || e.name !== 'AbortError') downloadFile(out.html, out.name, 'text/html');
    }
  });
}

copySrcBtn.addEventListener('click', async () => {
  const text = serializeProgram();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    const prev = copySrcBtn.textContent;
    copySrcBtn.textContent = 'copied';
    setTimeout(() => { copySrcBtn.textContent = prev; }, 1200);
  } catch {
    const prev = copySrcBtn.textContent;
    copySrcBtn.textContent = 'err';
    setTimeout(() => { copySrcBtn.textContent = prev; }, 1200);
  }
});

shareBtn.addEventListener('click', async () => {
  const prev = shareBtn.textContent;
  shareBtn.textContent = '…';
  shareBtn.disabled = true;
  try {
    const text = serializeProgram();
    const url = await generateShareUrl(text);
    shareRow.style.display = '';
    shareUrlEl.value = url;
    shareLenEl.textContent = `· ${url.length} chars`;
    try {
      // QR encodes the q:d (base45) form — same content, ~22% denser in
      // QR alphanumeric mode than the i:d (base64url) form we show in the
      // link box. Tap-to-copy uses the link form; scan uses the QR form.
      const qrUrl = await generateShareUrlForQR(text);
      shareQrEl.innerHTML = qrSvgFor(qrUrl, {moduleSize: 4, margin: 2});
    } catch (e) {
      // Payload too big for the largest QR version — show a note and continue with the link only.
      shareQrEl.innerHTML = `<span style="font-size:10px;color:var(--au-fg-soft)">QR: ${e.message}</span>`;
    }
    if (navigator.share) {
      try {
        await navigator.share({title: 'ep program', text: `ep program: ${currentProgramName || 'untitled'}`, url});
      } catch { /* user cancelled share — fine */ }
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
      shareBtn.textContent = 'copied';
      setTimeout(() => { shareBtn.textContent = prev; shareBtn.disabled = false; }, 1200);
      shareUrlEl.select();
      return;
    } else {
      shareUrlEl.select();
    }
    shareBtn.textContent = prev;
  } catch (e) {
    console.error('share encode failed:', e);
    shareBtn.textContent = 'err';
    setTimeout(() => { shareBtn.textContent = prev; }, 1200);
  } finally {
    shareBtn.disabled = false;
  }
});

function downloadFile(text, name, type) {
  const blob = new Blob([text], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
