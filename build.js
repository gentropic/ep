#!/usr/bin/env node
// build.js — concatenates src/ into a single index.html.
// Zero dependencies. Run `node build.js`.
//
// What it does:
//   1. Builds co-located vendor libraries (ext/numbat) into their dist artifacts.
//   2. Reads src/template.html and finds the markers:
//        /* MARKER:STYLE */    — replaced with contents of src/style.css
//        /* MARKER:SCRIPT */   — replaced with concatenated, stripped vendor
//                                and source JS
//        /* MARKER:STATE_START */ … /* MARKER:STATE_END */
//        — preserved verbatim (self-cloning contract that .html export depends on)
//   3. Concatenates vendor builds BEFORE ep's own src/js/*.js (so vendor
//      top-level declarations are in scope for ep's adapter modules).
//   4. Strips ES-module imports/exports from every file so the inlined script
//      runs as one flat-scope block.
//   5. Writes the result to index.html at the repo root.
//
// Conventions enforced on src/js/*.js (NOT vendor):
//   - Single-line imports only.
//   - Named exports only (no `export default`, no `export { x }` re-exports).
//   - No top-level name collisions across files (flat scope after build).
//   - INITIAL_STATE is treated as a free global; defined in the template.
//
// Set EP_SKIP_VENDOR_BUILD=1 to reuse existing vendor dist files (useful when
// iterating on ep without changing numbat-js).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT   = dirname(fileURLToPath(import.meta.url));
const SRC    = join(ROOT, 'src');
const JS_DIR = join(SRC, 'js');

// Derive a build-stamp version string from git. Falls back to 'unknown'
// when git isn't available. Format: `YYYY-MM-DD (sha[+dirty])` — chosen
// because hyper's "last updated N ago" display is the primary use case,
// so the commit date is more useful than a synthetic semver.
function epVersion() {
  function git(args) {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || `git ${args.join(' ')} failed`);
    return r.stdout.trim();
  }
  try {
    const sha   = git(['rev-parse', '--short', 'HEAD']);
    const date  = git(['log', '-1', '--format=%cd', '--date=short']);
    let dirty = '';
    try { if (git(['status', '--porcelain'])) dirty = '+dirty'; } catch {}
    return `${date} (${sha}${dirty})`;
  } catch {
    return 'unknown';
  }
}

// Co-located libraries: each entry has a build script and the resulting dist
// file. ep's build invokes the build script then concatenates the dist into
// the final index.html before its own sources.
// Each entry: dist = built artifact to inline; build = optional builder
// script (omitted means the dist is committed as a prebuilt artifact, e.g.
// CM6's bundle which requires npm + rollup that we don't want in ep's main
// build path).
const VENDORS = [
  { build: 'ext/numbat/build.js', dist: 'ext/numbat/dist/numbat.js' },
  { build: 'ext/qrcode/build.js', dist: 'ext/qrcode/dist/qrcode.js' },
  {                                dist: 'ext/cm6/cm6.min.js' },
  // Temporal polyfill — fires only when globalThis.Temporal is missing
  // (Safari + Node + older Chromium). 57 KB raw / 18 KB gzipped; the
  // guard means modern browsers skip the polyfill body at runtime.
  {                                dist: 'ext/temporal/temporal-polyfill.min.js',
                                   wrap: 'if (typeof globalThis.Temporal === "undefined") { /* CONTENT */ }' },
  // bearing.js — structural-geology stereonet library (SVG output).
  // Pure JS, zero deps, ~56 KB raw. IIFE-wrapped so its internal
  // helpers (e.g. `normalize`, which collides with numbat-js's own
  // `normalize`) don't leak into flat scope; only the `Stereonet`
  // entry point is hoisted out. render.js uses it to render
  // `'stereonet'` plot descriptors.
  {                                dist: 'ext/bearing/dist/bearing.js',
                                   wrap: 'const __bearing = (function(){ /* CONTENT */ return { Stereonet }; })();\nconst Stereonet = __bearing.Stereonet;',
                                   opaque: true },
];

// JS subset for the viewer artifact — chip eval + render only. No editor,
// no drawer, no persistence. render.js is reusable because it fires
// ep:params-changed via event (not a storage.js function call).
// Note: `guides.js` is intentionally absent — the viewer is what gets
// baked into program-form `.html` exports (per export.js), and the
// embedded user guides are dead weight in a shared calculator that
// only exposes the form view. They live in the main editor bundle only.
const VIEWER_JS_FILES = [
  'docs.js',
  'units.js',
  'blame.js',
  'evaluator.js',
  'state.js',
  'csv-assets.js',
  'menu.js',
  'render.js',
  'morsel.js',
  'viewer-main.js',
];

// Concat order for ep's own sources: dependencies before dependents.
// (Function declarations hoist within the concatenated flat scope, so this
// order is mostly cosmetic — but it makes reading the built file saner.)
const JS_FILES = [
  'viewport.js',
  'docs.js',
  'guides.js',
  'units.js',
  'blame.js',
  'evaluator.js',
  'state.js',
  'snapshot-retention.js',
  'idb.js',
  'storage.js',
  'csv-assets.js',
  'menu.js',
  'formatter.js',
  'render.js',
  'param-history.js',
  'attach-dialog.js',
  'dataset-viewer.js',
  'format-cmd.js',
  'morsel.js',
  'update-check.js',
  'share.js',
  'dialogs.js',
  'ctxmenu.js',
  'scenarios.js',
  'examples.js',
  'examples-panel.js',
  'snapshots.js',
  'drawer.js',
  'tutorial.js',
  'unit-picker.js',
  'accessory.js',
  'view.js',
  'export.js',
  'io.js',
  'settings.js',
  'gcu-announce.js',
  'pip.js',
  'main.js',
];

function topLevelNames(strippedSrc) {
  const names = new Set();
  const re = /^(?:async\s+)?(?:const|let|var|function|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;
  let m;
  while ((m = re.exec(strippedSrc)) !== null) names.add(m[1]);
  return names;
}

function stripModules(src, file, opts = {}) {
  const { allowExportBlock = false } = opts;

  if (/^\s*import\s+\{[^}]*$/m.test(src)) {
    throw new Error(`${file}: multi-line imports are not allowed (single-line only)`);
  }
  // Aliased imports (`import { X as Y }`) would leave call sites referencing
  // a name (Y) that doesn't exist in flat scope after strip. Forbid them.
  if (/^\s*import\s+\{[^}]*\bas\b[^}]*\}/m.test(src)) {
    throw new Error(`${file}: aliased imports (\`import { X as Y }\`) are not allowed — references to Y would dangle after strip; use the original name`);
  }
  if (/^\s*export\s+default\b/m.test(src)) {
    throw new Error(`${file}: \`export default\` is not allowed; use named exports`);
  }
  if (!allowExportBlock && /^\s*export\s*\{/m.test(src)) {
    throw new Error(`${file}: \`export { ... }\` re-export form is not allowed; inline the export keyword on declarations`);
  }

  let out = src.replace(/^\s*import\s[^\n]*\n?/gm, '');
  out = out.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$\n?/gm, '');  // strip vendor's public-API block
  out = out.replace(/^(\s*)export\s+/gm, '$1');                     // strip inline export prefix
  return out;
}

function buildVendors() {
  if (process.env.EP_SKIP_VENDOR_BUILD === '1') return;
  for (const v of VENDORS) {
    if (!v.build) continue;  // prebuilt vendor (e.g., CM6 — rebuild via cd ext/cm6 && npm i && node build.js)
    const buildPath = join(ROOT, v.build);
    const r = spawnSync(process.execPath, [buildPath], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`vendor build failed: ${v.build}`);
  }
}

// Build the viewer artifact — a slim purpose-built HTML that ep's .html
// export uses as its template. Includes only numbat-js (for evaluation)
// plus the chip-rendering subset of ep's source. No CM6, no drawer, no
// share, no autosave; the artifact is locked to form view.
function buildViewer() {
  const template = readFileSync(join(SRC, 'viewer-template.html'), 'utf8');
  const style    = readFileSync(join(SRC, 'style.css'), 'utf8').replace(/\s+$/, '');

  const numbatRaw = readFileSync(join(ROOT, 'ext/numbat/dist/numbat.js'), 'utf8');
  const numbat    = stripModules(numbatRaw, 'ext/numbat/dist/numbat.js', { allowExportBlock: true });

  // Stereonet support travels with the viewer too — a recipient who
  // opens a program that uses stereonet_planes / stereonet_lines
  // shouldn't get an "unknown identifier" or a blank canvas. Same
  // IIFE wrap as the editor build, to avoid bearing's internal
  // `normalize` colliding with numbat-js's.
  const bearingRaw = readFileSync(join(ROOT, 'ext/bearing/dist/bearing.js'), 'utf8');
  const bearing    = 'const __bearing = (function(){ '
                   + stripModules(bearingRaw, 'ext/bearing/dist/bearing.js', { allowExportBlock: true })
                   + ' return { Stereonet }; })();\nconst Stereonet = __bearing.Stereonet;';

  const srcStripped = VIEWER_JS_FILES.map(name => {
    const raw = readFileSync(join(JS_DIR, name), 'utf8');
    return { name, src: stripModules(raw, name) };
  });

  const parts = [];
  parts.push('// ─── (viewer vendor) numbat.js ' + '─'.repeat(40) + '\n' + numbat.replace(/\s+$/, ''));
  parts.push('// ─── (viewer vendor) bearing.js ' + '─'.repeat(39) + '\n' + bearing.replace(/\s+$/, ''));
  for (const { name, src } of srcStripped) {
    const sep = `// ─── (viewer) ${name} ` + '─'.repeat(Math.max(0, 50 - name.length)) + '\n';
    parts.push(sep + src.replace(/\s+$/, ''));
  }
  const js = parts.join('\n\n');

  let out = template;
  if (!out.includes('/* MARKER:STYLE */'))  throw new Error('viewer-template.html: missing /* MARKER:STYLE */');
  if (!out.includes('/* MARKER:SCRIPT */')) throw new Error('viewer-template.html: missing /* MARKER:SCRIPT */');
  out = out.replace('/* MARKER:STYLE */',  () => style);
  out = out.replace('/* MARKER:SCRIPT */', () => js);

  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  writeFileSync(join(ROOT, 'dist/viewer.html'), out);
  console.log(`built dist/viewer.html (${out.length.toLocaleString()} bytes)`);
  return out;
}

function build() {
  buildVendors();

  // Build the viewer artifact first; its bytes get embedded into ep's main
  // bundle as a string so .html export can substitute the STATE block
  // without needing a separate file at runtime.
  const viewerHtml = buildViewer();

  const template = readFileSync(join(SRC, 'template.html'), 'utf8');
  const style    = readFileSync(join(SRC, 'style.css'), 'utf8').replace(/\s+$/, '');

  // Strip vendor dist files (allow trailing export { ... } block).
  // A `wrap` template lets us guard the dist content (e.g., conditional
  // polyfill: only run when the native global is missing).
  const vendorStripped = VENDORS.map(v => {
    const raw = readFileSync(join(ROOT, v.dist), 'utf8');
    let src = stripModules(raw, v.dist, { allowExportBlock: true });
    // Use a callback so `$` sequences in src (e.g. ``${n}$`` inside the
    // temporal polyfill's template literals) aren't interpreted as
    // String.replace's replacement-string specials (`$&`, `$\``, etc.).
    if (v.wrap) src = v.wrap.replace('/* CONTENT */', () => src);
    return { name: v.dist, src };
  });

  // Strip ep's own sources (strict). gcu-announce.js gets its
  // `__EP_VERSION__` placeholder substituted with the git-derived
  // version stamp at build time.
  const epVer = epVersion();
  const srcStripped = JS_FILES.map(name => {
    const raw = readFileSync(join(JS_DIR, name), 'utf8');
    let src = stripModules(raw, name);
    if (name === 'gcu-announce.js') {
      src = src.replace("'__EP_VERSION__'", () => JSON.stringify(epVer));
    }
    return { name, src };
  });

  // Cross-file top-level-name collision check across everything.
  // Vendors marked `opaque: true` are IIFE-wrapped (or otherwise enforce
  // their own scope), so their internal declarations can't actually
  // collide — skip them. We still scan the `wrap` template itself to
  // catch collisions on names the wrap re-exports at top scope.
  const opaqueVendors = new Set(VENDORS.filter(v => v.opaque).map(v => v.dist));
  const declOwner = new Map();
  const collisions = [];
  for (const { name, src } of [...vendorStripped, ...srcStripped]) {
    if (opaqueVendors.has(name)) continue;
    for (const decl of topLevelNames(src)) {
      const prior = declOwner.get(decl);
      if (prior) collisions.push({ name: decl, files: [prior, name] });
      else declOwner.set(decl, name);
    }
  }
  // For opaque vendors, only their wrap template's top-level decls
  // matter — scan those separately (the wrap is the boundary between
  // hidden internals and exposed names).
  for (const v of VENDORS) {
    if (!v.opaque || !v.wrap) continue;
    const wrapTopLevel = v.wrap.replace('/* CONTENT */', '');
    for (const decl of topLevelNames(wrapTopLevel)) {
      const prior = declOwner.get(decl);
      if (prior) collisions.push({ name: decl, files: [prior, v.dist] });
      else declOwner.set(decl, v.dist);
    }
  }
  if (collisions.length) {
    const msg = collisions.map(c => `  ${c.name}: declared in both ${c.files[0]} and ${c.files[1]}`).join('\n');
    throw new Error(`top-level name collisions (flat-scope after build):\n${msg}`);
  }

  const parts = [];
  for (const { name, src } of vendorStripped) {
    const sep = `// ─── (vendor) ${name} ` + '─'.repeat(Math.max(0, 50 - name.length)) + '\n';
    parts.push(sep + src.replace(/\s+$/, ''));
  }
  for (const { name, src } of srcStripped) {
    const sep = `// ─── ${name} ` + '─'.repeat(Math.max(0, 60 - name.length)) + '\n';
    parts.push(sep + src.replace(/\s+$/, ''));
  }
  const js = parts.join('\n\n');

  let out = template;
  if (!out.includes('/* MARKER:STYLE */'))  throw new Error('template.html: missing /* MARKER:STYLE */');
  if (!out.includes('/* MARKER:SCRIPT */')) throw new Error('template.html: missing /* MARKER:SCRIPT */');
  if (!/\/\* MARKER:STATE_START \*\/[\s\S]*?\/\* MARKER:STATE_END \*\//.test(out)) {
    throw new Error('template.html: missing STATE_START/STATE_END marker pair');
  }

  out = out.replace('/* MARKER:STYLE */', () => style);
  // The viewer HTML is embedded as a const so .html export can do a STATE
  // marker substitution at runtime. Escape `</script>` so the HTML parser
  // doesn't close the outer <script> tag mid-string. JSON.stringify handles
  // the rest. (`<\/script>` is valid JSON+JS and evaluates back to
  // `</script>` at runtime.)
  if (out.includes('/* MARKER:VIEWER_HTML */')) {
    const embedded = JSON.stringify(viewerHtml).replace(/<\/(script|style)/gi, '<\\/$1');
    out = out.replace('/* MARKER:VIEWER_HTML */',
                      () => `const VIEWER_HTML = ${embedded};`);
  }
  out = out.replace('/* MARKER:SCRIPT */', () => js);

  if (!/\/\* MARKER:STATE_START \*\/[\s\S]*?\/\* MARKER:STATE_END \*\//.test(out)) {
    throw new Error('built index.html lost the STATE marker pair (self-cloning contract broken)');
  }

  writeFileSync(join(ROOT, 'index.html'), out);
  console.log(`built index.html (${out.length.toLocaleString()} bytes, ${vendorStripped.length} vendor + ${srcStripped.length} src modules)`);
}

build();
