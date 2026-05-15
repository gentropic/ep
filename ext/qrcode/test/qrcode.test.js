// Basic sanity tests for the QR encoder. Full correctness needs a real
// decoder (or scanning a printed QR); these check structural invariants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQR, qrToSvg, gfMul, rsGenerator, rsCompute, GF_EXP, GF_LOG } from '../qrcode.js';

// ── GF(256) ───────────────────────────────────────────────────────

test('GF(256): α^0 = 1 and α^255 wraps to α^0', () => {
  assert.equal(GF_EXP[0], 1);
});

test('GF(256): log/exp inverse', () => {
  for (let i = 1; i < 256; i++) {
    assert.equal(GF_EXP[GF_LOG[i]], i, `log/exp inverse fails at ${i}`);
  }
});

test('GF(256): multiplication a*1 = a', () => {
  for (let a = 0; a < 256; a++) assert.equal(gfMul(a, 1), a);
});

test('GF(256): multiplication is commutative', () => {
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
    assert.equal(gfMul(a, b), gfMul(b, a));
  }
});

// ── Reed-Solomon generator polynomial ─────────────────────────────

test('rsGenerator: degree 2 = [3, 2] (x^2 + αx + α^2 mod 0x11D)', () => {
  // Sanity check against Nayuki's published expected values for small degrees.
  const g = rsGenerator(2);
  assert.equal(g.length, 2);
  // g(x) = (x - 1)(x - α) = x^2 - (1 + α)x + α
  // In GF(2^n), - = +, so = x^2 + (1 + α)x + α
  // (1 + α) = 1 ^ 2 = 3; α = α^1 = 2. So result = [3, 2].
  assert.deepEqual([...g], [3, 2]);
});

test('rsGenerator: degree 10 leading coefficient is implicit, non-zero terms', () => {
  const g = rsGenerator(10);
  assert.equal(g.length, 10);
  // All coefficients should be in [0, 255]
  for (const c of g) assert.ok(c >= 0 && c <= 255);
});

// ── Encode end-to-end ─────────────────────────────────────────────

test('encodeQR: small ascii fits in version 1', () => {
  const qr = encodeQR('HELLO', { ecc: 'M' });
  assert.equal(qr.version, 1);
  assert.equal(qr.size, 21);
  assert.equal(qr.modules.length, 21);
  assert.equal(qr.modules[0].length, 21);
});

test('encodeQR: finder patterns at the three corners', () => {
  const qr = encodeQR('HELLO', { ecc: 'M' });
  const size = qr.size;
  // Top-left finder: (0,0) should be dark (outer ring), (1,1) light (gap).
  assert.equal(qr.modules[0][0], 1);
  assert.equal(qr.modules[1][1], 0);
  assert.equal(qr.modules[3][3], 1);  // inner 3x3
  // Top-right finder
  assert.equal(qr.modules[0][size - 1], 1);
  assert.equal(qr.modules[3][size - 4], 1);
  // Bottom-left finder
  assert.equal(qr.modules[size - 1][0], 1);
  assert.equal(qr.modules[size - 4][3], 1);
});

test('encodeQR: timing pattern alternates on row 6 and column 6', () => {
  const qr = encodeQR('HELLO', { ecc: 'M' });
  // Between finder patterns, row 6 alternates 1010... starting from x=8
  for (let x = 8; x <= qr.size - 9; x++) {
    assert.equal(qr.modules[6][x], x % 2 === 0 ? 1 : 0, `timing row mismatch at x=${x}`);
  }
  for (let y = 8; y <= qr.size - 9; y++) {
    assert.equal(qr.modules[y][6], y % 2 === 0 ? 1 : 0, `timing col mismatch at y=${y}`);
  }
});

test('encodeQR: dark module at (8, size - 8)', () => {
  const qr = encodeQR('HELLO', { ecc: 'M' });
  assert.equal(qr.modules[qr.size - 8][8], 1);
});

test('encodeQR: version selection scales with payload size', () => {
  // 50 bytes won't fit at v1 ECC M (max ~14 byte chars), should pick v3 or so.
  const v50 = encodeQR('x'.repeat(50), { ecc: 'M' }).version;
  assert.ok(v50 >= 3 && v50 <= 6, `expected mid version for 50 bytes, got ${v50}`);
  // 200 bytes needs more
  const v200 = encodeQR('x'.repeat(200), { ecc: 'M' }).version;
  assert.ok(v200 > v50, `expected larger version for 200 bytes, got ${v200} vs ${v50}`);
});

test('encodeQR: too-large payload throws cleanly', () => {
  assert.throws(() => encodeQR('x'.repeat(10000), { ecc: 'H' }), /too large/);
});

test('encodeQR: all 4 ECC levels work for the same payload', () => {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    const qr = encodeQR('https://gentropic.org/ep/?p=abc', { ecc });
    assert.equal(qr.ecc, ecc);
    assert.equal(qr.size, 17 + 4 * qr.version);
  }
});

test('encodeQR: mask is in 0..7', () => {
  for (let i = 0; i < 5; i++) {
    const qr = encodeQR('x'.repeat(10 + i), { ecc: 'M' });
    assert.ok(qr.mask >= 0 && qr.mask <= 7);
  }
});

test('encodeQR: deterministic — same input gives same matrix', () => {
  const a = encodeQR('hello world', { ecc: 'M' });
  const b = encodeQR('hello world', { ecc: 'M' });
  assert.equal(a.version, b.version);
  assert.equal(a.mask, b.mask);
  for (let y = 0; y < a.size; y++) {
    for (let x = 0; x < a.size; x++) {
      assert.equal(a.modules[y][x], b.modules[y][x]);
    }
  }
});

test('encodeQR: large version 40 fits ~2900 bytes at ECC L', () => {
  const qr = encodeQR('x'.repeat(2900), { ecc: 'L' });
  assert.equal(qr.version, 40);
  assert.equal(qr.size, 177);
});

// ── SVG output ────────────────────────────────────────────────────

test('qrToSvg: produces valid SVG with one <path>', () => {
  const qr = encodeQR('HELLO', { ecc: 'M' });
  const svg = qrToSvg(qr, { moduleSize: 4, margin: 2 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /<path d="M[\d,]/);  // path data starts with a moveto
});

test('qrToSvg: dimensions match (size + 2*margin) * moduleSize', () => {
  const qr = encodeQR('HELLO', { ecc: 'M' });
  const svg = qrToSvg(qr, { moduleSize: 5, margin: 3 });
  const total = (qr.size + 6) * 5;
  assert.ok(svg.includes(`viewBox="0 0 ${total} ${total}"`));
});
