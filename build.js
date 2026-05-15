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
];

// JS subset for the viewer artifact — chip eval + render only. No editor,
// no drawer, no persistence. render.js is reusable because it fires
// ep:params-changed via event (not a storage.js function call).
const VIEWER_JS_FILES = [
  'units.js',
  'evaluator.js',
  'state.js',
  'menu.js',
  'render.js',
  'viewer-main.js',
];

// Concat order for ep's own sources: dependencies before dependents.
// (Function declarations hoist within the concatenated flat scope, so this
// order is mostly cosmetic — but it makes reading the built file saner.)
const JS_FILES = [
  'units.js',
  'evaluator.js',
  'state.js',
  'storage.js',
  'menu.js',
  'render.js',
  'share.js',
  'dialogs.js',
  'ctxmenu.js',
  'scenarios.js',
  'examples.js',
  'drawer.js',
  'tutorial.js',
  'accessory.js',
  'view.js',
  'export.js',
  'io.js',
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

  const srcStripped = VIEWER_JS_FILES.map(name => {
    const raw = readFileSync(join(JS_DIR, name), 'utf8');
    return { name, src: stripModules(raw, name) };
  });

  const parts = [];
  parts.push('// ─── (viewer vendor) numbat.js ' + '─'.repeat(40) + '\n' + numbat.replace(/\s+$/, ''));
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
  const vendorStripped = VENDORS.map(v => {
    const raw = readFileSync(join(ROOT, v.dist), 'utf8');
    return { name: v.dist, src: stripModules(raw, v.dist, { allowExportBlock: true }) };
  });

  // Strip ep's own sources (strict).
  const srcStripped = JS_FILES.map(name => {
    const raw = readFileSync(join(JS_DIR, name), 'utf8');
    return { name, src: stripModules(raw, name) };
  });

  // Cross-file top-level-name collision check across everything.
  const declOwner = new Map();
  const collisions = [];
  for (const { name, src } of [...vendorStripped, ...srcStripped]) {
    for (const decl of topLevelNames(src)) {
      const prior = declOwner.get(decl);
      if (prior) collisions.push({ name: decl, files: [prior, name] });
      else declOwner.set(decl, name);
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
