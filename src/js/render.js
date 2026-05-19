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
import { takeSnapshot, currentProgramName, getSetting } from './storage.js';
import { epPrompt } from './dialogs.js';
import { renderDocInfo, parseSignature } from './docs.js';

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

// ── Tiny canvas plotter ──────────────────────────────────────────
// Hand-rolled, ~150 LOC, no library. Handles four chart types:
// line / scatter / bar / hist. Auto-scales axes, draws light gridless
// frame + ticks, renders the data in the theme's orange. Read from
// drawPlot(canvas, descriptor, dpr) where descriptor is whatever
// numbat-js's _plotSink emitted: {type, xs?, ys?, values?, xUnit?, yUnit?}.
//
// All drawing is in CSS pixels (we apply ctx.scale(dpr, dpr) once at
// the top), so coordinate math elsewhere uses CSS px directly.
function drawPlot(canvas, descriptor, dpr) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !descriptor) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  const cssW = canvas.width  / dpr;
  const cssH = canvas.height / dpr;
  ctx.clearRect(0, 0, cssW, cssH);

  // Read theme colors from CSS variables on the document. Falls back
  // to muted neutrals when the variable isn't defined (e.g. canvas
  // mounted into a PiP doc whose stylesheet copy missed).
  const cs = getComputedStyle(document.documentElement);
  const cssVar = (n, fallback) => (cs.getPropertyValue(n).trim() || fallback);
  const colData = cssVar('--sw-orange',    '#B54E1A');
  const colAxis = cssVar('--sw-border',    '#B3B1AD');
  const colText = cssVar('--sw-text-soft', '#7A7875');
  const colBg   = cssVar('--sw-bg-raised', '#E4E3E1');

  // Background
  ctx.fillStyle = colBg;
  ctx.fillRect(0, 0, cssW, cssH);

  // Plot area inset for axes + tick labels. Extra space at top for a
  // title (when given), and at left/bottom for axis labels (when given).
  const hasTitle  = !!descriptor.title;
  const hasXLabel = !!descriptor.xLabel;
  const hasYLabel = !!descriptor.yLabel;
  const ML = hasYLabel ? 50 : 36;
  const MR = 12;
  const MT = hasTitle  ? 26 : 10;
  const MB = hasXLabel ? 38 : 24;
  const PW = cssW - ML - MR;
  const PH = cssH - MT - MB;

  // Title — top-center, slightly larger
  if (hasTitle) {
    ctx.fillStyle = cssVar('--sw-text', '#232322');
    ctx.font = '600 12px var(--sw-mono, monospace)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(descriptor.title, cssW / 2, 6);
  }

  // Pull data into (xs, ys) form depending on chart type. Bar/hist
  // synthesize xs from value index / bin centers.
  let xs = [], ys = [];
  const type = descriptor.type || 'line';

  if (type === 'line' || type === 'scatter') {
    xs = descriptor.xs || [];
    ys = descriptor.ys || [];
    if (xs.length !== ys.length) {
      const n = Math.min(xs.length, ys.length);
      xs = xs.slice(0, n);
      ys = ys.slice(0, n);
    }
  } else if (type === 'bar') {
    const values = descriptor.values || [];
    xs = values.map((_, i) => i);
    ys = values.slice();
  } else if (type === 'hist') {
    const values = descriptor.values || [];
    if (values.length) {
      const n = Math.max(2, Math.min(50, Math.ceil(Math.sqrt(values.length))));
      let lo = Infinity, hi = -Infinity;
      for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === hi) { lo -= 0.5; hi += 0.5; }
      const w = (hi - lo) / n;
      const bins = new Array(n).fill(0);
      for (const v of values) {
        let i = Math.floor((v - lo) / w);
        if (i >= n) i = n - 1;
        if (i < 0)  i = 0;
        bins[i]++;
      }
      xs = bins.map((_, i) => lo + (i + 0.5) * w);
      ys = bins;
    }
  }

  if (!xs.length || !ys.length) {
    ctx.fillStyle = colText;
    ctx.font = '11px var(--sw-mono, monospace)';
    ctx.textBaseline = 'middle';
    ctx.fillText('(no data)', ML + 4, MT + PH / 2);
    return;
  }

  // Bounds with 5% padding so points aren't on the frame.
  let xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (xMin === xMax) { xMin -= 0.5; xMax += 0.5; }
  if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }
  const xPad = (xMax - xMin) * 0.05;
  const yPad = (yMax - yMin) * 0.05;
  // bar/hist: start y at 0 (bars need a baseline at 0 to read).
  const yLo = (type === 'bar' || type === 'hist') ? Math.min(0, yMin - yPad) : yMin - yPad;
  const xLo = xMin - xPad;
  const xHi = xMax + xPad;
  const yHi = yMax + yPad;

  const xPix = x => ML + ((x - xLo) / (xHi - xLo)) * PW;
  const yPix = y => MT + PH - ((y - yLo) / (yHi - yLo)) * PH;

  // Frame
  ctx.strokeStyle = colAxis;
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, PW, PH);

  // Axis tick labels — 3 on each side, formatted to a few sig digits.
  ctx.fillStyle = colText;
  ctx.font = '10px var(--sw-mono, monospace)';
  ctx.textBaseline = 'middle';
  const fmtTick = v => {
    if (Math.abs(v) >= 1e4 || (v !== 0 && Math.abs(v) < 1e-2)) return v.toExponential(1);
    return parseFloat(v.toPrecision(3)).toString();
  };
  // y-axis: 3 ticks (low, mid, hi)
  for (let i = 0; i <= 2; i++) {
    const v = yLo + (yHi - yLo) * (i / 2);
    const py = yPix(v);
    ctx.textAlign = 'right';
    ctx.fillText(fmtTick(v), ML - 4, py);
  }
  // x-axis: 3 ticks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 2; i++) {
    const v = xLo + (xHi - xLo) * (i / 2);
    const px = xPix(v);
    ctx.fillText(fmtTick(v), px, MT + PH + 4);
  }

  // Axis labels — drawn after ticks so they sit further out. xLabel
  // centered below the x-axis ticks; yLabel rotated -90° and centered
  // vertically on the left margin.
  if (hasXLabel) {
    ctx.fillStyle = cssVar('--sw-text', '#232322');
    ctx.font = '500 11px var(--sw-mono, monospace)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(descriptor.xLabel, ML + PW / 2, cssH - 4);
  }
  if (hasYLabel) {
    ctx.save();
    ctx.fillStyle = cssVar('--sw-text', '#232322');
    ctx.font = '500 11px var(--sw-mono, monospace)';
    ctx.translate(12, MT + PH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(descriptor.yLabel, 0, 0);
    ctx.restore();
  }

  // Data
  ctx.strokeStyle = colData;
  ctx.fillStyle = colData;
  ctx.lineWidth = 1.5;
  if (type === 'line') {
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) {
      const px = xPix(xs[i]), py = yPix(ys[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  } else if (type === 'scatter') {
    for (let i = 0; i < xs.length; i++) {
      ctx.beginPath();
      ctx.arc(xPix(xs[i]), yPix(ys[i]), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (type === 'bar' || type === 'hist') {
    const baselinePx = yPix(Math.max(0, yLo));
    // Bar width = bin width (or 1 unit for bar with integer x) scaled to px.
    const dx = xs.length > 1 ? (xs[1] - xs[0]) : 1;
    const wPx = Math.max(1, (dx / (xHi - xLo)) * PW * 0.8);
    for (let i = 0; i < xs.length; i++) {
      const cx = xPix(xs[i]);
      const top = yPix(ys[i]);
      const h = baselinePx - top;
      ctx.fillRect(cx - wPx / 2, top, wPx, h);
    }
  }
}

function resultMarkerHtml(lineIdx) {
  const r = state.body[lineIdx];
  if (!r) return null;
  // Cursor-line quiet: when the user is typing on this very line, the
  // applyErrorMarks pass already suppressed the squiggle + block widget.
  // Suppress the gutter ✕ too, so the whole line is calm mid-edit.
  // Suspect rows (amber) keep their gutter marker — they're a softer
  // signal and not actually an error on this line.
  const cursorLine = (state.ui && state.ui._cursorLine) || 0;
  if (r.error && (lineIdx + 1) === cursorLine) return null;
  if (r.error) {
    // Red ✕ as a shape-distinct error mark (accessible for color-blind
    // users). The full message lives in the inline error block below
    // the line; the gutter just flags the row.
    return { html: '<span class="ep-gutter-err-x" aria-label="error">✕</span>',
             text: r.error, cls: 'error' };
  }
  if (!r.result) {
    // No value yet — but a suspect annotation may still apply.
    if (r.suspect) {
      return { html: '<span class="ep-gutter-suspect-sq" aria-label="suspect" title="' + escapeHtml(r.suspect) + '"></span>',
               text: r.suspect, cls: 'suspect' };
    }
    return null;
  }
  // Bare `print(...)` line: the expression returns Quantity(0, {})
  // (Numbat's void sentinel) but the user wrote it for side-effect, not
  // value. Suppress the `0` in the gutter — the inline info block below
  // the line already shows the captured output. Only applies when the
  // row is a bare expression; let-bindings and @output rows still show
  // their (incidental) zero so users see what they explicitly named.
  if (r.kind === 'expr' && r.print
      && typeof r.result === 'object'
      && r.result.value === 0
      && r.result.dim && Object.keys(r.result.dim).length === 0) {
    return null;
  }
  // Non-Quantity values (Bool / String / fn-ref / struct) reach this
  // path when a binding's RHS evaluates to something other than a
  // dimensioned number. fmt() expects a Quantity; show a typed
  // placeholder instead.
  if (typeof r.result !== 'object' || r.result.dim == null) {
    const t = typeof r.result;
    const label = t === 'boolean' ? (r.result ? 'true' : 'false')
                : t === 'string'  ? '"' + String(r.result).slice(0, 32) + '"'
                : t === 'function'? 'fn'
                : t;
    return { html: `<span class="u">${escapeHtml(label)}</span>`, text: label, cls: '' };
  }

  const outputSpec = r.kind === 'binding'
    ? state.outputs.find(s => s.name === r.name)
    : null;
  const isOutput = !!outputSpec;
  // Dot semantics, refined:
  //   - 'output'  → teal dot (binding is in @outputs)
  //   - 'binding' → orange dot (binding is @input — user-editable chip)
  //   - ''        → no dot (plain intermediate; value reads on its own)
  // This way orange is reserved for "you can change this", which is the
  // signal that actually matters at a glance.
  let cls = '';
  if (r.kind === 'binding') {
    if (isOutput)        cls = 'output';
    else if (r.inParams) cls = 'binding';
  }
  // Suspect annotation: blame-trace flagged this row as implicated in
  // some downstream output's dim mismatch. Adds an amber square after
  // the value (via .suspect::after) — additive with any existing
  // input/output dot.
  if (r.suspect) cls = (cls + ' suspect').trim();

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
    Decoration, WidgetType, StateField, StateEffect,
    autocompletion, CompletionContext, acceptCompletion,
    search, searchKeymap, highlightSelectionMatches,
    showTooltip,
  } = CM6;

  // Inline-error block widget — renders BELOW the offending line so the
  // full message has room to breathe. The gutter is too narrow for
  // dim-mismatch + did-you-mean style messages. `kind` is 'error' (red)
  // for runtime/typecheck failures or 'warn' (amber) for blame-trace
  // suspect annotations.
  class EpErrorWidget extends WidgetType {
    constructor(message, col, kind, suggestDim, rowIdx, plot) {
      super();
      this.message = message;
      this.col = col;
      this.kind = kind || 'error';
      // 'suggest' kind carries the named dim to apply ("Length", "Mass", …)
      // and the row index to edit. Other kinds ignore these fields.
      this.suggestDim = suggestDim || null;
      this.rowIdx = (rowIdx == null) ? -1 : rowIdx;
      // 'plot' kind carries the descriptor object produced by numbat-js's
      // _plotSink. Other kinds ignore.
      this.plot = plot || null;
    }
    eq(other) {
      if (this.kind === 'plot') {
        // Plot descriptors are large; cheap object-identity check is
        // wrong (each evaluation produces a fresh descriptor). Compare
        // a fingerprint instead — type + length-of-data + label opts
        // is enough for re-render decisions.
        const a = this.plot, b = other.plot;
        if (!a || !b) return a === b;
        return a.type === b.type
          && a.title  === b.title
          && a.xLabel === b.xLabel
          && a.yLabel === b.yLabel
          && (a.xs?.length || 0) === (b.xs?.length || 0)
          && (a.ys?.length || 0) === (b.ys?.length || 0)
          && (a.values?.length || 0) === (b.values?.length || 0)
          && JSON.stringify(a.xs || a.values || []) === JSON.stringify(b.xs || b.values || [])
          && JSON.stringify(a.ys || []) === JSON.stringify(b.ys || []);
      }
      return other.message === this.message
        && other.col === this.col
        && other.kind === this.kind
        && other.suggestDim === this.suggestDim
        && other.rowIdx === this.rowIdx;
    }
    toDOM() {
      if (this.kind === 'plot') {
        // Canvas-rendered chart. Block widget so it claims its own row
        // below the plot()-calling line. ~400×200 default — big enough
        // to read, small enough not to push the page around. Lives in
        // a wrapper that picks up our theme variables so the canvas
        // colors match the rest of ep on light/dark.
        const wrap = document.createElement('div');
        wrap.className = 'cm-ep-plot-block';
        const canvas = document.createElement('canvas');
        canvas.className = 'cm-ep-plot-canvas';
        // Use devicePixelRatio so the line strokes don't go fuzzy on
        // hi-DPI displays. CSS width/height is set in the style sheet;
        // the canvas backing store is sized in actual pixels.
        const cssW = 400, cssH = 200;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        canvas.width  = cssW * dpr;
        canvas.height = cssH * dpr;
        // Note: NOT setting inline style.width/style.height. The
        // backing store dimensions (canvas.width/height attrs) act as
        // intrinsic dimensions; CSS rules in style.css (.cm-ep-plot-
        // canvas { max-width: 100%; height: auto }) shrink the
        // displayed canvas on narrow viewports while preserving the
        // 2:1 aspect ratio. Setting inline width/height would override
        // the responsive CSS.
        wrap.appendChild(canvas);
        // Defer the draw to next frame: the canvas needs to be in the
        // DOM before getComputedStyle resolves --sw-* CSS variables.
        const desc = this.plot;
        requestAnimationFrame(() => drawPlot(canvas, desc, dpr));
        return wrap;
      }
      if (this.kind === 'suggest') {
        // Inline at end of line. Wrap in a span (not a div) so the
        // browser inline-positions it next to the line text rather than
        // wrapping it to a new row.
        const span = document.createElement('span');
        span.className = 'cm-ep-suggest-inline';
        const btn = document.createElement('button');
        btn.className = 'cm-ep-suggest-btn';
        btn.textContent = `+ ${this.suggestDim}?`;
        btn.title = `add type annotation — this binding's result has dim of ${this.suggestDim}`;
        const dim = this.suggestDim;
        const rowIdx = this.rowIdx;
        btn.addEventListener('click', e => {
          e.stopPropagation();
          applySuggestion(rowIdx, dim);
        });
        span.appendChild(btn);
        return span;
      }
      const el = document.createElement('div');
      el.className = 'cm-ep-error-block'
        + (this.kind === 'warn' ? ' cm-ep-warn-block' : '')
        + (this.kind === 'info' ? ' cm-ep-info-block' : '');
      const pad = document.createElement('span');
      pad.className = 'cm-ep-error-block-pad';
      pad.style.setProperty('--ep-err-col', String(Math.max(0, this.col - 1)));
      const msg = document.createElement('span');
      msg.className = 'cm-ep-error-block-msg';
      msg.textContent = this.message;
      el.append(pad, msg);
      return el;
    }
    ignoreEvent() { return false; }
  }

  // Insert ` : <DimName>` between the binding's name and its `=`. Used
  // by the suggest widget's "+ Length?" button. Bails defensively if
  // the row no longer matches the expected `name = expr` shape (user
  // edited it in the meantime), if an annotation already exists, or if
  // the editor isn't mounted.
  function applySuggestion(rowIdx, dimName) {
    if (!cmView || rowIdx < 0) return;
    if (rowIdx >= cmView.state.doc.lines) return;
    const line = cmView.state.doc.line(rowIdx + 1);
    const m = line.text.match(/^(\s*(?:let\s+)?[a-zA-Z_][a-zA-Z0-9_]*)(\s*=)/);
    if (!m) return;
    // Already has `: Anno` somewhere before `=`? Don't double-up.
    if (/:/.test(line.text.slice(0, m[1].length + m[2].length))) return;
    const insertAt = line.from + m[1].length;
    cmView.dispatch({
      changes: { from: insertAt, to: insertAt, insert: ` : ${dimName}` },
    });
  }
  void foldService;  // no @params fold in decorator form; service still imported for future use

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

  // (No fold service yet — the old @params { } block fold doesn't apply to
  // decorator form. A future fold could group consecutive @input chips, but
  // there's no clear win until users have programs big enough to need it.)

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
    // Decorator context: line starts with `@`, suggest @input/@output/@options
    // (and let the user complete partial names).
    // Helper: attach an `info` callback to an option iff there's a doc
    // entry for it. CM6's autocomplete calls info() when the option is
    // focused and renders the returned string in a side panel. Returning
    // undefined here (no doc entry) makes CM6 just not show the panel
    // for that option — silent fallback, no UI noise.
    const withInfo = (option, lookupName) => {
      const info = renderDocInfo(lookupName !== undefined ? lookupName : option.label);
      if (info) option.info = info;
      return option;
    };

    const decoratorWord = context.matchBefore(/@[a-zA-Z_]*/);
    if (decoratorWord && (decoratorWord.from !== decoratorWord.to || context.explicit)) {
      const { decorators } = getCompletionData();
      return {
        from: decoratorWord.from,
        options: decorators.map(d => withInfo({ label: d, type: 'keyword', boost: 50 })),
      };
    }

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
        options: dimensions.map(d => withInfo({ label: d, type: 'type', boost: 20 })),
      };
    }

    const scopeNames = state.params.map(p => p.name)
      .concat(Object.keys(state._scope || {}));
    const options = [];
    for (const n of new Set(scopeNames))     options.push(withInfo({ label: n, type: 'variable', boost: 30 }));
    for (const k of keywords)                options.push(withInfo({ label: k, type: 'keyword',  boost: 10 }));
    // Functions: the option's `apply` adds the open paren, but the doc
    // lookup should still use the bare name — pass it explicitly.
    for (const f of functions)               options.push(withInfo({ label: f, type: 'function', boost:  5, apply: f + '(' }, f));
    for (const u of units)                   options.push(withInfo({ label: u, type: 'unit',     boost:  0 }));
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
        const decos = [];
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
          const kind = it.kind || 'error';
          // Inline mark for the underline (also keeps the title attribute
          // as a fallback for screen readers / quick hover). Warn rows
          // get a softer amber underline; info (print output) and
          // suggest (annotation-fixup) rows skip the underline entirely
          // — they're not flagging a problem with the row, they're
          // surfacing captured output / offering a polish action.
          if ((kind === 'error' || kind === 'warn') && !it.suppressMark) {
            decos.push(Decoration.mark({
              class: kind === 'warn' ? 'cm-ep-warn' : 'cm-ep-error',
              attributes: { title: it.message || '' },
            }).range(from, to));
          }
          // Block widget on the line AFTER, with the full message.
          // Strip the upstream `<src>:line:col:` prefix when present —
          // the caret already positions it, the user doesn't need to
          // re-read the coordinates.
          const cleanMsg = (it.message || '').replace(/^[^:]*:\d+:\d+:\s*/, '');
          // Suggestions render INLINE at end of line — small, low-noise,
          // doesn't push the next row down. Errors / warnings / info
          // stay as block widgets BELOW the line so their full message
          // has room.
          if (kind === 'suggest') {
            decos.push(Decoration.widget({
              widget: new EpErrorWidget('', 0, kind, it.suggestDim, it.rowIdx),
              side: 1,
            }).range(line.to));
          } else if (kind === 'plot') {
            decos.push(Decoration.widget({
              widget: new EpErrorWidget('', 0, kind, null, -1, it.plot),
              block: true,
              side: 1,
            }).range(line.to));
          } else if (!it.suppressBlock) {
            // error / warn / info paths. suppressBlock is set by
            // applyErrorMarks for error+warn rows where the cursor
            // currently lives — see the comment there for the
            // rationale. info (print output) and plot never set it.
            decos.push(Decoration.widget({
              widget: new EpErrorWidget(cleanMsg, fromCol + 1, kind, it.suggestDim, it.rowIdx),
              block: true,
              side: 1,
            }).range(line.to));
          }
        }
        value = Decoration.set(decos, true);
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

  // §4.3 — signature help. When the cursor sits inside a function-call
  // arg list (e.g. `plot(xs, |ys)`), show the function's signature with
  // the current arg highlighted. Scans the current line backward from
  // the cursor, counting parens + commas at depth 0 to figure out which
  // arg the cursor is on. String literals are skipped so unbalanced
  // parens inside "foo(" don't fool us. Looks up DOCS for the signature
  // text. No DOCS entry → no tooltip (silent).
  function findEnclosingCall(state, pos) {
    const line  = state.doc.lineAt(pos);
    const text  = line.text;
    const col   = pos - line.from;
    let depth = 0;
    let commaCount = 0;
    let inStr = false, strCh = '';
    for (let i = col - 1; i >= 0; i--) {
      const c = text[i];
      if (inStr) {
        // Walking backward through a string. End it when we hit the
        // opening quote (not escaped). Approximate — we don't try to
        // count odd vs. even leading backslashes; ep strings are rare.
        if (c === strCh && text[i - 1] !== '\\') inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
      if (c === ')') { depth++; continue; }
      if (c === '(') {
        if (depth === 0) {
          // Unmatched open paren — this is our call. Identify the name
          // immediately before it (skipping whitespace).
          let j = i - 1;
          while (j >= 0 && /\s/.test(text[j])) j--;
          const end = j + 1;
          while (j >= 0 && /[A-Za-z0-9_]/.test(text[j])) j--;
          // Allow `::` inside names (module-qualified, e.g. core::lists::map),
          // but only after we've consumed at least one identifier char.
          while (j >= 1 && text[j] === ':' && text[j - 1] === ':') {
            j -= 2;
            while (j >= 0 && /[A-Za-z0-9_]/.test(text[j])) j--;
          }
          const name = text.slice(j + 1, end);
          if (!name) return null;
          return { name, parenPos: line.from + i, argIndex: commaCount };
        }
        depth--;
        continue;
      }
      if (c === ',' && depth === 0) commaCount++;
    }
    return null;
  }

  function buildSigTooltipDom(name, argIndex) {
    const parsed = parseSignature(name);
    if (!parsed) return null;
    const wrap = document.createElement('div');
    // Both classes: cm-tooltip so our `.cm-tooltip.cm-ep-sighelp`
    // override hits regardless of whether CM6 also tags the outer
    // element. Belt-and-braces — keeps the dark Switchboard surface
    // visible against the default light CM6 tooltip styling.
    wrap.className = 'cm-tooltip cm-ep-sighelp';
    const sigLine = document.createElement('div');
    sigLine.className = 'cm-ep-sighelp-sig';
    sigLine.appendChild(document.createTextNode(parsed.prefix));
    parsed.args.forEach((a, i) => {
      if (i > 0) sigLine.appendChild(document.createTextNode(', '));
      const span = document.createElement('span');
      span.textContent = a;
      // Highlight the arg the cursor is currently on. If there are more
      // commas than declared args (extra/trailing arg in a typo), nothing
      // gets highlighted — better than highlighting the wrong slot.
      if (i === argIndex) span.className = 'cm-ep-sighelp-active';
      sigLine.appendChild(span);
    });
    sigLine.appendChild(document.createTextNode(parsed.suffix));
    wrap.appendChild(sigLine);
    if (parsed.description) {
      const desc = document.createElement('div');
      desc.className = 'cm-ep-sighelp-desc';
      desc.textContent = parsed.description;
      wrap.appendChild(desc);
    }
    return wrap;
  }

  const sigHelpField = StateField.define({
    create(state) { return computeSigTooltip(state); },
    update(value, tr) {
      if (!tr.docChanged && !tr.selection) return value;
      return computeSigTooltip(tr.state);
    },
    provide: f => showTooltip.from(f),
  });

  function computeSigTooltip(state) {
    const pos = state.selection.main.head;
    const call = findEnclosingCall(state, pos);
    if (!call) { updateSigHelpStrip(null, 0); return null; }
    const dom = buildSigTooltipDom(call.name, call.argIndex);
    if (!dom) { updateSigHelpStrip(null, 0); return null; }
    updateSigHelpStrip(call.name, call.argIndex);
    return {
      // Anchor at the open paren so the tooltip stays put while the user
      // types args. `above: true` lifts it above the line so the in-
      // progress text below stays visible. strictSide: false lets CM6
      // flip the tooltip below if there's no room above.
      pos: call.parenPos,
      above: true,
      strictSide: false,
      create() { return { dom }; },
    };
  }

  // Mirror the floating tooltip's content into the docked strip above
  // the accessory bar. CSS owns the desktop/mobile visibility split —
  // see .sighelp-strip rules in style.css. Passing name=null clears /
  // hides the strip.
  function updateSigHelpStrip(name, argIndex) {
    const strip = document.getElementById('sighelpStrip');
    if (!strip) return;
    if (!name) {
      strip.hidden = true;
      strip.replaceChildren();
      return;
    }
    const inner = buildSigTooltipDom(name, argIndex);
    if (!inner) {
      strip.hidden = true;
      strip.replaceChildren();
      return;
    }
    // buildSigTooltipDom returns a `.cm-tooltip.cm-ep-sighelp` div —
    // drop the cm-tooltip class on this copy since we're outside the
    // editor's tooltip layer and don't want CM6's default tooltip
    // styling fighting our docked-strip CSS.
    inner.className = 'cm-ep-sighelp cm-ep-sighelp--strip';
    strip.replaceChildren(inner);
    strip.hidden = false;
  }

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
        EditorView.lineWrapping,
        history(),
        drawSelection(),
        // Search panel + selection-match highlighting. searchKeymap binds
        // Cmd/Ctrl+F to open the panel, Cmd/Ctrl+G to find-next, Esc to
        // close — standard CM6 conventions that users expect.
        search({ top: true }),
        highlightSelectionMatches(),
        _errorsField,
        sigHelpField,
        resultGutter,
        keymap.of([
          // Tab accepts the open completion. acceptCompletion returns false
          // when no popup is showing — Tab then falls through to default
          // browser tab order (so users can still leave the editor).
          { key: 'Tab', run: acceptCompletion },
          ...(searchKeymap || []),    // Cmd/Ctrl-F / -G, Esc to close
          ...(historyKeymap || []),   // Mod-z / Mod-Shift-z / Mod-y
          ...(foldKeymap || []),      // Cmd/Ctrl-Alt-[ / -] fold / unfold
          ...(defaultKeymap || []),   // arrow keys, Home/End, word jumps, etc.
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
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
            return;
          }
          // Cursor moved without a doc change. Re-fire applyErrorMarks so
          // the cursor-line block-widget suppression updates: errors on
          // the line the user just left should reappear, and errors on
          // the line they just entered should go quiet.
          if (update.selectionSet) {
            const before = update.startState.doc.lineAt(update.startState.selection.main.head).number;
            const after  = update.state.doc.lineAt(update.state.selection.main.head).number;
            if (before !== after) applyErrorMarks();
          }
        }),
        EditorView.theme({
          '&': { height: '100%' },
        }),
        // ep-script isn't English prose; browser spell-check leaves
        // red wavy underlines under unit-bearing values (`242 m`,
        // `50 m`) and identifier names. Disable on the content
        // attribute so the editor reads as "code", not "text".
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
      ],
    }),
    parent: bodyEl,
  });

  bodyEl.addEventListener('focusin', () => { state._lastFocused = cmView; });

  // When settings change (e.g., toggling "annotation suggestions"
  // off), re-run the inline-block dispatch so widgets that depend on
  // the setting clear immediately instead of waiting for the next
  // body or chip edit.
  window.addEventListener('ep:params-changed', () => applyErrorMarks());

  // Right-click in the body opens ep's body-row context menu (snapshot,
  // copy result as, format document). Skipped when the user has an
  // active text selection — the browser-native menu (with copy/paste)
  // is more useful when there's a selection to act on.
  bodyEl.addEventListener('contextmenu', e => {
    if (!cmView) return;
    const sel = cmView.state.selection.main;
    if (!sel.empty) return;  // let browser native menu win
    const pos = cmView.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) return;
    const lineNo = cmView.state.doc.lineAt(pos).number;
    e.preventDefault();
    openBodyRowMenu(lineNo - 1, e.clientX, e.clientY);
  });
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
  // Detect widget-kind drift first — if any chip is mounted with the wrong
  // kind (e.g. source-side edit switched from "200 m" to "NQ_core", or
  // added/removed an @range decorator), the existing element can't
  // carry the new shape and we full-rebuild via renderChips. dataset.kind
  // is set by makeChipControl when the chip is created.
  for (const p of state.params) {
    if (!p._inputEl) continue;
    const want = chipWidgetKind(p);
    const have = p._inputEl.dataset.kind ||
                 (p._inputEl.tagName === 'SELECT' ? 'select' : 'input');
    if (want !== have) { renderChips(); return; }
  }
  // Per-chip value sync. Slider chips have a wrapper + nested range +
  // text input; sync both when the source changes externally (chip-side
  // edits already update both via makeChipControl's listeners).
  for (const p of state.params) {
    if (!p._inputEl) continue;
    if (p._inputEl === document.activeElement) continue;
    if (p._inputEl.dataset.kind === 'slider') {
      const text = p._inputEl.querySelector('.chip-slider-val');
      const range = p._inputEl.querySelector('.chip-slider');
      if (text && text !== document.activeElement && text.value !== p.valueSrc) {
        text.value = p.valueSrc;
      }
      if (range) {
        const info = chipSliderInfo(p);
        if (info && range.value !== String(info.num)) range.value = String(info.num);
      }
      continue;
    }
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

function chipWidgetKind(p) {
  // Priority: options (enum-style) wins over range (slider) wins over
  // freeform text input. Options + range is incoherent (you can't both
  // pick from a list and drag a slider), so we honor the more specific
  // signal — options — when both are present.
  if (chipWidgetOptions(p))   return 'select';
  if (chipSliderInfo(p))      return 'slider';
  return 'input';
}

// Returns {min, max, step, num, unit} if the chip should render as a
// numeric slider, else null. Requires the @range decorator on the binding
// AND a parseable numeric value (current source like "200 m" — the leading
// number is the slider position, the rest is the preserved unit).
function chipSliderInfo(p) {
  if (!p || !p.range) return null;
  const v = (p.valueSrc || '').trim();
  const m = v.match(/^(-?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\s*(.*)$/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/_/g, ''));
  if (!Number.isFinite(num)) return null;
  const unit = m[2].trim();
  return { min: p.range.min, max: p.range.max, step: p.range.step, num, unit };
}

// Returns {options: [...]} if the param should render as a select, else null.
// Priority:
//   1. Explicit `# options: a, b, c` annotation on the source line (p.options).
//   2. Auto-detected enum (DCDMA drill core, Tyler/ASTM sieve mesh).
// The options array is the full set so users can pick any peer value.
function chipWidgetOptions(p) {
  if (p && Array.isArray(p.options) && p.options.length) {
    return { options: p.options };
  }
  const v = (p && p.valueSrc ? p.valueSrc : '').trim();
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
  const widget = chipWidgetOptions(p);
  if (widget) {
    const sel = document.createElement('select');
    sel.className = 'chip-val chip-val-select';
    sel.dataset.paramName = p.name;
    sel.dataset.kind = 'select';
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
  const slider = chipSliderInfo(p);
  if (slider) {
    // Slider chip: a <div> wrapper holding a range input + a small
    // editable text label. Drag the slider OR type into the label —
    // both fire onChange with a reconstructed "<number> <unit>" string.
    // Returning the wrapper keeps the slot-replacement pattern intact
    // (caller appends it like any other control).
    const wrap = document.createElement('div');
    wrap.className = 'chip-val chip-val-slider';
    wrap.dataset.paramName = p.name;
    wrap.dataset.kind = 'slider';

    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'chip-slider';
    range.min = String(slider.min);
    range.max = String(slider.max);
    if (slider.step != null) range.step = String(slider.step);
    range.value = String(slider.num);
    range.dataset.paramName = p.name;

    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'chip-slider-val';
    text.value = p.valueSrc;
    text.spellcheck = false;
    text.autocapitalize = 'off';
    text.autocomplete = 'off';
    text.dataset.paramName = p.name;

    const fmtVal = (num) => {
      // Cap displayed precision to step granularity; otherwise float
      // arithmetic gives "200.00000000000003 m" on slider drag.
      let s;
      if (slider.step != null && slider.step > 0) {
        const decimals = Math.max(0, -Math.floor(Math.log10(slider.step) - 1e-9));
        s = num.toFixed(decimals);
      } else {
        s = String(parseFloat(num.toPrecision(8)));
      }
      return slider.unit ? `${s} ${slider.unit}` : s;
    };

    range.addEventListener('input', () => {
      const num = parseFloat(range.value);
      const v = fmtVal(num);
      text.value = v;
      onChange(v);
    });
    text.addEventListener('input', () => {
      const m = text.value.trim().match(/^(-?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/);
      if (m) {
        const n = parseFloat(m[1].replace(/_/g, ''));
        if (Number.isFinite(n)) range.value = String(n);
      }
      onChange(text.value);
    });
    range.addEventListener('focus', () => { state._lastFocused = range; });
    text.addEventListener('focus',  () => { state._lastFocused = text; });

    wrap.append(range, text);
    return wrap;
  }
  const inp = document.createElement('input');
  inp.className = 'chip-val';
  inp.value = p.valueSrc;
  inp.spellcheck = false;
  inp.autocapitalize = 'off';
  inp.autocomplete = 'off';
  inp.dataset.paramName = p.name;
  inp.dataset.kind = 'input';
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
      // Preserve any trailing comment (e.g., `# options: …`) — otherwise
      // editing the chip would erase the user's declared options list.
      // String-aware match so `# inside literal "..."` isn't treated as
      // a comment marker.
      let trailingComment = '';
      if (eq >= 0) {
        const rhs = line.src.slice(eq + 1);
        let inStr = false;
        for (let k = 0; k < rhs.length; k++) {
          const c = rhs[k];
          if (inStr) {
            if (c === '\\' && k + 1 < rhs.length) { k++; continue; }
            if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') { inStr = true; continue; }
          if (c === '#' || (c === '-' && rhs[k + 1] === '-')) {
            trailingComment = '  ' + rhs.slice(k).replace(/^\s+/, '');
            break;
          }
        }
      }
      line.src = (eq >= 0 ? line.src.slice(0, eq + 1) + ' ' : `  ${name} = `) + newValue + trailingComment;
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

// Build the hover-tooltip text for a Quantity-shaped result. Shows the
// canonical value (raw number in canonical units — g, m, s, etc.,
// pre-sig-digit-trimming) plus the dim signature. Useful when the chip
// display is auto-scaled to "12.5 t" and you want to know it's actually
// 12,500,000 g, or when you want to confirm "200 m" really did parse
// as Length and not something weird.
function chipTooltip(q) {
  if (!q || typeof q !== 'object' || q.dim == null) return '';
  const canonical = String(q.value);
  const dimStr = fmtDim(q.dim);
  return dimStr ? `${canonical}  [${dimStr}]` : canonical;
}

function renderChipResults() {
  for (const p of state.params) {
    if (!p._resEl) continue;
    if (p.error) {
      p._resEl.className = 'chip-res error';
      p._resEl.textContent = p.error;
      p._resEl.title = p.error;
    } else if (p.result) {
      const [n, u] = fmt(p.result);
      p._resEl.className = 'chip-res';
      p._resEl.innerHTML = n + (u ? ` <span class="u">${u}</span>` : '');
      p._resEl.title = chipTooltip(p.result);
    } else {
      p._resEl.className = 'chip-res';
      p._resEl.textContent = '';
      p._resEl.removeAttribute('title');
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

  // Tuck the long-tail families into submenus so the top-level list stays
  // browseable. Length picker is the offender: 32 sieve mesh sizes + DCDMA
  // core sizes (NQ_core / HQ_hole / etc.) flatten into a scroll-forever
  // list otherwise. Other dimensions don't have giant families and pass
  // through unchanged.
  const isMesh = c => /^mesh\d+/.test(c.name);
  const isCore = c => /_(core|hole)$/.test(c.name);
  const mesh = candidates.filter(isMesh);
  const cores = candidates.filter(isCore);
  const standard = candidates.filter(c => !isMesh(c) && !isCore(c));

  const toItem = c => ({
    label: c.name + (c.name === current ? '  ✓' : ''),
    action: () => setGutterUnit(row.name, c.name),
  });

  const items = standard.map(toItem);
  if (mesh.length) {
    if (items.length) items.push({ separator: true });
    items.push({
      label: `mesh sizes (${mesh.length})`,
      submenu: mesh.map(toItem),
    });
  }
  if (cores.length) {
    if (items.length && !mesh.length) items.push({ separator: true });
    items.push({
      label: `DCDMA cores (${cores.length})`,
      submenu: cores.map(toItem),
    });
  }
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
  // Suppress every error indicator on the line the cursor is on —
  // block widget, squiggle underline, and gutter ✕. The user is typing
  // right there; flagging an "unknown identifier" or trailing-comma
  // error mid-edit is just noise (and the block widget tends to slip
  // behind the autocomplete popup as it grows). When the cursor moves
  // off the line, everything reappears via the selection-change
  // listener that re-fires applyErrorMarks.
  const cursorLine = cmView.state.doc.lineAt(cmView.state.selection.main.head).number;
  // Stash for the result gutter — resultMarkerHtml reads this to
  // suppress the ✕ on the cursor's line. Also bumped in the selection
  // listener so gutter redraws pick up cursor moves.
  state.ui._cursorLine = cursorLine;
  const items = [];
  for (let i = 0; i < state.body.length; i++) {
    const row = state.body[i];
    const onCursorLine = (i + 1) === cursorLine;
    if (row.error) {
      const message = row.error;
      let col = 0;
      const m = message.match(/^[^:]*:1:(\d+):/);
      if (m) col = parseInt(m[1], 10);
      items.push({ line: i + 1, col, message, kind: 'error', suppressBlock: onCursorLine, suppressMark: onCursorLine });
    }
    // Suspect annotation from the @output blame walker: the binding on
    // this row was implicated by a downstream output's dim mismatch.
    // Rendered in amber as a warning, not red as an error, since the
    // binding itself isn't broken — it just doesn't fit what some
    // OTHER row expected.
    if (row.suspect && !row.error) {
      items.push({ line: i + 1, col: 0, message: row.suspect, kind: 'warn', suppressBlock: onCursorLine, suppressMark: onCursorLine });
    }
    // print(...) output captured during evaluation. Rendered in a
    // neutral info block below the line — same mechanism as
    // error/suspect, distinct color.
    if (row.print) {
      items.push({ line: i + 1, col: 0, message: row.print, kind: 'info' });
    }
    // Plot output — canvas-rendered chart below the line. plot/scatter/
    // bar_chart/hist procs in numbat-js write to _plotSink which lands
    // here as row.plot.
    if (row.plot) {
      items.push({ line: i + 1, col: 0, message: '', kind: 'plot', plot: row.plot });
    }
    // Annotation auto-suggest — only when there's no other in-line
    // block in play for this row (don't pile a suggest on top of an
    // error / suspect warning; the suggestion is for clean rows). The
    // user can also opt out entirely via Settings → display →
    // "annotation suggestions" off.
    if (row.suggest && !row.error && !row.suspect
        && getSetting('suggestAnnotations', true)) {
      items.push({
        line: i + 1, col: 0, message: '', kind: 'suggest',
        suggestDim: row.suggest.dimName, rowIdx: i,
      });
    }
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
    // Defensive: @output on a bare expression (no binding name) gets a
    // null name; rendering would look up state._scope[null] = undefined.
    // Skip — the inline result still appears in the editor gutter.
    if (!name) continue;
    const chip = document.createElement('div');
    chip.className = 'chip readonly';
    const lbl = document.createElement('div');
    lbl.className = 'chip-lbl';
    lbl.textContent = unit ? `${name} : ${unit}` : name;

    // Plot-typed output: the binding's value is the void sentinel
    // (plot() returns Quantity(0, {})), so the "value" position carries
    // a small canvas thumbnail of the plot instead. Look up the
    // descriptor on the corresponding body row.
    const plotRow = state.body.find(r => r && r.name === name && r.plot);
    if (plotRow) {
      const canvas = document.createElement('canvas');
      canvas.className = 'cm-ep-plot-canvas chip-out-plot';
      const cssW = 240, cssH = 120;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
      const desc = plotRow.plot;
      requestAnimationFrame(() => drawPlot(canvas, desc, dpr));
      chip.append(lbl, canvas);
      outChipsEl.append(chip);
      continue;
    }

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
        // Don't try to render the full error message inside the chip —
        // it forces the chip wide and can horizontal-scroll the whole
        // app. Just show a compact "--" marker; the inline error block
        // above the binding in the editor has the full diagnostic.
        // Stash the message on the element's title so hovering still
        // surfaces it.
        val.classList.add('error');
        val.textContent = '--';
        val.title = err;
      } else {
        val.innerHTML = n + (u ? ` <span class="u">${u}</span>` : '');
        val.title = chipTooltip(q);  // canonical + dim — see chipTooltip()
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

// Pure helper: build the copy-format items array from a result. Used by
// both the output-chip copy-as menu (which anchors to a copy button it
// can flash on success) and the body-row right-click menu (which has no
// anchor — onCopied is omitted).
function copyAsItems(name, q, plainText, onCopied) {
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

  return formats.map(f => ({
    label: f.label,
    action: async () => {
      try { await copyToClipboard(f.text); if (onCopied) onCopied(); }
      catch { /* swallow — the menu has closed */ }
    },
  }));
}

function openCopyAsMenu(name, q, plainText, x, y, anchorBtn) {
  showMenu(copyAsItems(name, q, plainText, () => flashCopied(anchorBtn)),
           x, y, { alignRight: true });
}

// ── Body-row context menu (§4 — desktop scope 2) ─────────────────
// Right-click on a body line opens this menu. Items depend on what
// the row holds: rows with a Quantity result get "copy result as"
// (a submenu of formats); all rows get program-level actions
// (snapshot now, format document). On rows that are comments or
// have no result, the "copy result as" item is just absent.
//
// Plays nicely with CM6's own behavior: the listener is on the body
// container, intercepts contextmenu, and only fires when there's no
// active text selection in the editor (so right-click on selected
// text still surfaces the browser-native copy/paste menu).
async function snapshotNowFromBodyMenu() {
  const name = currentProgramName;
  if (!name) return;
  const label = await epPrompt({
    title: 'Take snapshot',
    label: 'label (optional)',
    value: '',
    okLabel: 'Snapshot',
  });
  if (label === null) return;
  takeSnapshot(name, (label || '').trim() || null);
}

function openBodyRowMenu(lineIdx, x, y) {
  const row = state.body[lineIdx];
  const items = [];

  // Copy result as — only when there's a Quantity-shaped result. Reuse
  // the same plain-text format the gutter cell shows, so what the user
  // copies matches what they see.
  if (row && row.result && typeof row.result === 'object' && row.result.dim != null) {
    const marker = resultMarkerHtml(lineIdx);
    const plainText = marker ? marker.text : '';
    if (plainText) {
      items.push({
        label: 'copy result as',
        submenu: copyAsItems(row.name || '', row.result, plainText),
      });
      items.push({ separator: true });
    }
  }

  items.push({ label: 'snapshot now…',  action: snapshotNowFromBodyMenu });
  items.push({ label: 'format document', action: () => {
    // Late-bound — format-cmd.js is concatenated into the same flat
    // scope at build time, so this resolves at call time even though
    // we don't import it (avoiding a circular-import risk).
    if (typeof formatCurrentProgram === 'function') formatCurrentProgram();
  } });

  showMenu(items, x, y);
}
