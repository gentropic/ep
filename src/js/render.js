// All DOM rendering: input chips, body rows, output chips, results.

import { state, evaluateAll } from './state.js';
import { fmt } from './units.js';

const chipsEl      = document.getElementById('chips');
const outChipsEl   = document.getElementById('outChips');
const bodyEl       = document.getElementById('body');
const paramMetaEl  = document.getElementById('paramMeta');
const outMetaEl    = document.getElementById('outMeta');
// outputsPanel is owned by view.js; query it inline where needed to avoid a
// duplicate top-level binding (flat scope after build).

export function renderChips() {
  chipsEl.innerHTML = '';
  state.params.forEach(p => {
    const name = p.name;  // capture for closure stability across rebuilds
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
      // Find this param by name (state.params may be rebuilt by evaluateAll)
      const cur = state.params.find(x => x.name === name);
      if (!cur) return;
      const bodyIdx = cur.bodyIdx;
      // Write through to the body source line, preserving prefix up to and including `=`
      const line = state.body[bodyIdx];
      const eq = line.src.indexOf('=');
      line.src = (eq >= 0 ? line.src.slice(0, eq + 1) + ' ' : `  ${name} = `) + inp.value;
      evaluateAll();
      // Update the corresponding body row's input value without a full re-render
      const bodyRow = bodyEl.querySelector(`[data-body-idx="${bodyIdx}"] .row-src`);
      if (bodyRow) bodyRow.value = state.body[bodyIdx].src;
      renderResults();
    });
    inp.addEventListener('focus', () => { state._lastFocused = inp; });
    const res = document.createElement('div');
    res.className = 'chip-res';
    chip.append(lbl, inp, res);
    chipsEl.append(chip);
    p._resEl = res;
  });
  paramMetaEl.textContent = `· ${state.params.length} input${state.params.length===1?'':'s'}`;
}

export function renderBody() {
  bodyEl.innerHTML = '';
  // Lines that belong to a collapsed block (after its open, up to and including its close) are skipped
  const collapsedRanges = state._blocks
    .filter(b => state.ui.collapsedBlocks.includes(b.open))
    .map(b => ({open: b.open, close: b.close}));
  const isHidden = i => collapsedRanges.some(r => i > r.open && i <= r.close);

  state.body.forEach((r, i) => {
    if (isHidden(i)) return;
    makeRow(r, i);
  });
}

// Find the block this row opens, if any
function blockAt(i) {
  return state._blocks.find(b => b.open === i) || null;
}

function makeRow(r, i) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.bodyIdx = String(i);
  if (r.kind === 'comment')  row.classList.add('comment');
  if (r.kind === 'outputs')  row.classList.add('directive');
  if (r.inParams)            row.classList.add('in-block');

  // Block-opening rows get a toggle chevron and a summary chip
  const block = blockAt(i);
  if (block) {
    const collapsed = state.ui.collapsedBlocks.includes(i);
    if (collapsed) row.classList.add('collapsed');
    row.classList.add('in-block');  // visual cue on the opening line too
    const toggle = document.createElement('span');
    toggle.className = 'row-toggle';
    toggle.textContent = '▾';
    toggle.title = collapsed ? 'expand block' : 'collapse block';
    toggle.addEventListener('mousedown', e => e.preventDefault());  // don't steal focus from active inputs
    toggle.addEventListener('click', () => {
      const cur = state.ui.collapsedBlocks;
      const idx = cur.indexOf(i);
      if (idx >= 0) cur.splice(idx, 1); else cur.push(i);
      renderBody();
    });
    row.appendChild(toggle);
  }

  const src = document.createElement('input');
  src.className = 'row-src';
  src.value = r.src;
  src.spellcheck = false;
  src.autocapitalize = 'off';
  src.autocomplete = 'off';
  src.placeholder = i === state.body.length - 1 ? '…' : '';
  src.addEventListener('input', () => {
    r.src = src.value;
    evaluateAll();
    renderBody();
    renderChips();
    renderResults();
    const newRow = bodyEl.querySelector(`[data-body-idx="${i}"]`);
    if (newRow) {
      const inp = newRow.querySelector('.row-src');
      inp.focus();
      inp.setSelectionRange(src.selectionStart, src.selectionEnd);
    }
  });
  src.addEventListener('focus', () => { state._lastFocused = src; });
  src.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // If this is a collapsed block opener, insert after the closing brace so the new row is visible
      let insertAt = i + 1;
      const blk = blockAt(i);
      if (blk && state.ui.collapsedBlocks.includes(i)) {
        insertAt = blk.close + 1;
      }
      state.body.splice(insertAt, 0, {src: ''});
      evaluateAll();
      renderBody();
      renderChips();
      renderResults();
      const nextRow = bodyEl.querySelector(`[data-body-idx="${insertAt}"]`);
      if (nextRow) nextRow.querySelector('.row-src').focus();
    } else if (e.key === 'Backspace' && src.value === '' && state.body.length > 1) {
      e.preventDefault();
      state.body.splice(i, 1);
      evaluateAll();
      renderBody();
      renderChips();
      renderResults();
      // Focus the nearest previous visible row
      let prevIdx = i - 1;
      let prev = null;
      while (prevIdx >= 0) {
        prev = bodyEl.querySelector(`[data-body-idx="${prevIdx}"]`);
        if (prev) break;
        prevIdx--;
      }
      if (prev) {
        const inp = prev.querySelector('.row-src');
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    }
  });
  const res = document.createElement('div');
  res.className = 'row-res';
  row.append(src, res);

  // For collapsed block-opening rows, append a small summary
  if (block && state.ui.collapsedBlocks.includes(i)) {
    const summary = document.createElement('span');
    summary.className = 'row-summary';
    summary.innerHTML = `<span class="meta">…</span> ${block.count} input${block.count===1?'':'s'} <span class="meta">}</span>`;
    row.append(summary);
  }

  bodyEl.append(row);
  r._resEl = res;
  r._rowEl = row;
}

export function renderResults() {
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
  for (const r of state.body) {
    if (!r._resEl) continue;
    r._rowEl.classList.toggle('comment',   r.kind === 'comment');
    r._rowEl.classList.toggle('directive', r.kind === 'outputs');
    let isOutput = false;
    if (r.kind === 'binding' && state.outputs.includes(r.name)) isOutput = true;
    if (r.error) {
      r._resEl.className = 'row-res error';
      r._resEl.textContent = r.error;
    } else if (r.result) {
      const [n, u] = fmt(r.result);
      const cls = 'row-res' + (r.kind === 'binding' ? (isOutput ? ' output' : ' binding') : '');
      r._resEl.className = cls;
      r._resEl.innerHTML = n + (u ? ` <span class="u">${u}</span>` : '');
    } else {
      r._resEl.className = 'row-res';
      r._resEl.textContent = '';
    }
  }
  renderOutputs();
}

export function renderOutputs() {
  outChipsEl.innerHTML = '';
  const panel = document.getElementById('outputsPanel');
  const names = state.outputs;
  outMetaEl.textContent = `· ${names.length} result${names.length===1?'':'s'}`;
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
      // Strip any thousands separators from the copyable text; keep unit
      copyText = n.replace(/,/g, '') + (u ? ' ' + u.replace(/²/g,'^2').replace(/³/g,'^3') : '');
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
            // Fallback for non-secure contexts
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
        } catch (err) {
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
