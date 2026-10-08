// Shell-door smoke on the lead-acid bench (SPEC-pocket §4.6): ep runs
// shell-style on the desktop with ../lead-acid/bench.js mocking the
// native layer below the vendored shim. Checks exports go through
// publishStream (+ share by uri) and that intake opens shared text and an
// exported form. Usage: npm run smoke:shell

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const benchPath = path.resolve(root, '..', 'lead-acid', 'bench.js');
if (!existsSync(benchPath)) { console.error('shell-smoke: ../lead-acid/bench.js not found'); process.exit(2); }
function loadPlaywright() {
  for (const pkg of [path.join(root, 'package.json'), path.join(root, '..', 'auditable', 'package.json')]) {
    try { return createRequire(pkg)('playwright'); } catch { /* next */ }
  }
  console.error('shell-smoke: playwright not found'); process.exit(2);
}
const { chromium, devices } = loadPlaywright();
// The shim calls `/native/...` relative to the page origin and the bench
// mocks those by pathname, so the page must live on an http(s) origin, not
// file://. Serve the checkout from a fake origin via Playwright routing —
// no server process needed.
const ORIGIN = 'http://ep.test';
const url = ORIGIN + '/index.html?mobile=1&bench';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const serveFromDisk = async (route) => {
  const p = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\//, '');
  const file = path.join(root, p || 'index.html');
  if (!existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
  return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: readFileSync(file) });
};
const failures = [];
const check = (c, m) => { if (!c) failures.push(m); };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.route(ORIGIN + '/**', serveFromDisk);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('ep:tutorialDone', 'true'); } catch {} });
  await page.addInitScript({ content: readFileSync(benchPath, 'utf8') });
  await page.goto(url);
  await page.waitForSelector('#body .cm-editor', { timeout: 15000 });
  await page.waitForTimeout(800);

  check(await page.evaluate(() => shell.present === true), 'shell.present is not true under the bench');

  // Export → publishStream into Downloads; Share → publish + share by uri.
  await page.click('#exportBtn');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => getComputedStyle(document.getElementById('shareFileBtn')).display !== 'none'), 'Share button hidden inside the shell');
  await page.click('#dlHtmlBtn');
  await page.waitForFunction(() => window.__bench.published.length >= 1, null, { timeout: 10000 });
  const pub = await page.evaluate(() => window.__bench.published.map(p => ({ name: p.name, mime: p.mime, bytes: p.bytes.length, hasState: new TextDecoder().decode(p.bytes).includes('MARKER:STATE_START') })));
  check(pub[0] && pub[0].name === 'weekend_hike.html' && pub[0].mime === 'text/html' && pub[0].hasState && pub[0].bytes > 10000, `published form looks wrong: ${JSON.stringify(pub)}`);
  await page.click('#shareFileBtn');
  await page.waitForFunction(() => window.__bench.shared.length >= 1, null, { timeout: 10000 });
  const sh = await page.evaluate(() => window.__bench.shared.map(s => ({ name: s.name, uri: s.uri, bytes: s.bytes ? s.bytes.length : 0 })));
  check(sh[0] && sh[0].name === 'weekend_hike.html' && sh[0].uri && !sh[0].bytes, `share should go by uri, got ${JSON.stringify(sh)}`);
  await page.keyboard.press('Escape');

  // Intake: shared text becomes a sheet; a shared exported form opens as its program.
  await page.evaluate(() => window.__bench.intake([{ kind: 'text', text: 'speed = 3 km / 4 min -> km/h\n' }]));
  await page.waitForFunction(() => cmView.state.doc.toString().startsWith('speed = 3 km / 4 min'), null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => cmView.state.doc.toString().startsWith('speed = 3 km / 4 min')), 'shared text did not open as a sheet');
  const formHtml = await page.evaluate(() => new TextDecoder().decode(window.__bench.published[0].bytes));
  await page.evaluate((html) => {
    const bytes = new TextEncoder().encode(html);
    window.__bench.files['f1'] = bytes;
    window.__bench.intake([{ kind: 'file', name: 'weekend_hike.html', mime: 'text/html', token: 'f1', size: bytes.length }]);
  }, formHtml);
  await page.waitForFunction(() => cmView.state.doc.toString().includes('distance = 14 km'), null, { timeout: 8000 }).catch(() => {});
  check(await page.evaluate(() => cmView.state.doc.toString().includes('distance = 14 km') && document.getElementById('hdrFile').textContent.includes('weekend_hike')), 'shared exported form did not open as its program');
  // @sensor over the shell stream: the bench serves a slowly rotating
  // rotation vector, so a heading binding must go live and change.
  await page.evaluate(() => { cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: '@sensor(heading)\naz = 0 deg\n@output\nback = az + 180 deg\n' } }); });
  await page.waitForFunction(() => state._live.has('az'), null, { timeout: 8000 }).catch(() => {});
  check(await page.evaluate(() => state._live.has('az')), 'heading binding never went live on the bench stream');
  const h1 = await page.evaluate(() => state._live.get('az') && state._live.get('az').value);
  await page.waitForTimeout(1500);
  const h2 = await page.evaluate(() => state._live.get('az') && state._live.get('az').value);
  check(typeof h1 === 'number' && typeof h2 === 'number' && h1 !== h2, `heading did not move: ${h1} → ${h2}`);
  const liveCells = await page.evaluate(() => document.querySelectorAll('.ep-result-gutter .ep-gutter-result.live').length);
  check(liveCells >= 1, 'no live marker on the sensor row');
  const outText = await page.evaluate(() => document.querySelector('#outChips .chip-out-val') && document.querySelector('#outChips .chip-out-val').textContent.trim());
  check(outText && !/^180\b/.test(outText), `output did not follow the live heading: ${outText}`);
  // A live stereonet must redraw as the reading moves (the plot widget
  // used to be reused because its fingerprint ignored the data).
  await page.evaluate(() => { cmView.dispatch({ changes: { from: 0, to: cmView.state.doc.length, insert: '@sensor(heading)\naz = 0 deg\n@sensor(dip)\ndip = 30 deg\nstereonet_planes(az, dip, "live")\n' } }); });
  await page.waitForFunction(() => state._live.has('az') && !!document.querySelector('.cm-ep-plot-block svg, .cm-ep-plot-block canvas'), null, { timeout: 8000 }).catch(() => {});
  const frame = () => page.evaluate(() => { const el = document.querySelector('.cm-ep-plot-block svg, .cm-ep-plot-block canvas'); return el ? (el.tagName === 'CANVAS' ? el.toDataURL().length + ':' + el.toDataURL().slice(-40) : el.innerHTML.length + ':' + el.innerHTML.slice(-80)) : null; });
  const f1 = await frame();
  await page.waitForTimeout(1500);
  const f2 = await frame();
  check(f1 && f2 && f1 !== f2, `live stereonet did not redraw (${f1 && f1.slice(0, 20)} → ${f2 && f2.slice(0, 20)})`);
  check(errors.length === 0, 'page errors: ' + errors.join(' | '));
} finally {
  await browser.close();
}
if (failures.length) { console.error('shell-smoke FAILED:\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('shell-smoke ok');
