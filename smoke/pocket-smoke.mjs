// Pocket-mode (phone layout) smoke — SPEC-pocket M1 guard.
//
// Lives outside test/ so `node --test` doesn't pick it up — it needs a
// browser. Resolves Playwright from this repo's node_modules or, failing
// that, the sibling ../auditable checkout, so it runs on the dev box
// without adding a dependency here. Usage:
//
//   npm run smoke            (or: node smoke/pocket-smoke.mjs [screenshot.png])
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
      inchips: document.querySelectorAll('#body .cm-ep-inchip').length,
      decoLines: document.querySelectorAll('#body .cm-ep-deco-line').length,
    };
  });
  check(s.inchips === 3, `expected 3 inline input chips, got ${s.inchips}`);
  check(s.decoLines === 5, `expected 5 folded decorator lines, got ${s.decoLines}`);

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

  // Bottom sheets (SPEC-pocket §3.1): drawer and export dialog open from
  // the bottom edge, full width; Escape closes the export dialog.
  await page.click('#menuBtn');
  await page.waitForTimeout(350);
  const dr = await page.evaluate(() => { const r = document.getElementById('drawer').getBoundingClientRect(); return { top: r.top, w: r.width, bottom: r.bottom, vw: innerWidth, vh: innerHeight }; });
  check(dr.w >= dr.vw - 1 && dr.top > dr.vh * 0.05 && Math.abs(dr.bottom - dr.vh) < 2, `drawer is not a bottom sheet: ${JSON.stringify(dr)}`);
  await page.click('#drawerCloseBtn');
  await page.waitForTimeout(300);
  await page.click('#exportBtn');
  await page.waitForTimeout(250);
  const dl = await page.evaluate(() => { const r = document.querySelector('#scrim .dialog').getBoundingClientRect(); return { w: r.width, bottom: r.bottom, vw: innerWidth, vh: innerHeight, title: document.getElementById('exportDlgTitle').textContent, preview: getComputedStyle(document.getElementById('exportSrc')).display }; });
  check(dl.w >= dl.vw - 1 && Math.abs(dl.bottom - dl.vh) < 2, `export dialog is not a bottom sheet: ${JSON.stringify(dl)}`);
  check(dl.title === 'Make this a form', `export sheet title is "${dl.title}"`);
  check(dl.preview === 'none', 'source preview still shown in the export sheet');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check(!(await page.evaluate(() => document.getElementById('scrim').classList.contains('on'))), 'Escape did not close the export dialog');

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
