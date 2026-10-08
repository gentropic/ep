// Export dialog: package the current program as .ep source or self-cloning .html.
// The .html path reads its own outerHTML and swaps the INITIAL_STATE block via
// the STATE markers — preserving this contract is critical to the round-trip.

import { state } from './state.js';
import { currentProgramName } from './storage.js';
import { generateShareUrl, generateShareUrlForQR, qrSvgFor } from './share.js';
import { isPocket, dismissKeyboard } from './viewport.js';

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
  if (shareFileBtn) shareFileBtn.style.display = _canShareFiles ? '' : 'none';
  renderExportInputs();
  scrim.classList.add('on');
});
cancelBtn.addEventListener('click', () => scrim.classList.remove('on'));
scrim.addEventListener('click', e => { if (e.target === scrim) scrim.classList.remove('on'); });
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && scrim.classList.contains('on')) scrim.classList.remove('on');
});

dlEpBtn.addEventListener('click', () => {
  const text = serializeProgram();
  const name = (exportNameEl.value || 'program') + '.ep';
  downloadFile(text, name, 'text/plain');
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

dlHtmlBtn.addEventListener('click', () => {
  const out = buildExportHtml();
  if (!out) return;
  downloadFile(out.html, out.name, 'text/html');
  scrim.classList.remove('on');
});

// Share the form itself (not a link) through the system share sheet —
// the phone's natural "send this to someone" gesture. Only wired where
// navigator.canShare accepts files.
if (shareFileBtn) {
  shareFileBtn.addEventListener('click', async () => {
    const out = buildExportHtml();
    if (!out) return;
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
