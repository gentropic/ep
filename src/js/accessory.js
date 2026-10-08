// Accessory bar: tap-to-insert tokens (operators, units, functions) into the
// most recently focused input. Reads state._lastFocused, set by render.js.
//
// In pocket mode (SPEC-pocket §3.2) the same element is the KEYBOARD ROW:
// CSS shows only the eight tokens tagged `.pk` plus the units button, at
// thumb size with no horizontal scroll, and a second row of variable
// chips (every name the sheet defines) appears beneath them. Desktop keeps
// the full scrolling palette.

import { state } from './state.js';
import { openUnitPicker } from './unit-picker.js';
import { smartInsertion, TOKEN_KIND } from './insert.js';

const TOKENS = [
  ['op', '+', '+'], ['op', '−', '-'], ['op', '×', '*'], ['op', '÷', '/'],
  ['op', '^', '^'], ['op', '(', '('], ['op', ')', ')'], ['op', '=', '='],
  ['op', '→', ' -> '], ['op', 'to', ' to '], ['op', '|>', ' |> '],
  ['fn', 'π', 'pi'], ['fn', '√', 'sqrt('],
  ['fn', 'sin', 'sin('], ['fn', 'cos', 'cos('],
  ['fn', 'ln', 'ln('], ['fn', 'log', 'log('],
  ['unit', 'm', ' m'], ['unit', 'cm', ' cm'], ['unit', 'km', ' km'],
  ['unit', 'kg', ' kg'], ['unit', 't', ' t'], ['unit', 'Mt', ' Mt'],
  ['unit', 'g/t', ' g/t'], ['unit', 'ppm', ' ppm'], ['unit', 'ozt', ' ozt'],
];

// The pocket keyboard row: operators, grouping, `=` (a new binding on a
// phone shouldn't need the symbols page), the conversion arrow. The system
// keyboard supplies digits and letters; `^` and functions are typed or
// completed; units come from the picker.
const POCKET_KEEP = new Set(['+', '−', '×', '÷', '=', '(', ')', '→']);

// Insert text at the cursor of state._lastFocused (CM6 or plain input).
// Used by the accessory bar and by the unit-picker sheet; exported so any
// future popup-style affordance can route through the same code path.
export function insertAtCursor(text) {
  const t = state._lastFocused;
  if (!t) return false;
  if (t.dispatch && t.state && t.state.selection) {
    const sel = t.state.selection.main;
    t.dispatch({
      changes:   { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    t.focus();
    return true;
  }
  // Plain input / textarea fallback (chip inputs).
  if (typeof t.selectionStart !== 'number') return false;
  const start = t.selectionStart, end = t.selectionEnd;
  const v = t.value;
  t.value = v.slice(0, start) + text + v.slice(end);
  t.setSelectionRange(start + text.length, start + text.length);
  t.focus();
  t.dispatchEvent(new Event('input', {bubbles: true}));
  return true;
}

// Insert a token with spacing rules (insert.js smartInsertion): a unit
// after a number gets its space, an operator trims the spaces before it
// and pads itself, `->` likewise. Works on the current line of a CM6 view
// or a plain input; falls back to insertAtCursor when there's no target.
export function insertSmart(token, kind) {
  const t = state._lastFocused;
  if (!t) return false;
  if (t.dispatch && t.state && t.state.selection) {
    const sel = t.state.selection.main;
    const line = t.state.doc.lineAt(sel.from);
    const before = t.state.doc.sliceString(line.from, sel.from);
    const after  = t.state.doc.sliceString(sel.to, line.to);
    const { trim, text, trimAfter } = smartInsertion(before, after, token, kind);
    t.dispatch({
      changes:   { from: sel.from - trim, to: sel.to + (trimAfter || 0), insert: text },
      selection: { anchor: sel.from - trim + text.length },
    });
    t.focus();
    return true;
  }
  if (typeof t.selectionStart !== 'number') return false;
  const start = t.selectionStart, end = t.selectionEnd;
  const v = t.value;
  const { trim, text, trimAfter } = smartInsertion(v.slice(0, start), v.slice(end), token, kind);
  t.value = v.slice(0, start - trim) + text + v.slice(end + (trimAfter || 0));
  const caret = start - trim + text.length;
  t.setSelectionRange(caret, caret);
  t.focus();
  t.dispatchEvent(new Event('input', {bubbles: true}));
  return true;
}

// Keep focus (and the soft keyboard) on the editor when a palette button
// is tapped. mousedown covers mouse; pointerdown covers touch, where
// Android Chrome would otherwise move focus to the button and dismiss
// the keyboard before the click lands.
function keepEditorFocus(el) {
  el.addEventListener('mousedown',   e => e.preventDefault());
  el.addEventListener('pointerdown', e => e.preventDefault());
}

const accEl = document.getElementById('accessory');
TOKENS.forEach(([cls, lbl, ins]) => {
  const b = document.createElement('button');
  b.className = 'tok ' + cls + (POCKET_KEEP.has(lbl) ? ' pk' : '');
  b.textContent = lbl;
  b.dataset.tok = lbl;
  // Out of the Tab cycle (SPEC §4.6): the palette is a pointer/touch
  // convenience — a keyboard user types the operator directly, and
  // would not want ~26 token buttons between the outputs and the drawer.
  b.tabIndex = -1;
  keepEditorFocus(b);
  // Operators / arrows / parens go through the spacing rules; units and
  // functions too (their table text carried a leading space or trailing
  // paren for the raw path — the rules supply those now).
  const kind = TOKEN_KIND[lbl]
    || (cls === 'unit' ? 'unit'
      : cls === 'fn' ? (/\($/.test(ins) ? 'fn' : 'name')   // `pi` behaves like a name
      : 'raw');
  const token = kind === 'raw' ? ins : ins.trim();
  b.addEventListener('click', () => insertSmart(token, kind));
  accEl.append(b);
});

// "More units" button at the tail of the bar — opens the unit picker
// sheet (categorised grid of every resolvable unit name).
const moreUnitsBtn = document.createElement('button');
moreUnitsBtn.className = 'tok unit tok-more-units';
moreUnitsBtn.textContent = 'units';
moreUnitsBtn.title = 'pick a unit';
moreUnitsBtn.tabIndex = -1;   // pointer chrome — out of the Tab cycle (§4.6)
keepEditorFocus(moreUnitsBtn);
moreUnitsBtn.addEventListener('click', () => openUnitPicker());
accEl.append(moreUnitsBtn);

// ── Variable chips (pocket keyboard row, second line) ─────────────
// One chip per name the sheet defines, inputs first. Tap inserts the
// name at the cursor. Rebuilt from state.body after every evaluate
// (render.js calls renderVarChips from renderResults); cheap because the
// row is only re-rendered when the set of names changes. Hidden on
// desktop by CSS.
const varsRow = document.createElement('div');
varsRow.className = 'pocket-vars';
varsRow.hidden = true;
accEl.append(varsRow);
let _varsKey = '';

export function renderVarChips() {
  const seen = new Set();
  const inputs = [], others = [];
  for (const r of state.body) {
    if (!r || !r.name || seen.has(r.name)) continue;
    seen.add(r.name);
    (r.inParams ? inputs : others).push(r.name);
  }
  const all = [...inputs, ...others];
  const live = typeof hasLiveSensors === 'function' && hasLiveSensors();
  const key = all.join('\u0001') + '\u0002' + inputs.length + (live ? '\u0003live' : '');
  if (key === _varsKey) return;
  _varsKey = key;
  varsRow.innerHTML = '';
  // "measure" leads the row while the sheet has live sensor readings:
  // one tap logs every reading into its `<name>_log` list.
  if (live) {
    const m = document.createElement('button');
    m.className = 'vchip measure';
    m.textContent = '● measure';
    m.title = 'append the current readings to their _log lists';
    m.tabIndex = -1;
    keepEditorFocus(m);
    m.addEventListener('click', () => { if (typeof captureReadings === 'function') captureReadings(); });
    varsRow.append(m);
  }
  for (const name of all) {
    const b = document.createElement('button');
    b.className = 'vchip' + (inputs.includes(name) ? ' in' : '');
    b.textContent = name;
    b.tabIndex = -1;
    keepEditorFocus(b);
    b.addEventListener('click', () => insertSmart(name, 'name'));
    varsRow.append(b);
  }
  varsRow.hidden = all.length === 0 && !live;
}

// Publish the bar's rendered height as --ep-acc-h so the fixed-position
// stack above it (sig-help strip, pocket outputs strip) and the .app's
// bottom padding can follow it exactly instead of assuming 44px. The row
// is taller in pocket mode and when variable chips are showing.
if (typeof ResizeObserver !== 'undefined') {
  const publish = () => {
    document.documentElement.style.setProperty('--ep-acc-h', accEl.offsetHeight + 'px');
  };
  new ResizeObserver(publish).observe(accEl);
  publish();
}
