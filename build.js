#!/usr/bin/env node
// build.js — concatenates src/ into a single index.html.
// Zero dependencies. Run `node build.js`.
//
// What it does:
//   1. Reads src/template.html and finds the three markers:
//        /* MARKER:STYLE */    — replaced with contents of src/style.css
//        /* MARKER:SCRIPT */   — replaced with concatenated, stripped src/js/*.js
//        /* MARKER:STATE_START */ … /* MARKER:STATE_END */
//        — preserved verbatim from the template (this is the self-cloning
//          contract that .html export depends on).
//   2. Strips `import ... from '...'` lines and the `export` keyword prefix
//      from each JS file before concatenation. This collapses ES modules to
//      a single flat-scope script. Multi-line imports, `export default`, and
//      `export { ... }` re-exports are rejected — author named exports only.
//   3. Writes the result to index.html at the repo root.
//
// Conventions enforced on src/js/*.js:
//   - All imports are single-line.
//   - Only named exports (no `export default`, no `export { x } from '...'`).
//   - No top-level name collisions across files (flat scope after build).
//   - INITIAL_STATE is treated as a free global; defined in the template.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT   = dirname(fileURLToPath(import.meta.url));
const SRC    = join(ROOT, 'src');
const JS_DIR = join(SRC, 'js');

// Concat order: dependencies before dependents.
const JS_FILES = [
  'units.js',
  'parser.js',
  'evaluator.js',
  'state.js',
  'render.js',
  'accessory.js',
  'view.js',
  'export.js',
  'io.js',
  'main.js',
];

// Collect top-level `const|let|var|function|class` names from a stripped file.
// Matches only declarations that start at column 0 (no indentation), which is
// the project convention. Conservative — won't catch destructuring or expressions
// like `const {a, b} = ...`, but covers the common case that bites at build time.
function topLevelNames(strippedSrc) {
  const names = new Set();
  const re = /^(?:async\s+)?(?:const|let|var|function|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;
  let m;
  while ((m = re.exec(strippedSrc)) !== null) names.add(m[1]);
  return names;
}

function stripModules(src, file) {
  // Reject multi-line imports (the `{` on the import line without a closing `}` on the same line).
  const multilineImport = /^\s*import\s+\{[^}]*$/m;
  if (multilineImport.test(src)) {
    throw new Error(`${file}: multi-line imports are not allowed (single-line only)`);
  }
  // Reject `export default`.
  if (/^\s*export\s+default\b/m.test(src)) {
    throw new Error(`${file}: \`export default\` is not allowed; use named exports`);
  }
  // Reject `export { x };` re-export form.
  if (/^\s*export\s*\{/m.test(src)) {
    throw new Error(`${file}: \`export { ... }\` re-export form is not allowed; inline the export keyword on declarations`);
  }
  // Strip whole-line `import ... from '...';` statements.
  let out = src.replace(/^\s*import\s[^\n]*\n?/gm, '');
  // Strip leading `export ` keyword prefix on declarations.
  out = out.replace(/^(\s*)export\s+/gm, '$1');
  return out;
}

function build() {
  const template = readFileSync(join(SRC, 'template.html'), 'utf8');
  const style    = readFileSync(join(SRC, 'style.css'), 'utf8').replace(/\s+$/, '');

  // First pass: strip imports/exports per file.
  const stripped = JS_FILES.map(name => {
    const raw = readFileSync(join(JS_DIR, name), 'utf8');
    return {name, src: stripModules(raw, name)};
  });

  // Cross-file check: no two files may declare the same top-level name.
  // After concat everything shares one flat scope, so duplicates throw at runtime.
  const declOwner = new Map();   // name -> first file that declared it
  const collisions = [];         // [{name, files: [a, b]}]
  for (const {name, src} of stripped) {
    for (const decl of topLevelNames(src)) {
      const prior = declOwner.get(decl);
      if (prior) collisions.push({name: decl, files: [prior, name]});
      else declOwner.set(decl, name);
    }
  }
  if (collisions.length) {
    const msg = collisions.map(c => `  ${c.name}: declared in both ${c.files[0]} and ${c.files[1]}`).join('\n');
    throw new Error(`top-level name collisions (flat-scope after build):\n${msg}`);
  }

  const parts = stripped.map(({name, src}) => {
    const sep = `// ─── ${name} ` + '─'.repeat(Math.max(0, 60 - name.length)) + '\n';
    return sep + src.replace(/\s+$/, '');
  });
  const js = parts.join('\n\n');

  let out = template;
  if (!out.includes('/* MARKER:STYLE */'))  throw new Error('template.html: missing /* MARKER:STYLE */');
  if (!out.includes('/* MARKER:SCRIPT */')) throw new Error('template.html: missing /* MARKER:SCRIPT */');
  if (!/\/\* MARKER:STATE_START \*\/[\s\S]*?\/\* MARKER:STATE_END \*\//.test(out)) {
    throw new Error('template.html: missing STATE_START/STATE_END marker pair');
  }

  out = out.replace('/* MARKER:STYLE */', () => style);
  out = out.replace('/* MARKER:SCRIPT */', () => js);

  // Sanity: built output must still contain the STATE markers for self-cloning export.
  if (!/\/\* MARKER:STATE_START \*\/[\s\S]*?\/\* MARKER:STATE_END \*\//.test(out)) {
    throw new Error('built index.html lost the STATE marker pair (self-cloning contract broken)');
  }

  writeFileSync(join(ROOT, 'index.html'), out);
  console.log(`built index.html (${out.length.toLocaleString()} bytes, ${JS_FILES.length} modules)`);
}

build();
