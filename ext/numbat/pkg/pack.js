#!/usr/bin/env node
// Packs @gcu/numbat into a .gcupkg distributable for auditable.
//
// Layout produced — matches EXTENSION_SPEC.md §6.1:
//
//   _gcu_numbat@0.1.0.gcupkg              (ZIP)
//   ├── .gcupkg-meta.json                  (generated; integrity + sizes)
//   ├── package.json
//   ├── index.js                           (the numbat engine — ../dist/numbat.js)
//   ├── adder.js                           (the @gcu/numbat/adder Python-shape bridge)
//   ├── LICENSE
//   ├── README.md
//   ├── docs/                              (§6.3 — wired into the Works docs surface)
//   │   └── index.md
//   └── examples/                          (§6.4 — Help → Open example…; they run)
//       ├── manifest.json
//       └── *.txt
//
// index.js is the engine (the package's "." entry); adder.js is the "./adder"
// secondary entry. Auditable loads the package main (caching the engine in
// _importCache["@gcu/numbat"]) before the adder secondary reads it.
//
// Integrity: SHA-256 over sorted ["adder.js", "index.js"] with NUL framing
// (§6.1's recommended cover = index.js + every secondary entry in `exports`).
//
// The engine dist is produced by numbat's own build (`node build.js` rebuilds
// ext/numbat/dist/numbat.js as part of ep's top-level build). Run that first;
// this packer reads the built artifact, it does not build it.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = __dirname;
const distEngine = path.join(pkgRoot, '..', 'dist', 'numbat.js');

const read = (rel) => fs.readFileSync(path.join(pkgRoot, rel));
const maybeRead = (rel) => {
  const p = path.join(pkgRoot, rel);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
};

if (!fs.existsSync(distEngine)) {
  console.error(`pack: engine dist missing at ${path.relative(pkgRoot, distEngine)} — run \`node build.js\` at the ep root first.`);
  process.exit(1);
}

const indexJs    = fs.readFileSync(distEngine);          // engine ("." entry)
const adderJs    = read('adder.js');                     // bridge ("./adder")
const packageJson = read('package.json');
const license    = maybeRead('LICENSE') || Buffer.from('MIT — see https://gentropic.org/ep\n', 'utf8');
const readme     = maybeRead('README.md') || Buffer.from('# @gcu/numbat\n', 'utf8');

const files = {
  'package.json': packageJson,
  'index.js':     indexJs,
  'adder.js':     adderJs,
  'LICENSE':      license,
  'README.md':    readme,
};

// Bundle docs/ (§6.3 — Works docs surface) and examples/ (§6.4 — Help → Open
// example…) verbatim. Forward-slashed archive paths; flat one-level walk.
function addDir(rel) {
  const dir = path.join(pkgRoot, rel);
  if (!fs.existsSync(dir)) return [];
  const added = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) { files[`${rel}/${name}`] = fs.readFileSync(p); added.push(name); }
  }
  return added;
}
const docFiles = addDir('docs');
const exampleFiles = addDir('examples').filter((n) => n.endsWith('.txt'));

// Integrity: SHA-256 over sorted [adder.js, index.js] with NUL framing.
const covers = ['adder.js', 'index.js'];
function sriHashOver(coverNames) {
  const h = crypto.createHash('sha256');
  for (const name of coverNames) {
    h.update(Buffer.from(name, 'utf8'));
    h.update(Buffer.from([0]));
    h.update(files[name]);
    h.update(Buffer.from([0]));
  }
  return 'sha256-' + h.digest('base64');
}
const integrity = sriHashOver(covers);

// Build .gcupkg-meta.json last so the integrity covers everything else.
const pkgObj = JSON.parse(packageJson.toString('utf8'));
const meta = {
  gcupkgVersion: 1,
  name:        pkgObj.name,
  version:     pkgObj.version,
  description: pkgObj.description,
  spdx:        pkgObj.license,
  homepage:    pkgObj.homepage,
  requires:    { auditable: '>=0.0.0' },
  contributes: ['exports'],
  bundles:     { docs: docFiles.length > 0, examples: exampleFiles.length, vendorLicenses: 1 },
  size:        { 'index.js': indexJs.length, 'adder.js': adderJs.length },
  integrity,
  integrityCovers: covers,
};
files['.gcupkg-meta.json'] = Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8');

// ── Minimal ZIP writer (deflate-raw / store) ─────────────────────────
// Subset of PKZIP APPNOTE.TXT: fixed file list, deflate-or-store, no
// encryption, no multi-disk — the shape auditable's stdlib unzipArchive
// consumes. Mirrors ext/example-quip/pack.js.
function makeZip(fileMap) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const t = _dosTime(new Date());
  for (const [name, content] of Object.entries(fileMap)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = _crc32(content);
    const compressed = zlib.deflateRawSync(content);
    const useDeflate = compressed.length < content.length;
    const data = useDeflate ? compressed : content;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(t.time, 10);
    local.writeUInt16LE(t.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    localParts.push(local, data);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(t.time, 12);
    cd.writeUInt16LE(t.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);
    centralParts.push(cd);

    offset += local.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(fileMap).length, 8);
  eocd.writeUInt16LE(Object.keys(fileMap).length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
}

function _dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const _crcTable = (() => {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[n] = c >>> 0;
  }
  return tbl;
})();

function _crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (_crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

const archiveName = `${pkgObj.name.replace(/[@/]/g, '_')}@${pkgObj.version}.gcupkg`;
const outDir = path.join(pkgRoot, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const archivePath = path.join(outDir, archiveName);
fs.writeFileSync(archivePath, makeZip(files));
console.log(`Packed dist/${archiveName} (${(fs.statSync(archivePath).size / 1024).toFixed(1)} KB)`);
console.log(`Integrity: ${integrity}`);
console.log(`Files: ${Object.keys(files).join(', ')}`);
