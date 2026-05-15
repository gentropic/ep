#!/usr/bin/env node
// Trivial vendor build: copies qrcode.js to dist/qrcode.js so ep's build can
// pick it up via the standard VENDORS pattern. No transformation needed; the
// source is already plain ES2022 with named exports.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));

mkdirSync(join(ROOT, 'dist'), { recursive: true });

const src = readFileSync(join(ROOT, 'qrcode.js'), 'utf8');
writeFileSync(join(ROOT, 'dist', 'qrcode.js'), src);

console.log(`built ext/qrcode/dist/qrcode.js (${src.length.toLocaleString()} bytes)`);
