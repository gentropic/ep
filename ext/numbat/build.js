#!/usr/bin/env node
// numbat-js build: concatenate src/*.js into dist/numbat.js as a single
// ES module exposing the public API. Zero dependencies.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

// Concat order: dependencies before dependents.
const SRC_FILES = [
  'dimensions.js',
  'quantity.js',
  'units.js',
  'format.js',
  'prelude.js',
  'api.js',
];

const PUBLIC_API = [
  'Numbat', 'Quantity', 'UnitRegistry', 'DimRegistry',
  // Dimension primitives — useful for hosts that want to manipulate dim vectors
  // directly without going through Quantity.
  'dimEq', 'dimMul', 'dimDiv', 'dimPow', 'dimInv', 'dimEmpty', 'dimFormat',
  // Number formatter — exposed so hosts can format raw numbers consistently.
  'formatNumber',
];

function topLevelNames(strippedSrc) {
  const names = new Set();
  const re = /^(?:async\s+)?(?:const|let|var|function|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/gm;
  let m;
  while ((m = re.exec(strippedSrc)) !== null) names.add(m[1]);
  return names;
}

function stripModule(src, file) {
  if (/^\s*import\s+\{[^}]*$/m.test(src)) {
    throw new Error(`${file}: multi-line imports are not allowed`);
  }
  if (/^\s*export\s+default\b/m.test(src)) {
    throw new Error(`${file}: \`export default\` is not allowed; use named exports`);
  }
  let out = src.replace(/^\s*import\s[^\n]*\n?/gm, '');
  out = out.replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$\n?/gm, '');
  out = out.replace(/^(\s*)export\s+/gm, '$1');
  return out;
}

function build() {
  const stripped = SRC_FILES.map(file => {
    const raw = readFileSync(join(SRC, file), 'utf8');
    return { name: file, src: stripModule(raw, file) };
  });

  // Cross-file top-level name collision check (flat scope after concat).
  const declOwner = new Map();
  const collisions = [];
  for (const { name, src } of stripped) {
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

  // Sanity: all PUBLIC_API names must actually be declared somewhere.
  for (const name of PUBLIC_API) {
    if (!declOwner.has(name)) {
      throw new Error(`PUBLIC_API references '${name}' but no source file declares it`);
    }
  }

  const parts = stripped.map(({ name, src }) => {
    const sep = `// ─── ${name} ` + '─'.repeat(Math.max(0, 50 - name.length)) + '\n';
    return sep + src.replace(/\s+$/, '');
  });

  const header =
    '// numbat-js v0.1 — built artifact, do not edit by hand.\n' +
    '// Source: ext/numbat/src/. Rebuild with `node ext/numbat/build.js`.\n\n';
  const exportLine = `\nexport { ${PUBLIC_API.join(', ')} };\n`;

  mkdirSync(DIST, { recursive: true });
  const out = header + parts.join('\n\n') + exportLine;
  writeFileSync(join(DIST, 'numbat.js'), out);
  console.log(`built ext/numbat/dist/numbat.js (${out.length.toLocaleString()} bytes, ${SRC_FILES.length} modules)`);
}

build();
