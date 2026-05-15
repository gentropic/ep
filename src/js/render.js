// DOM rendering: input chips above, CodeMirror 6 editor + right-side results
// gutter for the body, output chips below.
//
// Body model:
//   The body is a CodeMirror 6 EditorView mounted in #body. Native undo/redo
//   across the whole document, full keyboard navigation, multi-line selection
//   all "just work." Per-line results render in CM6's right-side gutter via
//   the gutter({side: 'after'}) extension, aligned 1:1 to source lines by CM6
//   itself.
//
// Sync model:
//   - body edit  → CM6 update listener splits doc by '\n', updates state.body,
//                  evaluateAll, refreshes chip inputs and chip results. The
//                  results gutter recomputes automatically via lineMarkerChange.
//   - chip edit  → write-through to state.body[bodyIdx].src → evaluateAll →
//                  dispatch a CM6 transaction reflecting the new doc. The
//                  _syncingFromChip flag short-circuits the update listener so
//                  we don't re-evaluate redundantly.

import { state, evaluateAll } from './state.js';
import { fmt } from './units.js';
import { scheduleAutosave } from './storage.js';

const chipsEl    = document.getElementById('chips');
const outChipsEl = document.getElementById('outChips');
const bodyEl     = document.getElementById('body');
const paramMetaEl = document.getElementById('paramMeta');
const outMetaEl   = document.getElementById('outMeta');

let cmView = null;
let _syncingFromChip = false;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resultMarkerHtml(lineIdx) {
  const r = state.body[lineIdx];
  if (!r) return null;
  if (r.error) {
    return { html: escapeHtml(r.error), text: r.error, cls: 'error' };
  }
  if (r.result) {
    const [n, u] = fmt(r.result);
    const isOutput = r.kind === 'binding' && state.outputs.includes(r.name);
    const cls = r.kind === 'binding' ? (isOutput ? 'output' : 'binding') : '';
    return {
      html: escapeHtml(n) + (u ? ` <span class="u">${escapeHtml(u)}</span>` : ''),
      text: n + (u ? ' ' + u : ''),
      cls,
    };
  }
  return null;
}

function mountCm6() {
  const CM6 = globalThis.CM6;
  if (!CM6) {
    bodyEl.innerHTML = '<div style="padding:20px;color:var(--sw-red);font-family:var(--sw-mono);font-size:12px">CodeMirror 6 bundle not loaded.</div>';
    return;
  }

  const {
    EditorView, EditorState, keymap, history, historyKeymap,
    gutter, GutterMarker, drawSelection, defaultKeymap,
    StreamLanguage, syntaxHighlighting, HighlightStyle, tags,
    foldGutter, foldKeymap, foldService,
    bracketMatching, closeBrackets,
  } = CM6;

  // ── ep-script tokenizer (StreamLanguage) ────────────────────────
  const KEYWORDS = /^(let|fn|if|then|else|where|dimension|unit|struct|use|to|per|and|or|not|true|false)\b/;
  const CONSTANTS = /^(pi|tau|e|π|τ|φ)\b/;
  const NUMBER   = /^[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?/;
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

  // Fold @params { ... } blocks via foldService. Returns the range from end
  // of `@params {` line to before the matching `}` line; CM6's foldGutter
  // renders a chevron next to lines with foldable content.
  const epFold = foldService.of((state, lineStart, lineEnd) => {
    const lineText = state.doc.sliceString(lineStart, lineEnd);
    if (!/^\s*@params\s*\{\s*$/.test(lineText)) return null;
    const openLineNo = state.doc.lineAt(lineStart).number;
    for (let i = openLineNo + 1; i <= state.doc.lines; i++) {
      const next = state.doc.line(i);
      if (/^\s*\}\s*$/.test(next.text)) return { from: lineEnd, to: next.from - 1 };
    }
    return null;
  });

  // The result-gutter marker class. eq() lets CM6 skip DOM updates when the
  // formatted result hasn't changed line-to-line. title attr carries the
  // full text so long errors are readable on hover even though they're
  // truncated in the gutter cell.
  class ResultMarker extends GutterMarker {
    constructor(html, text, cls) { super(); this.html = html; this.text = text; this.cls = cls; }
    eq(other) { return other && other.html === this.html && other.cls === this.cls; }
    toDOM() {
      const el = document.createElement('div');
      el.className = 'ep-gutter-result' + (this.cls ? ' ' + this.cls : '');
      el.innerHTML = this.html;
      el.title = this.text;
      return el;
    }
  }

  const resultGutter = gutter({
    side: 'after',
    class: 'ep-result-gutter',
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;  // 1-indexed
      const m = resultMarkerHtml(lineNo - 1);
      return m ? new ResultMarker(m.html, m.text, m.cls) : null;
    },
    lineMarkerChange() { return true; },
  });

  const initialDoc = state.body.map(r => r.src).join('\n');

  bodyEl.innerHTML = '';
  cmView = new EditorView({
    state: EditorState.create({
      doc: initialDoc,
      extensions: [
        epLang,
        syntaxHighlighting(epHighlight),
        bracketMatching(),
        closeBrackets(),
        foldGutter(),
        epFold,
        EditorView.lineWrapping,
        history(),
        drawSelection(),
        resultGutter,
        keymap.of([
          ...(historyKeymap || []),   // Mod-z / Mod-Shift-z / Mod-y
          ...(foldKeymap || []),      // Cmd/Ctrl-Alt-[ / -] fold / unfold
          ...(defaultKeymap || []),   // arrow keys, Home/End, word jumps, etc.
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (_syncingFromChip) return;
          try {
            const text = update.state.doc.toString();
            state.body = text.split('\n').map(src => ({src}));
            evaluateAll();
            syncChipInputsFromState();
            renderChipResults();
            renderOutputs();
            scheduleAutosave();
          } catch (e) {
            // Never let an evaluator hiccup wedge CM6's update cycle.
            console.error('ep: evaluator threw during doc update:', e);
          }
        }),
        EditorView.theme({
          '&': { height: '100%' },
        }),
      ],
    }),
    parent: bodyEl,
  });

  bodyEl.addEventListener('focusin', () => { state._lastFocused = cmView; });
}

function syncCmFromState() {
  if (!cmView) return;
  const text = state.body.map(r => r.src).join('\n');
  const current = cmView.state.doc.toString();
  if (current === text) return;
  _syncingFromChip = true;
  try {
    cmView.dispatch({ changes: { from: 0, to: current.length, insert: text } });
  } finally {
    _syncingFromChip = false;
  }
}

function syncChipInputsFromState() {
  for (const p of state.params) {
    if (!p._inputEl) continue;
    if (p._inputEl === document.activeElement) continue;
    if (p._inputEl.value !== p.valueSrc) p._inputEl.value = p.valueSrc;
  }
}

// ── Chips ─────────────────────────────────────────────────────────

export function renderChips() {
  chipsEl.innerHTML = '';
  state.params.forEach(p => {
    const name = p.name;
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.dataset.paramName = name;
    const lbl = document.createElement('div');
    lbl.className = 'chip-lbl';
    lbl.textContent = p.anno ? `${name} : ${p.anno}` : name;
    const inp = document.createElement('input');
    inp.className = 'chip-val';
    inp.value = p.valueSrc;
    inp.spellcheck = false;
    inp.autocapitalize = 'off';
    inp.autocomplete = 'off';
    inp.dataset.paramName = name;
    inp.addEventListener('input', () => {
      const cur = state.params.find(x => x.name === name);
      if (!cur) return;
      const bodyIdx = cur.bodyIdx;
      const line = state.body[bodyIdx];
      const eq = line.src.indexOf('=');
      line.src = (eq >= 0 ? line.src.slice(0, eq + 1) + ' ' : `  ${name} = `) + inp.value;
      evaluateAll();
      syncCmFromState();
      renderChipResults();
      renderOutputs();
      scheduleAutosave();
    });
    inp.addEventListener('focus', () => { state._lastFocused = inp; });
    const res = document.createElement('div');
    res.className = 'chip-res';
    chip.append(lbl, inp, res);
    chipsEl.append(chip);
    p._resEl   = res;
    p._inputEl = inp;
  });
  paramMetaEl.textContent = `· ${state.params.length} input${state.params.length === 1 ? '' : 's'}`;
}

// ── Body ──────────────────────────────────────────────────────────

export function renderBody() {
  if (!cmView) {
    mountCm6();
    return;
  }
  syncCmFromState();
}

// ── Results ───────────────────────────────────────────────────────

function renderChipResults() {
  for (const p of state.params) {
    if (!p._resEl) continue;
    if (p.error) {
      p._resEl.className = 'chip-res error';
      p._resEl.textContent = p.error;
    } else if (p.result) {
      const [n, u] = fmt(p.result);
      p._resEl.className = 'chip-res';
      p._resEl.innerHTML = n + (u ? ` <span class="u">${u}</span>` : '');
    } else {
      p._resEl.className = 'chip-res';
      p._resEl.textContent = '';
    }
  }
}

export function renderResults() {
  renderChipResults();
  renderOutputs();
}

export function renderOutputs() {
  outChipsEl.innerHTML = '';
  const panel = document.getElementById('outputsPanel');
  const names = state.outputs;
  outMetaEl.textContent = `· ${names.length} result${names.length === 1 ? '' : 's'}`;
  if (!names.length) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  for (const name of names) {
    const chip = document.createElement('div');
    chip.className = 'chip readonly';
    const lbl = document.createElement('div');
    lbl.className = 'chip-lbl';
    lbl.textContent = name;

    const row = document.createElement('div');
    row.className = 'chip-out-row';
    const val = document.createElement('div');
    val.className = 'chip-out-val';
    const q = state._scope[name];
    let copyText = '';
    if (q == null) {
      val.classList.add('error');
      val.textContent = 'undefined';
    } else {
      const [n, u] = fmt(q);
      val.innerHTML = n + (u ? ` <span class="u">${u}</span>` : '');
      copyText = n.replace(/,/g, '') + (u ? ' ' + u.replace(/²/g, '^2').replace(/³/g, '^3') : '');
    }
    row.append(val);

    if (q != null) {
      const btn = document.createElement('button');
      btn.className = 'chip-copy';
      btn.textContent = 'copy';
      btn.title = `copy "${copyText}"`;
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(copyText);
          } else {
            const ta = document.createElement('textarea');
            ta.value = copyText;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
          btn.textContent = 'copied';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1200);
        } catch {
          btn.textContent = 'err';
          setTimeout(() => { btn.textContent = 'copy'; }, 1200);
        }
      });
      row.append(btn);
    }

    chip.append(lbl, row);
    outChipsEl.append(chip);
  }
}
