// Document Picture-in-Picture scratchpad. Opens a floating always-on-top
// window with a slim ep editor: just the body + result gutter + inline
// error/info widgets. No chips, no drawer, no header. A separate
// scratch program (NOT the main one) persisted to ep:pip-scratch.
//
// Browser support: Chromium-based browsers ship the Document PiP API
// (Chrome 116+ / Edge 116+). Firefox + Safari don't yet. The PiP button
// is hidden when the API is unavailable; the keyboard shortcut quietly
// no-ops in that case.
//
// Why duplicate some CM6 wiring from render.js?
//   render.js's EpErrorWidget / ResultMarker / epLang are local to its
//   setupBody() closure — not exported. Pulling them out for reuse would
//   require refactoring the whole render module. For now, the PiP keeps
//   its own slim copies (~150 LOC). They mirror the originals but read
//   from a PiP-local _pipRows array instead of the global state.body,
//   so the scratchpad's evaluation is fully isolated from the main
//   program.

import { evaluate, getCompletionData } from './evaluator.js';
import { fmt } from './units.js';
import { getSetting } from './storage.js';

const PIP_STORAGE_KEY = 'ep:pip-scratch';
const DEFAULT_SCRATCH = '# scratchpad — auto-saves as you type\n# Shift+Alt+P from the main window to reopen\n\n';

let _pipWindow = null;
let _pipView = null;
let _pipRows = [];
let _saveTimer = null;

function loadScratch() {
  try { return localStorage.getItem(PIP_STORAGE_KEY) || DEFAULT_SCRATCH; }
  catch { return DEFAULT_SCRATCH; }
}

function saveScratch(text) {
  try { localStorage.setItem(PIP_STORAGE_KEY, text); } catch {}
}

function scheduleSave(text) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => saveScratch(text), 400);
}

function pipEscapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Per-line gutter cell HTML — read from the PiP-local _pipRows.
// Smaller surface than render.js's resultMarkerHtml: no @input/@output
// chip semantics (scratchpad has no decorators), no per-line unit
// override, no suspect markers (no @output → no blame to surface).
function pipMarkerHtml(lineIdx) {
  const r = _pipRows[lineIdx];
  if (!r) return null;
  if (r.error) {
    return { html: '<span class="ep-gutter-err-x" aria-label="error">✕</span>', cls: 'error' };
  }
  if (!r.result) return null;
  // Bare print() returns Quantity(0, {}) — suppress the gutter value;
  // the inline info block below the line shows the captured text.
  if (r.kind === 'expr' && r.print
      && typeof r.result === 'object'
      && r.result.value === 0
      && r.result.dim && Object.keys(r.result.dim).length === 0) {
    return null;
  }
  if (typeof r.result !== 'object' || r.result.dim == null) {
    const t = typeof r.result;
    const label = t === 'boolean' ? (r.result ? 'true' : 'false')
                : t === 'string'  ? '"' + String(r.result).slice(0, 24) + '"'
                : t === 'function'? 'fn'
                : String(t);
    return { html: `<span class="u">${pipEscapeHtml(label)}</span>`, cls: '' };
  }
  try {
    const [num, unit] = fmt(r.result);
    return {
      html: `<span class="n">${pipEscapeHtml(num)}</span>` + (unit ? ` <span class="u">${pipEscapeHtml(unit)}</span>` : ''),
      cls: '',
    };
  } catch {
    return null;
  }
}

export async function openPip() {
  if (!('documentPictureInPicture' in window)) {
    console.warn('ep: Document Picture-in-Picture not supported in this browser');
    return;
  }
  // Singleton — re-focusing an already-open PiP just brings it forward.
  if (_pipWindow && !_pipWindow.closed) {
    try { _pipWindow.focus(); } catch {}
    return;
  }

  const pip = await window.documentPictureInPicture.requestWindow({
    width: 380, height: 480,
  });
  _pipWindow = pip;

  // Copy stylesheets from main document into the PiP document.
  // ep's CSS lives inline (single-file ethos) so cssRules is readable;
  // try/catch guards future deployments that might import external sheets.
  for (const sheet of document.styleSheets) {
    try {
      const styleEl = pip.document.createElement('style');
      styleEl.textContent = [...sheet.cssRules].map(r => r.cssText).join('\n');
      pip.document.head.appendChild(styleEl);
    } catch {
      // Cross-origin or otherwise unreadable — silently skip.
    }
  }

  // Mirror the dark/light theme at the moment of opening.
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme) pip.document.documentElement.setAttribute('data-theme', theme);

  pip.document.title = 'ep · scratchpad';
  pip.document.body.classList.add('app');
  pip.document.body.style.cssText = 'margin:0;padding:0;height:100vh;display:flex;flex-direction:column;background:var(--sw-bg);color:var(--sw-text);';

  // Use the same `.body` class the main editor mounts under — every
  // gutter / error-block / completion-popup CSS rule in style.css is
  // scoped to `.body .something`, so the PiP's editor only renders
  // correctly when its container picks up that class.
  const root = pip.document.createElement('div');
  root.className = 'body';
  root.style.cssText = 'flex:1;overflow:auto;min-height:0;';
  pip.document.body.appendChild(root);

  // ── CM6 wiring (mirrors render.js, slim variant) ───────────────────
  const {
    EditorView, EditorState, keymap, history, historyKeymap,
    gutter, GutterMarker, drawSelection, defaultKeymap,
    StreamLanguage, syntaxHighlighting, HighlightStyle, tags,
    foldGutter, foldKeymap, lineNumbers,
    bracketMatching, closeBrackets,
    Decoration, WidgetType, StateField, StateEffect,
    autocompletion, acceptCompletion,
  } = CM6;

  const KEYWORDS  = /^(let|fn|if|then|else|where|dimension|unit|struct|use|to|per|and|or|not|true|false)\b/;
  const CONSTANTS = /^(pi|tau|e|π|τ|φ)\b/;
  const NUMBER    = /^[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?/;
  const epLang = StreamLanguage.define({
    name: 'ep-script',
    token(stream) {
      if (stream.eatSpace()) return null;
      if (stream.match(/^#.*/))                                  return 'comment';
      if (stream.match(/^--.*/))                                 return 'comment';
      if (stream.match(/^@[a-zA-Z_][a-zA-Z0-9_]*/))              return 'meta';
      if (stream.match(KEYWORDS))                                return 'keyword';
      if (stream.match(CONSTANTS))                               return 'atom';
      if (stream.match(NUMBER))                                  return 'number';
      if (stream.match(/^"(\\.|[^"\\])*"/))                      return 'string';
      if (stream.match(/^[A-Z][a-zA-Z0-9_]*/))                   return 'typeName';
      if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/))               return 'variableName';
      if (stream.match(/^(->|→|×|÷|−|≤|≥|≠|==|!=|<=|>=|\|>)/))   return 'operatorKeyword';
      if (stream.match(/^[+\-*/^=<>!]/))                         return 'operator';
      stream.next();
      return null;
    },
    languageData: { commentTokens: { line: '#' } },
  });
  const epHighlight = HighlightStyle.define([
    { tag: tags.comment,         color: 'var(--sw-text-soft)', fontStyle: 'italic' },
    { tag: tags.lineComment,     color: 'var(--sw-text-soft)', fontStyle: 'italic' },
    { tag: tags.meta,            color: 'var(--sw-orange)',    fontWeight: '700' },
    { tag: tags.keyword,         color: 'var(--sw-orange)' },
    { tag: tags.atom,            color: 'var(--sw-indigo)' },
    { tag: tags.number,          color: 'var(--sw-text-mid)' },
    { tag: tags.string,          color: 'var(--sw-teal)' },
    { tag: tags.typeName,        color: 'var(--sw-teal)' },
    { tag: tags.variableName,    color: 'var(--sw-text)' },
    { tag: tags.operatorKeyword, color: 'var(--sw-orange)' },
    { tag: tags.operator,        color: 'var(--sw-text-mid)' },
  ]);

  // Inline error/info block widget — kind: 'error' | 'warn' | 'info'.
  // The PiP only uses 'error' and 'info' in practice (no @output blame
  // → no 'warn'), but the kind field is plumbed through for parity.
  class PipBlockWidget extends WidgetType {
    constructor(message, kind) { super(); this.message = message; this.kind = kind || 'error'; }
    eq(other) { return other.message === this.message && other.kind === this.kind; }
    toDOM() {
      const el = pip.document.createElement('div');
      el.className = 'cm-ep-error-block'
        + (this.kind === 'warn' ? ' cm-ep-warn-block' : '')
        + (this.kind === 'info' ? ' cm-ep-info-block' : '');
      const msg = pip.document.createElement('span');
      msg.className = 'cm-ep-error-block-msg';
      msg.textContent = this.message;
      el.appendChild(msg);
      return el;
    }
    ignoreEvent() { return false; }
  }

  const errorEffect = StateEffect.define();
  const errorsField = StateField.define({
    create() { return Decoration.none; },
    update(value, tr) {
      value = value.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(errorEffect)) continue;
        const decos = [];
        for (const it of e.value) {
          if (!it || it.line < 1 || it.line > tr.state.doc.lines) continue;
          const line = tr.state.doc.line(it.line);
          if (line.length === 0) continue;
          const leadingWS = line.text.match(/^\s*/)[0].length;
          const fromCol = it.col && it.col > leadingWS ? it.col - 1 : leadingWS;
          const from = line.from + fromCol;
          const to = line.to;
          if (from < to && it.kind !== 'info') {
            decos.push(Decoration.mark({
              class: it.kind === 'warn' ? 'cm-ep-warn' : 'cm-ep-error',
              attributes: { title: it.message || '' },
            }).range(from, to));
          }
          const cleanMsg = (it.message || '').replace(/^[^:]*:\d+:\d+:\s*/, '');
          decos.push(Decoration.widget({
            widget: new PipBlockWidget(cleanMsg, it.kind),
            block: true,
            side: 1,
          }).range(line.to));
        }
        value = Decoration.set(decos, true);
      }
      return value;
    },
    provide: f => EditorView.decorations.from(f),
  });

  class ResultMarker extends GutterMarker {
    constructor(html, cls, lineIdx) {
      super();
      this.html = html; this.cls = cls; this.lineIdx = lineIdx;
    }
    eq(other) { return other && other.html === this.html && other.cls === this.cls && other.lineIdx === this.lineIdx; }
    toDOM() {
      const el = pip.document.createElement('span');
      el.className = 'ep-gutter-result' + (this.cls ? ' ' + this.cls : '');
      el.innerHTML = this.html;
      return el;
    }
  }

  const resultGutter = gutter({
    side: 'after',
    class: 'ep-result-gutter',
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;
      const m = pipMarkerHtml(lineNo - 1);
      return m ? new ResultMarker(m.html, m.cls, lineNo - 1) : null;
    },
    lineMarkerChange() { return true; },
  });

  // Completion source — mirrors render.js's _epCompletions but scoped
  // to the PiP. Variable suggestions come from any named bindings in
  // the scratchpad's most recent evaluation; everything else (units,
  // fns, dimensions, keywords) shares getCompletionData() with main ep.
  const _pipCompletions = (context) => {
    const word = context.matchBefore(/[a-zA-Z_µμπτφ][a-zA-Z0-9_]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const { units, functions, dimensions, keywords } = getCompletionData();

    const before = context.state.doc.sliceString(Math.max(0, word.from - 4), word.from);
    if (/:\s$/.test(before)) {
      return { from: word.from, options: dimensions.map(d => ({ label: d, type: 'type', boost: 20 })) };
    }

    const scopeNames = new Set();
    for (const r of _pipRows) if (r && r.name) scopeNames.add(r.name);

    const options = [];
    for (const n of scopeNames)              options.push({ label: n, type: 'variable', boost: 30 });
    for (const k of keywords)                options.push({ label: k, type: 'keyword',  boost: 10 });
    for (const f of functions)               options.push({ label: f, type: 'function', boost:  5, apply: f + '(' });
    for (const u of units)                   options.push({ label: u, type: 'unit',     boost:  0 });
    return { from: word.from, options };
  };

  // Recompute on every doc change: run a pure evaluate(), stash the
  // rows for the gutter, dispatch error/info items to the field.
  function recompute(view) {
    const text = view.state.doc.toString();
    const body = text.split('\n').map(src => ({src}));
    try {
      const r = evaluate(body);
      _pipRows = r.rows;
    } catch (e) {
      _pipRows = body.map(() => ({ kind: 'expr', error: 'evaluator threw: ' + (e && e.message || e) }));
    }
    const items = [];
    for (let i = 0; i < _pipRows.length; i++) {
      const row = _pipRows[i];
      if (row.error) {
        const message = row.error;
        let col = 0;
        const m = message.match(/^[^:]*:1:(\d+):/);
        if (m) col = parseInt(m[1], 10);
        items.push({ line: i + 1, col, message, kind: 'error' });
      }
      if (row.print) {
        items.push({ line: i + 1, col: 0, message: row.print, kind: 'info' });
      }
    }
    view.dispatch({ effects: errorEffect.of(items) });
    scheduleSave(text);
  }

  _pipView = new EditorView({
    state: EditorState.create({
      doc: loadScratch(),
      extensions: [
        epLang,
        syntaxHighlighting(epHighlight),
        bracketMatching(),
        closeBrackets(),
        autocompletion({
          override: [_pipCompletions],
          activateOnTyping: true,
          closeOnBlur: true,
          maxRenderedOptions: 60,
        }),
        // Line-number gutter — mirrors the main editor's optional gutter,
        // gated on the same `lineNumbers` setting. Read once at open; the
        // PiP is a transient window, so no live-toggle compartment.
        ...(getSetting('lineNumbers', false) ? [lineNumbers()] : []),
        foldGutter(),
        EditorView.lineWrapping,
        history(),
        drawSelection(),
        errorsField,
        resultGutter,
        keymap.of([
          // Tab accepts the open completion when one is showing (matches
          // main ep). Falls through to default tab behavior otherwise.
          { key: 'Tab', run: acceptCompletion },
          ...(historyKeymap || []),
          ...(foldKeymap || []),
          ...(defaultKeymap || []),
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          recompute(update.view);
        }),
        EditorView.theme({
          '&': { height: '100%' },
        }),
      ],
    }),
    parent: root,
  });

  // Seed the gutter with current results from the freshly-loaded doc.
  recompute(_pipView);

  pip.addEventListener('pagehide', () => {
    try { saveScratch(_pipView ? _pipView.state.doc.toString() : ''); } catch {}
    try { if (_pipView) _pipView.destroy(); } catch {}
    _pipView = null;
    _pipWindow = null;
  });

  try { _pipView.focus(); } catch {}
}

// ── Wiring: header button + feature detection ─────────────────────────
const btn = document.getElementById('pipBtn');
if (btn) {
  if ('documentPictureInPicture' in window) {
    btn.style.display = '';
    btn.addEventListener('click', () => {
      openPip().catch(e => console.error('ep: PiP open failed:', e));
    });
  } else {
    // API unsupported — leave button hidden, no fallback UI.
    btn.style.display = 'none';
  }
}
