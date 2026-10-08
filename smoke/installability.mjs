// Static installability check — the criteria a TWA / PWA install depends on
// (SPEC-pocket §3.7), checked against the files on disk so a broken
// manifest is caught before a deploy, without Lighthouse. Usage:
//
//   npm run check:install

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };

// manifest
let manifest = null;
try { manifest = JSON.parse(readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8')); }
catch (e) { problems.push('manifest.webmanifest does not parse: ' + e.message); }
if (manifest) {
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons', 'theme_color', 'background_color']) {
    need(k in manifest, `manifest: missing "${k}"`);
  }
  need(['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display), `manifest: display "${manifest.display}" is not installable`);
  need(String(manifest.start_url || '').startsWith(String(manifest.scope || './')) || manifest.start_url === './', 'manifest: start_url is outside scope');
  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const pngOf = (size, purpose) => icons.find(i => i.type === 'image/png' && i.sizes === `${size}x${size}` && (i.purpose || 'any') === purpose);
  need(pngOf(192, 'any'), 'manifest: no 192x192 PNG icon (purpose any)');
  need(pngOf(512, 'any'), 'manifest: no 512x512 PNG icon (purpose any)');
  need(pngOf(512, 'maskable'), 'manifest: no 512x512 maskable PNG icon');
  // every icon exists; PNGs really are the declared size (IHDR)
  for (const i of icons) {
    const file = path.join(root, String(i.src || '').replace(/^\.\//, ''));
    if (!existsSync(file)) { problems.push(`manifest: icon ${i.src} not found`); continue; }
    if (i.type === 'image/png') {
      const buf = readFileSync(file);
      const ok = buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG';
      need(ok, `icon ${i.src} is not a PNG`);
      if (ok) {
        const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
        need(`${w}x${h}` === i.sizes, `icon ${i.src} is ${w}x${h}, manifest says ${i.sizes}`);
      }
    }
  }
}

// service worker shell list: every entry must be a real file
const sw = readFileSync(path.join(root, 'sw.js'), 'utf8');
const shell = [...sw.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]).filter(Boolean);
for (const f of shell) need(existsSync(path.join(root, f)), `sw.js SHELL lists ./${f} but it does not exist`);
need(/skipWaiting\(\)/.test(sw) && /clients\.claim\(\)/.test(sw), 'sw.js does not take control promptly (skipWaiting / clients.claim)');

// the page wires the manifest and registers the worker
const html = readFileSync(path.join(root, 'src', 'template.html'), 'utf8');
need(/<link rel="manifest" href="\.\/manifest\.webmanifest">/.test(html), 'template.html: no <link rel="manifest">');
need(/<meta name="theme-color"/.test(html), 'template.html: no theme-color meta');
const mainjs = readFileSync(path.join(root, 'src', 'js', 'main.js'), 'utf8');
need(/serviceWorker\.register\('\.\/sw\.js'\)/.test(mainjs), 'main.js: service worker is not registered from ./sw.js');
need(existsSync(path.join(root, '.nojekyll')), '.nojekyll missing — GitHub Pages would mangle files');

// the built artifact has a clean version stamp (release discipline)
if (existsSync(path.join(root, 'index.html'))) {
  const built = readFileSync(path.join(root, 'index.html'), 'utf8');
  const m = built.match(/([0-9a-f]{7,})(\+dirty)?/);
  if (m && m[2]) problems.push(`index.html version stamp is ${m[1]}+dirty — rebuild from a clean tree before deploying`);
}

if (problems.length) {
  console.error('installability: FAILED\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
console.log('installability: ok');
