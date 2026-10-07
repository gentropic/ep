// Pocket-mode (phone layout) smoke — SPEC-pocket M1 guard.
//
// Not part of `npm test` (no *.test.js suffix) because it needs a browser.
// Resolves Playwright from this repo's node_modules or, failing that, the
// sibling ../auditable checkout, so it runs on the dev box without adding
// a dependency here. Usage:
//
//   node test/pocket-smoke.mjs [screenshot.png]
//
// Opens index.html?mobile=1 in a Pixel-7-sized Chromium with fresh
// storage and checks the phone layout is up: data-pocket set, panels
// gone, outputs strip present, keyboard row = 8 operators + units,
// variable chips rendered, hint shown, and the spec's acceptance
// expression evaluates to 45 km/h in the gutter.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function loadPlaywright() {
  const candidates = [
    path.join(root, 'package.json'),
    path.join(root, '..', 'auditable', 'package.json'),
  ];
  for (const pkg of candidates) {
    if (!existsSync(pkg)) continue;
    try { return createRequire(pkg)('playwright'); } catch { /* next */ }
  }
  console.error('pocket-smoke: playwright not found (looked in ./node_modules and ../auditable/node_modules)');
  process.exit(2);
}

const { chromium, devices } = loadPlaywright();
const url = 'file:///' + path.join(root, 'index.html').replace(/\\/g, '/') + '?mobile=1';
const shot = process.argv[2] || null;

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(url);
  await page.waitForSelector('#body .cm-editor', { timeout: 15000 });
  await page.waitForTimeout(600);

  const s = await page.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0; };
    const toks = [...document.querySelectorAll('.accessory .tok')].filter(t => getComputedStyle(t).display !== 'none');
    const tokRects = toks.map(t => t.getBoundingClientRect());
    return {
      pocket: document.documentElement.getAttribute('data-pocket'),
      params: vis('#paramsPanel'),
      outputs: vis('#outputsPanel'),
      outChips: document.querySelectorAll('#outChips .chip').length,
      outputsFixed: getComputedStyle(document.getElementById('outputsPanel')).position,
      tokCount: toks.length,
      tokLabels: toks.map(t => t.textContent.trim()),
      tokMinH: Math.min(...tokRects.map(r => r.height)),
      tokOverflow: Math.max(...tokRects.map(r => r.right)) > innerWidth + 1,
      vchips: document.querySelectorAll('.accessory .vchip').length,
      hint: vis('.pocket-hint'),
      exportLabel: document.getElementById('exportBtn').textContent.trim(),
      pip: vis('#pipBtn'), form: vis('#formBtn'),
      file: document.getElementById('hdrFile').textContent.trim(),
    };
  });

  check(s.pocket === '1', 'data-pocket not set');
  check(!s.params, '@params panel still visible');
  check(s.outputs && s.outputsFixed === 'fixed', 'outputs strip not shown as a fixed bar');
  check(s.outChips === 2, `expected 2 output chips on the demo sheet, got ${s.outChips}`);
  check(s.tokCount === 9, `expected 9 keyboard-row tokens, got ${s.tokCount}: ${s.tokLabels.join(' ')}`);
  check(s.tokMinH >= 44, `keyboard-row tokens shorter than 44px (${s.tokMinH})`);
  check(!s.tokOverflow, 'keyboard row overflows the viewport');
  check(s.vchips >= 3, `expected variable chips, got ${s.vchips}`);
  check(s.hint, 'first-run hint not shown');
  check(s.exportLabel === 'Make form', `export button reads "${s.exportLabel}"`);
  check(!s.pip && !s.form, 'PiP / form buttons visible in pocket mode');
  check(s.file === 'weekend_hike', `demo sheet is "${s.file}"`);

  // Acceptance expression from SPEC-pocket §3.2.
  await page.evaluate(() => {
    const view = (typeof cmView !== 'undefined') ? cmView : EditorView.findFromDOM(document.querySelector('#body .cm-editor'));
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'speed = 3 km / 4 min -> km/h\n' } });
  });
  await page.waitForTimeout(500);
  const gutter = await page.evaluate(() => [...document.querySelectorAll('.ep-result-gutter .ep-gutter-result')].map(e => e.textContent.trim()).filter(Boolean));
  check(gutter.some(t => t.replace(/\s+/g, ' ') === '45 km/h'), `gutter shows ${JSON.stringify(gutter)}, expected "45 km/h"`);
  check(pageErrors.length === 0, 'page errors: ' + pageErrors.join(' | '));

  if (shot) {
    await page.reload();
    await page.waitForSelector('#body .cm-editor');
    await page.waitForTimeout(600);
    await page.screenshot({ path: shot });
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('pocket-smoke FAILED:\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
console.log('pocket-smoke ok');
