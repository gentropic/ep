// Accessory bar: tap-to-insert tokens (operators, units, functions) into the
// most recently focused input. Reads state._lastFocused, set by render.js.

import { state } from './state.js';

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

const accEl = document.getElementById('accessory');
TOKENS.forEach(([cls, lbl, ins]) => {
  const b = document.createElement('button');
  b.className = 'tok ' + cls;
  b.textContent = lbl;
  b.addEventListener('mousedown', e => e.preventDefault());
  b.addEventListener('click', () => {
    const t = state._lastFocused;
    if (!t) return;
    // CM6 EditorView: dispatch a transaction at the current selection.
    if (t.dispatch && t.state && t.state.selection) {
      const sel = t.state.selection.main;
      t.dispatch({
        changes:   { from: sel.from, to: sel.to, insert: ins },
        selection: { anchor: sel.from + ins.length },
      });
      t.focus();
      return;
    }
    // Plain input / textarea fallback (chip inputs).
    const start = t.selectionStart, end = t.selectionEnd;
    const v = t.value;
    t.value = v.slice(0, start) + ins + v.slice(end);
    t.setSelectionRange(start + ins.length, start + ins.length);
    t.focus();
    t.dispatchEvent(new Event('input', {bubbles: true}));
  });
  accEl.append(b);
});
