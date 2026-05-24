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
import { fmt, fmtNum, dEq, fmtDim, DT, Q } from './units.js';
import { resolveUnitExpression, getCompletionData, getCompatibleUnits } from './evaluator.js';
import { attachLongPress, showMenu } from './menu.js';
import { takeSnapshot, currentProgramName, getSetting } from './storage.js';
import { epPrompt } from './dialogs.js';
import { DOCS, renderDocInfo, parseSignature } from './docs.js';

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

// Population stdev — used by the Uncertain chip display alongside the
// mean (which is just q.value for an Uncertain). Same formula as
// BUILTIN_PROCS.stdev in numbat-js — kept here so chip rendering
// doesn't need a round trip through the evaluator.
function stdevOf(samples) {
  const N = samples.length;
  if (N === 0) return 0;
  let sum = 0;
  for (let i = 0; i < N; i++) sum += samples[i];
  const m = sum / N;
  let sumsq = 0;
  for (let i = 0; i < N; i++) sumsq += (samples[i] - m) * (samples[i] - m);
  return Math.sqrt(sumsq / N);
}

// Histogram thumbnail for an Uncertain output chip — bin the samples
// into ~30 cells and draw bars in the theme orange. No axes, no labels;
// this is a glanceable "what does the distribution look like" widget,
// not a serious plot. (The pdf/cdf builders, Phase 1+, will produce
// full-chrome plots.)
function drawUncertainHist(canvas, samples, dpr) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  const n = samples.length;
  if (n === 0) return;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!isFinite(mn) || !isFinite(mx)) return;
  if (mn === mx) { mx = mn + 1; mn -= 1; }       // degenerate (constant)
  const bins = 30;
  const counts = new Int32Array(bins);
  const span = mx - mn;
  for (let i = 0; i < n; i++) {
    let bi = Math.floor(((samples[i] - mn) / span) * bins);
    if (bi < 0) bi = 0;
    if (bi >= bins) bi = bins - 1;
    counts[bi]++;
  }
  let peak = 0;
  for (let i = 0; i < bins; i++) if (counts[i] > peak) peak = counts[i];
  if (peak === 0) return;
  const cs = getComputedStyle(document.documentElement);
  const fill = (cs.getPropertyValue('--sw-orange') || '#D4672E').trim();
  ctx.fillStyle = fill;
  const barW = w / bins;
  for (let i = 0; i < bins; i++) {
    const barH = (counts[i] / peak) * (h - 2);   // leave 2px headroom
    ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 1), barH);
  }
}

// Render a stereonet Plot into `host` (a DOM div). The Plot's `layers`
// array drives bearing.js's `.plane()` / `.line()` / `.pole()` calls;
// the resulting SVG goes into `host.innerHTML`. No canvas, no DPR —
// SVG scales cleanly. See SPEC-LAYERED-PLOTS for the Plot shape.
// Hover inspection isn't wired here in Phase 1; bearing.js's own SVG
// can carry tooltips natively if we want to opt in later.
function renderStereonet(host, plot) {
  if (typeof Stereonet === 'undefined') {
    host.textContent = 'stereonet: bearing.js missing from build';
    return;
  }
  // bearing.js's plane / line / pole accept a `style` object with SVG
  // attrs (stroke, strokeWidth, strokeDasharray, opacity). Map the
  // ep-side style fields onto those names. Default color cycles match
  // the canvas family for visual consistency.
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const cssVar = (n, fb) => cs ? (cs.getPropertyValue(n).trim() || fb) : fb;
  const colCycle = [
    cssVar('--sw-orange', '#B54E1A'),
    cssVar('--sw-indigo', '#4E5580'),
    cssVar('--sw-teal',   '#1F6F69'),
    cssVar('--sw-red',    '#A23A2F'),
  ];
  const styleFor = (layer, li) => {
    const out = { stroke: layer.color || colCycle[li % colCycle.length] };
    if (layer.width !== undefined) out.strokeWidth = layer.width;
    if (layer.dash && layer.dash.length) out.strokeDasharray = layer.dash.join(',');
    if (layer.alpha !== undefined) out.opacity = layer.alpha;
    return out;
  };
  try {
    const sn = new Stereonet();
    const layers = (plot && plot.layers) || [];
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const pairs = layer.pairs || [];
      const style = styleFor(layer, li);
      if (layer.kind === 'planes') {
        for (const [dd, dip] of pairs) sn.plane(dd, dip, style);
      } else if (layer.kind === 'lines') {
        for (const [trend, plunge] of pairs) sn.line(trend, plunge, style);
      } else if (layer.kind === 'poles') {
        for (const [dd, dip] of pairs) sn.pole(dd, dip, style);
      }
    }
    host.innerHTML = sn.svg();
  } catch (e) {
    host.textContent = 'stereonet: ' + (e && e.message || e);
  }
}

// Auto-bin a list of values into ~√N bins (capped at 50). Used by
// drawPlot's histogram-layer normalization.
function _autoBin(values) {
  if (!values || !values.length) return { xs: [], ys: [] };
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const n = Math.max(2, Math.min(50, Math.ceil(Math.sqrt(values.length))));
  const w = (hi - lo) / n;
  const bins = new Array(n).fill(0);
  for (const v of values) {
    let i = Math.floor((v - lo) / w);
    if (i >= n) i = n - 1;
    if (i < 0)  i = 0;
    bins[i]++;
  }
  return {
    xs: bins.map((_, i) => lo + (i + 0.5) * w),
    ys: bins,
  };
}

// Flatten a Plot value (SPEC-LAYERED-PLOTS) — OR a legacy single-
// descriptor — into a uniform array of layers, each
// {kind, xs, ys, xUnit, yUnit, label}. Bar layers synthesize xs as
// integer indices; hist layers auto-bin via _autoBin. The legacy
// descriptor path is kept for the still-unmigrated pdf / cdf builtins
// that emit { type:'line', xs, ys, … }.
function _normalizePlotLayers(plot) {
  if (!plot) return [];
  // Carry per-layer style overrides through the normalize step. Each
  // is undefined → "use default"; the dispatch in drawPlot falls back
  // to colCycle / 1.5 px / [] dash / kind-specific alpha as needed.
  const styleFields = (l) => ({
    color:      l.color,
    width:      l.width,
    dash:       l.dash,
    alpha:      l.alpha,
    markerSize: l.markerSize,
  });
  if (plot.__plot) {
    if (plot.family === 'xy') {
      return (plot.layers || []).map(l => {
        const kind = l.kind || 'line';
        if (kind === 'band') {
          return {
            kind: 'band',
            xs: l.xs || [], lo: l.lo || [], hi: l.hi || [],
            // ys is empty for bands — the dispatch reads lo/hi instead,
            // and the unified bounds-loop / hover skip the empty ys.
            ys: [],
            xUnit: l.xUnit || '', yUnit: l.yUnit || '',
            label: l.label || '',
            ...styleFields(l),
          };
        }
        return {
          kind,
          xs: l.xs || [], ys: l.ys || [],
          xUnit: l.xUnit || '', yUnit: l.yUnit || '',
          label: l.label || '',
          ...styleFields(l),
        };
      });
    }
    if (plot.family === 'bar') {
      return (plot.layers || []).map(l => {
        const ys = (l.values || []).slice();
        return {
          kind: 'bars',
          xs: ys.map((_, i) => i), ys,
          xUnit: '', yUnit: l.valueUnit || '',
          label: l.label || '',
          ...styleFields(l),
        };
      });
    }
    if (plot.family === 'hist') {
      return (plot.layers || []).map(l => {
        const { xs, ys } = _autoBin(l.values || []);
        return {
          kind: 'bins', xs, ys,
          xUnit: l.valueUnit || '', yUnit: '',
          label: l.label || '',
          ...styleFields(l),
        };
      });
    }
    return [];
  }
  // Legacy descriptor shape (pdf / cdf, anything not yet migrated).
  const type = plot.type;
  if (type === 'line' || type === 'scatter') {
    return [{ kind: type, xs: plot.xs || [], ys: plot.ys || [],
              xUnit: plot.xUnit || '', yUnit: plot.yUnit || '', label: '' }];
  }
  if (type === 'bar') {
    const ys = (plot.values || []).slice();
    return [{ kind: 'bars', xs: ys.map((_, i) => i), ys,
              xUnit: '', yUnit: plot.valueUnit || '', label: '' }];
  }
  if (type === 'hist') {
    const { xs, ys } = _autoBin(plot.values || []);
    return [{ kind: 'bins', xs, ys,
              xUnit: plot.valueUnit || '', yUnit: '', label: '' }];
  }
  return [];
}

function drawPlot(canvas, plot, dpr, opts) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !plot) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  const cssW = canvas.width  / dpr;
  const cssH = canvas.height / dpr;
  ctx.clearRect(0, 0, cssW, cssH);

  // Compact mode strips all chrome — title, tick labels, axis labels,
  // frame — leaving just the data shape on a subtle background. Used
  // by the @output chip thumbnail where the user wants a symbolic
  // representation, not a readable chart. Hit "tap" on the chip to
  // see the full version.
  const compact = !!(opts && opts.compact);

  // Read theme colors from CSS variables on the document. Falls back
  // to muted neutrals when the variable isn't defined (e.g. canvas
  // mounted into a PiP doc whose stylesheet copy missed). Layers are
  // drawn in cycled colors from the theme palette.
  const cs = getComputedStyle(document.documentElement);
  const cssVar = (n, fallback) => (cs.getPropertyValue(n).trim() || fallback);
  const colCycle = [
    cssVar('--sw-orange',    '#B54E1A'),
    cssVar('--sw-indigo',    '#4E5580'),
    cssVar('--sw-teal',      '#1F6F69'),
    cssVar('--sw-red',       '#A23A2F'),
  ];
  const colAxis = cssVar('--sw-border',    '#B3B1AD');
  const colText = cssVar('--sw-text-soft', '#7A7875');
  const colBg   = cssVar('--sw-bg-raised', '#E4E3E1');

  ctx.fillStyle = colBg;
  ctx.fillRect(0, 0, cssW, cssH);

  // Flatten Plot → uniform layer list. Each layer carries its own
  // xUnit / yUnit; the axis labels use the first layer's units, and
  // each layer's data is scaled by its own unit factor so they line up.
  const rawLayers = _normalizePlotLayers(plot);
  const unitFactor = (u) => {
    if (!u) return 1;
    try { return resolveUnitExpression(u).mul || 1; } catch { return 1; }
  };
  const layers = rawLayers.map(l => {
    const xF = unitFactor(l.xUnit), yF = unitFactor(l.yUnit);
    const out = {
      kind:  l.kind,
      xs:    l.xs.map(v => v / xF),
      ys:    (l.ys || []).map(v => v / yF),
      xUnit: l.xUnit, yUnit: l.yUnit,
      label: l.label,
      color: l.color, width: l.width, dash: l.dash,
      alpha: l.alpha, markerSize: l.markerSize,
    };
    if (l.kind === 'band') {
      out.lo = (l.lo || []).map(v => v / yF);
      out.hi = (l.hi || []).map(v => v / yF);
    }
    return out;
  });

  // Axis labels: explicit Plot label wins; otherwise first layer's unit.
  const title  = (plot && plot.title)  || '';
  const xUnit  = layers.length ? layers[0].xUnit : '';
  const yUnit  = layers.length ? layers[0].yUnit : '';
  const xLabel = (plot && plot.xLabel) || xUnit;
  const yLabel = (plot && plot.yLabel) || yUnit;

  // Margins.
  const hasTitle  = !compact && !!title;
  const hasXLabel = !compact && !!xLabel;
  const hasYLabel = !compact && !!yLabel;
  const ML = compact ? 4 : (hasYLabel ? 50 : 36);
  const MR = compact ? 4 : 12;
  const MT = compact ? 4 : (hasTitle  ? 26 : 10);
  const MB = compact ? 4 : (hasXLabel ? 38 : 24);
  const PW = cssW - ML - MR;
  const PH = cssH - MT - MB;

  if (hasTitle) {
    ctx.fillStyle = cssVar('--sw-text', '#232322');
    ctx.font = '600 12px var(--sw-mono, monospace)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(title, cssW / 2, 6);
  }

  if (!layers.length || !layers.some(l => l.xs.length)) {
    ctx.fillStyle = colText;
    ctx.font = '11px var(--sw-mono, monospace)';
    ctx.textBaseline = 'middle';
    ctx.fillText('(no data)', ML + 4, MT + PH / 2);
    canvas._plotState = null;
    return;
  }

  // Combine bounds across every layer. Band layers contribute their
  // lo + hi to the y range (the ys field is empty for bands).
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const layer of layers) {
    const isBand = layer.kind === 'band';
    for (let i = 0; i < layer.xs.length; i++) {
      const x = layer.xs[i];
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (isBand) {
        const lo = layer.lo[i], hi = layer.hi[i];
        if (lo < yMin) yMin = lo;
        if (hi > yMax) yMax = hi;
        // also widen on the other side in case lo > hi at some i
        if (hi < yMin) yMin = hi;
        if (lo > yMax) yMax = lo;
      } else {
        const y = layer.ys[i];
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
  }
  if (xMin === xMax) { xMin -= 0.5; xMax += 0.5; }
  if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }
  const xPad = (xMax - xMin) * 0.05;
  const yPad = (yMax - yMin) * 0.05;
  // bar/hist: pin y to 0 baseline.
  const hasBars = layers.some(l => l.kind === 'bars' || l.kind === 'bins');
  const xLo = xMin - xPad;
  const xHi = xMax + xPad;
  const yLo = hasBars ? Math.min(0, yMin - yPad) : (yMin - yPad);
  const yHi = yMax + yPad;

  const xPix = x => ML + ((x - xLo) / (xHi - xLo)) * PW;
  const yPix = y => MT + PH - ((y - yLo) / (yHi - yLo)) * PH;

  if (!compact) {
    ctx.strokeStyle = colAxis;
    ctx.lineWidth = 1;
    ctx.strokeRect(ML, MT, PW, PH);

    // Tick labels.
    ctx.fillStyle = colText;
    ctx.font = '10px var(--sw-mono, monospace)';
    ctx.textBaseline = 'middle';
    const fmtTick = v => {
      if (Math.abs(v) >= 1e4 || (v !== 0 && Math.abs(v) < 1e-2)) return v.toExponential(1);
      return parseFloat(v.toPrecision(3)).toString();
    };
    for (let i = 0; i <= 2; i++) {
      const v = yLo + (yHi - yLo) * (i / 2);
      const py = yPix(v);
      ctx.textAlign = 'right';
      ctx.fillText(fmtTick(v), ML - 4, py);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 2; i++) {
      const v = xLo + (xHi - xLo) * (i / 2);
      const px = xPix(v);
      ctx.fillText(fmtTick(v), px, MT + PH + 4);
    }
  }

  // Axis labels.
  if (hasXLabel) {
    ctx.fillStyle = cssVar('--sw-text', '#232322');
    ctx.font = '500 11px var(--sw-mono, monospace)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(xLabel, ML + PW / 2, cssH - 4);
  }
  if (hasYLabel) {
    ctx.save();
    ctx.fillStyle = cssVar('--sw-text', '#232322');
    ctx.font = '500 11px var(--sw-mono, monospace)';
    ctx.translate(12, MT + PH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
  }

  // For grouped bar layout: count bar-kind layers up front so each one
  // can claim a slot of the shared x-position. bin-kind (hist) layers
  // typically have non-aligned x grids across layers, so they fall
  // back to alpha blending rather than slot-grouping.
  const barLayerIdxs = [];
  let binLayerCount = 0;
  for (let li = 0; li < layers.length; li++) {
    if (layers[li].kind === 'bars') barLayerIdxs.push(li);
    else if (layers[li].kind === 'bins') binLayerCount++;
  }
  const numBars = barLayerIdxs.length;

  // Draw each layer in its cycled color (or its explicit `color`
  // override). Line / scatter / bars / bins share the same dispatch
  // table. layer._drawOffsetPx is stashed on bar-kind layers so hover
  // can map a bar back to the right group. Per-layer style overrides
  // (color, width, dash, alpha, markerSize) come from the with_color /
  // with_width / with_dash / with_alpha / with_marker_size adders.
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const color = layer.color || colCycle[li % colCycle.length];
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = layer.width ?? 1.5;
    ctx.setLineDash(layer.dash && layer.dash.length ? layer.dash : []);
    if (layer.kind === 'band') {
      // Filled envelope between lo and hi. Drawn at low alpha so an
      // overlying line layer in the same color cycle reads cleanly on
      // top. Skipped when fewer than 2 points (a polygon needs >= 3
      // vertices to have area).
      if (layer.xs.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(xPix(layer.xs[0]), yPix(layer.hi[0]));
      for (let i = 1; i < layer.xs.length; i++) {
        ctx.lineTo(xPix(layer.xs[i]), yPix(layer.hi[i]));
      }
      for (let i = layer.xs.length - 1; i >= 0; i--) {
        ctx.lineTo(xPix(layer.xs[i]), yPix(layer.lo[i]));
      }
      ctx.closePath();
      ctx.globalAlpha = layer.alpha ?? 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (layer.kind === 'line') {
      ctx.globalAlpha = layer.alpha ?? 1;
      ctx.beginPath();
      for (let i = 0; i < layer.xs.length; i++) {
        const px = xPix(layer.xs[i]), py = yPix(layer.ys[i]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (layer.kind === 'scatter') {
      ctx.globalAlpha = layer.alpha ?? 1;
      const r = layer.markerSize ?? 2.5;
      for (let i = 0; i < layer.xs.length; i++) {
        ctx.beginPath();
        ctx.arc(xPix(layer.xs[i]), yPix(layer.ys[i]), r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (layer.kind === 'bars') {
      const baselinePx = yPix(Math.max(0, yLo));
      const dx = layer.xs.length > 1 ? (layer.xs[1] - layer.xs[0]) : 1;
      const slotW = Math.max(1, (dx / (xHi - xLo)) * PW * 0.8);
      const j = barLayerIdxs.indexOf(li);
      const barW = numBars > 1 ? slotW / numBars : slotW;
      const offset = numBars > 1 ? (j - (numBars - 1) / 2) * barW : 0;
      layer._drawOffsetPx = offset;
      layer._drawWidthPx  = barW;
      ctx.globalAlpha = layer.alpha ?? 1;
      for (let i = 0; i < layer.xs.length; i++) {
        const cx = xPix(layer.xs[i]) + offset;
        const top = yPix(layer.ys[i]);
        const h = baselinePx - top;
        ctx.fillRect(cx - barW / 2, top, barW, h);
      }
      ctx.globalAlpha = 1;
    } else if (layer.kind === 'bins') {
      const baselinePx = yPix(Math.max(0, yLo));
      const dx = layer.xs.length > 1 ? (layer.xs[1] - layer.xs[0]) : 1;
      const binW = Math.max(1, (dx / (xHi - xLo)) * PW * 0.95);
      layer._drawOffsetPx = 0;
      layer._drawWidthPx  = binW;
      ctx.globalAlpha = layer.alpha ?? (binLayerCount > 1 ? 0.55 : 1);
      for (let i = 0; i < layer.xs.length; i++) {
        const cx = xPix(layer.xs[i]);
        const top = yPix(layer.ys[i]);
        const h = baselinePx - top;
        ctx.fillRect(cx - binW / 2, top, binW, h);
      }
      ctx.globalAlpha = 1;
    }
  }
  // Reset dash so legend / chrome drawn after this loop isn't dashed.
  ctx.setLineDash([]);

  // Stash plot state for hover inspection. attachPlotHover iterates
  // every layer to find the nearest data point in pixel space.
  if (!compact && layers.length) {
    canvas._plotState = {
      ML, MT, PW, PH,
      xLo, xHi, yLo, yHi,
      layers,
    };
  } else {
    canvas._plotState = null;
  }
}

// Hover inspection — wire a canvas drawn by drawPlot so the user can
// move the cursor over it (or touch-drag) and read the nearest data
// point in a tooltip, with a crosshair line at the picked x. The
// canvas needs to have been drawn with `compact: false` (i.e. has
// chrome / a plot area) — drawPlot stashes its geometry there as
// `canvas._plotState`. attachPlotHover is idempotent: calling it twice
// on the same canvas reuses the existing tooltip + listeners.
function attachPlotHover(canvas) {
  if (!canvas) return;
  const parent = canvas.parentElement;
  if (!parent) return;
  // Anchor the absolutely-positioned tooltip + crosshair inside the
  // canvas's wrapper. Only bump position when it's static — leave any
  // explicit value (relative / absolute / fixed) alone.
  const cs = getComputedStyle(parent);
  if (cs.position === 'static') parent.style.position = 'relative';

  // Get-or-create tooltip + crosshair line, one pair per canvas.
  let tip  = canvas._plotTip;
  let line = canvas._plotLine;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'plot-hover-tip';
    tip.style.display = 'none';
    parent.appendChild(tip);
    canvas._plotTip = tip;
  }
  if (!line) {
    line = document.createElement('div');
    line.className = 'plot-hover-line';
    line.style.display = 'none';
    parent.appendChild(line);
    canvas._plotLine = line;
  }

  if (canvas._plotHoverWired) return;
  canvas._plotHoverWired = true;

  const hide = () => {
    tip.style.display  = 'none';
    line.style.display = 'none';
  };
  const fmtTickish = v => {
    if (!isFinite(v)) return String(v);
    if (Math.abs(v) >= 1e4 || (v !== 0 && Math.abs(v) < 1e-2)) return v.toExponential(2);
    return fmtNum(v);
  };

  const onMove = (e) => {
    const state = canvas._plotState;
    if (!state || !state.layers || !state.layers.length) { hide(); return; }
    const rect = canvas.getBoundingClientRect();
    // Canvas reports in CSS pixels via getBoundingClientRect; the
    // plot state is stored in those same units, so no DPR scaling here.
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (sx < state.ML || sx > state.ML + state.PW || sy < state.MT || sy > state.MT + state.PH) {
      hide();
      return;
    }
    const xPix = x => state.ML + ((x - state.xLo) / (state.xHi - state.xLo)) * state.PW;
    const yPix = y => state.MT + state.PH - ((y - state.yLo) / (state.yHi - state.yLo)) * state.PH;

    // Find the nearest sample across every layer in pixel space.
    // Bar layers offset their drawn x by layer._drawOffsetPx; the
    // distance check honors that so grouped bars hit-test correctly.
    let best = null;
    for (let li = 0; li < state.layers.length; li++) {
      const layer = state.layers[li];
      if (!layer.xs || !layer.xs.length) continue;
      if (layer.kind !== 'line' && layer.kind !== 'scatter'
          && layer.kind !== 'bars' && layer.kind !== 'bins') continue;
      const off = layer._drawOffsetPx || 0;
      for (let i = 0; i < layer.xs.length; i++) {
        const px = xPix(layer.xs[i]) + off;
        const py = yPix(layer.ys[i]);
        const d = Math.hypot(px - sx, py - sy);
        if (!best || d < best.dist) {
          best = { dist: d, layerIdx: li, sampleIdx: i };
        }
      }
    }
    if (!best) { hide(); return; }

    const layer = state.layers[best.layerIdx];
    const xV = layer.xs[best.sampleIdx], yV = layer.ys[best.sampleIdx];
    const labelPrefix = (state.layers.length > 1 && layer.label) ? `${layer.label} · ` : '';
    let info, crosshairData;
    if (layer.kind === 'bins') {
      const dx = layer.xs.length > 1 ? (layer.xs[1] - layer.xs[0]) : 1;
      const half = dx / 2;
      info = `${labelPrefix}[${fmtTickish(xV - half)}, ${fmtTickish(xV + half)})${layer.xUnit ? ' ' + layer.xUnit : ''} · count ${yV}`;
      crosshairData = xV;
    } else if (layer.kind === 'bars') {
      const yPart = `${fmtTickish(yV)}${layer.yUnit ? ' ' + layer.yUnit : ''}`;
      info = `${labelPrefix}bar #${best.sampleIdx} · ${yPart}`;
      crosshairData = xV;
    } else {
      const xPart = `${fmtTickish(xV)}${layer.xUnit ? ' ' + layer.xUnit : ''}`;
      const yPart = `${fmtTickish(yV)}${layer.yUnit ? ' ' + layer.yUnit : ''}`;
      info = `${labelPrefix}${xPart} · ${yPart}`;
      crosshairData = xV;
    }

    // Position the crosshair at the picked data x (CSS pixels).
    // canvas.offsetLeft/Top translate from "inside canvas" to "inside
    // the positioned parent" — needed because the parent (e.g. the
    // padded `.cm-ep-plot-block`) offsets the canvas, and the tooltip
    // / line live in the parent's coordinate space.
    const cLeft = canvas.offsetLeft, cTop = canvas.offsetTop;
    const cx = state.ML + (crosshairData - state.xLo) / (state.xHi - state.xLo) * state.PW
            + (layer._drawOffsetPx || 0);
    line.style.display = '';
    line.style.left   = (cLeft + cx)       + 'px';
    line.style.top    = (cTop  + state.MT) + 'px';
    line.style.height = state.PH + 'px';

    tip.textContent = info;
    tip.style.display = '';
    // Position the tooltip near the cursor, clamping inside the canvas.
    const tipW = tip.offsetWidth, tipH = tip.offsetHeight;
    let tx = sx + 12, ty = sy + 12;
    if (tx + tipW > rect.width)  tx = sx - tipW - 12;
    if (ty + tipH > rect.height) ty = sy - tipH - 12;
    if (tx < 0) tx = 0;
    if (ty < 0) ty = 0;
    tip.style.left = (cLeft + tx) + 'px';
    tip.style.top  = (cTop  + ty) + 'px';
  };

  canvas.addEventListener('pointermove',  onMove);
  canvas.addEventListener('pointerleave', hide);
  canvas.addEventListener('pointercancel', hide);
}

// Open a centered overlay showing the plot at a comfortable size with
// full chrome (labels, ticks, title). Dismiss on Esc, backdrop click,
// or the explicit close button. Reuses the global keydown handler we
// add here for one modal at a time — calling again while one's open
// just closes the existing and reopens.
function openPlotModal(descriptor, name) {
  // Close any pre-existing modal first so re-tapping a chip doesn't
  // stack overlays.
  const existing = document.getElementById('plotModalScrim');
  if (existing) existing.remove();

  const scrim = document.createElement('div');
  scrim.id = 'plotModalScrim';
  scrim.className = 'plot-modal-scrim';

  const card = document.createElement('div');
  card.className = 'plot-modal-card';
  scrim.appendChild(card);

  const titleRow = document.createElement('div');
  titleRow.className = 'plot-modal-title';
  titleRow.textContent = name || 'plot';
  card.appendChild(titleRow);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'plot-modal-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'close');
  closeBtn.textContent = '×';
  card.appendChild(closeBtn);

  const canvas = document.createElement('canvas');
  canvas.className = 'plot-modal-canvas';
  card.appendChild(canvas);

  // Size canvas to fit the viewport with sensible caps.
  const cssW = Math.min(720, window.innerWidth  - 64);
  const cssH = Math.min(420, Math.floor(cssW * 9 / 16));
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const close = () => {
    document.removeEventListener('keydown', onKey);
    scrim.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  closeBtn.addEventListener('click', close);

  document.body.appendChild(scrim);
  // Defer the draw so the canvas is in the DOM (some browsers measure
  // CSS variables off-tree as empty strings). Wire hover inspection
  // once the draw is committed so canvas._plotState is populated.
  requestAnimationFrame(() => {
    drawPlot(canvas, descriptor, dpr);
    attachPlotHover(canvas);
  });
}

// Scroll the CM6 editor so the row defining this named plot is in
// view, and briefly highlight it so the user sees what jumped. Used
// by the long-press handler on the @output chip thumbnail. cmView is
// the module-scope EditorView from mountCm6().
function scrollToPlotRow(name) {
  if (!cmView) return;
  const idx = state.body.findIndex(r => r && r.name === name && r.plot);
  if (idx < 0) return;
  const line = cmView.state.doc.line(idx + 1);
  // EditorView.scrollIntoView is a static helper that returns a state
  // effect. cmView.constructor works too, but reaching through the
  // global IIFE namespace is clearer and survives any future minifier
  // mangling of constructor.name.
  const EV = (typeof CM6 !== 'undefined' && CM6.EditorView) || cmView.constructor;
  cmView.dispatch({
    selection: { anchor: line.from },
    effects: EV.scrollIntoView(line.from, { y: 'center' }),
  });
  cmView.focus();
  // Brief highlight flash on the target line so the jump is obvious.
  // Uses a one-shot decoration cleared by a timer; no StateField
  // needed for something this transient.
  const dom = cmView.domAtPos(line.from).node;
  const lineEl = dom && (dom.nodeType === 1 ? dom : dom.parentNode);
  if (lineEl && lineEl.classList) {
    lineEl.classList.add('ep-line-flash');
    setTimeout(() => lineEl.classList.remove('ep-line-flash'), 900);
  }
}

// Insert a `use module::path` statement at the top of the editor.
// Called from the drawer's Modules section when a user clicks a
// vendored-module entry. Skips duplicates so click-twice doesn't spam
// the document, and focuses the editor afterward so the user sees the
// insertion land. No-op if the editor isn't mounted yet.
export function insertUseStatement(modulePath) {
  if (!cmView) return;
  const target = `use ${modulePath}`;
  const doc = cmView.state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    if (doc.line(i).text.trim() === target) {
      // Already imported — just jump the cursor there so the user
      // sees what's already in place.
      const ln = doc.line(i);
      cmView.dispatch({ selection: { anchor: ln.from } });
      cmView.focus();
      return;
    }
  }
  cmView.dispatch({
    changes: { from: 0, to: 0, insert: target + '\n' },
  });
  cmView.focus();
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
  // Dataset value — show a `rows × cols` summary in the gutter rather
  // than the generic "object" placeholder.
  if (typeof r.result === 'object' && r.result.__dataset) {
    const rows = r.result.length;
    const cols = r.result.columns ? r.result.columns.size : 0;
    const label = `${fmtNum(rows)} × ${cols}`;
    return { html: `<span class="u">${escapeHtml(label)}</span>`,
             text: `dataset ${label}`, cls: '' };
  }
  // List value — inline a few elements via fmt(); show a shape summary
  // when it's long or nested. Lets users glance-verify time-series ops,
  // map results, dataset columns, etc. without resorting to print().
  if (Array.isArray(r.result)) {
    const arr = r.result;
    const n = arr.length;
    if (n === 0) {
      return { html: `<span class="u">[]</span>`, text: '[]', cls: '' };
    }
    // List-of-lists (e.g. `roll(xs, w)`) — just show the nested shape.
    if (Array.isArray(arr[0])) {
      const inner = arr[0].length;
      const label = `List<List, ${n} × ${inner}>`;
      return { html: `<span class="u">${escapeHtml(label)}</span>`, text: label, cls: '' };
    }
    // List of structs (datasets-as-rows, etc.) — opaque shape summary.
    if (arr[0] && typeof arr[0] === 'object' && arr[0].__struct) {
      const label = `List<${arr[0].__struct}, ${n}>`;
      return { html: `<span class="u">${escapeHtml(label)}</span>`, text: label, cls: '' };
    }
    const MAX = 6;
    const slice = arr.slice(0, MAX);
    const fmtElem = (v) => {
      if (v && typeof v === 'object' && v.dim != null) {
        const [num, unit] = fmt(v);
        return unit ? `${num} ${unit}` : num;
      }
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'string')  return '"' + v.slice(0, 16) + '"';
      if (typeof v === 'number')  return String(v);
      return String(v);
    };
    const fmted = slice.map(fmtElem);
    const ellipsis = n > MAX ? `, … (${n} total)` : '';
    const label = `[${fmted.join(', ')}${ellipsis}]`;
    return { html: `<span class="u">${escapeHtml(label)}</span>`, text: label, cls: '' };
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

  // A datetime renders as a calendar date — fmt() routes DateTime values
  // to the date formatter (unit is null). Skip the unit-resolution block
  // below: dividing a datetime's epoch-seconds by a unit's `mul` (a
  // gutter override or @output unit) is meaningless. The dot `cls` still
  // applies, so a datetime @input/@output keeps its marker.
  if (r.result instanceof DT) {
    const [dn] = fmt(r.result);
    return { html: escapeHtml(dn), text: dn, cls };
  }

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

// True when the editor has at least one non-empty selection range. Scopes
// the Tab / Shift-Tab indent commands to "select + Tab" — a bare Tab with
// no selection still accepts a completion or tabs out of the editor.
function hasEditorSelection(view) {
  return view.state.selection.ranges.some(r => !r.empty);
}

function mountCm6() {
  const CM6 = globalThis.CM6;
  if (!CM6) {
    bodyEl.innerHTML = '<div style="padding:20px;color:var(--sw-red);font-family:var(--sw-mono);font-size:12px">CodeMirror 6 bundle not loaded.</div>';
    return;
  }

  const {
    EditorView, EditorState, keymap, history, historyKeymap,
    gutter, GutterMarker, drawSelection, defaultKeymap, indentWithTab,
    StreamLanguage, syntaxHighlighting, HighlightStyle, tags,
    foldGutter, foldKeymap, foldService,
    bracketMatching, closeBrackets,
    Decoration, WidgetType, StateField, StateEffect,
    autocompletion, CompletionContext, acceptCompletion,
    search, searchKeymap, highlightSelectionMatches,
    showTooltip, hoverTooltip,
    lineNumbers, Compartment,
  } = CM6;

  // Inline-error block widget — renders BELOW the offending line so the
  // full message has room to breathe. The gutter is too narrow for
  // dim-mismatch + did-you-mean style messages. `kind` is 'error' (red)
  // for runtime/typecheck failures or 'warn' (amber) for blame-trace
  // suspect annotations.
  class EpErrorWidget extends WidgetType {
    constructor(message, col, kind, suggestDim, rowIdx, plot, csv) {
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
      // 'csv-asset' kind carries { name, attached, rows, cols }.
      this.csv = csv || null;
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
          && a.xUnit  === b.xUnit
          && a.yUnit  === b.yUnit
          && a.valueUnit === b.valueUnit
          && (a.xs?.length || 0) === (b.xs?.length || 0)
          && (a.ys?.length || 0) === (b.ys?.length || 0)
          && (a.values?.length || 0) === (b.values?.length || 0)
          && JSON.stringify(a.xs || a.values || []) === JSON.stringify(b.xs || b.values || [])
          && JSON.stringify(a.ys || []) === JSON.stringify(b.ys || []);
      }
      if (this.kind === 'csv-asset') {
        const a = this.csv, b = other.csv;
        if (!a || !b) return a === b;
        return a.name === b.name && a.attached === b.attached
            && a.rows === b.rows && a.cols === b.cols;
      }
      return other.message === this.message
        && other.col === this.col
        && other.kind === this.kind
        && other.suggestDim === this.suggestDim
        && other.rowIdx === this.rowIdx;
    }
    toDOM() {
      if (this.kind === 'plot') {
        // Stereonet plots (structural geology) are SVG, not canvas —
        // bearing.js generates the projection + features as an SVG
        // string. Same block-widget shape, different inner content.
        // Detects the layered Plot value (SPEC-LAYERED-PLOTS).
        if (this.plot && this.plot.__plot && this.plot.family === 'stereonet') {
          const wrap = document.createElement('div');
          wrap.className = 'cm-ep-plot-block cm-ep-stereonet-block';
          if (this.plot.title) {
            const title = document.createElement('div');
            title.className = 'cm-ep-stereonet-title';
            title.textContent = this.plot.title;
            wrap.appendChild(title);
          }
          const host = document.createElement('div');
          host.className = 'cm-ep-stereonet';
          wrap.appendChild(host);
          const desc = this.plot;
          requestAnimationFrame(() => renderStereonet(host, desc));
          return wrap;
        }
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
        // attachPlotHover runs after the draw so canvas._plotState is
        // ready for the inverse pixel → data transform.
        const desc = this.plot;
        requestAnimationFrame(() => {
          drawPlot(canvas, desc, dpr);
          attachPlotHover(canvas);
        });
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
        // Out of the Tab cycle (SPEC §4.6): an inline editor decoration,
        // not a stop between the form chips and the body.
        btn.tabIndex = -1;
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
      if (this.kind === 'csv-asset') {
        // Inline end-of-line affordance on a `name = load_csv("x")` line.
        const span = document.createElement('span');
        span.className = 'cm-ep-suggest-inline';
        const csv = this.csv || {};
        const fire = (e) => {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('ep:csv-attach-request',
            { detail: { name: csv.name } }));
        };
        if (csv.attached) {
          const chip = document.createElement('span');
          chip.className = 'cm-ep-csv-chip';
          chip.textContent = `${csv.name} · ${fmtNum(csv.rows)} × ${csv.cols}`;
          chip.title = 'attached data — click to re-attach';
          chip.addEventListener('click', fire);
          span.appendChild(chip);
        } else {
          const btn = document.createElement('button');
          btn.className = 'cm-ep-suggest-btn';
          btn.tabIndex = -1;   // inline decoration — out of the Tab cycle (§4.6)
          btn.textContent = 'attach…';
          btn.title = `no data attached for "${csv.name}" — click to attach a CSV`;
          btn.addEventListener('click', fire);
          span.appendChild(btn);
        }
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
          } else if (kind === 'csv-asset') {
            decos.push(Decoration.widget({
              widget: new EpErrorWidget('', 0, kind, null, -1, null, it.csv),
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
  //
  // Also maintains --ep-sighelp-h: the strip's current rendered height.
  // The mobile .app rule reads this and extends its padding-bottom by
  // that amount, so when the strip overlaps the @outputs panel the user
  // can still scroll the outputs into view above the strip. 0px when
  // hidden, ~strip.offsetHeight when shown. rAF defers the read until
  // after layout has settled so we don't measure mid-frame.
  function updateSigHelpStrip(name, argIndex) {
    const strip = document.getElementById('sighelpStrip');
    if (!strip) return;
    const setInsetVar = (px) => {
      document.documentElement.style.setProperty('--ep-sighelp-h', px + 'px');
    };
    if (!name) {
      strip.hidden = true;
      strip.replaceChildren();
      setInsetVar(0);
      return;
    }
    const inner = buildSigTooltipDom(name, argIndex);
    if (!inner) {
      strip.hidden = true;
      strip.replaceChildren();
      setInsetVar(0);
      return;
    }
    // buildSigTooltipDom returns a `.cm-tooltip.cm-ep-sighelp` div —
    // drop the cm-tooltip class on this copy since we're outside the
    // editor's tooltip layer and don't want CM6's default tooltip
    // styling fighting our docked-strip CSS.
    inner.className = 'cm-ep-sighelp cm-ep-sighelp--strip';
    strip.replaceChildren(inner);
    strip.hidden = false;
    requestAnimationFrame(() => {
      // Visible only on mobile (CSS @media handles the display: block).
      // On desktop offsetHeight will still be measurable, but the var
      // doesn't matter there since the .app rule scoping it lives
      // inside the same mobile media query.
      setInsetVar(strip.offsetHeight || 0);
    });
  }

  // §4.4 — hover docs. Hovering a builtin / decorator / keyword shows
  // its DOCS entry as a tooltip. Same data the autocomplete info panel
  // and signature help draw from. Only fires for names that HAVE a docs
  // entry — hovering a user binding or plain number does nothing.
  function wordRangeAt(state, pos) {
    const line = state.doc.lineAt(pos);
    const text = line.text;
    let rel = pos - line.from;
    const isWord = (c) => /[A-Za-z0-9_]/.test(c);
    // pos can sit just past the end of the word (CM6 gives the boundary);
    // step back one if the char under pos isn't a word char but the one
    // before is.
    if (rel > 0 && (rel >= text.length || !isWord(text[rel])) && isWord(text[rel - 1])) {
      rel--;
    }
    if (rel < 0 || rel >= text.length || !isWord(text[rel])) return null;
    let from = rel, to = rel;
    while (from > 0 && isWord(text[from - 1])) from--;
    while (to < text.length - 1 && isWord(text[to + 1])) to++;
    to++; // exclusive end
    // Pull a leading `@` into the range so decorator names (@input etc.)
    // resolve against their DOCS keys.
    let name = text.slice(from, to);
    if (from > 0 && text[from - 1] === '@') { from--; name = '@' + name; }
    return { from: line.from + from, to: line.from + to, name };
  }

  function buildHoverDom(name) {
    const d = DOCS[name];
    if (!d) return null;
    const wrap = document.createElement('div');
    // Both classes so the `.cm-tooltip.cm-ep-hoverdoc` override applies
    // whether or not CM6 also tags the outer element — same belt-and-
    // braces as the sig-help tooltip.
    wrap.className = 'cm-tooltip cm-ep-hoverdoc';
    const sig = document.createElement('div');
    sig.className = 'cm-ep-hoverdoc-sig';
    sig.textContent = d.signature || name;
    wrap.appendChild(sig);
    if (d.description) {
      const desc = document.createElement('div');
      desc.className = 'cm-ep-hoverdoc-desc';
      desc.textContent = d.description;
      wrap.appendChild(desc);
    }
    if (d.example) {
      const ex = document.createElement('div');
      ex.className = 'cm-ep-hoverdoc-ex';
      ex.textContent = d.example;
      wrap.appendChild(ex);
    }
    return wrap;
  }

  const epHoverDocs = hoverTooltip((view, pos) => {
    const wr = wordRangeAt(view.state, pos);
    if (!wr) return null;
    const dom = buildHoverDom(wr.name);
    if (!dom) return null;
    return {
      pos: wr.from,
      end: wr.to,
      above: true,
      create() { return { dom }; },
    };
  }, { hoverTime: 350 });

  const initialDoc = state.body.map(r => r.src).join('\n');

  // Line-number gutter, in a Compartment so the settings toggle can
  // switch it on/off live without rebuilding the editor. CM6 numbers
  // document lines only — the inline error / print / plot block
  // widgets are decorations, not lines, so they're skipped and the
  // numbering stays 1:1 with state.body rows.
  const lineNumberCompartment = new Compartment();
  const lineNumbersExt = () =>
    getSetting('lineNumbers', false) ? lineNumbers() : [];

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
        lineNumberCompartment.of(lineNumbersExt()),
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
        epHoverDocs,
        resultGutter,
        keymap.of([
          // Tab: accept an open completion; else, with a non-empty
          // selection, indent the selected lines; else return false so
          // Tab falls through to browser tab order (users can still
          // leave the editor). Shift-Tab dedents the selected lines.
          // indentWithTab.run / .shift are CM6's indentMore / indentLess.
          {
            key: 'Tab',
            run: (view) => acceptCompletion(view)
              || (hasEditorSelection(view) && indentWithTab.run(view)),
            shift: (view) => hasEditorSelection(view) && indentWithTab.shift(view),
          },
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
              scheduleErrorMarks();
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

  // Line-number setting toggled in Settings — reconfigure the
  // compartment so the gutter appears / disappears immediately.
  window.addEventListener('ep:line-numbers-setting-changed', () => {
    if (cmView) {
      cmView.dispatch({ effects: lineNumberCompartment.reconfigure(lineNumbersExt()) });
    }
  });

  // When settings change (e.g., toggling "annotation suggestions"
  // off), re-run the inline-block dispatch so widgets that depend on
  // the setting clear immediately instead of waiting for the next
  // body or chip edit.
  window.addEventListener('ep:params-changed', () => scheduleErrorMarks());

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
    if (p._inputEl.dataset.kind === 'filepicker') continue;   // no text value to sync
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
  // file-picker (a load_csv binding) wins over freeform text input.
  // Options + range is incoherent (you can't both pick from a list and
  // drag a slider), so we honor the more specific signal — options —
  // when both are present.
  if (chipWidgetOptions(p))   return 'select';
  if (chipSliderInfo(p))      return 'slider';
  if (chipFilePickerInfo(p))  return 'filepicker';
  return 'input';
}

// Returns { name } if the chip should render as a CSV file-picker /
// drop-zone, else null. Triggers when the binding's value is a bare
// load_csv("…") call — an @input on such a binding means "let the user
// (or a recipient of the exported form) drop their own CSV here".
function chipFilePickerInfo(p) {
  if (!p || !p.valueSrc) return null;
  const m = p.valueSrc.trim().match(/^load_csv\s*\(\s*"([^"]*)"\s*\)\s*$/);
  return m ? { name: m[1] } : null;
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
// Apply a new value to an @input chip's binding: rewrite the source line
// (preserving any trailing comment), re-evaluate, refresh dependent UI.
// Shared by the chip controls' onChange and the param-history menu (which
// reaches it via the ep:param-set event). Deliberately does NOT re-sync
// the chip inputs — the typing path must not fight the cursor; the menu
// path calls syncChipInputsFromState itself.
function applyChipValue(name, newValue) {
  const cur = state.params.find(x => x.name === name);
  if (!cur) return;
  const bodyIdx = cur.bodyIdx;
  const line = state.body[bodyIdx];
  const eq = line.src.indexOf('=');
  // Preserve any trailing comment (e.g., `# options: …`) — otherwise
  // editing the chip would erase the user's declared options list.
  // String-aware match so `# inside literal "..."` isn't treated as a
  // comment marker.
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
  scheduleErrorMarks();
  // storage.js listens for ep:params-changed and triggers autosave.
  // Decoupled from render so the viewer can reuse render.js without
  // pulling in the storage layer.
  window.dispatchEvent(new CustomEvent('ep:params-changed'));
}

// §7.1 — a chip value was committed (change event, not every keystroke).
// render.js stays storage-free: it just announces the commit; the
// editor-only param-history.js records it.
function announceChipCommit(name, value) {
  window.dispatchEvent(new CustomEvent('ep:param-committed', { detail: { name, value } }));
}

// §7.1 — the param-history menu (param-history.js) picks a recent value
// and asks us to apply it. We own the apply path; re-sync the chip
// inputs afterwards since this is a menu action, not a typing edit, so
// there's no cursor to disturb.
window.addEventListener('ep:param-set', (e) => {
  const d = e.detail || {};
  if (!d.name) return;
  applyChipValue(d.name, d.value);
  syncChipInputsFromState();
});

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
    sel.addEventListener('change', () => announceChipCommit(p.name, sel.value));
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
    // §7.1 — record on commit (drag-release / blur), not every drag tick.
    range.addEventListener('change', () => announceChipCommit(p.name, text.value));
    text.addEventListener('change',  () => announceChipCommit(p.name, text.value));

    wrap.append(range, text);
    return wrap;
  }
  const picker = chipFilePickerInfo(p);
  if (picker) {
    // The chip IS a CSV drop-zone / file-picker. The binding source —
    // load_csv("name") — never changes; only the asset's content does,
    // so there's no onChange / source rewrite. Drop a file, or tap the
    // chip. When attached, the WHOLE chip is the tap target (a full-width,
    // comfortably-tall touch hit area): in the editor it opens a menu —
    // replace file / re-configure parsing; the viewer, with no attach
    // dialog, just replaces. Unattached → tap picks the first file.
    const ds = (p.result && typeof p.result === 'object' && p.result.__dataset)
      ? p.result : null;
    const zone = document.createElement('div');
    zone.className = 'chip-val chip-val-filepicker' + (ds ? ' attached' : '');
    zone.dataset.paramName = p.name;
    zone.dataset.kind = 'filepicker';
    zone.tabIndex = 0;

    const label = document.createElement('span');
    label.className = 'chip-fp-label';
    label.textContent = ds
      ? `${picker.name} · ${fmtNum(ds.length)} × ${ds.columns.size}`
      : 'drop CSV · or click';
    zone.appendChild(label);
    if (ds) {
      const hint = document.createElement('span');
      hint.className = 'chip-fp-hint';
      hint.textContent = '⚙';
      zone.appendChild(hint);
    }

    const readFile = (file) => {
      if (!file) return;
      file.text()
        .then(text => window.dispatchEvent(new CustomEvent('ep:csv-attach-request',
          { detail: { name: picker.name, text } })))
        .catch(err => console.error('ep: failed to read dropped CSV:', err));
    };
    const pick = () => {
      const fi = document.createElement('input');
      fi.type = 'file';
      fi.accept = '.csv,text/csv';
      fi.addEventListener('change', () => readFile(fi.files && fi.files[0]));
      fi.click();
    };
    const activate = (e) => {
      // Attached, in the editor → a menu (full-width rows are far easier
      // to hit on touch than a tiny inline cog). Otherwise → pick a file.
      if (ds && !state._viewer) {
        // Keep this click from bubbling to menu.js's window-level dismiss
        // listener, which would otherwise close the menu on the very
        // click that opened it.
        if (e) e.stopPropagation();
        const r = zone.getBoundingClientRect();
        showMenu([
          { label: 'replace file…', action: pick },
          { label: 're-configure parsing…', action: () =>
              window.dispatchEvent(new CustomEvent('ep:csv-reconfigure-request',
                { detail: { name: picker.name } })) },
        ], r.left, r.bottom);
      } else {
        pick();
      }
    };

    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dragover');
      readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
    zone.addEventListener('click', activate);
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    zone.addEventListener('focus', () => { state._lastFocused = zone; });
    return zone;
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
  inp.addEventListener('change', () => announceChipCommit(p.name, inp.value));
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
    const inp = makeChipControl(p, (newValue) => applyChipValue(name, newValue));
    const res = document.createElement('div');
    res.className = 'chip-res';
    chip.append(lbl, inp, res);
    chipsEl.append(chip);
    // §7.1 — long-press (or right-click) the chip label to recall this
    // param's recent values. Attached to the label, not the input, so it
    // doesn't fight text selection / the input's own context menu.
    attachLongPress(lbl, (x, y) => {
      window.dispatchEvent(new CustomEvent('ep:param-history-request',
        { detail: { name, x, y } }));
    });
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

// Debounced applyErrorMarks. Evaluation itself stays synchronous —
// results, the gutter, and chip values update live on every keystroke.
// Only the ERROR DECORATION pass is deferred: while the user is mid-
// edit, downstream rows transiently error (e.g. typing `x = ` makes
// every row using `x` go red for a frame) and that flicker is pure
// noise. Waiting ~300ms past the last keystroke lets the program
// settle before lighting anything up. Cursor-only moves still apply
// marks immediately — see the selectionSet branch — so the cursor-
// line suppression releases without lag.
let _errorMarksTimer = null;
function scheduleErrorMarks() {
  if (_errorMarksTimer) clearTimeout(_errorMarksTimer);
  _errorMarksTimer = setTimeout(() => {
    _errorMarksTimer = null;
    applyErrorMarks();
  }, 300);
}

// §4.2 — push the current set of body-row errors into the CM6 decoration
// field. The parser surfaces "<src>:1:<col>: msg" for parse errors; we
// extract col and translate it into source-line coordinates by adding the
// `name = ` prefix length on binding lines. Non-binding lines (or messages
// without a parseable position) fall back to underlining the whole line.
function applyErrorMarks() {
  // A pending debounce timer is now moot — we're applying marks right
  // now. Clear it so a stale timer doesn't double-fire a moment later.
  if (_errorMarksTimer) { clearTimeout(_errorMarksTimer); _errorMarksTimer = null; }
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
    // Inline load_csv affordance — shown on a `name = load_csv("x")`
    // line regardless of error: a missing asset both errors AND offers
    // the attach… widget (the widget is how you fix it).
    if (row.csvAsset) {
      items.push({ line: i + 1, col: 0, message: '', kind: 'csv-asset', csv: row.csvAsset });
    }
  }
  cmView.dispatch({ effects: _errorEffect.of(items) });
}

export function renderOutputs() {
  outChipsEl.innerHTML = '';
  const panel = document.getElementById('outputsPanel');
  const specs = state.outputs;
  outMetaEl.textContent = `· ${specs.length} result${specs.length === 1 ? '' : 's'}`;
  // Panel-level export affordance — built once, kept in the header next
  // to the chevron. Hidden when there are no exportable outputs (any
  // named, non-dataset result counts).
  const exportBtn = ensureOutputsExportBtn(panel);
  const exportable = specs.some(s => {
    const q = s.name ? state._scope[s.name] : null;
    return q != null && !(typeof q === 'object' && q.__dataset);
  });
  exportBtn.style.display = exportable ? '' : 'none';
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
      // Smaller than the in-editor block — chrome's been stripped so
      // less area is needed to read the shape. Wider than tall keeps
      // line plots legible.
      const cssW = 200, cssH = 90;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
      const desc = plotRow.plot;
      requestAnimationFrame(() => drawPlot(canvas, desc, dpr, { compact: true }));
      canvas.title = 'tap to enlarge · long-press to jump to source';
      // Tap → modal with full-chrome version. Long-press → scroll the
      // editor to the source line. attachLongPress fires before the
      // tap so it gets first dibs; the click handler short-circuits
      // when long-press fired.
      let longPressed = false;
      attachLongPress(canvas, () => {
        longPressed = true;
        scrollToPlotRow(name);
      });
      canvas.addEventListener('click', () => {
        if (longPressed) { longPressed = false; return; }
        openPlotModal(desc, name);
      });
      chip.append(lbl, canvas);
      outChipsEl.append(chip);
      continue;
    }

    const row = document.createElement('div');
    row.className = 'chip-out-row';
    const val = document.createElement('div');
    val.className = 'chip-out-val';
    const q = state._scope[name];
    const isUnc   = q && q.__uncertain;
    const isSwept = q && q.__swept;
    let copyText = '';
    // Hoisted to the row scope so the chip-thumbnail click handlers
    // (further down) can scale samples to the chip's display unit using
    // the same `n` / `u` it shows.
    let n, u, sNum = null, sMin = null, sMax = null, err = null;
    if (q == null) {
      val.classList.add('error');
      val.textContent = 'undefined';
    } else {
      // Per-output unit (if any) overrides the binding's own display.
      // resolveUnitExpression falls back to parsing the text as a Numbat
      // expression so compound forms like ft^3 / kg/m^2 / km/h work even
      // when they aren't pre-registered aliases. For Uncertain values
      // (SPEC-UNCERTAINTY): also compute and display the stdev so the
      // chip reads `mean ± stdev unit`. For Swept values (sensitivity
      // sweep): compute the output range so the chip reads `min … max`.
      const sigma = isUnc ? stdevOf(q.samples) : 0;
      let minV = 0, maxV = 0;
      if (isSwept) {
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < q.samples.length; i++) {
          const v = q.samples[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        minV = mn; maxV = mx;
      }
      if (unit) {
        try {
          const spec = resolveUnitExpression(unit);
          if (!dEq(spec.dim, q.dim)) {
            err = `expected [${fmtDim(q.dim)}] but ${unit} is [${fmtDim(spec.dim)}]`;
          } else {
            n = fmtNum(q.value / spec.mul);
            u = spec.displayName;
            if (isUnc)   sNum = fmtNum(sigma / spec.mul);
            if (isSwept) {
              sMin = fmtNum(minV / spec.mul);
              sMax = fmtNum(maxV / spec.mul);
            }
          }
        } catch (e) { err = e.message; }
      } else {
        [n, u] = fmt(q);
        // Format ancillary values in the same auto-chosen display the
        // mean used — `fmt` picks a unit/scale from q's dim+disp; passing
        // a matched Quantity yields the same display unit.
        if (isUnc) [sNum] = fmt(new Q(sigma, q.dim, q.disp));
        if (isSwept) {
          [sMin] = fmt(new Q(minV, q.dim, q.disp));
          [sMax] = fmt(new Q(maxV, q.dim, q.disp));
        }
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
      } else if (isUnc) {
        val.innerHTML =
          `${n} <span class="u">±</span> ${sNum}` + (u ? ` <span class="u">${u}</span>` : '');
        val.title = chipTooltip(q);
        copyText = (`${n} ± ${sNum}` + (u ? ' ' + u : '')).replace(/,/g, '')
                    .replace(/²/g, '^2').replace(/³/g, '^3');
      } else if (isSwept) {
        // Range display: "min … max unit". Compact enough to fit the
        // chip; the inline thumbnail below carries the shape.
        val.innerHTML =
          `${sMin} <span class="u">…</span> ${sMax}` + (u ? ` <span class="u">${u}</span>` : '');
        val.title = chipTooltip(q);
        copyText = (`${sMin}..${sMax}` + (u ? ' ' + u : '')).replace(/,/g, '')
                    .replace(/²/g, '^2').replace(/³/g, '^3');
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
    // Line-plot thumbnail for Swept outputs — a glanceable view of the
    // input-vs-output relationship. Tap to open the full plot modal
    // with axis labels (input dim x output dim).
    if (isSwept) {
      const cssW = 200, cssH = 60;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const cvs = document.createElement('canvas');
      cvs.className = 'chip-out-hist';   // reuse Uncertain thumbnail styling (same dims, same cursor:pointer)
      cvs.width  = cssW * dpr;
      cvs.height = cssH * dpr;
      cvs.style.width  = cssW + 'px';
      cvs.style.height = cssH + 'px';
      cvs.title = 'tap to enlarge';
      const inputSamples = q.inputSamples;
      const outputSamples = q.samples;
      requestAnimationFrame(() => drawPlot(cvs, {
        type: 'line',
        xs: Array.from(inputSamples),
        ys: Array.from(outputSamples),
      }, dpr, { compact: true }));
      cvs.addEventListener('click', () => {
        // Modal: canonical values + the chip's display units; drawPlot
        // handles the scaling. Input axis uses inputDisp from the
        // original sweep() args; output axis uses `u` (whatever the
        // chip resolved to for the mean / range display).
        let xUnit = '';
        try {
          // Derive a display-unit label for the input axis by formatting
          // a typical inputSamples value via fmt — this matches the
          // unit string drawPlot's unitFactor can consume.
          const midI = q.inputSamples[Math.floor(q.inputSamples.length / 2)];
          const [, xMidUnit] = fmt(new Q(midI, q.inputDim, q.inputDisp));
          xUnit = xMidUnit || '';
        } catch {}
        openPlotModal({
          type: 'line',
          xs: Array.from(inputSamples),
          ys: Array.from(outputSamples),
          xUnit, yUnit: u || '',
          xLabel: xUnit,
          yLabel: u || '',
          title: `${name} — sweep`,
        }, name);
      });
      chip.appendChild(cvs);
    }
    // Histogram thumbnail for Uncertain outputs — a glanceable view of
    // the distribution shape, drawn from the sample array. Tap to open
    // a full-size hist in the plot modal (same path the other plot
    // outputs use, so the chrome and close behavior are consistent).
    if (isUnc) {
      const cssW = 200, cssH = 60;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const hist = document.createElement('canvas');
      hist.className = 'chip-out-hist';
      hist.width  = cssW * dpr;
      hist.height = cssH * dpr;
      hist.style.width  = cssW + 'px';
      hist.style.height = cssH + 'px';
      hist.title = 'tap to enlarge';
      const samples = q.samples;
      requestAnimationFrame(() => drawUncertainHist(hist, samples, dpr));
      // Build a hist descriptor whose values are in the chip's display
      // unit (canonical / scale), so the modal's bin numbers match the
      // chip's `mean ± stdev` text. Scale is recovered from the
      // formatted mean: scale = canonical / displayed.
      hist.addEventListener('click', () => {
        const numStr = typeof n === 'string' ? n.replace(/,/g, '') : '';
        const displayed = parseFloat(numStr);
        const scale = (Number.isFinite(displayed) && displayed !== 0 && Number.isFinite(q.value))
          ? q.value / displayed : 1;
        const scaled = new Array(samples.length);
        for (let i = 0; i < samples.length; i++) scaled[i] = samples[i] / scale;
        openPlotModal({
          type: 'hist',
          values: scaled,
          valueUnit: u || '',
          title: `${name} — distribution`,
          xLabel:  u || '',
          yLabel: 'count',
        }, name);
      });
      chip.appendChild(hist);
    }
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

// ── Bulk export of @output results ────────────────────────────────
// The per-chip "copy" button copies one result; this is the panel-level
// affordance — "give me all the outputs at once" as CSV / JSON / text,
// either to the clipboard or as a downloaded file. The point is that an
// exported viewer is a self-contained form: a recipient fills in the
// chips, gets results, and now has a way out for those results.
//
// Dataset-valued outputs (a binding whose result is a load_csv view) are
// skipped here — they're tabular and belong in the per-chip dataset
// viewer / a future per-chip CSV export, not a row in this flat export.

function outputRecord(spec) {
  const { name, unit: targetUnit } = spec;
  const q = state._scope[name];
  if (q == null) return null;
  if (q && typeof q === 'object' && q.__dataset) return { name, dataset: true };
  let n, u;
  if (targetUnit) {
    try {
      const sp = resolveUnitExpression(targetUnit);
      if (!dEq(sp.dim, q.dim)) return null;
      n = fmtNum(q.value / sp.mul);
      u = sp.displayName;
    } catch { return null; }
  } else {
    [n, u] = fmt(q);
  }
  const numAscii  = n.replace(/,/g, '');
  const unitAscii = (u || '').replace(/²/g, '^2').replace(/³/g, '^3');
  const num = parseFloat(numAscii);
  return {
    name,
    value: Number.isFinite(num) ? num : numAscii,
    unit:  unitAscii,
    text:  numAscii + (unitAscii ? ' ' + unitAscii : ''),
  };
}

function collectOutputRecords() {
  return state.outputs
    .map(outputRecord)
    .filter(r => r && !r.dataset);
}

function csvEscape(s) {
  const str = s == null ? '' : String(s);
  return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

function exportOutputsCsv() {
  const rs = collectOutputRecords();
  const lines = ['name,value,unit'];
  for (const r of rs) lines.push(`${csvEscape(r.name)},${r.value},${csvEscape(r.unit)}`);
  return lines.join('\n') + '\n';
}

function exportOutputsJson() {
  const rs = collectOutputRecords();
  return JSON.stringify(rs.map(r => ({ name: r.name, value: r.value, unit: r.unit })), null, 2) + '\n';
}

function exportOutputsText() {
  const rs = collectOutputRecords();
  return rs.map(r => `${r.name} = ${r.text}`).join('\n') + '\n';
}

function downloadOutputName(ext) {
  const hdr = document.getElementById('hdrFile');
  const base = (hdr && hdr.textContent.trim()) || 'outputs';
  return `${base.replace(/[^\w.-]/g, '_')}-outputs.${ext}`;
}

function downloadOutputs(content, mimeType, ext) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadOutputName(ext);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Get-or-create the panel-header export button. The button lives in a
// `.panel-hdr-right` wrapper alongside the chevron so the header's
// `justify-content: space-between` still pins them to the right edge.
function ensureOutputsExportBtn(panel) {
  let btn = document.getElementById('outExportBtn');
  if (btn) return btn;
  const hdr = panel.querySelector('.panel-hdr');
  const chevron = hdr.querySelector('.chevron');
  let right = hdr.querySelector('.panel-hdr-right');
  if (!right) {
    right = document.createElement('span');
    right.className = 'panel-hdr-right';
    hdr.insertBefore(right, chevron);
    right.appendChild(chevron);
  }
  btn = document.createElement('button');
  btn.id = 'outExportBtn';
  btn.type = 'button';
  btn.className = 'panel-act';
  btn.textContent = '⋯';
  btn.title = 'copy or download these outputs';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();    // don't toggle the panel
    const r = btn.getBoundingClientRect();
    openOutputsExportMenu(r.right, r.bottom, btn);
  });
  right.insertBefore(btn, chevron);
  return btn;
}

function openOutputsExportMenu(x, y, anchorBtn) {
  // The anchor button shows an icon (⋯), not the word "copy" — use a
  // local flash that restores whatever text the button started with.
  const flash = anchorBtn ? () => {
    const orig = anchorBtn.textContent;
    anchorBtn.textContent = '✓';
    setTimeout(() => { anchorBtn.textContent = orig; }, 900);
  } : () => {};
  const items = [
    { label: 'copy as CSV',    action: async () => { await copyToClipboard(exportOutputsCsv()); flash(); } },
    { label: 'copy as JSON',   action: async () => { await copyToClipboard(exportOutputsJson()); flash(); } },
    { label: 'copy as text',   action: async () => { await copyToClipboard(exportOutputsText()); flash(); } },
    { separator: true },
    { label: 'download .csv',  action: () => downloadOutputs(exportOutputsCsv(),  'text/csv',         'csv') },
    { label: 'download .json', action: () => downloadOutputs(exportOutputsJson(), 'application/json', 'json') },
  ];
  showMenu(items, x, y, { alignRight: true });
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
