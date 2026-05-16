// Entry point for the viewer build. The viewer artifact is a purpose-built
// HTML file produced by ep's `.html` export — it loads one program and
// presents its chips + computed outputs, with no editor / drawer / export
// machinery. State arrives baked into INITIAL_STATE via the same STATE
// markers ep uses for self-cloning.

import { evaluateAll } from './state.js';
import { renderChips, renderResults } from './render.js';
import { encodeInlineI } from './pointer.js';

import { state } from './state.js';

evaluateAll();
renderChips();
renderResults();

// Header filename comes from the exported program's name. INITIAL_STATE.name
// is set by export.js when serializing the viewer artifact.
const hdrFileEl = document.getElementById('hdrFile');
if (hdrFileEl && typeof INITIAL_STATE !== 'undefined' && INITIAL_STATE.name) {
  hdrFileEl.textContent = INITIAL_STATE.name;
  document.title = `${INITIAL_STATE.name} — ep`;
}

// Surface the program's first comment line as a subtitle. Authors who
// open a `# what this calculates` line in their source get free
// description text in the viewer header.
const subtitleEl = document.getElementById('viewerSubtitle');
if (subtitleEl) {
  const desc = firstCommentLine(state.body.map(r => r.src));
  if (desc) {
    subtitleEl.textContent = desc;
    subtitleEl.style.display = '';
  }
}

function firstCommentLine(bodyLines) {
  for (const line of bodyLines || []) {
    const t = (line || '').trim();
    if (!t) continue;
    if (t.startsWith('#'))  return t.replace(/^#+\s*/, '').trim();
    if (t.startsWith('--')) return t.replace(/^--+\s*/, '').trim();
    return null;
  }
  return null;
}

// "Modify this calculation" link — encode the current program as an
// @gcu/pointer and point at gentropic.org/ep with it. One click takes a
// recipient from "I'm reading this calculation" to "I'm editing it in
// the full ep editor". Suppressed entirely when the exporter unchecked
// "include modify link" — the link element AND its separator hide so
// the footer collapses cleanly to just the attribution.
const editLink = document.getElementById('viewerEditLink');
const includeEdit = INITIAL_STATE && INITIAL_STATE.ui && INITIAL_STATE.ui.includeEditLink !== false;
if (editLink && includeEdit) {
  const text = state.body.map(r => r.src).join('\n');
  encodeInlineI(text).then(pointer => {
    editLink.href = 'https://gentropic.org/ep#' + pointer;
  }).catch(() => { /* leave default href in place */ });
} else if (editLink) {
  editLink.style.display = 'none';
  const sep = editLink.nextElementSibling;
  if (sep && sep.classList.contains('viewer-footer-sep')) sep.style.display = 'none';
}

// "Show calculation" toggle — read-only source reveal. The recipient can
// inspect the program without an editor; chips remain the only interaction
// surface. The source gets a small regex-based syntax highlight pass so it
// looks like the editor view (without dragging CM6 into the viewer bundle).
const showSourceBtn = document.getElementById('showSourceBtn');
const sourceView    = document.getElementById('sourceView');
const appEl         = document.getElementById('app');
if (showSourceBtn && sourceView) {
  let shown = false;
  showSourceBtn.addEventListener('click', () => {
    shown = !shown;
    if (shown) {
      sourceView.innerHTML = highlightEpScript(state.body.map(r => r.src).join('\n'));
      sourceView.style.display = '';
      showSourceBtn.textContent = 'hide calculation ▴';
      if (appEl) appEl.classList.add('source-shown');
    } else {
      sourceView.style.display = 'none';
      showSourceBtn.textContent = 'show calculation ▾';
      if (appEl) appEl.classList.remove('source-shown');
    }
  });
}

// ── Regex tokenizer for the source view ───────────────────────────
// Mirrors the editor's CM6 StreamLanguage / HighlightStyle scheme so the
// viewer source pane visually matches the editor. Per-line; comment tokens
// (`#` and `--`) consume to end of line.

function htmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HL_KEYWORDS  = /^(let|fn|if|then|else|where|dimension|unit|struct|use|to|per|and|or|not|true|false)\b/;
const HL_CONSTANTS = /^(pi|tau|e|π|τ|φ)\b/;
const HL_NUMBER    = /^[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?/;
const HL_OPKEY     = /^(->|→|×|÷|−|≤|≥|≠|==|!=|<=|>=|\|>)/;
const HL_OP        = /^[+\-*/^=<>!]/;
const HL_TYPE      = /^[A-Z][a-zA-Z0-9_]*/;
const HL_IDENT     = /^[a-zA-Z_][a-zA-Z0-9_]*/;
const HL_STRING    = /^"(\\.|[^"\\])*"/;
const HL_DECORATOR = /^@[a-zA-Z_][a-zA-Z0-9_]*/;
const HL_WS        = /^[ \t]+/;

function highlightEpScript(source) {
  return source.split('\n').map(highlightLine).join('\n');
}

function highlightLine(line) {
  let rest = line;
  let out = '';
  const wrap = (cls, text) => `<span class="hl-${cls}">${htmlEscape(text)}</span>`;

  while (rest.length > 0) {
    // Comments swallow the rest of the line.
    if (rest.startsWith('#') || rest.startsWith('--')) {
      out += wrap('comment', rest);
      break;
    }
    let m;
    if ((m = rest.match(HL_STRING)))    { out += wrap('string',          m[0]); }
    else if ((m = rest.match(HL_DECORATOR))) { out += wrap('meta',       m[0]); }
    else if ((m = rest.match(HL_KEYWORDS)))  { out += wrap('keyword',    m[0]); }
    else if ((m = rest.match(HL_CONSTANTS))) { out += wrap('atom',       m[0]); }
    else if ((m = rest.match(HL_NUMBER)))    { out += wrap('number',     m[0]); }
    else if ((m = rest.match(HL_OPKEY)))     { out += wrap('opKeyword',  m[0]); }
    else if ((m = rest.match(HL_TYPE)))      { out += wrap('typeName',   m[0]); }
    else if ((m = rest.match(HL_IDENT)))     { out += wrap('ident',      m[0]); }
    else if ((m = rest.match(HL_OP)))        { out += wrap('operator',   m[0]); }
    else if ((m = rest.match(HL_WS)))        { out += htmlEscape(m[0]); }
    else { out += htmlEscape(rest[0]); rest = rest.slice(1); continue; }
    rest = rest.slice(m[0].length);
  }
  return out;
}
