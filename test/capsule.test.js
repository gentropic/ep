// Capsule module tests. CompressionStream is available in Node 18+, so
// the full encode/decode round-trip is testable in the same runtime as
// the rest of the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeInlineI, encodeInlineQ, resolveCapsule,
  fragmentEncode, fragmentDecode,
} from '../src/js/capsule.js';

test('capsule: encodeInlineI → resolveCapsule round-trips', async () => {
  const text = 'hello world\n@input\nx = 5\n';
  const ptr = await encodeInlineI(text);
  assert.ok(ptr.startsWith('i:d'), 'i: compact-form prefix');
  const decoded = await resolveCapsule(ptr);
  assert.equal(decoded, text);
});

test('capsule: encodeInlineQ → resolveCapsule round-trips', async () => {
  const text = 'hello world\n@input\nx = 5\n';
  const ptr = await encodeInlineQ(text);
  assert.ok(ptr.startsWith('q:d'), 'q: QR-form prefix');
  const decoded = await resolveCapsule(ptr);
  assert.equal(decoded, text);
});

test('capsule: long-form inline:deflate accepted', async () => {
  // Round-trip via i: form, then rewrite to long form and decode.
  const text = 'small thing';
  const compact = await encodeInlineI(text);
  const payload = compact.slice('i:d'.length);
  const longForm = 'inline:deflate:' + payload;
  const decoded = await resolveCapsule(longForm);
  assert.equal(decoded, text);
});

test('capsule: leading # is stripped', async () => {
  const text = 'x = 1';
  const ptr = await encodeInlineI(text);
  const decoded = await resolveCapsule('#' + ptr);
  assert.equal(decoded, text);
});

test('capsule: unknown scheme returns EUNKNOWN', async () => {
  await assert.rejects(
    () => resolveCapsule('gh:user/repo:file.ep'),
    /EUNKNOWN/,
  );
});

test('capsule: capsule with no colon returns ENOSCHEME', async () => {
  await assert.rejects(
    () => resolveCapsule('garbage-no-colon'),
    /ENOSCHEME/,
  );
});

test('capsule: same content yields equivalent decoded text across i/q forms', async () => {
  const text = '@input\ncore = NQ_core\n@output(kg)\nmass = sample_mass(core, 5 m, 2.7 g/cm3)\n';
  const i = await encodeInlineI(text);
  const q = await encodeInlineQ(text);
  const di = await resolveCapsule(i);
  const dq = await resolveCapsule(q);
  assert.equal(di, text);
  assert.equal(dq, text);
  assert.equal(di, dq);
});

test('capsule: brotli codec returns EUNSUPPORTEDCODEC', async () => {
  await assert.rejects(
    () => resolveCapsule('i:bAAAA'),
    /EUNSUPPORTEDCODEC/,
  );
});

// ── fragment safety for base45 (q:) payloads ──────────────────────

test('fragmentEncode/Decode: round-trip the two unsafe chars', () => {
  // raw strings exercising space, %, and the adversarial literal "%20"
  for (const raw of ['', 'plain', 'a b c', 'a%b', '100%', '%20', '% 20%', 'x%25y',
                     'q:d8N9C7%S7 RKUU8', 'q:r+8D VD82EK4F.KE5TC']) {
    assert.equal(fragmentDecode(fragmentEncode(raw)), raw, JSON.stringify(raw));
  }
});

test('fragmentEncode: leaves base64url untouched (no space or %)', () => {
  const s = 'i:dK8lIVSgszUzOVkgqyi_PU0jLr1DIKs0tKFbIL0stUigBSuckVlUqpOSn6wEA';
  assert.equal(fragmentEncode(s), s);
});

test('capsule: q: round-trips through a fragment-encoded URL hash', async () => {
  // Find a program whose q: encoding contains a space or %, then simulate
  // the full QR → URL → location.hash → boot path via fragmentEncode/Decode.
  let hit = null;
  for (let i = 0; i < 80 && !hit; i++) {
    const text = `@input\ngrade row ${i} = ${i} g/t\nyield = grade row ${i} * 1.5\n`;
    const q = await encodeInlineQ(text);
    if (q.includes(' ') || q.includes('%')) hit = { text, q };
  }
  assert.ok(hit, 'expected at least one space/%-bearing q: payload in the sample set');
  const inUrlHash = fragmentEncode(hit.q);          // what share.js puts after '#'
  assert.ok(!inUrlHash.includes(' '), 'no raw space survives into the fragment');
  const backToCapsule = fragmentDecode(inUrlHash);  // what consumeCapsule reverses
  assert.equal(backToCapsule, hit.q);
  const decoded = await resolveCapsule(backToCapsule);
  assert.equal(decoded, hit.text);
});
