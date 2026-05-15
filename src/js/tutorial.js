// Interactive 4-step walkthrough that runs on absolute-first launch and is
// available as a replay from the drawer's About section. Dims the page with
// a cutout around the current target (box-shadow trick — simpler than SVG
// masks and well-supported everywhere ep runs).
//
// Steps:
//   1. tap a chip                  — auto-advances on chip input event
//   2. watch the outputs update    — auto-advances after 2s
//   3. the chips are just source   — manual "next →"
//   4. programs travel             — manual "next →" (final step)

const TUTORIAL_DONE_KEY = 'ep:tutorialDone';

export function isTutorialDone() {
  try { return localStorage.getItem(TUTORIAL_DONE_KEY) === 'true'; }
  catch { return true; }  // storage unavailable → don't pester
}

function markDone() {
  try { localStorage.setItem(TUTORIAL_DONE_KEY, 'true'); } catch {}
}

export function resetTutorial() {
  try { localStorage.removeItem(TUTORIAL_DONE_KEY); } catch {}
}

const STEPS = [
  {
    title: 'tap a chip',
    body: 'These are your @params — the inputs to the calculation. Try editing one to see what happens.',
    target: () => document.querySelector('#chips .chip'),
    auto: (advance) => {
      const el = document.getElementById('chips');
      const handler = () => advance();
      el.addEventListener('input', handler, {once: true});
      return () => el.removeEventListener('input', handler);
    },
  },
  {
    title: 'outputs update live',
    body: 'Down here in @outputs, the values just changed. ep recomputes the whole DAG on every keystroke.',
    target: () => document.getElementById('outputsPanel'),
    delay: 2200,
  },
  {
    title: 'the chips are just source',
    body: 'The chips above mirror the @params { } block in the source below — edit either side and both update.',
    target: () => document.getElementById('paramsPanel'),
    manual: true,
  },
  {
    title: 'programs travel',
    body: 'Use export to bundle as a .ep file, a standalone .html, or a shareable link / QR.',
    target: () => document.getElementById('exportBtn'),
    manual: true,
  },
];

let overlay = null;
let cleanup = null;

function buildOverlay() {
  const wrap = document.createElement('div');
  wrap.className = 'tut-overlay';
  const cutout = document.createElement('div');
  cutout.className = 'tut-cutout';
  const tooltip = document.createElement('div');
  tooltip.className = 'tut-tooltip';
  wrap.append(cutout, tooltip);
  document.body.appendChild(wrap);
  return {wrap, cutout, tooltip};
}

function tearDown() {
  if (cleanup) { cleanup(); cleanup = null; }
  if (overlay) { overlay.wrap.remove(); overlay = null; }
}

function placeTooltip(rect) {
  // Wait a tick so offsetHeight is measured with the new content.
  const tt = overlay.tooltip;
  const margin = 12;
  const maxW = Math.min(300, window.innerWidth - margin * 2);
  tt.style.width = maxW + 'px';

  const ttH = tt.offsetHeight;
  const placeBelow = rect.bottom + ttH + margin + 8 < window.innerHeight - margin;
  const top = placeBelow
    ? rect.bottom + margin
    : Math.max(margin, rect.top - ttH - margin);
  const left = Math.max(margin, Math.min(window.innerWidth - maxW - margin, rect.left));
  tt.style.top = top + 'px';
  tt.style.left = left + 'px';
}

function showStep(i, advance, finish) {
  const step = STEPS[i];
  const target = step.target();
  if (!target) { finish(); return; }

  const rect = target.getBoundingClientRect();
  const pad = 6;
  Object.assign(overlay.cutout.style, {
    left:   (rect.left - pad) + 'px',
    top:    (rect.top - pad) + 'px',
    width:  (rect.width + pad * 2) + 'px',
    height: (rect.height + pad * 2) + 'px',
  });

  const stepNum = i + 1;
  overlay.tooltip.innerHTML = `
    <div class="tut-tooltip-hdr">
      <span class="tut-tooltip-title">${step.title}</span>
      <span class="tut-tooltip-step">${stepNum} / ${STEPS.length}</span>
    </div>
    <div class="tut-tooltip-body">${step.body}</div>
    <div class="tut-tooltip-actions">
      <a class="tut-skip">skip tutorial</a>
      ${step.manual ? '<a class="tut-next">next →</a>' : '<span class="tut-hint">continues automatically</span>'}
    </div>
  `;
  placeTooltip(rect);

  overlay.tooltip.querySelector('.tut-skip').addEventListener('click', finish);
  const nextLink = overlay.tooltip.querySelector('.tut-next');
  if (nextLink) nextLink.addEventListener('click', advance);

  if (cleanup) { cleanup(); cleanup = null; }
  if (step.auto)  cleanup = step.auto(advance);
  else if (step.delay) {
    const t = setTimeout(advance, step.delay);
    cleanup = () => clearTimeout(t);
  }
}

export function startTutorial() {
  tearDown();
  overlay = buildOverlay();
  let i = 0;
  const finish = () => { tearDown(); markDone(); };
  const advance = () => {
    i++;
    if (i >= STEPS.length) finish();
    else                   showStep(i, advance, finish);
  };
  showStep(0, advance, finish);
}
