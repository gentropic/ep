// Accessory bar: tap-to-insert tokens (operators, units, functions) into the
// most recently focused input. Reads state._lastFocused, set by render.js.

import { state } from './state.js';
import { openUnitPicker } from './unit-picker.js';

const TOKENS = [
  ['op', '+', '+'], ['op', '−', '-'], ['op', '×', '*'], ['op', '÷', '/'],
  ['op', '^', '^'], ['op', '(', '('], ['op', ')', ')'], ['op', '=', '='],
  ['op', '→', ' -> '], ['op', 'to', ' to '],
  ['fn', 'π', 'pi'], ['fn', '√', 'sqrt('],
  ['fn', 'sin', 'sin('], ['fn', 'cos', 'cos('],
  ['fn', 'ln', 'ln('], ['fn', 'log', 'log('],
  ['unit', 'm', ' m'], ['unit', 'cm', ' cm'], ['unit', 'km', ' km'],
  ['unit', 'kg', ' kg'], ['unit', 't', ' t'], ['unit', 'Mt', ' Mt'],
  ['unit', 'g/t', ' g/t'], ['unit', 'ppm', ' ppm'], ['unit', 'ozt', ' ozt'],
];

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

const accEl = document.getElementById('accessory');
TOKENS.forEach(([cls, lbl, ins]) => {
  const b = document.createElement('button');
  b.className = 'tok ' + cls;
  b.textContent = lbl;
  // Out of the Tab cycle (SPEC §4.6): the palette is a pointer/touch
  // convenience — a keyboard user types the operator directly, and
  // would not want ~26 token buttons between the outputs and the drawer.
  b.tabIndex = -1;
  b.addEventListener('mousedown', e => e.preventDefault());
  b.addEventListener('click', () => insertAtCursor(ins));
  accEl.append(b);
});

// "More units" button at the tail of the bar — opens the unit picker
// sheet (categorised grid of every resolvable unit name).
const moreUnitsBtn = document.createElement('button');
moreUnitsBtn.className = 'tok unit tok-more-units';
moreUnitsBtn.textContent = '⋯ units';
moreUnitsBtn.title = 'pick a unit';
moreUnitsBtn.tabIndex = -1;   // pointer chrome — out of the Tab cycle (§4.6)
moreUnitsBtn.addEventListener('mousedown', e => e.preventDefault());
moreUnitsBtn.addEventListener('click', () => openUnitPicker());
accEl.append(moreUnitsBtn);
