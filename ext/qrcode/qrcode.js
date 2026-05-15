// QR Code Model 2 encoder. ISO/IEC 18004:2015 byte mode, all 40 versions,
// ECC levels L/M/Q/H. Selects the smallest fitting version and best of the
// 8 mask patterns by the standard penalty rules.
//
// Algorithm structure follows Nayuki's reference
// (https://github.com/nayuki/QR-Code-generator, MIT). This is an
// independent implementation; the code here is original. MIT licensed.

// ─── Constants from ISO/IEC 18004 Annex E ──────────────────────────

// ECC level → format-info bit pattern. M=00, L=01, H=10, Q=11.
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const ECC_LEVEL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

// ECC codewords per block, indexed [eccIdx][version-1].
const ECC_CODEWORDS_PER_BLOCK = [
  // L
  [7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  // M
  [10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  // Q
  [13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  // H
  [17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
];

// Number of error-correction blocks, indexed [eccIdx][version-1].
const NUM_ERROR_CORRECTION_BLOCKS = [
  [1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25,25],
  [1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  [1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  [1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
];

// Alignment pattern center positions per version. Empty for version 1.
const ALIGNMENT_PATTERN_POSITIONS = [
  [], [6,18], [6,22], [6,26], [6,30], [6,34],
  [6,22,38], [6,24,42], [6,26,46], [6,28,50], [6,30,54], [6,32,58], [6,34,62],
  [6,26,46,66], [6,26,48,70], [6,26,50,74], [6,30,54,78], [6,30,56,82], [6,30,58,86], [6,34,62,90],
  [6,28,50,72,94], [6,26,50,74,98], [6,30,54,78,102], [6,28,54,80,106], [6,32,58,84,110],
  [6,30,58,86,114], [6,34,62,90,118],
  [6,26,50,74,98,122], [6,30,54,78,102,126], [6,26,52,78,104,130], [6,30,56,82,108,134],
  [6,34,60,86,112,138], [6,30,58,86,114,142], [6,34,62,90,118,146],
  [6,30,54,78,102,126,150], [6,24,50,76,102,128,154], [6,28,54,80,106,132,158],
  [6,32,58,84,110,136,162], [6,26,54,82,110,138,166], [6,30,58,86,114,142,170],
];

// ─── GF(256) arithmetic for Reed-Solomon ───────────────────────────
// Primitive polynomial 0x11D = x^8 + x^4 + x^3 + x^2 + 1.

export const GF_EXP = new Uint8Array(256);
export const GF_LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
})();

export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

// Generator polynomial of degree `degree`. Stored as the non-leading
// coefficients (the leading 1 is implicit). Length `degree`.
export function rsGenerator(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

// Reed-Solomon remainder of `data` divided by the generator polynomial.
// Returns `degree` ECC codewords.
export function rsCompute(data, generator) {
  const degree = generator.length;
  const result = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ result[0];
    for (let i = 1; i < degree; i++) result[i - 1] = result[i];
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i++) {
      result[i] ^= gfMul(generator[i], factor);
    }
  }
  return result;
}

// ─── Capacity ──────────────────────────────────────────────────────

function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version, eccIdx) {
  return Math.floor(numRawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[eccIdx][version - 1] * NUM_ERROR_CORRECTION_BLOCKS[eccIdx][version - 1];
}

function byteSegmentBits(numBytes, version) {
  const charCountBits = (version <= 9) ? 8 : 16;
  return 4 + charCountBits + 8 * numBytes;
}

function pickVersion(numBytes, eccIdx, minVer, maxVer) {
  for (let v = minVer; v <= maxVer; v++) {
    if (byteSegmentBits(numBytes, v) <= numDataCodewords(v, eccIdx) * 8) return v;
  }
  throw new Error(`QR: data too large (${numBytes} bytes won't fit at v${maxVer} ECC ${'LMQH'[eccIdx]})`);
}

// ─── Data codeword construction ────────────────────────────────────

function buildDataCodewords(bytes, version, eccIdx) {
  const dataCap = numDataCodewords(version, eccIdx) * 8;
  // Bit buffer
  const bits = [];
  const append = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };

  // Mode indicator: 0100 (byte mode)
  append(0b0100, 4);
  // Character count
  append(bytes.length, version <= 9 ? 8 : 16);
  // Data
  for (const b of bytes) append(b, 8);
  // Terminator (up to 4 zero bits)
  append(0, Math.min(4, dataCap - bits.length));
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad with alternating 0xEC, 0x11 (236, 17)
  let padByte = 0xEC;
  while (bits.length < dataCap) {
    append(padByte, 8);
    padByte ^= 0xEC ^ 0x11;
  }

  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}

// Add ECC, interleave per QR spec.
function interleaveCodewords(data, version, eccIdx) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[eccIdx][version - 1];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[eccIdx][version - 1];
  const rawCw = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - rawCw % numBlocks;
  const shortBlockDataLen = Math.floor(rawCw / numBlocks) - eccLen;

  const dataBlocks = [];
  const eccBlocks  = [];
  const gen = rsGenerator(eccLen);
  let off = 0;
  for (let i = 0; i < numBlocks; i++) {
    const blockLen = shortBlockDataLen + (i < numShortBlocks ? 0 : 1);
    const blockData = data.slice(off, off + blockLen);
    off += blockLen;
    dataBlocks.push(blockData);
    eccBlocks.push(rsCompute(blockData, gen));
  }

  const out = new Uint8Array(rawCw);
  let idx = 0;
  for (let col = 0; col < shortBlockDataLen + 1; col++) {
    for (let blk = 0; blk < numBlocks; blk++) {
      if (col < shortBlockDataLen || blk >= numShortBlocks) {
        out[idx++] = dataBlocks[blk][col];
      }
    }
  }
  for (let col = 0; col < eccLen; col++) {
    for (let blk = 0; blk < numBlocks; blk++) {
      out[idx++] = eccBlocks[blk][col];
    }
  }
  return out;
}

// ─── Matrix construction ───────────────────────────────────────────

function setM(modules, isFunc, x, y, dark) {
  modules[y][x] = dark ? 1 : 0;
  isFunc[y][x] = 1;
}

function drawFinder(modules, isFunc, x, y) {
  const size = modules.length;
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
      let dark;
      if (dx < 0 || dy < 0 || dx >= 7 || dy >= 7) dark = false;          // separator
      else if (dx === 0 || dx === 6 || dy === 0 || dy === 6) dark = true; // outer ring
      else if (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4) dark = true;     // inner 3x3
      else dark = false;                                                  // gap
      setM(modules, isFunc, xx, yy, dark);
    }
  }
}

function drawAlignment(modules, isFunc, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const ax = Math.abs(dx), ay = Math.abs(dy);
      const dist = Math.max(ax, ay);
      setM(modules, isFunc, cx + dx, cy + dy, dist !== 1);
    }
  }
}

function bchEncode(data, generator, dataBits) {
  // Compute (data << dataBits) mod generator, where generator has degree dataBits.
  let rem = data;
  for (let i = 0; i < dataBits; i++) rem = (rem << 1) ^ (((rem >>> (dataBits - 1)) & 1) * generator);
  return rem;
}

function formatBits(eccIdx, mask) {
  // 5 data bits = ECC level (2 bits) || mask (3 bits).
  const data = (ECC_FORMAT_BITS['LMQH'[eccIdx]] << 3) | mask;
  const rem = bchEncode(data, 0x537, 10);  // BCH(15,5) gen poly
  return ((data << 10) | rem) ^ 0x5412;    // XOR with format mask
}

function versionBitsFor(version) {
  const rem = bchEncode(version, 0x1F25, 12); // BCH(18,6)
  return (version << 12) | rem;
}

function drawFormatBits(modules, isFunc, eccIdx, mask) {
  const bits = formatBits(eccIdx, mask);
  const size = modules.length;
  // First copy: around the top-left finder.
  for (let i = 0; i <= 5; i++) setM(modules, isFunc, 8, i, (bits >> i) & 1);
  setM(modules, isFunc, 8, 7, (bits >> 6) & 1);
  setM(modules, isFunc, 8, 8, (bits >> 7) & 1);
  setM(modules, isFunc, 7, 8, (bits >> 8) & 1);
  for (let i = 9; i < 15; i++) setM(modules, isFunc, 14 - i, 8, (bits >> i) & 1);
  // Second copy: along the bottom and right of the timing rows.
  for (let i = 0; i < 8; i++)  setM(modules, isFunc, size - 1 - i, 8, (bits >> i) & 1);
  for (let i = 8; i < 15; i++) setM(modules, isFunc, 8, size - 15 + i, (bits >> i) & 1);
  setM(modules, isFunc, 8, size - 8, 1); // always-dark module
}

function drawVersionBits(modules, isFunc, version) {
  if (version < 7) return;
  const bits = versionBitsFor(version);
  const size = modules.length;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setM(modules, isFunc, a, b, bit);
    setM(modules, isFunc, b, a, bit);
  }
}

function drawFunctionPatterns(modules, isFunc, version) {
  const size = modules.length;
  // Timing patterns
  for (let i = 0; i < size; i++) {
    setM(modules, isFunc, 6, i, i % 2 === 0);
    setM(modules, isFunc, i, 6, i % 2 === 0);
  }
  // Finder patterns (and their separators)
  drawFinder(modules, isFunc, 0, 0);
  drawFinder(modules, isFunc, size - 7, 0);
  drawFinder(modules, isFunc, 0, size - 7);
  // Alignment patterns
  const align = ALIGNMENT_PATTERN_POSITIONS[version - 1];
  const n = align.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Skip the three positions that would overlap with finder patterns
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      drawAlignment(modules, isFunc, align[j], align[i]);
    }
  }
  // Reserve format-info cells (overwritten after mask selection)
  drawFormatBits(modules, isFunc, 0, 0);
  // Reserve version-info cells (versions 7+)
  if (version >= 7) drawVersionBits(modules, isFunc, version);
}

function drawCodewords(modules, isFunc, data) {
  const size = modules.length;
  let i = 0;
  // Iterate columns from right to left, two at a time, zigzag direction.
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunc[y][x] && i < data.length * 8) {
          modules[y][x] = (data[i >> 3] >> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
}

function maskFn(m, x, y) {
  switch (m) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
  return false;
}

function applyMask(modules, isFunc, m) {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunc[y][x] && maskFn(m, x, y)) modules[y][x] ^= 1;
    }
  }
}

function getPenalty(modules) {
  const size = modules.length;
  let penalty = 0;

  // Rule 1: 5+ consecutive same-color modules in a row / column.
  for (let y = 0; y < size; y++) {
    let color = -1, run = 0;
    for (let x = 0; x < size; x++) {
      if (modules[y][x] !== color) { color = modules[y][x]; run = 1; }
      else { run++; if (run === 5) penalty += 3; else if (run > 5) penalty += 1; }
    }
  }
  for (let x = 0; x < size; x++) {
    let color = -1, run = 0;
    for (let y = 0; y < size; y++) {
      if (modules[y][x] !== color) { color = modules[y][x]; run = 1; }
      else { run++; if (run === 5) penalty += 3; else if (run > 5) penalty += 1; }
    }
  }

  // Rule 2: 2x2 same-color blocks.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (modules[y][x+1] === c && modules[y+1][x] === c && modules[y+1][x+1] === c) penalty += 3;
    }
  }

  // Rule 3: finder-like patterns 1011101 surrounded by 4 light modules.
  const pat1 = [1,0,1,1,1,0,1,0,0,0,0];
  const pat2 = [0,0,0,0,1,0,1,1,1,0,1];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x <= size - 11; x++) {
      let m1 = true, m2 = true;
      for (let k = 0; k < 11; k++) {
        if (modules[y][x+k] !== pat1[k]) m1 = false;
        if (modules[y][x+k] !== pat2[k]) m2 = false;
        if (!m1 && !m2) break;
      }
      if (m1) penalty += 40;
      if (m2) penalty += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y <= size - 11; y++) {
      let m1 = true, m2 = true;
      for (let k = 0; k < 11; k++) {
        if (modules[y+k][x] !== pat1[k]) m1 = false;
        if (modules[y+k][x] !== pat2[k]) m2 = false;
        if (!m1 && !m2) break;
      }
      if (m1) penalty += 40;
      if (m2) penalty += 40;
    }
  }

  // Rule 4: deviation of dark-module ratio from 50 %.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
  const total = size * size;
  const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
  penalty += k * 10;

  return penalty;
}

// ─── Public API ────────────────────────────────────────────────────

export function encodeQR(text, opts = {}) {
  const eccLevel = opts.ecc || 'M';
  const eccIdx = ECC_LEVEL_INDEX[eccLevel];
  if (eccIdx === undefined) throw new Error(`QR: bad ECC level "${eccLevel}"`);

  const bytes = (typeof text === 'string') ? new TextEncoder().encode(text) : text;
  const minVer = opts.minVersion || 1;
  const maxVer = opts.maxVersion || 40;
  const version = pickVersion(bytes.length, eccIdx, minVer, maxVer);

  const dataCw = buildDataCodewords(bytes, version, eccIdx);
  const allCw  = interleaveCodewords(dataCw, version, eccIdx);

  const size = 17 + 4 * version;
  const modules = [];
  const isFunc  = [];
  for (let y = 0; y < size; y++) { modules.push(new Uint8Array(size)); isFunc.push(new Uint8Array(size)); }

  drawFunctionPatterns(modules, isFunc, version);
  drawCodewords(modules, isFunc, allCw);

  // Try all 8 masks; pick the one with the lowest penalty.
  let bestMask = 0, bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(modules, isFunc, m);
    drawFormatBits(modules, isFunc, eccIdx, m);
    const p = getPenalty(modules);
    if (p < bestPenalty) { bestPenalty = p; bestMask = m; }
    applyMask(modules, isFunc, m); // undo (XOR is involutive)
  }

  applyMask(modules, isFunc, bestMask);
  drawFormatBits(modules, isFunc, eccIdx, bestMask);

  return { version, size, ecc: eccLevel, mask: bestMask, modules };
}

// Render a QR struct to an inline SVG string. Uses a single <path> for all
// dark modules; scales cleanly at any zoom level.
export function qrToSvg(qr, opts = {}) {
  const margin     = opts.margin ?? 2;
  const moduleSize = opts.moduleSize || 4;
  const fg = opts.foreground || 'currentColor';
  const bg = opts.background || 'none';
  const size = qr.size;
  const total = (size + margin * 2) * moduleSize;

  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.modules[y][x]) {
        path += `M${(x + margin) * moduleSize},${(y + margin) * moduleSize}h${moduleSize}v${moduleSize}h${-moduleSize}z`;
      }
    }
  }

  const bgRect = bg === 'none' ? '' : `<rect width="${total}" height="${total}" fill="${bg}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}" shape-rendering="crispEdges">${bgRect}<path d="${path}" fill="${fg}"/></svg>`;
}
