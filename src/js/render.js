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
import { fmt, fmtNum, dEq, fmtDim } from './units.js';
import { resolveUnitExpression, getCompletionData, getCompatibleUnits } from './evaluator.js';
import { attachLongPress, showMenu } from './menu.js';

const chipsEl    = document.getElementById('chips');
const outChipsEl = document.getElementById('outChips');
const bodyEl     = document.getElementById('body');
const paramMetaEl = document.getElementById('paramMeta');
const outMetaEl   = document.getElementById('outMeta');

let cmView = null;
let _syncingFromChip = false;

// CM6 error-decoration plumbing — assigned inside mountCm6() (where CM6 is
// destructured) and used by applyErrorMarks() after each evaluate. Held at
// module scope so applyErrorMarks() can reach them without re-destructuring.
let _errorEffect = null;
let _errorsField = null;

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
  if (!r.result) return null;

  const outputSpec = r.kind === 'binding'
    ? state.outputs.find(s => s.name === r.name)
    : null;
  const isOutput = !!outputSpec;
  const cls = r.kind === 'binding' ? (isOutput ? 'output' : 'binding') : '';

  // Display unit resolution, highest priority first:
  //   1. Per-line override the user picked from the gutter (state.ui.gutterUnits)
  //   2. @outputs unit spec for this binding
  //   3. fmt()'s auto-scale (which itself honors a `.disp` from -> conversion)
  let n, u;
  const userOverride = r.name && state.ui.gutterUnits ? state.ui.gutterUnits[r.name] : null;
  if (userOverride) {
    try {
      const spec = resolveUnitExpression(userOverride);
      if (dEq(spec.dim, r.result.dim)) {
        n = fmtNum(r.result.value / spec.mul);
        u = spec.displayName;
      }
    } catch { /* fall through */ }
  }
  if (n === undefined && outputSpec && outputSpec.unit) {
    try {
      const spec = resolveUnitExpression(outputSpec.unit);
      if (dEq(spec.dim, r.result.dim)) {
        n = fmtNum(r.result.value / spec.mul);
        u = spec.displayName;
      }
    } catch { /* fall through to auto-scale */ }
  }
  if (n === undefined) [n, u] = fmt(r.result);

  return {
    html: escapeHtml(n) + (u ? ` <span class="u">${escapeHtml(u)}</span>` : ''),
    text: n + (u ? ' ' + u : ''),
    cls,
  };
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
    Decoration, StateField, StateEffect,
    autocompletion, CompletionContext, acceptCompletion,
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
    constructor(html, text, cls, lineIdx) {
      super();
      this.html = html; this.text = text; this.cls = cls;
      this.lineIdx = lineIdx;
    }
    eq(other) {
      return other && other.html === this.html && other.cls === this.cls
        && other.lineIdx === this.lineIdx;
    }
    toDOM() {
      const el = document.createElement('div');
      el.className = 'ep-gutter-result' + (this.cls ? ' ' + this.cls : '');
      el.innerHTML = this.html;
      el.title = this.text;
      const idx = this.lineIdx;
      // Click on a result cell opens the per-line unit-override menu.
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openGutterUnitMenu(idx, e.clientX, e.clientY);
      });
      return el;
    }
  }

  // ── Autocompletion (units / functions / dimensions / keywords) ─
  // Two-phase priority: identifiers in the user's current scope come
  // first (higher boost), so completing `vol|` in a program that already
  // has `volume` suggests that before `volumeflowrate`. Dimension names
  // surface only after a `:` (annotation context). Long unit list is
  // included unconditionally — it's the most painful thing to type and
  // remember, so the cost of a longer popup is worth it.
  const _epCompletions = (context) => {
    const word = context.matchBefore(/[a-zA-Z_µμπτφ][a-zA-Z0-9_]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    const { units, functions, dimensions, keywords } = getCompletionData();

    // Annotation context: just `name :` (one space after colon). Restrict
    // to dimension names there since unit/fn lookups are pointless.
    const before = context.state.doc.sliceString(
      Math.max(0, word.from - 4), word.from);
    if (/:\s$/.test(before)) {
      return {
        from: word.from,
        options: dimensions.map(d => ({ label: d, type: 'type', boost: 20 })),
      };
    }

    const scopeNames = state.params.map(p => p.name)
      .concat(Object.keys(state._scope || {}));
    const options = [];
    for (const n of new Set(scopeNames))     options.push({ label: n, type: 'variable', boost: 30 });
    for (const k of keywords)                options.push({ label: k, type: 'keyword',  boost: 10 });
    for (const f of functions)               options.push({ label: f, type: 'function', boost:  5, apply: f + '(' });
    for (const u of units)                   options.push({ label: u, type: 'unit',     boost:  0 });
    return { from: word.from, options };
  };

  // ── Error pinpoint (§4.2) ───────────────────────────────────────
  // After each evaluate, dispatch _errorEffect with [{line, col, message}, …].
  // The field translates that into Decoration.mark ranges so CM6 underlines
  // the offending range in the editor. col is 1-based within the source
  // line; if absent or <=1, the whole non-whitespace span of the line is
  // underlined. Tooltip is via the native title attribute on the mark span.
  // (Assigned at module scope so applyErrorMarks() can dispatch on cmView.)
  _errorEffect = StateEffect.define();
  _errorsField = StateField.define({
    create() { return Decoration.none; },
    update(value, tr) {
      value = value.map(tr.changes);
      for (const e of tr.effects) {
        if (!e.is(_errorEffect)) continue;
        const marks = [];
        for (const it of e.value) {
          if (!it || it.line < 1 || it.line > tr.state.doc.lines) continue;
          const line = tr.state.doc.line(it.line);
          if (line.length === 0) continue;
          // Skip leading whitespace so the underline doesn't sit under
          // indentation, which reads as a long dash rather than a marker.
          const leadingWS = line.text.match(/^\s*/)[0].length;
          const fromCol = it.col && it.col > leadingWS ? it.col - 1 : leadingWS;
          const from = line.from + fromCol;
          const to   = line.to;
          if (from >= to) continue;
          marks.push(Decoration.mark({
            class: 'cm-ep-error',
            attributes: { title: it.message || '' },
          }).range(from, to));
        }
        value = Decoration.set(marks, true);
      }
      return value;
    },
    provide: f => EditorView.decorations.from(f),
  });

  const resultGutter = gutter({
    side: 'after',
    class: 'ep-result-gutter',
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;  // 1-indexed
      const m = resultMarkerHtml(lineNo - 1);
      return m ? new ResultMarker(m.html, m.text, m.cls, lineNo - 1) : null;
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
        autocompletion({
          override: [_epCompletions],
          activateOnTyping: true,
          closeOnBlur: true,
          maxRenderedOptions: 60,
        }),
        foldGutter(),
        epFold,
        EditorView.lineWrapping,
        history(),
        drawSelection(),
        _errorsField,
        resultGutter,
        keymap.of([
          // Tab accepts the open completion. acceptCompletion returns false
          // when no popup is showing — Tab then falls through to default
          // browser tab order (so users can still leave the editor).
          { key: 'Tab', run: acceptCompletion },
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
            // If params were added/removed/renamed, rebuild the chip panel
            // wholesale; otherwise just update existing chip values + results.
            if (state._paramsStructureChanged) renderChips();
            else                                syncChipInputsFromState();
            renderChipResults();
            renderOutputs();
            applyErrorMarks();
            window.dispatchEvent(new CustomEvent('ep:params-changed'));
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
  // Detect widget-kind drift first — if any chip is mounted as a <select>
  // but its current valueSrc isn't in the enum set (or vice versa), the
  // existing element can't carry the value cleanly and we have to do a
  // full re-render. This handles source-side edits that switch a chip
  // from enum-style ("NQ_core") to freeform ("5 cm") and back.
  for (const p of state.params) {
    if (!p._inputEl) continue;
    const want = chipWidgetKind(p.valueSrc);
    const have = p._inputEl.tagName === 'SELECT' ? 'select' : 'input';
    if (want !== have) { renderChips(); return; }
  }
  for (const p of state.params) {
    if (!p._inputEl) continue;
    if (p._inputEl === document.activeElement) continue;
    if (p._inputEl.value !== p.valueSrc) p._inputEl.value = p.valueSrc;
  }
}

// ── Chip widget dispatch ──────────────────────────────────────────
// Currently auto-detected from the value text. Easy to extend: any new
// enum-like prelude registration should add a detector entry here and
// surface an options list. Future widget kinds (range slider for bounded
// numbers, date picker, color, etc.) can dispatch from the same place.

const DCDMA_CODES = ['AQ','BQ','NQ','NQ2','NQ3','HQ','HQ3','PQ','PQ3'];
const SIEVE_MESHES = [635,500,450,400,325,270,230,200,170,150,120,100,80,70,60,50,45,40,35,30,25,20,18,16,14,12,10,8,7,6,5,4];

function chipWidgetKind(valueSrc) {
  return chipWidgetOptions(valueSrc) ? 'select' : 'input';
}

// Returns {options: [...]} if valueSrc matches a known enum, else null.
// The options array is the full set so users can pick any peer value.
function chipWidgetOptions(valueSrc) {
  const v = (valueSrc || '').trim();
  // DCDMA drill core / hole — e.g. NQ_core, HQ_hole
  const m = v.match(/^([A-Z]+\d*)_(core|hole)$/);
  if (m && DCDMA_CODES.includes(m[1])) {
    const suffix = '_' + m[2];
    return { options: DCDMA_CODES.map(c => c + suffix) };
  }
  // Sieve mesh — e.g. mesh200
  const s = v.match(/^mesh(\d+)$/);
  if (s && SIEVE_MESHES.includes(parseInt(s[1], 10))) {
    return { options: SIEVE_MESHES.map(n => 'mesh' + n) };
  }
  return null;
}

// Build the chip's input control. Returns a {el, getValue} pair so the
// caller can wire its own onChange without caring whether the element is
// an <input> or a <select>.
function makeChipControl(p, onChange) {
  const widget = chipWidgetOptions(p.valueSrc);
  if (widget) {
    const sel = document.createElement('select');
    sel.className = 'chip-val chip-val-select';
    sel.dataset.paramName = p.name;
    for (const opt of widget.options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      sel.appendChild(o);
    }
    sel.value = p.valueSrc;
    sel.addEventListener('change', () => onChange(sel.value));
    sel.addEventListener('focus', () => { state._lastFocused = sel; });
    return sel;
  }
  const inp = document.createElement('input');
  inp.className = 'chip-val';
  inp.value = p.valueSrc;
  inp.spellcheck = false;
  inp.autocapitalize = 'off';
  inp.autocomplete = 'off';
  inp.dataset.paramName = p.name;
  inp.addEventListener('input', () => onChange(inp.value));
  inp.addEventListener('focus', () => { state._lastFocused = inp; });
  return inp;
}

// ── Chips ─────────────────────────────────────────────────────────

export function renderChips() {
  chipsEl.innerHTML = '';
  // Auto-hide empty params panel — the .empty class triggers CSS that
  // hides the whole panel when .app.auto-hide-empty is also set.
  const paramsPanel = document.getElementById('paramsPanel');
  if (paramsPanel) paramsPanel.classList.toggle('empty', state.params.length === 0);
  state.params.forEach(p => {
    const name = p.name;
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.dataset.paramName = name;
    const lbl = document.createElement('div');
    lbl.className = 'chip-lbl';
    lbl.textContent = p.anno ? `${name} : ${p.anno}` : name;
    const inp = makeChipControl(p, (newValue) => {
      const cur = state.params.find(x => x.name === name);
      if (!cur) return;
      const bodyIdx = cur.bodyIdx;
      const line = state.body[bodyIdx];
      const eq = line.src.indexOf('=');
      line.src = (eq >= 0 ? line.src.slice(0, eq + 1) + ' ' : `  ${name} = `) + newValue;
      evaluateAll();
      syncCmFromState();
      renderChipResults();
      renderOutputs();
      applyErrorMarks();
      // storage.js listens for ep:params-changed and triggers autosave.
      // Decoupled from render so the viewer can reuse render.js without
      // pulling in the storage layer.
      window.dispatchEvent(new CustomEvent('ep:params-changed'));
    });
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
  applyErrorMarks();
}

// Per-line gutter unit-override menu. Opens when the user clicks a result
// cell in the gutter. Lists every unit that matches the binding's dim;
// pick one to swap the displayed unit (the underlying canonical value is
// untouched). Stored as state.ui.gutterUnits[bindingName] so it survives
// reload/scenarios and isn't position-dependent.
function openGutterUnitMenu(lineIdx, x, y) {
  const row = state.body[lineIdx];
  if (!row || !row.result || !row.name) return;
  const candidates = getCompatibleUnits(row.result.dim);
  if (!candidates.length) return;
  state.ui.gutterUnits = state.ui.gutterUnits || {};
  const current = state.ui.gutterUnits[row.name] || null;
  const items = candidates.map(c => ({
    label: c.name + (c.name === current ? '  ✓' : ''),
    action: () => setGutterUnit(row.name, c.name),
  }));
  if (current) {
    items.push({ separator: true });
    items.push({ label: 'auto-scale', action: () => setGutterUnit(row.name, null) });
  }
  showMenu(items, x, y);
}

function setGutterUnit(name, unitName) {
  state.ui.gutterUnits = state.ui.gutterUnits || {};
  if (unitName === null) delete state.ui.gutterUnits[name];
  else                   state.ui.gutterUnits[name] = unitName;
  renderChipResults();
  // Force a gutter rebuild — lineMarkerChange returns true on any update,
  // so an empty selection dispatch is enough to trigger re-eval of every
  // visible cell without churning the doc.
  if (cmView) {
    cmView.dispatch({ selection: cmView.state.selection });
  }
  // Persist through the existing autosave path.
  window.dispatchEvent(new CustomEvent('ep:params-changed'));
}

// §4.2 — push the current set of body-row errors into the CM6 decoration
// field. The parser surfaces "<src>:1:<col>: msg" for parse errors; we
// extract col and translate it into source-line coordinates by adding the
// `name = ` prefix length on binding lines. Non-binding lines (or messages
// without a parseable position) fall back to underlining the whole line.
function applyErrorMarks() {
  if (!cmView || !_errorEffect) return;
  const items = [];
  for (let i = 0; i < state.body.length; i++) {
    const row = state.body[i];
    if (!row.error) continue;
    const message = row.error;
    let col = 0;
    const m = message.match(/^[^:]*:1:(\d+):/);   // numbat formats as "src:1:col: …"
    if (m) {
      const snippetCol = parseInt(m[1], 10);      // 1-based within the snippet
      // Bindings are passed to the evaluator with their RHS only; recover
      // the offset of the RHS within the source line so the col lines up.
      const src = row.src || '';
      const eq = src.indexOf('=');
      let prefix = 0;
      if (eq >= 0 && (row.kind === 'binding' || /^\s*[a-zA-Z_]/.test(src))) {
        prefix = eq + 1;
        while (prefix < src.length && src[prefix] === ' ') prefix++;
      }
      col = prefix + snippetCol;
    }
    items.push({ line: i + 1, col, message });
  }
  cmView.dispatch({ effects: _errorEffect.of(items) });
}

export function renderOutputs() {
  outChipsEl.innerHTML = '';
  const panel = document.getElementById('outputsPanel');
  const specs = state.outputs;
  outMetaEl.textContent = `· ${specs.length} result${specs.length === 1 ? '' : 's'}`;
  // Match the params-panel pattern: the .empty class plus app's
  // .auto-hide-empty drives visibility. When the setting is off, the
  // panel stays visible with its 0-results header.
  panel.classList.toggle('empty', specs.length === 0);
  panel.style.display = '';
  if (!specs.length) return;
  for (const spec of specs) {
    const { name, unit } = spec;
    const chip = document.createElement('div');
    chip.className = 'chip readonly';
    const lbl = document.createElement('div');
    lbl.className = 'chip-lbl';
    lbl.textContent = unit ? `${name} : ${unit}` : name;

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
      // Per-output unit (if any) overrides the binding's own display.
      // resolveUnitExpression falls back to parsing the text as a Numbat
      // expression so compound forms like ft^3 / kg/m^2 / km/h work even
      // when they aren't pre-registered aliases.
      let n, u, err = null;
      if (unit) {
        try {
          const spec = resolveUnitExpression(unit);
          if (!dEq(spec.dim, q.dim)) {
            err = `expected [${fmtDim(q.dim)}] but ${unit} is [${fmtDim(spec.dim)}]`;
          } else {
            n = fmtNum(q.value / spec.mul);
            u = spec.displayName;
          }
        } catch (e) { err = e.message; }
      } else {
        [n, u] = fmt(q);
      }
      if (err) {
        val.classList.add('error');
        val.textContent = err;
      } else {
        val.innerHTML = n + (u ? ` <span class="u">${u}</span>` : '');
        copyText = n.replace(/,/g, '') + (u ? ' ' + u.replace(/²/g, '^2').replace(/³/g, '^3') : '');
      }
    }
    row.append(val);

    if (q != null) {
      const btn = document.createElement('button');
      btn.className = 'chip-copy';
      btn.textContent = 'copy';
      btn.title = `copy "${copyText}"  ·  long-press for more`;
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          await copyToClipboard(copyText);
          flashCopied(btn);
        } catch {
          btn.textContent = 'err';
          setTimeout(() => { btn.textContent = 'copy'; }, 1200);
        }
      });
      // Long-press / right-click → copy-as menu with more formats.
      attachLongPress(btn, (x, y) => openCopyAsMenu(name, q, copyText, x, y, btn));
      row.append(btn);
    }

    chip.append(lbl, row);
    outChipsEl.append(chip);
  }
}

// ── Copy-as menu (§5.1) ───────────────────────────────────────────
// Long-press an output chip's copy button to pick a format. Quick tap
// still copies the plain-text "value with unit" default.

async function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for non-secure contexts.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

function flashCopied(btn) {
  btn.textContent = 'copied';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1200);
}

function openCopyAsMenu(name, q, plainText, x, y, anchorBtn) {
  // `plainText` is the already-computed "value with unit" string (commas
  // stripped, ² / ³ down-converted) that quick-tap copies. We derive the
  // other formats from it + q's canonical value and dim.
  const parts = plainText.split(' ');
  const numStr = parts[0];
  const unitAscii = parts.slice(1).join(' ');   // empty if dimensionless

  const formats = unitAscii ? [
    { label: 'value with unit',    text: plainText },
    { label: 'number only',        text: numStr },
    { label: 'as JSON',            text: JSON.stringify({
      name, value: parseFloat(numStr), unit: unitAscii,
      canonical: q.value, dim: q.dim,
    }) },
    { label: 'as LaTeX',           text: `${numStr} \\, \\text{${unitAscii}}` },
  ] : [
    { label: 'number',             text: numStr },
    { label: 'as JSON',            text: JSON.stringify({
      name, value: q.value, dim: q.dim,
    }) },
    { label: 'as LaTeX',           text: numStr },
  ];

  showMenu(formats.map(f => ({
    label: f.label,
    action: async () => {
      try { await copyToClipboard(f.text); flashCopied(anchorBtn); }
      catch { /* swallow — the menu has closed */ }
    },
  })), x, y, { alignRight: true });
}
